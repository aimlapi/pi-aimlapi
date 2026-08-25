import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadAimlapiOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
import { AIMLAPI_MODELS } from "./aimlapi.models.ts";

export function aimlapiProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "aimlapi",
		name: "★ aimlapi.com",
		baseUrl: "https://api.aimlapi.com/v1",
		auth: {
			apiKey: envApiKeyAuth("aimlapi.com key", ["AIMLAPI_API_KEY"]),
			oauth: lazyOAuth({
				name: "aimlapi.com sign-in",
				loginLabel: "Sign in with aimlapi.com",
				load: loadAimlapiOAuth,
			}),
		},
		models: Object.values(AIMLAPI_MODELS),
		api: openAICompletionsApi(),
	});
}
