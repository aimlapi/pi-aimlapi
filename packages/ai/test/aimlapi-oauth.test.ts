import { afterEach, describe, expect, it, vi } from "vitest";
import { aimlapiOAuth } from "../src/auth/oauth/aimlapi.ts";
import { aimlapiProvider } from "../src/providers/aimlapi.ts";

const ACCOUNT_URL = "https://auth.aimlapi.com/v1/auth/account";
const SEND_CODE_URL = "https://auth.aimlapi.com/v1/auth/sign-in/code";
const VERIFY_CODE_URL = "https://auth.aimlapi.com/v1/auth/sign-in/code/verify";
const PASSWORDLESS_URL = "https://auth.aimlapi.com/v1/auth/account/passwordless";
const KEYS_URL = "https://app.aimlapi.com/v1/keys";
const neverAbortedSignal = new AbortController().signal;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
	return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe.sequential("AI/ML API OAuth", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("is exposed alongside API-key auth", () => {
		const provider = aimlapiProvider();
		expect(provider.auth.apiKey).toBeDefined();
		expect(provider.auth.oauth).toBeDefined();
		expect(provider.auth.oauth?.loginLabel).toBe("Sign in with AI/ML API");
	});

	it("signs in an existing account with an emailed code and mints an API key", async () => {
		const calls: string[] = [];
		let verifyBody: Record<string, unknown> | undefined;
		let keyBody: Record<string, unknown> | undefined;
		let keyAuthHeader: string | null | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = input instanceof Request ? input.url : String(input);
				calls.push(url);
				if (url === ACCOUNT_URL) return jsonResponse({ action: "sign-in" });
				if (url === SEND_CODE_URL) return new Response(null, { status: 204 });
				if (url === VERIFY_CODE_URL) {
					verifyBody = requestBody(init);
					return jsonResponse({ token: "session-token", exp: 9999999999 });
				}
				if (url === KEYS_URL) {
					keyBody = requestBody(init);
					keyAuthHeader = new Headers(init?.headers).get("authorization");
					return jsonResponse({ key: "aiml-test-key", id: "key-1" });
				}
				throw new Error(`Unexpected request: ${url}`);
			}),
		);

		const prompts = ["user@example.com", "123456"];
		const credential = await aimlapiOAuth.login({
			signal: neverAbortedSignal,
			prompt: async () => prompts.shift() ?? "",
			notify: () => {},
		});

		expect(credential).toEqual({
			type: "oauth",
			access: "aiml-test-key",
			refresh: "",
			expires: Number.MAX_SAFE_INTEGER,
		});
		expect(calls).toEqual([ACCOUNT_URL, SEND_CODE_URL, VERIFY_CODE_URL, KEYS_URL]);
		expect(verifyBody).toEqual({ email: "user@example.com", code: "123456" });
		expect(keyBody).toEqual({ name: "pi CLI" });
		expect(keyAuthHeader).toBe("Bearer session-token");
	});

	it("creates a new account but does not attempt to mint a key — a fresh account is inactive until its first top-up", async () => {
		const calls: string[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = input instanceof Request ? input.url : String(input);
			calls.push(url);
			if (url === ACCOUNT_URL) return jsonResponse({ action: "sign-up" });
			if (url === PASSWORDLESS_URL) return jsonResponse({ token: "new-session-token", exp: 9999999999 });
			throw new Error(`Unexpected request: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			aimlapiOAuth.login({
				signal: neverAbortedSignal,
				prompt: async () => "new-user@example.com",
				notify: () => {},
			}),
		).rejects.toThrow(/Account created for new-user@example.com.*run \/login again/);
		expect(calls).toEqual([ACCOUNT_URL, PASSWORDLESS_URL]);
	});

	it("rejects an account linked to a third-party sign-in provider", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ action: "sign-in", provider: "google" })),
		);

		await expect(
			aimlapiOAuth.login({
				signal: neverAbortedSignal,
				prompt: async () => "user@example.com",
				notify: () => {},
			}),
		).rejects.toThrow(/signs in via google/);
	});

	it("reports an invalid verification code", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = input instanceof Request ? input.url : String(input);
				if (url === ACCOUNT_URL) return jsonResponse({ action: "sign-in" });
				if (url === SEND_CODE_URL) return new Response(null, { status: 204 });
				if (url === VERIFY_CODE_URL) return jsonResponse({ message: "invalid code" }, 400);
				throw new Error(`Unexpected request: ${url}`);
			}),
		);

		const prompts = ["user@example.com", "000000"];
		await expect(
			aimlapiOAuth.login({
				signal: neverAbortedSignal,
				prompt: async () => prompts.shift() ?? "",
				notify: () => {},
			}),
		).rejects.toThrow("AI/ML API request failed (HTTP 400): invalid code");
	});

	it("rejects a successful key response that carries no key", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = input instanceof Request ? input.url : String(input);
				if (url === ACCOUNT_URL) return jsonResponse({ action: "sign-in" });
				if (url === SEND_CODE_URL) return new Response(null, { status: 204 });
				if (url === VERIFY_CODE_URL) return jsonResponse({ token: "session-token", exp: 9999999999 });
				if (url === KEYS_URL) return jsonResponse({ id: "key-1" });
				throw new Error(`Unexpected request: ${url}`);
			}),
		);

		const prompts = ["user@example.com", "123456"];
		await expect(
			aimlapiOAuth.login({
				signal: neverAbortedSignal,
				prompt: async () => prompts.shift() ?? "",
				notify: () => {},
			}),
		).rejects.toThrow("AI/ML API did not return an API key");
	});

	it("rejects an empty email without making a request", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			aimlapiOAuth.login({
				signal: neverAbortedSignal,
				prompt: async () => "   ",
				notify: () => {},
			}),
		).rejects.toThrow("Email is required");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
