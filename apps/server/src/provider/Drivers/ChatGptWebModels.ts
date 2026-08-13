import type { ServerProviderModel } from "@azure/contracts";

export const CHATGPT_WEB_MODEL_PREFIX = "chatgpt-web/";

export const isChatGptWebModelSlug = (slug: string): boolean =>
  slug.startsWith(CHATGPT_WEB_MODEL_PREFIX);

export const nativeCodexModels = (
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> =>
  models.filter((model) => !isChatGptWebModelSlug(model.slug));

export const chatGptWebModels = (
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> =>
  models.filter((model) => isChatGptWebModelSlug(model.slug));

export const markFirstModelDefault = (
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> => {
  if (models.length === 0 || models.some((model) => model.isDefault)) return models;
  return models.map((model, index) => (index === 0 ? { ...model, isDefault: true } : model));
};
