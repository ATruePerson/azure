import type { ChatAttachment, ModelSelection } from "@azure/contracts";
import { TextGenerationError } from "@azure/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { extractJsonObject } from "@azure/shared/schemaJson";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";
import { sanitizeBranchFragment } from "@azure/shared/git";
import * as TextGeneration from "./TextGeneration.ts";

export interface OpenAICompatibleTextGenerationOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly headers?: Readonly<Record<string, string>>;
}

type Operation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

function joinUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/chat/completions`;
}

function failure(operation: Operation, detail: string): TextGenerationError {
  return new TextGenerationError({ operation, detail });
}

export const makeOpenAICompatibleTextGeneration = Effect.fn("makeOpenAICompatibleTextGeneration")(
  function* (options: OpenAICompatibleTextGenerationOptions) {
    const client = yield* HttpClient.HttpClient;

    const runJson = <S extends Schema.Top>(input: {
      readonly operation: Operation;
      readonly prompt: string;
      readonly outputSchema: S;
      readonly modelSelection: ModelSelection;
      readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
    }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
      Effect.gen(function* () {
        if (!options.apiKey.trim()) {
          return yield* failure(input.operation, "An API key is required for text generation.");
        }
        if (!input.modelSelection.model.trim()) {
          return yield* failure(input.operation, "A model is required for text generation.");
        }
        if ((input.attachments?.length ?? 0) > 0) {
          return yield* failure(
            input.operation,
            "This OpenAI-compatible provider does not support attachments.",
          );
        }
        const response = yield* client
          .execute(
            HttpClientRequest.post(joinUrl(options.baseUrl)).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                model: input.modelSelection.model,
                messages: [{ role: "user", content: input.prompt }],
                stream: false,
              }),
              HttpClientRequest.setHeaders({
                ...options.headers,
                Authorization: `Bearer ${options.apiKey}`,
                Accept: "application/json",
                "Content-Type": "application/json",
              }),
            ),
          )
          .pipe(Effect.mapError(() => failure(input.operation, "Provider request failed.")));
        if (response.status < 200 || response.status >= 300) {
          return yield* failure(
            input.operation,
            `Provider request failed (HTTP ${response.status}).`,
          );
        }
        const body = yield* response.text.pipe(
          Effect.mapError(() => failure(input.operation, "Provider response could not be read.")),
        );
        const raw = yield* Effect.try({
          try: () => decodeJson(body),
          catch: () => failure(input.operation, "Provider returned invalid JSON."),
        });
        if (
          typeof raw !== "object" ||
          raw === null ||
          !Array.isArray((raw as { choices?: unknown }).choices) ||
          typeof (raw as { choices: Array<{ message?: { content?: unknown } }> }).choices[0]
            ?.message?.content !== "string"
        ) {
          return yield* failure(input.operation, "Provider returned no text output.");
        }
        const text = (raw as { choices: Array<{ message: { content: string } }> }).choices[0]!
          .message.content;
        return yield* Schema.decodeEffect(Schema.fromJsonString(input.outputSchema))(
          extractJsonObject(text),
        ).pipe(
          Effect.mapError(() =>
            failure(input.operation, "Provider returned invalid structured output."),
          ),
        );
      });

    const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
      (input) =>
        Effect.gen(function* () {
          const { prompt, outputSchema } = buildCommitMessagePrompt({
            branch: input.branch,
            stagedSummary: input.stagedSummary,
            stagedPatch: input.stagedPatch,
            includeBranch: input.includeBranch === true,
            policy: input.policy,
          });
          const generated = yield* runJson({
            operation: "generateCommitMessage",
            prompt,
            outputSchema,
            modelSelection: input.modelSelection,
          });
          return {
            subject: sanitizeCommitSubject(generated.subject),
            body: generated.body.trim(),
            ...("branch" in generated && typeof generated.branch === "string"
              ? { branch: sanitizeBranchFragment(generated.branch) }
              : {}),
          };
        });

    const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] = (
      input,
    ) =>
      Effect.gen(function* () {
        const { prompt, outputSchema } = buildPrContentPrompt({
          baseBranch: input.baseBranch,
          headBranch: input.headBranch,
          commitSummary: input.commitSummary,
          diffSummary: input.diffSummary,
          diffPatch: input.diffPatch,
          policy: input.policy,
          changeRequestTemplate: input.changeRequestTemplate,
        });
        const generated = yield* runJson({
          operation: "generatePrContent",
          prompt,
          outputSchema,
          modelSelection: input.modelSelection,
        });
        return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
      });

    const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] = (
      input,
    ) =>
      Effect.gen(function* () {
        const { prompt, outputSchema } = buildBranchNamePrompt({
          message: input.message,
          ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
        });
        const generated = yield* runJson({
          operation: "generateBranchName",
          prompt,
          outputSchema,
          modelSelection: input.modelSelection,
          ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
        });
        return { branch: sanitizeBranchFragment(generated.branch) };
      });

    const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] = (
      input,
    ) =>
      Effect.gen(function* () {
        const { prompt, outputSchema } = buildThreadTitlePrompt({
          message: input.message,
          previousTitle: input.previousTitle,
          attachments: input.attachments,
        });
        const generated = yield* runJson({
          operation: "generateThreadTitle",
          prompt,
          outputSchema,
          modelSelection: input.modelSelection,
          attachments: input.attachments,
        });
        return { title: sanitizeThreadTitle(generated.title) };
      });

    return {
      generateCommitMessage,
      generatePrContent,
      generateBranchName,
      generateThreadTitle,
    } satisfies TextGeneration.TextGeneration["Service"];
  },
);
