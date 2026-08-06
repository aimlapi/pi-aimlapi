import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { fetchAimlapiModels, getAimlapiHeaders, resolveAimlapiBaseUrl } from "./aimlapi-catalog.ts";

/**
 * AIMLAPI — an OpenAI-compatible aggregator (1000+ models). The catalog is not
 * in the generated model data, so models are fetched dynamically from
 * `/v1/models` and cached, like the Radius gateway provider.
 */
export function aimlapiProvider(): Provider<"openai-completions"> {
	const id = "aimlapi";
	const baseUrl = resolveAimlapiBaseUrl();
	return createProvider({
		id,
		name: "aimlapi.com (1000+ models, one-click setup)",
		baseUrl,
		headers: getAimlapiHeaders(),
		auth: { apiKey: envApiKeyAuth("AIMLAPI API key", ["AIMLAPI_API_KEY"]) },
		models: [],
		fetchModels: (context) => {
			const apiKey = context.credential?.type === "oauth" ? context.credential.access : context.credential?.key;
			return fetchAimlapiModels(id, baseUrl, apiKey, context.signal);
		},
		api: openAICompletionsApi(),
	});
}
