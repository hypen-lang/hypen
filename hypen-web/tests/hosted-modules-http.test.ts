/**
 * Deferred HTTP (`hypen:http/deferred`) for hosted modules on a server.
 *
 *   1. `performHttpRequest` on its own, with a fake `fetch`: redirects (the
 *      rules of the native embedder, `hypen_runtime/http.rs`), the time
 *      budget, the streamed response cap, the failure kinds, the
 *      private-network rule and the app's egress policy.
 *   2. `HttpJobQueue`: bounded, ordered, never synchronous.
 *   3. A `RemoteServer` running `deferred_http_module.wasm`: the request a
 *      module queues is performed and its completion lands in module state;
 *      refusals and failures are reported with the field to change.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  MAX_HTTP_REDIRECTS,
  MAX_HTTP_RESPONSE_BODY_BYTES,
  parseHttpUrl,
} from "../packages/core/src/http";
import { HypenApp } from "../packages/core/src/app";
import type { HostedModuleDefinition, HostedModuleFailure } from "../packages/core/src/hosted-module";
import type { HostedModuleHttpEffect } from "../packages/core/src/types";
import { RemoteServer } from "../packages/server/src/remote/server";
import { HostedModuleSetupError, wasmModule, type HostedModulesOptions } from "../packages/server/src/hosted";
import {
  DEFAULT_MAX_CONCURRENT_HTTP_REQUESTS,
  HttpJobQueue,
  httpHostsNameExplicitly,
  httpTargetNetwork,
  performHttpRequest,
  type HostedFetch,
  type HostedFetchInit,
  type HostedHttpRequestContext,
  type HostedHttpRequestInfo,
  type PerformHttpOptions,
} from "../packages/server/src/hosted/http";
import { connect, eventually, failureLog, fixture, flush, hasFixtures, hasServerEngine, type Client } from "./hosted-modules-harness";

const enc = new TextEncoder();

// ── 1. one exchange ─────────────────────────────────────────────────────────

type Call = { url: string; init: HostedFetchInit };

/** A fake network: `routes[url]` answers; calls are recorded. */
function fakeFetch(routes: Record<string, (init: HostedFetchInit) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetch: HostedFetch = async (url, init) => {
    calls.push({ url, init });
    const route = routes[url];
    if (!route) throw new TypeError(`fake network: nothing listens at ${url}`);
    return route(init);
  };
  return { fetch, calls };
}

const redirect = (location: string, status = 302): Response =>
  new Response(null, { status, headers: { location } });

function effect(overrides: Partial<HostedModuleHttpEffect["request"]> = {}, allowedHosts: string[] | null = null): HostedModuleHttpEffect {
  return {
    type: "http",
    id: 1,
    request: { method: "GET", url: "https://api.example.com/start", headers: [], body: null, timeoutMs: 30_000, ...overrides },
    then: "fetched",
    tag: "t",
    allowedHosts,
  };
}

function perform(
  e: HostedModuleHttpEffect,
  fetch: HostedFetch,
  options: Partial<PerformHttpOptions> = {}
) {
  return performHttpRequest(e, {
    fetch,
    module: "Net",
    scope: "net",
    sessionId: "s1",
    privateNetwork: "block",
    redirectAllowed: () => true,
    signal: new AbortController().signal,
    ...options,
  });
}

describe("performHttpRequest", () => {
  test("a response of any status completes ok, with headers and body as received", async () => {
    const net = fakeFetch({
      "https://api.example.com/start": () =>
        new Response("nope", { status: 404, headers: { "Content-Type": "text/plain", "X-Trace": "abc" } }),
    });
    const done = await perform(effect({ method: "POST", headers: [["accept", "text/plain"]], body: enc.encode("hi") }), net.fetch);
    expect(done.url).toBe("https://api.example.com/start");
    if (!done.result.ok) throw new Error(done.result.error.message);
    expect(done.result.status).toBe(404);
    expect(new TextDecoder().decode(done.result.body as Uint8Array)).toBe("nope");
    expect(Object.fromEntries(done.result.headers as [string, string][])).toMatchObject({
      "content-type": "text/plain",
      "x-trace": "abc",
    });
    // What was sent: the module's request, manual redirects, a default UA.
    expect(net.calls).toHaveLength(1);
    const { init } = net.calls[0]!;
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(init.body).toEqual(enc.encode("hi"));
    expect(init.headers).toEqual([
      ["accept", "text/plain"],
      ["user-agent", "hypen-server"],
    ]);
  });

  test("the module's own User-Agent is kept", async () => {
    const net = fakeFetch({ "https://api.example.com/start": () => new Response("ok") });
    await perform(effect({ headers: [["User-Agent", "mine/1"]] }), net.fetch);
    expect(net.calls[0]!.init.headers).toEqual([["User-Agent", "mine/1"]]);
  });

  test("redirects are followed here, each hop checked against the module's allowlist", async () => {
    const asked: string[] = [];
    const net = fakeFetch({
      "https://api.example.com/start": () => redirect("/moved?x=1"),
      "https://api.example.com/moved?x=1": () => redirect("//cdn.example.com/a/b"),
      "https://cdn.example.com/a/b": () => redirect("c", 307),
      "https://cdn.example.com/a/c": () => new Response("landed"),
    });
    const done = await perform(effect(), net.fetch, {
      redirectAllowed: (url) => {
        asked.push(url);
        return true;
      },
    });
    expect(done.result.ok).toBe(true);
    expect(done.url).toBe("https://cdn.example.com/a/c");
    expect(asked).toEqual([
      "https://api.example.com/moved?x=1",
      "https://cdn.example.com/a/b",
      "https://cdn.example.com/a/c",
    ]);
  });

  test("a redirect to a host outside the allowlist ends the request as denied, unrequested", async () => {
    const net = fakeFetch({
      "https://api.example.com/start": () => redirect("https://evil.test/steal"),
      "https://evil.test/steal": () => new Response("secrets"),
    });
    const done = await perform(effect(), net.fetch, { redirectAllowed: (url) => !url.includes("evil.test") });
    expect(done).toEqual({
      result: {
        ok: false,
        error: {
          kind: "denied",
          message:
            "redirect from https://api.example.com/start to https://evil.test/steal refused: host " +
            "'evil.test:443' is not in the manifest's `httpHosts` allowlist",
        },
      },
      url: "https://evil.test/steal",
      refusedBy: "httpHosts",
      refusedHost: "evil.test:443",
    });
    expect(net.calls.map((c) => c.url)).toEqual(["https://api.example.com/start"]);
  });

  test(`at most ${MAX_HTTP_REDIRECTS} redirects are followed`, async () => {
    const routes: Record<string, () => Response> = {};
    for (let n = 0; n <= MAX_HTTP_REDIRECTS + 1; n++) routes[`https://api.example.com/${n}`] = () => redirect(`/${n + 1}`);
    const net = fakeFetch(routes);
    const done = await perform(effect({ url: "https://api.example.com/0" }), net.fetch);
    expect(done.result).toEqual({
      ok: false,
      error: { kind: "invalid-response", message: "more than 5 redirects (last: https://api.example.com/5)" },
    });
    expect(net.calls).toHaveLength(MAX_HTTP_REDIRECTS + 1);

    // Exactly the limit is fine.
    routes[`https://api.example.com/${MAX_HTTP_REDIRECTS}`] = () => new Response("made it");
    const within = await perform(effect({ url: "https://api.example.com/0" }), fakeFetch(routes).fetch);
    expect(within.result.ok).toBe(true);
  });

  test("a Location that is not a requestable URL is invalid-response", async () => {
    for (const location of ["javascript:alert(1)", "https://user:pw@example.com/", "http://exa mple.com/"]) {
      const net = fakeFetch({ "https://api.example.com/start": () => redirect(location) });
      const done = await perform(effect(), net.fetch);
      expect(done.result).toMatchObject({ ok: false, error: { kind: "invalid-response" } });
      if (!done.result.ok) expect(done.result.error.message).toContain("redirected to a location that cannot be requested");
    }
  });

  test("credentials stay with their origin; 303 and POST-301/302 become a body-less GET; 307/308 repeat", async () => {
    const sent = (init: HostedFetchInit) => ({
      method: init.method,
      body: init.body,
      headers: init.headers.filter(([n]) => n !== "user-agent"),
    });
    const headers: Array<[string, string]> = [
      ["Authorization", "Bearer x"],
      ["Cookie", "a=1"],
      ["Content-Type", "application/json"],
      ["X-Keep", "1"],
    ];
    const post = (status: number, location: string) => {
      const net = fakeFetch({
        "https://api.example.com/start": () => redirect(location, status),
        "https://api.example.com/next": () => new Response("same origin"),
        "https://other.example.com/next": () => new Response("cross origin"),
        "http://api.example.com/next": () => new Response("other scheme"),
      });
      return perform(effect({ method: "POST", headers, body: enc.encode("{}") }), net.fetch).then(() => sent(net.calls[1]!.init));
    };
    // Same origin, 307: the request as it was.
    expect(await post(307, "/next")).toEqual({ method: "POST", body: enc.encode("{}"), headers });
    expect(await post(308, "/next")).toEqual({ method: "POST", body: enc.encode("{}"), headers });
    // Same origin, 303 / 301 / 302 from POST: GET, no body, no content-* headers.
    for (const status of [301, 302, 303]) {
      expect(await post(status, "/next")).toEqual({
        method: "GET",
        body: null,
        headers: [
          ["Authorization", "Bearer x"],
          ["Cookie", "a=1"],
          ["X-Keep", "1"],
        ],
      });
    }
    // Another host, and the same host over another scheme: credentials dropped.
    for (const location of ["https://other.example.com/next", "http://api.example.com/next"]) {
      expect(await post(307, location)).toEqual({
        method: "POST",
        body: enc.encode("{}"),
        headers: [
          ["Content-Type", "application/json"],
          ["X-Keep", "1"],
        ],
      });
    }
    // 301/302 leave a GET (and a HEAD under 303) alone.
    const head = fakeFetch({
      "https://api.example.com/start": () => redirect("/next", 303),
      "https://api.example.com/next": () => new Response(null),
    });
    await perform(effect({ method: "HEAD" }), head.fetch);
    expect(head.calls[1]!.init.method).toBe("HEAD");
  });

  test("the time budget covers the whole exchange and aborts the fetch", async () => {
    let aborted = false;
    const fetch: HostedFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    const started = Date.now();
    const done = await perform(effect({ timeoutMs: 40 }), fetch);
    expect(done.result).toEqual({ ok: false, error: { kind: "timeout", message: "no complete response within 40 ms" } });
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("a body that stalls past the budget is a timeout too", async () => {
    const fetch: HostedFetch = async (_url, init) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(enc.encode("partial"));
            init.signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
          },
        })
      );
    const done = await perform(effect({ timeoutMs: 40 }), fetch);
    expect(done.result).toMatchObject({ ok: false, error: { kind: "timeout" } });
  });

  test("the response is capped while streaming: reading stops at the cap", async () => {
    const CHUNK = 256 * 1024;
    let pulled = 0;
    let cancelled = false;
    const endless = () =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              pulled += 1;
              controller.enqueue(new Uint8Array(CHUNK));
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 }
        )
      );
    const done = await perform(effect(), fakeFetch({ "https://api.example.com/start": endless }).fetch);
    expect(done.result).toEqual({
      ok: false,
      error: { kind: "too-large", message: `the response body exceeds ${MAX_HTTP_RESPONSE_BODY_BYTES} bytes` },
    });
    expect(cancelled).toBe(true);
    // 4 MiB / 256 KiB = 16 chunks fit; the 17th crosses the cap and is the last one read.
    expect(pulled).toBeGreaterThanOrEqual(17);
    expect(pulled).toBeLessThanOrEqual(19);
  });

  test("a body of exactly the cap is delivered; a declared length over it is refused unread", async () => {
    const atCap = await perform(
      effect(),
      fakeFetch({ "https://api.example.com/start": () => new Response(new Uint8Array(MAX_HTTP_RESPONSE_BODY_BYTES)) }).fetch
    );
    expect(atCap.result.ok && (atCap.result.body as Uint8Array).byteLength).toBe(MAX_HTTP_RESPONSE_BODY_BYTES);

    let read = false;
    const declared = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            read = true;
            controller.enqueue(new Uint8Array(1));
            controller.close();
          },
        }, { highWaterMark: 0 }),
        { headers: { "content-length": String(MAX_HTTP_RESPONSE_BODY_BYTES + 1) } }
      );
    const done = await perform(effect(), fakeFetch({ "https://api.example.com/start": declared }).fetch);
    expect(done.result).toMatchObject({ ok: false, error: { kind: "too-large" } });
    expect(read).toBe(false);
  });

  test("failures map to the contract's kinds", async () => {
    const failing = (error: unknown) => perform(effect(), async () => Promise.reject(error));
    const refused = await failing(Object.assign(new TypeError("fetch failed"), { code: "ConnectionRefused" }));
    expect(refused.result).toEqual({
      ok: false,
      error: { kind: "network", message: "requesting api.example.com failed: fetch failed" },
    });
    for (const malformed of [
      Object.assign(new Error("Parse Error: Expected HTTP/"), { code: "HPE_INVALID_CONSTANT" }),
      Object.assign(new TypeError("fetch failed"), { cause: { code: "HPE_INVALID_VERSION" } }),
      Object.assign(new Error("Malformed_HTTP_Response"), { code: "Malformed_HTTP_Response" }),
    ]) {
      expect((await failing(malformed)).result).toMatchObject({ ok: false, error: { kind: "invalid-response" } });
    }
    const midBody: HostedFetch = async () =>
      new Response(new ReadableStream<Uint8Array>({ pull: (c) => c.error(new Error("socket hang up")) }));
    expect((await perform(effect(), midBody)).result).toEqual({
      ok: false,
      error: { kind: "network", message: "reading the response from api.example.com failed: socket hang up" },
    });
  });
});

describe("the private-network rule", () => {
  const url = (s: string) => {
    const parsed = parseHttpUrl(s);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  };

  const NETWORKS: Array<[string, ReturnType<typeof httpTargetNetwork>]> = [
    ["https://api.example.com/", "public"],
    ["http://8.8.8.8/", "public"],
    ["http://[2001:4860:4860::8888]/", "public"],
    ["http://localhost:3000/", "loopback"],
    ["http://LOCALHOST/", "loopback"],
    ["http://app.localhost/", "loopback"],
    ["http://notlocalhost/", "public"],
    ["http://localhost.example.com/", "public"],
    ["http://127.0.0.1/", "loopback"],
    ["http://127.255.255.254/", "loopback"],
    ["http://[::1]/", "loopback"],
    ["http://[::ffff:127.0.0.1]/", "loopback"],
    ["http://[64:ff9b::7f00:1]/", "loopback"],
    ["http://0.0.0.0/", "unspecified"],
    ["http://[::]/", "unspecified"],
    ["http://169.254.169.254/latest/meta-data/", "linkLocal"],
    ["http://[fe80::1]/", "linkLocal"],
    ["http://[::ffff:169.254.169.254]/", "linkLocal"],
    ["http://10.0.0.5/", "private"],
    ["http://172.16.0.1/", "private"],
    ["http://172.31.255.255/", "private"],
    ["http://172.15.0.1/", "public"],
    ["http://172.32.0.1/", "public"],
    ["http://192.168.1.1/", "private"],
    ["http://192.169.1.1/", "public"],
    ["http://100.64.0.1/", "private"],
    ["http://100.128.0.1/", "public"],
    ["http://[fd00::1]/", "private"],
    ["http://[fc00::1]/", "private"],
    ["http://[fec0::1]/", "private"],
    ["http://[::ffff:10.1.2.3]/", "private"],
  ];
  for (const [target, network] of NETWORKS) {
    test(`${target} is ${network}`, () => {
      expect(httpTargetNetwork(url(target))).toBe(network);
    });
  }

  test("only an exact httpHosts entry names a host explicitly", () => {
    const local = url("http://127.0.0.1:8080/x");
    expect(httpHostsNameExplicitly(null, local)).toBe(false);
    expect(httpHostsNameExplicitly([], local)).toBe(false);
    expect(httpHostsNameExplicitly(["127.0.0.1"], local)).toBe(true);
    expect(httpHostsNameExplicitly(["127.0.0.1:8080"], local)).toBe(true);
    expect(httpHostsNameExplicitly(["127.0.0.1:9090"], local)).toBe(false);
    expect(httpHostsNameExplicitly(["api.example.com"], local)).toBe(false);
    expect(httpHostsNameExplicitly(["*.localhost"], url("http://app.localhost/"))).toBe(false);
    expect(httpHostsNameExplicitly(["app.localhost"], url("http://app.localhost/"))).toBe(true);
    expect(httpHostsNameExplicitly(["[0:0:0:0:0:0:0:1]"], url("http://[::1]:9/"))).toBe(true);
  });

  test("by default a request into the server's own network is denied before any fetch", async () => {
    for (const [target, what] of [
      ["http://127.0.0.1:8080/admin", "a loopback address"],
      ["http://localhost/", "a loopback address"],
      ["http://169.254.169.254/latest/meta-data/", "a link-local address"],
      ["http://10.0.0.5:5432/", "a private-network address"],
      ["http://[fd00::1]/", "a private-network address"],
      ["http://0.0.0.0/", "an unspecified address"],
    ] as const) {
      const net = fakeFetch({});
      const done = await perform(effect({ url: target }), net.fetch);
      const parsed = url(target);
      expect(done).toEqual({
        result: {
          ok: false,
          error: {
            kind: "denied",
            message:
              `request to ${parsed.host}:${parsed.port} refused: it is ${what}, which a hosted module on a ` +
              "server may only reach when its `httpHosts` names that host",
          },
        },
        url: parsed.href,
        refusedBy: "privateNetwork",
        refusedHost: `${parsed.host}:${parsed.port}`,
      });
      expect(net.calls).toEqual([]);
    }
  });

  test("naming the host in httpHosts, or privateNetwork: allow, lets it through", async () => {
    const routes = { "http://127.0.0.1:8080/health": () => new Response("up") };
    const named = await perform(effect({ url: "http://127.0.0.1:8080/health" }, ["127.0.0.1:8080"]), fakeFetch(routes).fetch);
    expect(named.result.ok).toBe(true);
    const allowed = await perform(effect({ url: "http://127.0.0.1:8080/health" }), fakeFetch(routes).fetch, {
      privateNetwork: "allow",
    });
    expect(allowed.result.ok).toBe(true);
    // An any-host grant is not a decision about the server's own network.
    const anyHost = await perform(effect({ url: "http://127.0.0.1:8080/health" }, null), fakeFetch(routes).fetch);
    expect(anyHost.refusedBy).toBe("privateNetwork");
  });

  test("a public URL that redirects into the private network is stopped at the hop", async () => {
    const net = fakeFetch({
      "https://api.example.com/start": () => redirect("http://169.254.169.254/latest/meta-data/"),
      "http://169.254.169.254/latest/meta-data/": () => new Response("credentials"),
    });
    const done = await perform(effect(), net.fetch);
    expect(done.refusedBy).toBe("privateNetwork");
    expect(done.result).toMatchObject({ ok: false, error: { kind: "denied" } });
    if (!done.result.ok) expect(done.result.error.message).toStartWith("redirect to 169.254.169.254:80 refused");
    expect(net.calls.map((c) => c.url)).toEqual(["https://api.example.com/start"]);
  });
});

describe("the app's egress policy (onHttpRequest)", () => {
  test("it sees every hop and can refuse one with a reason", async () => {
    const seen: Array<[HostedHttpRequestInfo, HostedHttpRequestContext]> = [];
    const net = fakeFetch({
      "https://api.example.com/start": () => redirect("https://billing.example.com/charge", 307),
      "https://billing.example.com/charge": () => new Response("charged"),
    });
    const done = await perform(effect({ method: "POST" }, ["*.example.com"]), net.fetch, {
      policy: (request, context) => {
        seen.push([request, context]);
        return request.host === "billing.example.com" ? { deny: "billing is off limits for modules" } : "allow";
      },
    });
    expect(seen.map(([r]) => r)).toEqual([
      { module: "Net", scope: "net", method: "POST", url: "https://api.example.com/start", scheme: "https", host: "api.example.com", port: 443, network: "public", hop: 0 },
      { module: "Net", scope: "net", method: "POST", url: "https://billing.example.com/charge", scheme: "https", host: "billing.example.com", port: 443, network: "public", hop: 1 },
    ]);
    expect(seen[0]![1]).toEqual({ sessionId: "s1", allowedHosts: ["*.example.com"], then: "fetched", tag: "t" });
    expect(done.refusedBy).toBe("policy");
    expect(done.result).toEqual({
      ok: false,
      error: {
        kind: "denied",
        message: "redirect to billing.example.com:443 refused by the server's egress policy: billing is off limits for modules",
      },
    });
    expect(net.calls.map((c) => c.url)).toEqual(["https://api.example.com/start"]);
  });

  test("it cannot widen: the private-network rule runs first and the policy is not asked", async () => {
    let asked = 0;
    const done = await perform(effect({ url: "http://10.0.0.5/" }), fakeFetch({}).fetch, {
      policy: () => {
        asked += 1;
        return "allow";
      },
    });
    expect(done.refusedBy).toBe("privateNetwork");
    expect(asked).toBe(0);
  });

  test("a policy that throws, or answers nonsense, denies", async () => {
    const thrown = await perform(effect(), fakeFetch({}).fetch, {
      policy: () => {
        throw new Error("policy db down");
      },
    });
    expect(thrown.result).toEqual({
      ok: false,
      error: { kind: "denied", message: "the server's egress policy failed for api.example.com:443: policy db down" },
    });
    const nonsense = await perform(effect(), fakeFetch({}).fetch, {
      policy: (() => undefined) as unknown as PerformHttpOptions["policy"],
    });
    expect(nonsense.result).toMatchObject({ ok: false, error: { kind: "denied" } });
  });
});

// ── 2. the queue ────────────────────────────────────────────────────────────

describe("HttpJobQueue", () => {
  test("runs at most `limit` jobs at a time, in order, never synchronously", async () => {
    const queue = new HttpJobQueue(2);
    const started: number[] = [];
    const release: Array<() => void> = [];
    let peak = 0;
    for (let n = 0; n < 5; n++) {
      queue.push(async () => {
        started.push(n);
        peak = Math.max(peak, queue.active);
        await new Promise<void>((done) => release.push(done));
      });
    }
    expect(started).toEqual([]); // nothing starts inside push()
    await flush(1);
    expect(started).toEqual([0, 1]);
    expect(queue.queued).toBe(3);
    release.shift()!();
    await flush(1);
    expect(started).toEqual([0, 1, 2]);
    while (release.length) {
      release.shift()!();
      await flush(1);
    }
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
    expect(queue.active).toBe(0);
  });

  test("stop() drops what has not started and accepts nothing more", async () => {
    const queue = new HttpJobQueue(1);
    const started: number[] = [];
    let finish = () => {};
    queue.push(async () => {
      started.push(0);
      await new Promise<void>((done) => (finish = done));
    });
    queue.push(async () => void started.push(1));
    await flush(1);
    queue.stop();
    queue.push(async () => void started.push(2));
    finish();
    await flush(5);
    expect(started).toEqual([0]);
  });

  test("a job that rejects does not stall the queue", async () => {
    const queue = new HttpJobQueue(1);
    const started: number[] = [];
    queue.push(async () => {
      throw new Error("boom");
    });
    queue.push(async () => void started.push(1));
    await flush(5);
    expect(started).toEqual([1]);
  });
});

// ── 3. through a RemoteServer ───────────────────────────────────────────────

const skip = !hasServerEngine || !hasFixtures("deferred_http_module.wasm");

const NET_UI = `Column {
  Text("Completions: @{state.completions}")
  Text("Body: @{state.last.body}")
}`;

const net = (grants: Parameters<typeof wasmModule>[0]["grants"] = { http: true }, extra: Partial<Parameters<typeof wasmModule>[0]> = {}): HostedModuleDefinition =>
  wasmModule({ name: "Net", component: fixture("deferred_http_module.wasm"), ui: NET_UI, grants, ...extra });

type Runtime = {
  dispatch(scope: string, action: string, payload: unknown): Promise<void>;
  pendingHttpRequests(scope: string): number;
};
const runtimeOf = (client: Client): Runtime => client.session.hostedModules as unknown as Runtime;

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function boot(modules: HostedModuleDefinition[], options: HostedModulesOptions = {}) {
  const app = new HypenApp();
  const entry = app.module("App").defineState({ ready: true }).ui(`module App { Column { Net {} } }`);
  const log = failureLog();
  const server = new RemoteServer().app(app).module("App", entry).wasmModules(modules).hostedModules({ onError: log.onError, ...options });
  await server.prepare();
  const client = await connect(server);
  cleanups.push(() => client.close());
  return { server, client, runtime: runtimeOf(client), failures: log.failures };
}

describe("wasmModule({ grants: { httpHosts } })", () => {
  const setupError = (run: () => unknown): HostedModuleSetupError => {
    try {
      run();
    } catch (err) {
      if (err instanceof HostedModuleSetupError) return err;
      throw err;
    }
    throw new Error("expected a HostedModuleSetupError");
  };

  test.skipIf(skip)("patterns are validated and stored canonically", () => {
    const definition = net({ http: true, httpHosts: ["API.Example.com", "*.example.org:8443", "api.example.com"] });
    expect(definition.hosted.grants).toMatchObject({ http: true, httpHosts: ["api.example.com", "*.example.org:8443"] });
    expect(net({ http: true }).hosted.grants.httpHosts).toEqual([]);
    expect(net({}).hosted.grants).toMatchObject({ http: false, httpHosts: [] });
  });

  test.skipIf(skip)("a malformed pattern, a wrong shape and an allowlist without http are setup errors naming the field", () => {
    const pattern = setupError(() => net({ http: true, httpHosts: ["https://api.example.com/v1"] }));
    expect(pattern).toMatchObject({ code: "INVALID_OPTIONS", module: "Net", field: 'wasmModule({ name: "Net" }).grants.httpHosts' });
    expect(pattern.message).toContain("invalid host pattern 'https://api.example.com/v1'");
    expect(pattern.message).toContain("drop the scheme");
    expect(pattern.hint).toContain('"*.example.com"');

    const shape = setupError(() => net({ http: true, httpHosts: "api.example.com" as unknown as string[] }));
    expect(shape).toMatchObject({ code: "INVALID_OPTIONS", field: 'wasmModule({ name: "Net" }).grants.httpHosts' });

    const withoutHttp = setupError(() => net({ httpHosts: ["api.example.com"] }));
    expect(withoutHttp).toMatchObject({ code: "INVALID_OPTIONS", field: 'wasmModule({ name: "Net" }).grants.httpHosts' });
    expect(withoutHttp.message).toContain("narrows the `http` grant");
    expect(withoutHttp.hint).toBe('set wasmModule({ name: "Net" }).grants.http to true, or remove httpHosts');
  });

  test.skipIf(skip)("a module importing hypen:http/deferred without the grant stops the server at prepare()", async () => {
    const app = new HypenApp();
    const entry = app.module("App").defineState({}).ui(`module App { Column { Net {} } }`);
    const server = new RemoteServer().app(app).module("App", entry).wasmModules([net({})]);
    const error = await server.prepare().then(
      () => null,
      (err: unknown) => err as HostedModuleSetupError
    );
    expect(error).toMatchObject({
      code: "UNGRANTED_IMPORT",
      module: "Net",
      field: 'wasmModule({ name: "Net" }).grants.http',
    });
    expect(error?.message).toBe('Hosted module "Net" imports hypen:http/deferred, which it has not been granted.');
    expect(error?.hint).toContain('set wasmModule({ name: "Net" }).grants.http to true');
  });
});

describe.skipIf(skip)("hosted modules: deferred HTTP on a server", () => {
  test("a queued request is fetched and its completion lands in module state, from a later turn", async () => {
    const network = fakeFetch({
      "https://api.example.com/hello": () => new Response("hello from the fake", { headers: { "content-type": "text/plain" } }),
    });
    const { client, runtime, failures } = await boot([net()], { fetch: network.fetch });

    await runtime.dispatch("net", "get", { url: "https://api.example.com/hello", tag: "one" });
    // The dispatch returned with the request queued and nothing completed:
    // the effect handler never calls the engine synchronously.
    expect(client.state("net")).toMatchObject({ queued: 1, completions: 0 });
    expect(runtime.pendingHttpRequests("net")).toBe(1);

    await eventually(() => expect(client.state("net").completions).toBe(1));
    expect(client.state("net").last).toEqual({
      ok: true,
      status: 200,
      body: "hello from the fake",
      bodyEncoding: "utf8",
      contentType: "text/plain",
      tag: "one",
    });
    expect(runtime.pendingHttpRequests("net")).toBe(0);
    await flush();
    expect(client.texts()).toContain("Body: hello from the fake");
    expect(failures).toEqual([]);
  });

  test("a completion handler can queue the next request (chained)", async () => {
    const network = fakeFetch({
      "https://a.example.com/first": () => new Response("1"),
      "https://b.example.com/second": () => new Response(new Uint8Array([0xff, 0x00]), { status: 503 }),
    });
    const { client, runtime, failures } = await boot([net()], { fetch: network.fetch });
    await runtime.dispatch("net", "get", { url: "https://a.example.com/first", tag: "one", next: "https://b.example.com/second" });
    await eventually(() => expect(client.state("net").completions).toBe(2));
    expect(client.state("net").log).toEqual(['"one":200', '"chained":503']);
    expect(client.state("net").last).toMatchObject({ status: 503, body: "/wA=", bodyEncoding: "base64" });
    expect(failures).toEqual([]);
  });

  test("the module's httpHosts reach the engine and the host: refused at send, nothing fetched", async () => {
    const network = fakeFetch({});
    const { client, runtime, failures } = await boot([net({ http: true, httpHosts: ["*.example.com"] })], { fetch: network.fetch });
    await runtime.dispatch("net", "get", { url: "https://evil.test/" });
    expect(client.state("net").sendError).toBe(
      "permission-denied: host 'evil.test:443' is not in the manifest's `httpHosts` allowlist"
    );
    await flush();
    expect(network.calls).toEqual([]);
    expect(failures).toEqual([]);
  });

  test("a redirect out of the allowlist is asked of the engine, denied, and reported with the field to change", async () => {
    const network = fakeFetch({
      "https://api.example.com/go": () => redirect("https://evil.test/landing"),
      "https://evil.test/landing": () => new Response("should never be read"),
    });
    const { client, runtime, failures } = await boot([net({ http: true, httpHosts: ["*.example.com"] })], { fetch: network.fetch });
    await runtime.dispatch("net", "get", { url: "https://api.example.com/go", tag: "r" });
    await eventually(() => expect(client.state("net").completions).toBe(1));
    expect(client.state("net").last).toMatchObject({ ok: false, error: "denied", tag: "r" });
    expect(network.calls.map((c) => c.url)).toEqual(["https://api.example.com/go"]);
    await flush();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      kind: "http",
      module: "Net",
      scope: "net",
      action: "fetched",
      missingGrant: { field: "httpHosts", value: "evil.test:443" },
      http: { method: "GET", url: "https://evil.test/landing", errorKind: "denied", refusedBy: "httpHosts" },
    });
    expect(failures[0]!.hint).toContain('add "evil.test:443" to wasmModule({ name: "Net" }).grants.httpHosts');
  });

  test("the private-network default: denied to the module, reported with both ways out", async () => {
    const network = fakeFetch({ "http://127.0.0.1:9/admin": () => new Response("internal") });
    const { client, runtime, failures } = await boot([net()], { fetch: network.fetch });
    await runtime.dispatch("net", "get", { url: "http://127.0.0.1:9/admin" });
    await eventually(() => expect(client.state("net").completions).toBe(1));
    expect(client.state("net").last).toMatchObject({ ok: false, error: "denied" });
    expect(client.state("net").last.message).toContain("request to 127.0.0.1:9 refused: it is a loopback address");
    expect(network.calls).toEqual([]);
    await flush();
    expect(failures).toHaveLength(1);
    const failure: HostedModuleFailure = failures[0]!;
    expect(failure).toMatchObject({
      kind: "http",
      missingGrant: { field: "httpHosts", value: "127.0.0.1:9" },
      http: { errorKind: "denied", refusedBy: "policy" },
    });
    expect(failure.message).toStartWith("GET http://127.0.0.1:9/admin refused (denied): ");
    expect(failure.hint).toContain('add "127.0.0.1:9" to wasmModule({ name: "Net" }).grants.httpHosts');
    expect(failure.hint).toContain('hostedModules({ privateNetwork: "allow" })');
  });

  test("a real request to a local server works once the module's httpHosts names it", async () => {
    const hits: string[] = [];
    const target = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        hits.push(`${request.method} ${path} ua=${request.headers.get("user-agent")}`);
        if (path === "/old") return Response.redirect(`http://127.0.0.1:${target.port}/new`, 302);
        return Response.json({ greeting: "hello", path });
      },
    });
    cleanups.push(() => target.stop(true));
    const { client, runtime, failures } = await boot([net({ http: true, httpHosts: [`127.0.0.1:${target.port}`] })]);
    await runtime.dispatch("net", "get", { url: `http://127.0.0.1:${target.port}/old`, tag: "real" });
    await eventually(() => expect(client.state("net").completions).toBe(1));
    expect(client.state("net").last).toMatchObject({
      ok: true,
      status: 200,
      body: '{"greeting":"hello","path":"/new"}',
      bodyEncoding: "utf8",
      tag: "real",
    });
    expect(hits).toEqual(["GET /old ua=hypen-server", "GET /new ua=hypen-server"]);
    expect(failures).toEqual([]);
  });

  test("a timeout completes as `timeout` and is reported with the budget", async () => {
    const stalled: HostedFetch = (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    const { client, runtime, failures } = await boot([net()], { fetch: stalled });
    await runtime.dispatch("net", "get", { url: "https://slow.example.com/", timeoutMs: 50 });
    await eventually(() => expect(client.state("net").completions).toBe(1));
    expect(client.state("net").last).toMatchObject({
      ok: false,
      error: "timeout",
      message: "no complete response within 50 ms",
    });
    await flush();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ kind: "http", http: { errorKind: "timeout" } });
    expect(failures[0]!.message).toBe("GET https://slow.example.com/ failed (timeout): no complete response within 50 ms");
    expect(failures[0]!.hint).toContain("50 ms");
  });

  test("the app's egress hook is asked, with the module and session, and its refusal reaches the module", async () => {
    const asked: HostedHttpRequestInfo[] = [];
    const network = fakeFetch({ "https://ok.example.com/": () => new Response("fine") });
    const { client, runtime, failures } = await boot([net()], {
      fetch: network.fetch,
      onHttpRequest: (request, context) => {
        asked.push(request);
        expect(context.sessionId).toBe(client.session.sessionId!);
        return request.host === "ok.example.com" ? "allow" : { deny: "not on the company list" };
      },
    });
    await runtime.dispatch("net", "get", { url: "https://ok.example.com/" });
    await runtime.dispatch("net", "get", { url: "https://other.example.net/" });
    await eventually(() => expect(client.state("net").completions).toBe(2));
    expect(asked.map((r) => [r.module, r.scope, r.host, r.hop])).toEqual([
      ["Net", "net", "ok.example.com", 0],
      ["Net", "net", "other.example.net", 0],
    ]);
    // The refusal needs no network, so it may complete first.
    expect([...client.state("net").log].sort()).toEqual(['null:"denied"', "null:200"]);
    await flush();
    expect(failures).toHaveLength(1);
    expect(failures[0]!.message).toContain("refused by the server's egress policy: not on the company list");
    expect(failures[0]!.hint).toContain("hostedModules({ onHttpRequest })");
  });

  test(`at most ${DEFAULT_MAX_CONCURRENT_HTTP_REQUESTS} exchanges run at once per session; the rest wait in order`, async () => {
    const order: string[] = [];
    const release: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    const slow: HostedFetch = async (url) => {
      order.push(url);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((done) => release.push(done));
      active -= 1;
      return new Response("ok");
    };
    const { client, runtime } = await boot([net()], { fetch: slow });
    await runtime.dispatch("net", "flood", { url: "https://api.example.com/f", count: 12 });
    expect(client.state("net").accepted).toBe(12);
    await flush(30);
    expect(order).toHaveLength(DEFAULT_MAX_CONCURRENT_HTTP_REQUESTS);
    expect(runtime.pendingHttpRequests("net")).toBe(12);
    while (client.state("net").completions < 12) {
      release.shift()?.();
      await flush(5);
    }
    expect(peak).toBe(DEFAULT_MAX_CONCURRENT_HTTP_REQUESTS);
    // Completions arrive in the order the requests were queued.
    expect(client.state("net").log).toEqual(Array.from({ length: 12 }, (_, n) => `"flood-${n}":200`));
  });

  test("maxConcurrentHttpRequests bounds it lower", async () => {
    let active = 0;
    let peak = 0;
    const slow: HostedFetch = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await flush(5);
      active -= 1;
      return new Response("ok");
    };
    const { client, runtime } = await boot([net()], { fetch: slow, maxConcurrentHttpRequests: 2 });
    await runtime.dispatch("net", "flood", { url: "https://api.example.com/f", count: 6 });
    await eventually(() => expect(client.state("net").completions).toBe(6));
    expect(peak).toBe(2);
  });

  test("ending the session aborts what is in flight and completes nothing", async () => {
    const signals: AbortSignal[] = [];
    const stalled: HostedFetch = (_url, init) => {
      signals.push(init.signal);
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    };
    const { client, runtime, failures } = await boot([net()], { fetch: stalled });
    await runtime.dispatch("net", "flood", { url: "https://api.example.com/f", count: 10 });
    await flush(20);
    expect(signals).toHaveLength(DEFAULT_MAX_CONCURRENT_HTTP_REQUESTS);
    await client.close();
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(runtime.pendingHttpRequests("net")).toBe(0);
    await flush(50);
    // The two that were still queued never started; nothing was reported.
    expect(signals).toHaveLength(DEFAULT_MAX_CONCURRENT_HTTP_REQUESTS);
    expect(failures).toEqual([]);
  });

  test("a failing completion action is reported as that action's failure", async () => {
    const network = fakeFetch({ "https://api.example.com/x": () => new Response("x") });
    const { runtime, failures } = await boot([net()], { fetch: network.fetch });
    // `then` is not one of the module's actions: refused when the reducer returns.
    await runtime.dispatch("net", "bad", { case: "then", url: "https://api.example.com/x" }).catch(() => {});
    await flush(30);
    expect(network.calls).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ kind: "cascade", scope: "net" });
    expect(failures[0]!.hint).toContain('completion action "not-an-action" it does not handle');
  });

  test("the engine's in-flight cap is reported with what to do", async () => {
    const stalled: HostedFetch = (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    const { client, runtime, failures } = await boot([net()], { fetch: stalled });
    const engine = (client.session as unknown as { engine: { setModuleHttpInFlightLimit(n: number): void; moduleHttpInFlightLimit(): number } }).engine;
    expect(engine.moduleHttpInFlightLimit()).toBe(32);
    engine.setModuleHttpInFlightLimit(1);
    await runtime.dispatch("net", "get", { url: "https://api.example.com/1" });
    await runtime.dispatch("net", "get", { url: "https://api.example.com/2", tag: "over" }).catch(() => {});
    await flush(30);
    expect(client.state("net").last).toMatchObject({ ok: false, error: "denied", tag: "over" });
    expect(failures).toHaveLength(1);
    expect(failures[0]!.report?.failures[0]?.cause).toEqual({ code: "httpLimit", limit: 1, per: "module" });
    expect(failures[0]!.hint).toContain("already has 1 requests in flight");
  });
});
