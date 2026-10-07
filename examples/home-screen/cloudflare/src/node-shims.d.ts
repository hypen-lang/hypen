// `node:async_hooks` is available under the `nodejs_compat` flag
// (wrangler.jsonc). Only the slice drive.ts uses is declared here, so the
// example does not need all of @types/node.
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, fn: () => R): R;
    getStore(): T | undefined;
  }
}
