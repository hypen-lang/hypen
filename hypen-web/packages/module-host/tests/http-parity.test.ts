/**
 * Parity of `src/http.ts` with its Rust original,
 * `hypen-engine-rs/src/module_host/http.rs`.
 *
 * WHERE THE CASES COME FROM. Every table below is transcribed from the
 * `#[cfg(test)] mod tests` at the bottom of that Rust file (the Rust test
 * name is given above each table), plus `wasmtime/deferred_http.rs`'s unit
 * tests for the per-call queue. When a Rust test gains or changes a case,
 * mirror it here: the two implementations answer the same guest, and the
 * engine re-validates with the Rust one whatever this one accepted.
 *
 * The bounds are not transcribed: the last test reads the `pub const
 * MAX_HTTP_*` lines out of the Rust source (when the monorepo is present)
 * and compares each with the constant exported here, so a bound changed on
 * one side only fails the suite.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as http from "../src/http.ts";
import {
  DeferredHttpQueue,
  base64Encode,
  checkHttpAuthority,
  checkHttpGrant,
  effectiveTimeoutMs,
  formatHostPattern,
  formatHttpDenial,
  hostPatternMatches,
  httpCompletionPayload,
  httpGrantOf,
  joinHttpUrl,
  parseHostPattern,
  parseHttpUrl,
  validateQueuedHttpRequest,
  type HostPattern,
  type HttpGrant,
  type HttpUrl,
  type QueuedHttpRequest,
} from "../src/http.ts";
import { REPO_ROOT } from "./_fixtures.ts";

const url = (s: string): HttpUrl => {
  const parsed = parseHttpUrl(s);
  if (!parsed.ok) throw new Error(`${s}: ${parsed.error}`);
  return parsed.value;
};
const pattern = (s: string): HostPattern => {
  const parsed = parseHostPattern(s);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};
const queued = (method: string, target: string): QueuedHttpRequest => ({
  request: { method, url: target, headers: [], body: null, timeoutMs: null },
  then: "done",
  tag: null,
});

describe("HttpUrl (http.rs tests)", () => {
  // urls_parse_into_scheme_host_port_and_target
  test("urls parse into scheme, host, port and target", () => {
    const u = url("HTTPS://API.Example.com/v1/items?q=a%20b&x[]=1#frag");
    expect(u.scheme).toBe("https");
    expect([u.host, u.port]).toEqual(["api.example.com", 443]);
    expect(u.pathAndQuery).toBe("/v1/items?q=a%20b&x[]=1");
    expect(u.authority).toBe("api.example.com");
    expect(u.href).toBe("https://api.example.com/v1/items?q=a%20b&x[]=1");

    const local = url("http://localhost:8080");
    expect([local.host, local.port, local.pathAndQuery]).toEqual(["localhost", 8080, "/"]);
    expect(local.authority).toBe("localhost:8080");
    expect(url("http://h?x=1").pathAndQuery).toBe("/?x=1");
    expect(url("http://h:80/").authority).toBe("h");

    const v6 = url("http://[0:0:0:0:0:0:0:1]:9/x");
    expect([v6.host, v6.port]).toEqual(["[::1]", 9]);
    expect(v6.ip).toEqual({ version: 6, segments: [0, 0, 0, 0, 0, 0, 0, 1] });
    expect(url("http://127.0.0.1/").host).toBe("127.0.0.1");
    expect(url("http://127.0.0.1/").ip).toEqual({ version: 4, octets: [127, 0, 0, 1] });
    expect(url("http://example.com/").ip).toBeNull();
  });

  // urls_another_parser_could_read_differently_are_refused
  const REFUSED = [
    "",
    "example.com/path",
    "ftp://example.com/",
    "file:///etc/passwd",
    "http://",
    "http:///path",
    "http://user:pw@example.com/",
    "http://example.com\\@evil.com/",
    "http://exa mple.com/",
    "http://example.com/a b",
    "http://example.com/\u{e9}",
    "http://ex\u{e4}mple.com/",
    "http://example.com:0/",
    "http://example.com:/",
    "http://example.com:99999/",
    "http://example.com:8a/",
    "http://.example.com/",
    "http://example..com/",
    "http://example.com./",
    "http://exa%6dple.com/",
    "http://[::1/",
    "http://[::1]x/",
    "http://[fe80::1%25eth0]/",
    // Numeric hosts other than a canonical dotted quad.
    "http://2130706433/",
    "http://127.1/",
    "http://0x7f.0.0.1/",
    "http://0177.0.0.1/",
    'http://example.com/a"b',
    "http://example.com/<x>",
    "http://example.com/\r\nHost: evil",
  ];
  for (const bad of REFUSED) {
    test(`refuses ${JSON.stringify(bad)}`, () => {
      const parsed = parseHttpUrl(bad);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toStartWith("invalid url: ");
    });
  }
  test("a URL with credentials points at the Authorization header", () => {
    const parsed = parseHttpUrl("http://user@example.com/");
    expect(!parsed.ok && parsed.error).toContain("Authorization header");
  });

  // Not in the Rust tests by name: `Ipv4Addr` / `Ipv6Addr` (`std::net`)
  // parsing and `Display`, which the Rust parser inherits and this port
  // re-implements. The expected column is what `HttpUrl::parse(..).host()`
  // printed for each input when this table was written.
  const IP_HOSTS: Array<[input: string, host: string | null]> = [
    ["[::]", "[::]"],
    ["[::1]", "[::1]"],
    ["[2001:DB8::1]", "[2001:db8::1]"],
    ["[2001:db8:0:0:1:0:0:1]", "[2001:db8::1:0:0:1]"],
    ["[1:0:0:2:0:0:0:3]", "[1:0:0:2::3]"],
    ["[1:2:3:4:5:6:7:0]", "[1:2:3:4:5:6:7:0]"],
    ["[1:2:3:4:5:6:7::]", "[1:2:3:4:5:6:7:0]"],
    ["[::ffff:10.0.0.1]", "[::ffff:10.0.0.1]"],
    ["[::ffff:a00:1]", "[::ffff:10.0.0.1]"],
    ["[::10.0.0.1]", "[::a00:1]"],
    ["[1:2:3:4:5:6:1.2.3.4]", "[1:2:3:4:5:6:102:304]"],
    ["[1:2:3:4:5:6:7::8]", null],
    ["[1::2::3]", null],
    ["[:::1]", null],
    ["[12345::1]", null],
    ["[1:2:3:4:5:6:7]", null],
    ["[1.2.3.4::1]", null],
    ["[::1.2.3]", null],
    ["[::01.2.3.4]", null],
    ["[g::1]", null],
    ["[]", null],
    ["0.0.0.0", "0.0.0.0"],
    ["255.255.255.255", "255.255.255.255"],
    ["256.1.1.1", null],
    ["1.2.3", null],
    ["1.2.3.4.5", null],
    ["01.2.3.4", null],
    ["a.1", null],
    ["1.2.3.0x4", null],
    // A hex-looking last label that is not `0x…` is an ordinary name.
    ["ab.cd", "ab.cd"],
    ["x.0xg", "x.0xg"],
  ];
  for (const [input, host] of IP_HOSTS) {
    test(`host ${input} -> ${host ?? "refused"}`, () => {
      const parsed = parseHttpUrl(`http://${input}/`);
      expect(parsed.ok ? parsed.value.host : null).toBe(host);
    });
  }

  // redirect_locations_resolve_against_the_current_url
  test("redirect locations resolve against the current url", () => {
    const base = url("https://a.example.com:8443/dir/page?q=1");
    const to = (location: string): string => {
      const joined = joinHttpUrl(base, location);
      if (!joined.ok) throw new Error(joined.error);
      return joined.value.href;
    };
    expect(to("http://b.example.com/x")).toBe("http://b.example.com/x");
    expect(to("//c.example.com/y")).toBe("https://c.example.com/y");
    expect(to("/root?z=2")).toBe("https://a.example.com:8443/root?z=2");
    expect(to("other")).toBe("https://a.example.com:8443/dir/other");
    expect(to("?p=3")).toBe("https://a.example.com:8443/dir/page?p=3");
    expect(to("#top")).toBe("https://a.example.com:8443/dir/page?q=1");
    expect(to("  /spaced\t")).toBe("https://a.example.com:8443/spaced");
    expect(joinHttpUrl(base, "").ok).toBe(false);
    expect(joinHttpUrl(base, "javascript:alert(1)").ok).toBe(false);
    expect(joinHttpUrl(base, "//user@evil.com/").ok).toBe(false);
  });
});

describe("HostPattern (http.rs tests)", () => {
  // host_patterns_match_exact_hosts_subdomains_and_ports
  const MATCHES: Array<[pattern: string, host: string, port: number, matches: boolean, why?: string]> = [
    ["API.example.com", "api.example.com", 443, true],
    ["API.example.com", "api.example.com", 8080, true],
    ["API.example.com", "example.com", 443, false],
    ["API.example.com", "x.api.example.com", 443, false],
    ["*.example.com", "a.example.com", 80, true],
    ["*.example.com", "a.b.example.com", 80, true],
    ["*.example.com", "example.com", 80, false, "the apex is not a subdomain"],
    ["*.example.com", "badexample.com", 80, false, "matches whole labels only"],
    ["*.example.com", "example.com.evil.net", 80, false],
    ["*.example.com:8443", "a.example.com", 8443, true],
    ["*.example.com:8443", "a.example.com", 443, false],
    ["127.0.0.1:8080", "127.0.0.1", 8080, true],
    ["[0:0:0:0:0:0:0:1]:9", "[::1]", 9, true],
    ["[::1]", "[::1]", 1234, true],
  ];
  for (const [p, host, port, matches, why] of MATCHES) {
    test(`${p} ${matches ? "matches" : "does not match"} ${host}:${port}${why ? ` (${why})` : ""}`, () => {
      expect(hostPatternMatches(pattern(p), host, port)).toBe(matches);
    });
  }
  test("patterns round-trip through their canonical text", () => {
    for (const text of ["api.example.com", "*.example.com:8443", "[::1]:9", "10.0.0.1"]) {
      expect(formatHostPattern(pattern(text))).toBe(text);
    }
    // serde: `*.Example.com:1` serializes as `*.example.com:1`.
    expect(formatHostPattern(pattern("*.Example.com:1"))).toBe("*.example.com:1");
  });

  // malformed_host_patterns_say_what_is_wrong
  const MALFORMED: Array<[pattern: string, hint: string]> = [
    ["", "empty"],
    ["https://example.com", "drop the scheme"],
    ["example.com/api", "drop the path"],
    ["user@example.com", "drop the path"],
    ["*", "leave the allowlist empty"],
    ["ex*mple.com", "whole first label"],
    ["*.*.example.com", "not a host name"],
    ["*.127.0.0.1", "not an address"],
    ["example.com:http", "not a port"],
    ["example.com:0", "not a port"],
    ["exa mple.com", "not a host name"],
    ["[::1", "unterminated"],
  ];
  for (const [bad, hint] of MALFORMED) {
    test(`${JSON.stringify(bad)} is refused: ${hint}`, () => {
      const parsed = parseHostPattern(bad);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.error).toContain(hint);
      expect(parsed.error).toStartWith(`invalid host pattern '`);
      expect(parsed.error).toEndWith("(expected `host`, `*.domain`, or either with `:port`)");
    });
  }
});

describe("HttpGrant (http.rs tests)", () => {
  const hosts: HttpGrant = { kind: "hosts", patterns: [pattern("*.example.com"), pattern("localhost:3000")] };

  // grants_check_the_parsed_url
  test("grants check the parsed url", () => {
    const target = url("https://api.example.com/x");
    expect(checkHttpGrant({ kind: "denied" }, target)).toEqual({ kind: "notGranted" });
    expect(checkHttpGrant({ kind: "anyHost" }, target)).toBeNull();
    expect(checkHttpGrant(hosts, target)).toBeNull();
    expect(checkHttpGrant(hosts, url("http://localhost:3000/"))).toBeNull();
    expect(checkHttpGrant(hosts, url("http://localhost/"))).toEqual({ kind: "hostNotAllowed", host: "localhost:80" });
    const denial = checkHttpGrant(hosts, url("https://evil.test/"));
    expect(denial && formatHttpDenial(denial)).toBe(
      "host 'evil.test:443' is not in the manifest's `httpHosts` allowlist",
    );
    expect(formatHttpDenial({ kind: "notGranted" })).toBe("the manifest does not grant `http`");

    // The wasi:http path canonicalizes before matching and, under an
    // allowlist, fails closed; without one nothing is second-guessed.
    expect(checkHttpAuthority(hosts, "API.Example.com", 443)).toBeNull();
    expect(checkHttpAuthority(hosts, "not a host", 443)).not.toBeNull();
    expect(checkHttpAuthority(hosts, "", 443)).not.toBeNull();
    expect(checkHttpAuthority({ kind: "anyHost" }, "example.com.", 80)).toBeNull();
    expect(checkHttpAuthority({ kind: "anyHost" }, "", 80)).toBeNull();
    expect(checkHttpAuthority({ kind: "denied" }, "x", 1)).toEqual({ kind: "notGranted" });
  });

  // ModuleManifest::http_grant, plus the manifest rules of
  // hypen_runtime/manifest.rs (`HostPattern`, `HostsWithoutHttp`).
  test("a manifest's http + httpHosts become one grant", () => {
    expect(httpGrantOf(false, undefined)).toEqual({ ok: true, value: { kind: "denied" } });
    expect(httpGrantOf(true, undefined)).toEqual({ ok: true, value: { kind: "anyHost" } });
    expect(httpGrantOf(true, [])).toEqual({ ok: true, value: { kind: "anyHost" } });
    expect(httpGrantOf(false, [])).toEqual({ ok: true, value: { kind: "denied" } });
    const narrowed = httpGrantOf(true, ["*.Example.com", "localhost:3000", "*.example.com"]);
    expect(narrowed.ok && narrowed.value).toEqual(hosts);
  });
  const BAD_MANIFESTS: Array<[label: string, http: boolean, hosts: unknown, hint: string]> = [
    ["an allowlist without http", false, ["api.example.com"], "`http` is not true"],
    ["a URL as a pattern", true, ["ok.example", "http://x"], "drop the scheme"],
    ["a non-string entry", true, [42], "must be a list of host patterns (strings)"],
    ["a string instead of a list", true, "api.example.com", "must be a list of host patterns"],
  ];
  for (const [label, grantsHttp, list, hint] of BAD_MANIFESTS) {
    test(`${label} is a manifest error, never a wider grant`, () => {
      const grant = httpGrantOf(grantsHttp, list, "net");
      expect(grant.ok).toBe(false);
      if (!grant.ok) expect(grant.error).toContain(hint);
      if (!grant.ok) expect(grant.error).toContain("manifest.httpHosts of module 'net'");
    });
  }
});

describe("QueuedHttpRequest::validate (http.rs tests)", () => {
  const told = (q: QueuedHttpRequest): string => {
    const result = validateQueuedHttpRequest(q);
    return result.ok ? "ok" : `${result.error.tag}: ${result.error.val}`;
  };
  const withHeader = (name: string, value: string): QueuedHttpRequest => {
    const q = queued("GET", "http://h/");
    q.request.headers.push([name, value]);
    return q;
  };
  const edit = (base: QueuedHttpRequest, change: (q: QueuedHttpRequest) => void): QueuedHttpRequest => {
    change(base);
    return base;
  };

  // requests_are_validated_part_by_part
  const CASES: Array<[label: string, request: () => QueuedHttpRequest, expected: string]> = [
    ["a plain GET", () => queued("GET", "https://example.com/"), "ok"],
    ["a custom method token", () => queued("x-custom", "http://example.com"), "ok"],
    ["an empty method", () => queued("", "http://h/"), "invalid-request: method '' is not an HTTP token of at most 32 bytes"],
    ["a method with a space", () => queued("GE T", "http://h/"), "invalid-request: method 'GE T' is not an HTTP token"],
    ["a method with CRLF", () => queued("G\r\nET", "http://h/"), "invalid-request: method 'G\\r\\nET' is not an HTTP token"],
    ["CONNECT in any case", () => queued("connect", "http://h/"), "invalid-request: method 'connect' is not allowed"],
    ["a relative URL", () => queued("GET", "h/"), "invalid-request: invalid url: must be absolute and start with http:// or https://"],
    ["an ordinary header", () => withHeader("Accept", "text/plain; q=0.5"), "ok"],
    ...["Host", "content-length", "Connection", "Transfer-Encoding", "Proxy-Authorization", "te"].map(
      (owned): [string, () => QueuedHttpRequest, string] => [
        `the host-owned header ${owned}`,
        () => withHeader(owned, "x"),
        `invalid-request: header '${owned}' is set by the host and cannot be sent by a module`,
      ],
    ),
    ["a header name with a space", () => withHeader("bad name", "x"), "invalid-request: header name 'bad name' is not an HTTP token"],
    ["an empty header name", () => withHeader("", "x"), "invalid-request: header name '' is not an HTTP token"],
    ["a header value with CRLF", () => withHeader("x", "a\r\nInjected: 1"), "invalid-request: value of header 'x' contains a control or non-ASCII character"],
    ["a non-ASCII header value", () => withHeader("x", "caf\u{e9}"), "invalid-request: value of header 'x' contains a control or non-ASCII character"],
    ["a zero timeout", () => edit(queued("GET", "http://h/"), (q) => (q.request.timeoutMs = 0)), "invalid-request: timeout-ms is 0; omit it for the default or give a positive budget"],
    ["an empty `then`", () => edit(queued("GET", "http://h/"), (q) => (q.then = "")), "invalid-request: `then` is empty; name the action that receives the completion"],
    [
      "a URL over the limit",
      () => queued("GET", `http://h/${"a".repeat(http.MAX_HTTP_URL_BYTES)}`),
      `limit-exceeded: url of ${http.MAX_HTTP_URL_BYTES + 9} bytes exceeds the 8192-byte limit`,
    ],
    [
      "too many headers",
      () => edit(queued("GET", "http://h/"), (q) => (q.request.headers = new Array(http.MAX_HTTP_HEADERS + 1).fill(["x", "y"]))),
      "limit-exceeded: 65 headers exceed the limit of 64",
    ],
    [
      "a header block over the limit",
      () => edit(queued("GET", "http://h/"), (q) => (q.request.headers = [["x", "y".repeat(http.MAX_HTTP_HEADER_BYTES)]])),
      "limit-exceeded: headers of 16385 bytes exceed the 16384-byte limit",
    ],
    [
      "a body over the limit",
      () => edit(queued("POST", "http://h/"), (q) => (q.request.body = new Uint8Array(http.MAX_HTTP_BODY_BYTES + 1))),
      "limit-exceeded: body of 1048577 bytes exceeds the 1048576-byte limit",
    ],
    ["a body at the limit", () => edit(queued("POST", "http://h/"), (q) => (q.request.body = new Uint8Array(http.MAX_HTTP_BODY_BYTES))), "ok"],
    [
      "a `then` over the limit",
      () => edit(queued("GET", "http://h/"), (q) => (q.then = "t".repeat(http.MAX_HTTP_NAME_BYTES + 1))),
      "limit-exceeded: `then` of 257 bytes exceeds the 256-byte limit",
    ],
    [
      "a tag over the limit",
      () => edit(queued("GET", "http://h/"), (q) => (q.tag = "t".repeat(http.MAX_HTTP_NAME_BYTES + 1))),
      "limit-exceeded: tag of 257 bytes exceeds the 256-byte limit",
    ],
    // Lengths are UTF-8 bytes (Rust `str::len`), not UTF-16 units.
    ["a tag of 128 two-byte characters", () => edit(queued("GET", "http://h/"), (q) => (q.tag = "é".repeat(128))), "ok"],
    [
      "a tag of 129 two-byte characters",
      () => edit(queued("GET", "http://h/"), (q) => (q.tag = "é".repeat(129))),
      "limit-exceeded: tag of 258 bytes exceeds the 256-byte limit",
    ],
  ];
  for (const [label, request, expected] of CASES) {
    test(label, () => {
      const answer = told(request());
      if (expected === "ok") expect(answer).toBe("ok");
      else expect(answer).toStartWith(expected);
    });
  }

  // timeouts_default_and_clamp
  test("timeouts default and clamp", () => {
    expect(effectiveTimeoutMs(null)).toBe(http.DEFAULT_HTTP_TIMEOUT_MS);
    expect(effectiveTimeoutMs(undefined)).toBe(http.DEFAULT_HTTP_TIMEOUT_MS);
    expect(effectiveTimeoutMs(250)).toBe(250);
    expect(effectiveTimeoutMs(0xffff_ffff)).toBe(http.MAX_HTTP_TIMEOUT_MS);
  });
});

describe("the per-call queue (wasmtime/deferred_http.rs tests)", () => {
  // requests_are_validated_allowlisted_and_bounded
  test("requests are validated, allowlisted and bounded", () => {
    const queue = new DeferredHttpQueue({ kind: "hosts", patterns: [pattern("*.example.com")] });
    expect(queue.send(queued("GET", "not a url"))?.tag).toBe("invalid-request");
    const denied = queue.send(queued("GET", "https://evil.test/"));
    expect(denied).toEqual({
      tag: "permission-denied",
      val: "host 'evil.test:443' is not in the manifest's `httpHosts` allowlist",
    });
    for (let n = 0; n < http.MAX_HTTP_REQUESTS_PER_CALL; n++) {
      expect(queue.send(queued("GET", "https://api.example.com/"))).toBeNull();
    }
    expect(queue.send(queued("GET", "https://api.example.com/"))).toEqual({
      tag: "limit-exceeded",
      val: "too many requests in one call (limit 16)",
    });
    expect(queue.drain()).toHaveLength(http.MAX_HTTP_REQUESTS_PER_CALL);
    expect(queue.drain()).toEqual([]);
  });
  test("a module without the grant queues nothing", () => {
    const queue = new DeferredHttpQueue({ kind: "denied" });
    expect(queue.send(queued("GET", "https://api.example.com/"))).toEqual({
      tag: "permission-denied",
      val: "the manifest does not grant `http`",
    });
  });
});

describe("HttpOutcome::into_payload (http.rs tests)", () => {
  // a_text_response_is_delivered_as_utf8_with_merged_lowercase_headers
  test("a text response is delivered as utf8 with merged lowercase headers", () => {
    expect(
      httpCompletionPayload(
        {
          ok: true,
          status: 200,
          headers: [
            ["Content-Type", "text/plain"],
            ["Set-Cookie", "a=1"],
            ["set-cookie", "b=2"],
          ],
          body: new TextEncoder().encode("h\u{e9}llo"),
        },
        "t1",
      ),
    ).toEqual({
      ok: true,
      status: 200,
      headers: { "content-type": "text/plain", "set-cookie": "a=1, b=2" },
      body: "h\u{e9}llo",
      bodyEncoding: "utf8",
      tag: "t1",
    });
  });
  // a_binary_response_is_base64_and_any_status_is_ok
  test("a binary response is base64 and any status is ok", () => {
    expect(
      httpCompletionPayload({ ok: true, status: 404, headers: [], body: new Uint8Array([0xff, 0xfe, 0x00, 0x01]) }, null),
    ).toEqual({ ok: true, status: 404, headers: {}, body: "//4AAQ==", bodyEncoding: "base64", tag: null });
  });
  // failures_carry_kind_and_message
  test("failures carry kind and message", () => {
    expect(http.HTTP_FAILURE_KINDS).toEqual(["network", "timeout", "denied", "too-large", "invalid-response"]);
    for (const kind of http.HTTP_FAILURE_KINDS) {
      expect(httpCompletionPayload({ ok: false, error: { kind, message: "why" } }, "t")).toEqual({
        ok: false,
        error: { kind, message: "why" },
        tag: "t",
      });
    }
  });
  // responses_the_contract_cannot_carry_become_failures
  test("responses the contract cannot carry become failures", () => {
    const big = httpCompletionPayload(
      { ok: true, status: 200, headers: [], body: new Uint8Array(http.MAX_HTTP_RESPONSE_BODY_BYTES + 1) },
      null,
    );
    expect(!big.ok && big.error.kind).toBe("too-large");
    const odd = httpCompletionPayload({ ok: true, status: 42, headers: [], body: new Uint8Array() }, null);
    expect(!odd.ok && odd.error.kind).toBe("invalid-response");
  });
  // base64_matches_rfc_4648
  test("base64 matches RFC 4648", () => {
    const cases: Array<[string, string]> = [
      ["", ""],
      ["f", "Zg=="],
      ["fo", "Zm8="],
      ["foo", "Zm9v"],
      ["foob", "Zm9vYg=="],
      ["fooba", "Zm9vYmE="],
      ["foobar", "Zm9vYmFy"],
    ];
    for (const [plain, encoded] of cases) expect(base64Encode(new TextEncoder().encode(plain))).toBe(encoded);
    expect(base64Encode(new Uint8Array([0xfb, 0xff, 0xbf]))).toBe("+/+/");
  });
});

const RUST_SOURCE = resolve(REPO_ROOT, "hypen-engine-rs/src/module_host/http.rs");

describe.skipIf(!existsSync(RUST_SOURCE))("the bounds are the Rust constants", () => {
  /** `pub const NAME: usize = 8 * 1024;` -> ["NAME", 8192]. */
  const rustConstants = (): Map<string, number> => {
    const out = new Map<string, number>();
    const source = readFileSync(RUST_SOURCE, "utf8");
    for (const [, name, expr] of source.matchAll(/^pub const (\w+): (?:usize|u32) = ([\d_ *]+);$/gm)) {
      const value = expr!
        .replaceAll("_", "")
        .split("*")
        .reduce((product, factor) => product * Number(factor.trim()), 1);
      out.set(name!, value);
    }
    return out;
  };
  const exported = http as unknown as Record<string, unknown>;

  test("every Rust bound is exported here with the same value", () => {
    const rust = rustConstants();
    // A rename or a new bound on the Rust side must show up here.
    expect([...rust.keys()].sort()).toEqual(
      [
        "DEFAULT_HTTP_IN_FLIGHT_PER_MODULE",
        "DEFAULT_HTTP_TIMEOUT_MS",
        "MAX_HTTP_BODY_BYTES",
        "MAX_HTTP_HEADERS",
        "MAX_HTTP_HEADER_BYTES",
        "MAX_HTTP_METHOD_BYTES",
        "MAX_HTTP_NAME_BYTES",
        "MAX_HTTP_REDIRECTS",
        "MAX_HTTP_REQUESTS_PER_CALL",
        "MAX_HTTP_RESPONSE_BODY_BYTES",
        "MAX_HTTP_TIMEOUT_MS",
        "MAX_HTTP_URL_BYTES",
      ].sort(),
    );
    for (const [name, value] of rust) {
      expect([name, exported[name]]).toEqual([name, value]);
    }
  });

  test("the host-owned headers are the Rust list", () => {
    const source = readFileSync(RUST_SOURCE, "utf8");
    const block = /const HOST_OWNED_HEADERS: &\[&str\] = &\[([^\]]+)\]/.exec(source)?.[1] ?? "";
    const names = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect([name, http.isHostOwnedHeader(name.toUpperCase())]).toEqual([name, true]);
    expect(http.isHostOwnedHeader("Proxy-Anything")).toBe(true);
    expect(http.isHostOwnedHeader("proxy")).toBe(false);
    expect(http.isHostOwnedHeader("authorization")).toBe(false);
  });
});
