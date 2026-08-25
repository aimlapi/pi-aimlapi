import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { AIMLAPI_MODELS } from "./aimlapi.models.ts";

export function aimlapiProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "aimlapi",
		name: "AI/ML API",
		baseUrl: "https://api.aimlapi.com/v1",
		auth: {
			apiKey: envApiKeyAuth("AI/ML API key", ["AIMLAPI_API_KEY"]),
		},
		models: Object.values(AIMLAPI_MODELS),
		api: openAICompletionsApi(),
	});
}
