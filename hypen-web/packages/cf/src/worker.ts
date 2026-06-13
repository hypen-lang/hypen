/** Minimal CF type stubs */
interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}
interface DurableObjectId {}
interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

export interface WorkerConfig {
  /** Name of the DO binding in wrangler.toml (e.g., "HYPEN_DO") */
  binding: string;

  /**
   * Extract the DO routing key from the request.
   * For session-based: extract from cookie or URL param
   * For global: return a fixed string
   * Default: uses URL pathname or generates a new session ID
   */
  getRoutingKey?: (request: Request) => string | Promise<string>;
}

function defaultRoutingKey(request: Request): string {
  const url = new URL(request.url);

  // Check for session ID in query params
  const sessionId = url.searchParams.get("sessionId");
  if (sessionId) return sessionId;

  // Check for session ID in cookie
  const cookie = request.headers.get("Cookie");
  if (cookie) {
    const match = cookie.match(/hypen_session=([^;]+)/);
    if (match && match[1]) return match[1];
  }

  // Use URL path as key (e.g., /room/abc -> "room:abc")
  const path = url.pathname.replace(/^\/+|\/+$/g, "");
  if (path) return path.replace(/\//g, ":");

  // Fallback: generate new session
  return crypto.randomUUID();
}

/**
 * Create a CF Worker fetch handler that routes to HypenDurableObject instances.
 *
 * Usage in worker entrypoint:
 * ```typescript
 * import { createWorkerHandler } from "@hypen-space/cf";
 * export default { fetch: createWorkerHandler({ binding: "HYPEN_DO" }) };
 * ```
 */
export function createWorkerHandler(config: WorkerConfig) {
  return async function fetch(
    request: Request,
    env: Record<string, DurableObjectNamespace>,
  ): Promise<Response> {
    // 1. Check if WebSocket upgrade request
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }

    // 2. Get the DO namespace from env using config.binding
    const doNamespace = env[config.binding];
    if (!doNamespace) {
      return new Response(
        `Durable Object binding "${config.binding}" not found`,
        { status: 500 },
      );
    }

    // 3. Get routing key
    const key = config.getRoutingKey
      ? await config.getRoutingKey(request)
      : defaultRoutingKey(request);

    // 4. Get DO instance
    const id = doNamespace.idFromName(key);
    const stub = doNamespace.get(id);

    // 5. Forward request to DO
    return stub.fetch(request);
  };
}
