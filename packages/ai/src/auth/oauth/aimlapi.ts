/**
 * AI/ML API passwordless email sign-in.
 *
 * Unlike OpenRouter's PKCE browser-redirect flow, AI/ML API's login is a
 * terminal-native email + one-time-code exchange (no browser or loopback
 * server involved): resolve whether the email signs in or signs up, collect
 * a verification code (existing accounts only), exchange it for a session
 * token, then mint a permanent API key scoped to this login. The result is
 * wrapped as an "oauth" credential the same way OpenRouter's key exchange
 * is — a permanent key, not an expiring access/refresh pair.
 */

import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";

const AUTH_BASE_URL = "https://auth.aimlapi.com";
const APP_BASE_URL = "https://app.aimlapi.com";
const REQUEST_TIMEOUT_MS = 30_000;
const KEY_NAME = "pi CLI";

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null;
}

function errorDetail(body: JsonObject): string | undefined {
	if (typeof body.message === "string") return body.message;
	if (typeof body.error === "string") return body.error;
	return undefined;
}

async function request(
	method: "GET" | "POST" | "PATCH",
	url: string,
	options: { body?: unknown; bearer?: string; expectJson?: boolean; signal: AbortSignal },
): Promise<JsonObject | undefined> {
	const controller = new AbortController();
	const onAbort = () => controller.abort(options.signal.reason);
	options.signal.addEventListener("abort", onAbort, { once: true });
	const timeout = setTimeout(
		() => controller.abort(new Error(`AI/ML API request to ${url} timed out`)),
		REQUEST_TIMEOUT_MS,
	);

	let response: Response;
	try {
		response = await fetch(url, {
			method,
			headers: {
				accept: "application/json",
				...(options.body !== undefined ? { "content-type": "application/json" } : {}),
				...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
			},
			...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
			signal: controller.signal,
		});
	} catch (error) {
		if (options.signal.aborted) throw new Error("Login cancelled");
		if (controller.signal.aborted) throw new Error(`AI/ML API request to ${url} timed out`);
		throw error;
	} finally {
		clearTimeout(timeout);
		options.signal.removeEventListener("abort", onAbort);
	}

	if (options.expectJson === false) {
		if (!response.ok) throw new Error(`AI/ML API request failed (HTTP ${response.status})`);
		return undefined;
	}

	let body: JsonObject = {};
	try {
		const parsed = (await response.json()) as unknown;
		if (isRecord(parsed)) body = parsed;
	} catch {
		if (response.ok) throw new Error("AI/ML API returned invalid JSON");
	}

	if (!response.ok) {
		const detail = errorDetail(body);
		throw new Error(`AI/ML API request failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
	}
	return body;
}

async function checkAccount(
	email: string,
	signal: AbortSignal,
): Promise<{ action: "sign-in" | "sign-up"; provider?: string }> {
	const body = await request("PATCH", `${AUTH_BASE_URL}/v1/auth/account`, { body: { email }, signal });
	const action = body?.action;
	if (action !== "sign-in" && action !== "sign-up") throw new Error("AI/ML API returned an invalid account response");
	return { action, provider: typeof body?.provider === "string" ? body.provider : undefined };
}

async function sendSignInCode(email: string, signal: AbortSignal): Promise<void> {
	await request("POST", `${AUTH_BASE_URL}/v1/auth/sign-in/code`, { body: { email }, expectJson: false, signal });
}

async function exchangeForToken(path: string, body: JsonObject, signal: AbortSignal): Promise<string> {
	const result = await request("POST", `${AUTH_BASE_URL}${path}`, { body, signal });
	const token = result?.token;
	if (typeof token !== "string" || token.length === 0) throw new Error("AI/ML API did not return an auth token");
	return token;
}

async function createKey(bearer: string, signal: AbortSignal): Promise<string> {
	const result = await request("POST", `${APP_BASE_URL}/v1/keys`, { body: { name: KEY_NAME }, bearer, signal });
	const key = result?.key;
	if (typeof key !== "string" || key.length === 0) throw new Error("AI/ML API did not return an API key");
	return key;
}

async function loginAimlapi(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const rawEmail = await interaction.prompt({ type: "text", message: "Enter your AI/ML API account email" });
	const email = rawEmail.trim();
	if (!email) throw new Error("Email is required");

	interaction.notify({ type: "progress", message: "Checking your AI/ML API account..." });
	const account = await checkAccount(email, interaction.signal);

	if (account.action === "sign-up") {
		// A freshly created passwordless account is inactive until its first top-up
		// (AI/ML API mints API keys only for active accounts), so there is no key to
		// hand back here yet — create the account and send the user to fund it.
		interaction.notify({ type: "progress", message: "Creating your AI/ML API account..." });
		await exchangeForToken("/v1/auth/account/passwordless", { email }, interaction.signal);
		throw new Error(
			`Account created for ${email}. Add credit at https://aimlapi.com/app, then run /login again to sign in.`,
		);
	}

	if (account.provider) {
		throw new Error(
			`This email signs in via ${account.provider} on AI/ML API — sign in at https://aimlapi.com/app and create an API key manually instead.`,
		);
	}
	await sendSignInCode(email, interaction.signal);
	interaction.notify({ type: "info", message: `A 6-digit code was sent to ${email}.` });
	const rawCode = await interaction.prompt({ type: "text", message: "Enter the 6-digit code" });
	const code = rawCode.trim();
	if (!code) throw new Error("Code is required");
	const sessionToken = await exchangeForToken("/v1/auth/sign-in/code/verify", { email, code }, interaction.signal);

	interaction.notify({ type: "progress", message: "Creating an AI/ML API key for pi..." });
	const key = await createKey(sessionToken, interaction.signal);

	return {
		type: "oauth",
		access: key,
		refresh: "",
		expires: Number.MAX_SAFE_INTEGER,
	};
}

export const aimlapiOAuth: OAuthAuth = {
	name: "AI/ML API sign-in",
	loginLabel: "Sign in with AI/ML API",
	login: loginAimlapi,
	async refresh(credential, _signal) {
		return credential;
	},
	async toAuth(credential) {
		return { apiKey: credential.access };
	},
};
