import type { FetchContextOptions } from "./context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFetchContext, HttpError, isBlockedAddress, withAllowedHosts } from "./context";

/** A resolver pinned to a public address, so no test ever touches real DNS. */
const publicResolve = (): Promise<string[]> => Promise.resolve(["93.184.216.34"]);

const jsonResponse = (body: string, init?: ResponseInit): Response => new Response(body, { status: 200, ...init });

function stubFetch(factory: () => Response): ReturnType<typeof vi.fn> {
	const mock = vi.fn(() => Promise.resolve(factory()));
	vi.stubGlobal("fetch", mock);
	return mock;
}

function makeContext(options: FetchContextOptions = {}) {
	return createFetchContext({ resolve: publicResolve, paceMs: 0, ...options });
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("isBlockedAddress", () => {
	it("blocks private, loopback, link-local and reserved IPv4 space", () => {
		for (const address of [
			"127.0.0.1",
			"10.0.0.1",
			"172.16.0.5",
			"192.168.1.1",
			"169.254.169.254",
			"0.0.0.0",
			"100.64.0.1",
			"255.255.255.255",
		]) {
			expect(isBlockedAddress(address), address).toBe(true);
		}
	});

	it("blocks IPv6 loopback, unique-local, link-local and mapped-IPv4 forms", () => {
		for (const address of [
			"::1",
			"::",
			"fc00::1",
			"fd12::1",
			"fe80::1",
			"fe80::1%eth0",
			"::ffff:127.0.0.1",
			"::ffff:7f00:1",
		]) {
			expect(isBlockedAddress(address), address).toBe(true);
		}
	});

	it("allows public addresses of both families", () => {
		for (const address of ["93.184.216.34", "8.8.8.8", "2606:4700::1111", "::ffff:5db8:d822"]) {
			expect(isBlockedAddress(address), address).toBe(false);
		}
	});

	it("treats unparseable input as blocked", () => {
		for (const address of ["", "not-an-ip", "1.2.3", "01.2.3.4", "999.1.1.1"]) {
			expect(isBlockedAddress(address), address).toBe(true);
		}
	});
});

describe("createFetchContext scheme handling", () => {
	it("rejects non-http(s) schemes outright", async () => {
		const mock = stubFetch(() => jsonResponse("{}"));
		const ctx = makeContext();
		await expect(ctx.fetchText("ftp://example.com/file")).rejects.toThrow(/refusing non-https/);
		expect(mock).not.toHaveBeenCalled();
	});

	it("rejects plain http by default", async () => {
		const mock = stubFetch(() => jsonResponse("{}"));
		const ctx = makeContext();
		await expect(ctx.fetchJson("http://example.com/jobs")).rejects.toThrow(/refusing non-https/);
		expect(mock).not.toHaveBeenCalled();
	});

	it("allows http only when allowHttp is set", async () => {
		stubFetch(() => jsonResponse('{"ok":true}'));
		const ctx = makeContext({ allowHttp: true });
		await expect(ctx.fetchJson("http://example.com/jobs")).resolves.toEqual({ ok: true });
	});

	it("rejects malformed URLs", async () => {
		const ctx = makeContext();
		await expect(ctx.fetchText("not a url")).rejects.toThrow(/invalid URL/);
	});
});

describe("createFetchContext private-address guard", () => {
	it("rejects private/loopback IP-literal hostnames without any DNS lookup", async () => {
		const mock = stubFetch(() => jsonResponse("{}"));
		const resolve = vi.fn(publicResolve);
		const ctx = makeContext({ allowHttp: true, resolve });
		for (const url of [
			"http://127.0.0.1/",
			"http://10.0.0.1/",
			"http://192.168.1.10/x",
			"http://169.254.169.254/latest/meta-data/",
			"http://[::1]/",
			"http://[::ffff:127.0.0.1]/",
			"https://172.16.0.1/",
		]) {
			await expect(ctx.fetchJson(url), url).rejects.toThrow(/non-public address/);
		}
		expect(resolve).not.toHaveBeenCalled();
		expect(mock).not.toHaveBeenCalled();
	});

	it("rejects a hostname that resolves to a private address", async () => {
		const mock = stubFetch(() => jsonResponse("{}"));
		const ctx = makeContext({ resolve: () => Promise.resolve(["10.1.2.3"]) });
		await expect(ctx.fetchJson("https://internal.example.com/")).rejects.toThrow(/non-public address 10\.1\.2\.3/);
		expect(mock).not.toHaveBeenCalled();
	});

	it("rejects a hostname where ANY resolved address is private (DNS-rebinding caution)", async () => {
		const mock = stubFetch(() => jsonResponse("{}"));
		const ctx = makeContext({ resolve: () => Promise.resolve(["93.184.216.34", "169.254.169.254"]) });
		await expect(ctx.fetchJson("https://rebind.example.com/")).rejects.toThrow(/non-public address/);
		expect(mock).not.toHaveBeenCalled();
	});

	it("rejects a hostname that resolves to nothing", async () => {
		stubFetch(() => jsonResponse("{}"));
		const ctx = makeContext({ resolve: () => Promise.resolve([]) });
		await expect(ctx.fetchJson("https://empty.example.com/")).rejects.toThrow(/no addresses/);
	});

	it("wraps resolver failures in a scanner error", async () => {
		stubFetch(() => jsonResponse("{}"));
		const ctx = makeContext({ resolve: () => Promise.reject(new Error("ENOTFOUND")) });
		await expect(ctx.fetchJson("https://missing.example.com/")).rejects.toThrow(/DNS lookup failed/);
	});

	it("fetches a hostname whose every address is public", async () => {
		const mock = stubFetch(() => jsonResponse('{"jobs":[]}'));
		const ctx = makeContext();
		await expect(ctx.fetchJson("https://api.example.com/jobs")).resolves.toEqual({ jobs: [] });
		expect(mock).toHaveBeenCalledTimes(1);
	});
});

describe("createFetchContext host allowlists", () => {
	it("enforces a per-call allowedHosts list before fetching", async () => {
		const mock = stubFetch(() => jsonResponse("{}"));
		const ctx = makeContext();
		await expect(ctx.fetchJson("https://evil.example.com/x", { allowedHosts: ["api.example.com"] })).rejects.toThrow(
			/not in the allowed host list/,
		);
		expect(mock).not.toHaveBeenCalled();
		await expect(ctx.fetchJson("https://API.example.com/x", { allowedHosts: ["api.EXAMPLE.com"] })).resolves.toEqual(
			{},
		);
	});

	it("enforces a context-wide allowlist in addition to the per-call one", async () => {
		stubFetch(() => jsonResponse("{}"));
		const ctx = makeContext({ allowedHosts: ["api.example.com"] });
		await expect(ctx.fetchText("https://other.example.com/")).rejects.toThrow(/not in the allowed host list/);
		await expect(ctx.fetchText("https://api.example.com/")).resolves.toBe("{}");
	});

	it("withAllowedHosts constrains both fetchJson and fetchText, and only ever narrows", async () => {
		const mock = stubFetch(() => jsonResponse("{}"));
		const wrapped = withAllowedHosts(makeContext(), ["api.example.com"]);
		await expect(wrapped.fetchJson("https://evil.example.com/")).rejects.toThrow(/not in the allowed host list/);
		await expect(wrapped.fetchText("https://evil.example.com/")).rejects.toThrow(/not in the allowed host list/);
		// A per-call list cannot re-broaden past the wrapper: the intersection is empty.
		await expect(
			wrapped.fetchJson("https://evil.example.com/", { allowedHosts: ["evil.example.com"] }),
		).rejects.toThrow(/not in the allowed host list/);
		expect(mock).not.toHaveBeenCalled();
		await expect(wrapped.fetchJson("https://api.example.com/")).resolves.toEqual({});
	});
});

describe("createFetchContext transport behavior", () => {
	it("always sends redirect: 'error' so a 3xx can never be followed", async () => {
		const mock = stubFetch(() => jsonResponse("{}"));
		const ctx = makeContext();
		await ctx.fetchJson("https://api.example.com/jobs", { redirect: "follow" });
		const init = mock.mock.calls[0]?.[1] as RequestInit | undefined;
		expect(init?.redirect).toBe("error");
		expect(init?.signal).toBeInstanceOf(AbortSignal);
	});

	it("applies a default User-Agent but lets a caller override it, whatever the capitalization", async () => {
		const mock = stubFetch(() => jsonResponse("{}"));
		const ctx = makeContext({ userAgent: "scanner-test/1.0" });
		await ctx.fetchJson("https://api.example.com/a");
		await ctx.fetchJson("https://api.example.com/b", { headers: { "User-Agent": "custom/2.0" } });
		const first = mock.mock.calls[0]?.[1] as RequestInit;
		const second = mock.mock.calls[1]?.[1] as RequestInit;
		expect(new Headers(first.headers).get("user-agent")).toBe("scanner-test/1.0");
		expect(new Headers(second.headers).get("user-agent")).toBe("custom/2.0");
	});

	it("throws HttpError with the status and Retry-After for a non-2xx response", async () => {
		stubFetch(() => new Response("slow down", { status: 429, headers: { "retry-after": "30" } }));
		const ctx = makeContext();
		const failure = await ctx.fetchJson("https://api.example.com/jobs").catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(HttpError);
		expect(failure).toMatchObject({ status: 429, retryAfter: "30" });
	});

	it("rejects a response body over the size cap", async () => {
		stubFetch(() => jsonResponse(`"${"x".repeat(2048)}"`));
		const ctx = makeContext({ maxBodyBytes: 1024 });
		await expect(ctx.fetchJson("https://api.example.com/big")).rejects.toThrow(/body cap/);
	});

	it("rejects early on a Content-Length over the cap", async () => {
		stubFetch(() => jsonResponse("{}", { headers: { "content-length": "9999999" } }));
		const ctx = makeContext({ maxBodyBytes: 1024 });
		await expect(ctx.fetchJson("https://api.example.com/big")).rejects.toThrow(/body cap/);
	});

	it("parses JSON without trusting the content-type header", async () => {
		stubFetch(() => jsonResponse('{"a":1}', { headers: { "content-type": "text/html" } }));
		const ctx = makeContext();
		await expect(ctx.fetchJson("https://api.example.com/jobs")).resolves.toEqual({ a: 1 });
	});

	it("throws a clear error for a non-JSON body", async () => {
		stubFetch(() => jsonResponse("<html>challenge</html>"));
		const ctx = makeContext();
		await expect(ctx.fetchJson("https://api.example.com/jobs")).rejects.toThrow(/not valid JSON/);
	});

	it("returns the raw body from fetchText", async () => {
		stubFetch(() => jsonResponse("| Title |"));
		const ctx = makeContext();
		await expect(ctx.fetchText("https://api.example.com/jobs.md")).resolves.toBe("| Title |");
	});
});

describe("createFetchContext per-host pacing", () => {
	it("spaces consecutive requests to the same host by paceMs, and leaves other hosts alone", async () => {
		stubFetch(() => jsonResponse("{}"));
		const sleeps: number[] = [];
		let clock = 0;
		const ctx = createFetchContext({
			resolve: publicResolve,
			paceMs: 500,
			now: () => clock,
			sleep: (ms) => {
				sleeps.push(ms);
				clock += ms;
				return Promise.resolve();
			},
		});
		await ctx.fetchJson("https://api.example.com/a");
		await ctx.fetchJson("https://api.example.com/b");
		await ctx.fetchJson("https://other.example.com/c");
		expect(sleeps).toEqual([500]);
	});
});
