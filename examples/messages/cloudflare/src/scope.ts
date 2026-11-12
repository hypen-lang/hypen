/**
 * Who is calling: the DO runs every socket event (message, close, error)
 * inside `connScope.run({ hub, key, visitorId, tz }, …)`, and module
 * handlers read it here. AsyncLocalStorage follows each handler's own async
 * continuations, so a handler that awaits a device pick for ten seconds still
 * sees its own caller even though other sockets' events ran in between.
 *
 * `key` is the socket object — the identity of one Hypen session in the hub's
 * connection registry. `visitorId` comes from the HttpOnly cookie the worker
 * stamped onto the socket at upgrade time; nothing the client sends over the
 * socket can change it.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { ChatHub } from "./hub";

export interface ConnScope {
  hub: ChatHub;
  key: object;
  visitorId: string;
  tz: string;
}

export const connScope = new AsyncLocalStorage<ConnScope>();

export function currentConn(): ConnScope | undefined {
  return connScope.getStore();
}
