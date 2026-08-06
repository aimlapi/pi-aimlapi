import { describe, expect, it } from "vitest";
import { mapAimlapiCatalog } from "../src/providers/aimlapi-catalog.ts";

const BASE_URL = "https://api.aimlapi.com/v1";

function chatEntry(id: string, extra: Record<string, unknown> = {}) {
	return {
		id,
		type: "openai/chat-completions",
		info: { name: id.toUpperCase(), contextLength: 16000, outputMax: 4096 },
		modalities: { input: ["text"], output: ["text"] },
		pricing: {
			units: [
				{ type: "charge", name: "token", content: "text", origin: "provided", price: 0.65, per: 1_000_000 },
				{ type: "charge", name: "token", content: "text", origin: "generated", price: 1.95, per: 1_000_000 },
			],
		},
		...extra,
	};
}

describe("mapAimlapiCatalog", () => {
	it("keeps only chat-completions models and stamps provider/api/baseUrl", () => {
		const models = mapAimlapiCatalog("aimlapi", BASE_URL, {
			data: [
				chatEntry("openai/gpt-4o"),
				{ id: "flux/schnell", type: "openai/image-generations" },
				{
					id: "openai/gpt-audio",
					type: "openai/chat-completions",
					modalities: { input: ["text"], output: ["audio", "text"] },
				},
				{ id: "google/gemini-3-pro-image", type: "openai/chat-completions", modalities: { output: ["text"] } },
			],
		});
		expect(models.map((model) => model.id)).toEqual(["openai/gpt-4o"]);
		expect(models[0]).toMatchObject({ api: "openai-completions", provider: "aimlapi", baseUrl: BASE_URL });
	});

	it("maps text-token pricing to per-1M cost by origin", () => {
		const [model] = mapAimlapiCatalog("aimlapi", BASE_URL, { data: [chatEntry("openai/gpt-4o")] });
		expect(model.cost).toEqual({ input: 0.65, output: 1.95, cacheRead: 0, cacheWrite: 0 });
		expect(model.contextWindow).toBe(16000);
		expect(model.maxTokens).toBe(4096);
	});

	it("orders hottest models first, alphabetical within each group", () => {
		const models = mapAimlapiCatalog("aimlapi", BASE_URL, {
			data: [
				chatEntry("z/plain"),
				chatEntry("a/plain"),
				chatEntry("m/hot", { info: { name: "Hot", isHottest: true, contextLength: 8000 } }),
				chatEntry("b/hot", { info: { name: "Hot2", isHottest: true, contextLength: 8000 } }),
			],
		});
		expect(models.map((model) => model.id)).toEqual(["b/hot", "m/hot", "a/plain", "z/plain"]);
	});

	it("defaults input to text and caps maxTokens at the context window", () => {
		const [model] = mapAimlapiCatalog("aimlapi", BASE_URL, {
			data: [chatEntry("x/y", { modalities: {}, info: { contextLength: 2000, outputMax: 9999 } })],
		});
		expect(model.input).toEqual(["text"]);
		expect(model.maxTokens).toBe(2000);
	});
});
