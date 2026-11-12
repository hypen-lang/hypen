import { describe, test, expect } from "bun:test";
import { createWorkerHandler, type WorkerConfig } from "../src/index.js";

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}
interface DurableObjectId {}
interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

function createMockEnv(binding: string) {
  const fetches: Array<{ name: string; request: Request }> = [];
  const namespace: DurableObjectNamespace = {
    idFromName(name: string) {
      return { __name: name } as any;
    },
    get(id: any) {
      return {
        fetch(req: Request) {
          fetches.push({ name: id.__name, request: req });
          return Promise.resolve(new Response(null, { status: 101 }));
        },
      };
    },
  };
  return { env: { [binding]: namespace } as Record<string, DurableObjectNamespace>, fetches };
}

function wsRequest(url: string, headers?: Record<string, string>): Request {
  return new Request(url, {
    headers: { Upgrade: "websocket", ...headers },
  });
}

describe("createWorkerHandler", () => {
  test("returns 426 for non-WebSocket requests", async () => {
    const handler = createWorkerHandler({ binding: "HYPEN_DO" });
    const { env } = createMockEnv("HYPEN_DO");

    const response = await handler(
      new Request("http://localhost/"),
      env,
    );

    expect(response.status).toBe(426);
    expect(await response.text()).toBe("WebSocket upgrade required");
  });

  test("forwards WebSocket upgrade to DO stub", async () => {
    const handler = createWorkerHandler({ binding: "HYPEN_DO" });
    const { env, fetches } = createMockEnv("HYPEN_DO");

    const request = wsRequest("http://localhost/room/abc");
    const response = await handler(request, env);

    expect(response.status).toBe(101);
    expect(fetches.length).toBe(1);
    expect(fetches[0].request).toBe(request);
  });

  test("uses custom getRoutingKey when provided", async () => {
    const handler = createWorkerHandler({
      binding: "HYPEN_DO",
      getRoutingKey: () => "custom-key-123",
    });
    const { env, fetches } = createMockEnv("HYPEN_DO");

    await handler(wsRequest("http://localhost/anything"), env);

    expect(fetches.length).toBe(1);
    expect(fetches[0].name).toBe("custom-key-123");
  });

  test("default routing: extracts sessionId from query param", async () => {
    const handler = createWorkerHandler({ binding: "HYPEN_DO" });
    const { env, fetches } = createMockEnv("HYPEN_DO");

    await handler(
      wsRequest("http://localhost/?sessionId=sess-abc-123"),
      env,
    );

    expect(fetches[0].name).toBe("sess-abc-123");
  });

  test("default routing: extracts session from cookie", async () => {
    const handler = createWorkerHandler({ binding: "HYPEN_DO" });
    const { env, fetches } = createMockEnv("HYPEN_DO");

    await handler(
      wsRequest("http://localhost/", {
        Cookie: "other=val; hypen_session=cookie-sess-42; foo=bar",
      }),
      env,
    );

    expect(fetches[0].name).toBe("cookie-sess-42");
  });

  test("default routing: uses URL path as key", async () => {
    const handler = createWorkerHandler({ binding: "HYPEN_DO" });
    const { env, fetches } = createMockEnv("HYPEN_DO");

    await handler(wsRequest("http://localhost/room/abc"), env);

    expect(fetches[0].name).toBe("room:abc");
  });

  test("default routing: bare /ws is not a path key (clients do not collapse into one DO)", async () => {
    const handler = createWorkerHandler({ binding: "HYPEN_DO" });
    const { env, fetches } = createMockEnv("HYPEN_DO");

    await handler(wsRequest("http://localhost/ws"), env);
    await handler(wsRequest("http://localhost/ws/"), env);

    expect(fetches[0].name).not.toBe("ws");
    expect(fetches[1].name).not.toBe("ws");
    expect(fetches[0].name).not.toBe(fetches[1].name);
  });

  test("default routing: the hypen_session cookie matches by exact name", async () => {
    const handler = createWorkerHandler({ binding: "HYPEN_DO" });
    const { env, fetches } = createMockEnv("HYPEN_DO");

    await handler(wsRequest("http://localhost/room/a", { Cookie: "not_hypen_session=x" }), env);

    expect(fetches[0].name).toBe("room:a");
  });

  test('routing: "visitor" keys on the visitor cookie and mints one on the 101', async () => {
    const handler = createWorkerHandler({ binding: "HYPEN_DO", routing: "visitor" });
    const { env, fetches } = createMockEnv("HYPEN_DO");

    const first = await handler(wsRequest("http://localhost/ws"), env);
    const id = first.headers.get("Set-Cookie")?.match(/hypen_visitor=([^;]+)/)?.[1];
    expect(id).toBeTruthy();
    expect(fetches[0].name).toBe(`visitor:${id}`);

    const second = await handler(wsRequest("http://localhost/ws", { Cookie: `hypen_visitor=${id}` }), env);
    expect(fetches[1].name).toBe(`visitor:${id}`);
    expect(second.headers.get("Set-Cookie")).toBeNull();

    // A malformed cookie value is not trusted as a key.
    await handler(wsRequest("http://localhost/ws", { Cookie: "hypen_visitor=../x" }), env);
    expect(fetches[2].name).not.toBe("visitor:../x");
  });

  test('routing: "shared" sends every client to one DO', async () => {
    const handler = createWorkerHandler({ binding: "HYPEN_DO", routing: "shared" });
    const { env, fetches } = createMockEnv("HYPEN_DO");

    await handler(wsRequest("http://localhost/ws?sessionId=a"), env);
    await handler(wsRequest("http://localhost/room/b"), env);

    expect(fetches.map((f) => f.name)).toEqual(["shared", "shared"]);
  });

  test("default routing: generates UUID when no key found", async () => {
    const handler = createWorkerHandler({ binding: "HYPEN_DO" });
    const { env, fetches } = createMockEnv("HYPEN_DO");

    await handler(wsRequest("http://localhost/"), env);

    // Should be a valid UUID v4
    expect(fetches[0].name).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("uses correct DO binding from config", async () => {
    const handler = createWorkerHandler({ binding: "MY_CUSTOM_DO" });
    const { env, fetches } = createMockEnv("MY_CUSTOM_DO");

    const response = await handler(
      wsRequest("http://localhost/test"),
      env,
    );

    expect(response.status).toBe(101);
    expect(fetches.length).toBe(1);
  });

  test("returns 500 when DO binding is missing", async () => {
    const handler = createWorkerHandler({ binding: "MISSING_DO" });
    const { env } = createMockEnv("OTHER_DO");

    const response = await handler(
      wsRequest("http://localhost/test"),
      env,
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toBe(
      'Durable Object binding "MISSING_DO" not found',
    );
  });
});
