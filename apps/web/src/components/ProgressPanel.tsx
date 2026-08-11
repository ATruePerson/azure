import { CheckCircle2, Circle, LoaderCircle } from "lucide-react";

import type { ActivePlanState } from "~/session-logic";
import { cn } from "~/lib/utils";

export function ProgressPanel({ plan }: { readonly plan: ActivePlanState | null }) {
  if (!plan || plan.steps.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <div className="max-w-xs text-center">
          <h2 className="text-base font-medium">Progress</h2>
          <p className="mt-2 text-sm text-muted-foreground">See task progress for longer tasks.</p>
        </div>
      </div>
    );
  }

  const completed = plan.steps.filter((step) => step.status === "completed").length;
  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-medium">Progress</h2>
          {plan.explanation ? (
            <p className="mt-1 text-sm text-muted-foreground">{plan.explanation}</p>
          ) : null}
        </div>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {completed}/{plan.steps.length}
        </span>
      </div>
      <ol className="space-y-3">
        {plan.steps.map((step) => {
          const Icon =
            step.status === "completed"
              ? CheckCircle2
              : step.status === "inProgress"
                ? LoaderCircle
                : Circle;
          return (
            <li key={step.step} className="flex items-start gap-3">
              <Icon
                className={cn(
                  "mt-0.5 size-4 shrink-0",
                  step.status === "completed"
                    ? "text-success"
                    : step.status === "inProgress"
                      ? "animate-spin text-primary motion-reduce:animate-none"
                      : "text-muted-foreground/50",
                )}
                aria-hidden
              />
              <span
                className={cn(
                  "text-sm leading-5",
                  step.status === "completed"
                    ? "text-muted-foreground line-through"
                    : "text-foreground",
                )}
              >
                {step.step}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
