import type { Model, ProviderHeaders } from "../types.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";

/** Public, OpenAI-compatible inference base. Overridable for staging/self-host. */
export const DEFAULT_AIMLAPI_BASE_URL = "https://api.aimlapi.com/v1";
/** Partner attribution defaults; overridable via env for testing. */
export const DEFAULT_AIMLAPI_PARTNER_ID = "part_XHt7FqYi5LOwKzWRsZ6qXONf";
export const AIMLAPI_SOURCE = "agent/pi";

/** OpenAI-compatible inference base URL (env override → default). */
export function resolveAimlapiBaseUrl(): string {
	const override = getProviderEnvValue("AIMLAPI_INFERENCE_URL");
	return normalizeBaseUrl(override?.trim() ? override : DEFAULT_AIMLAPI_BASE_URL);
}

/** Partner id sent for traffic/signup attribution (env override → default). */
export function resolveAimlapiPartnerId(): string {
	const override = getProviderEnvValue("AIMLAPI_PARTNER_ID");
	return override?.trim() ? override.trim() : DEFAULT_AIMLAPI_PARTNER_ID;
}

/** Attribution headers sent on every AIMLAPI request (inference + discovery). */
export function getAimlapiHeaders(): ProviderHeaders {
	return {
		"X-AIMLAPI-Source": AIMLAPI_SOURCE,
		"X-AIMLAPI-Partner-ID": resolveAimlapiPartnerId(),
	};
}

function normalizeBaseUrl(value: string): string {
	return value.replace(/\/+$/u, "");
}

// --- Catalog shape (minimal projection + include=capabilities,modalities,pricing) ---

interface AimlapiModelInfo {
	name?: string;
	contextLength?: number;
	outputMax?: number;
	isHottest?: boolean;
}

interface AimlapiPricingUnit {
	type?: string;
	name?: string;
	content?: string;
	origin?: string;
	price?: number;
	per?: number;
}

interface AimlapiCatalogEntry {
	id?: string;
	type?: string;
	info?: AimlapiModelInfo;
	capabilities?: string[];
	modalities?: { input?: string[]; output?: string[] };
	pricing?: { units?: AimlapiPricingUnit[] };
}

const DEFAULT_CONTEXT_WINDOW = 32_768;
const DEFAULT_MAX_TOKENS = 8_192;

/** Chat-only filter from `../../MODELS.md`: drop dedicated image/video/audio
 * endpoints, audio-output chat models, and image-on-chat models whose output
 * modality is mislabeled `[text]`. */
function isChatModel(entry: AimlapiCatalogEntry): boolean {
	if (entry.type !== "openai/chat-completions" || typeof entry.id !== "string") return false;
	const output = entry.modalities?.output;
	if (Array.isArray(output) && !output.every((modality) => modality === "text")) return false;
	if (/-image(-|$)/iu.test(entry.id)) return false;
	return true;
}

function positiveInt(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** Text-token charges → per-1M cost, discriminated by pricing `origin`. */
function mapCost(units: AimlapiPricingUnit[] | undefined): Model<"openai-completions">["cost"] {
	const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	for (const unit of units ?? []) {
		if (unit.name !== "token" || unit.content !== "text") continue;
		if (typeof unit.price !== "number" || typeof unit.per !== "number" || unit.per <= 0) continue;
		const perMillion = (unit.price / unit.per) * 1_000_000;
		switch (unit.origin) {
			case "provided":
				cost.input = perMillion;
				break;
			case "generated":
				cost.output = perMillion;
				break;
			case "cached":
				cost.cacheRead = perMillion;
				break;
			case "cache_write":
				cost.cacheWrite = perMillion;
				break;
			default:
				break;
		}
	}
	return cost;
}

function mapEntry(providerId: string, baseUrl: string, entry: AimlapiCatalogEntry): Model<"openai-completions"> {
	const info = entry.info ?? {};
	const contextWindow = positiveInt(info.contextLength, DEFAULT_CONTEXT_WINDOW);
	const input = (entry.modalities?.input ?? ["text"]).filter(
		(modality): modality is "text" | "image" => modality === "text" || modality === "image",
	);
	return {
		id: entry.id as string,
		name: info.name?.trim() ? info.name : (entry.id as string),
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		reasoning: Array.isArray(entry.capabilities) && entry.capabilities.includes("reasoning"),
		input: input.length > 0 ? input : ["text"],
		cost: mapCost(entry.pricing?.units),
		contextWindow,
		maxTokens: Math.min(contextWindow, positiveInt(info.outputMax, DEFAULT_MAX_TOKENS)),
	};
}

/** Map a raw `/v1/models` payload to chat models, hottest-first then
 * alphabetical within each group (`../../MODELS.md` § Featured models). */
export function mapAimlapiCatalog(
	providerId: string,
	baseUrl: string,
	payload: unknown,
): Model<"openai-completions">[] {
	const data = Array.isArray(payload)
		? payload
		: Array.isArray((payload as { data?: unknown })?.data)
			? ((payload as { data: unknown[] }).data as AimlapiCatalogEntry[])
			: [];
	const chat = (data as AimlapiCatalogEntry[]).filter(isChatModel);
	const hottest: AimlapiCatalogEntry[] = [];
	const rest: AimlapiCatalogEntry[] = [];
	for (const entry of chat) {
		(entry.info?.isHottest ? hottest : rest).push(entry);
	}
	const byId = (a: AimlapiCatalogEntry, b: AimlapiCatalogEntry) => (a.id as string).localeCompare(b.id as string);
	hottest.sort(byId);
	rest.sort(byId);
	return [...hottest, ...rest].map((entry) => mapEntry(providerId, baseUrl, entry));
}

function truncateHttpBody(body: string): string {
	const trimmed = body.trim();
	return trimmed.length > 512 ? `${trimmed.slice(0, 512)}…` : trimmed;
}

/** Fetch and map the AIMLAPI chat catalog. The catalog is public; the key and
 * attribution headers are sent when available. */
export async function fetchAimlapiModels(
	providerId: string,
	baseUrl: string,
	apiKey?: string,
	signal?: AbortSignal,
): Promise<Model<"openai-completions">[]> {
	const url = `${baseUrl}/models?include=capabilities,modalities,pricing`;
	const headers: Record<string, string> = { accept: "application/json", ...getAimlapiHeaders() };
	if (apiKey) headers.authorization = `Bearer ${apiKey}`;
	const response = await fetch(url, { headers, signal });
	if (!response.ok) {
		throw new Error(
			`Could not load AIMLAPI models from ${baseUrl}: ${response.status}: ${truncateHttpBody(await response.text())}`,
		);
	}
	return mapAimlapiCatalog(providerId, baseUrl, await response.json());
}
