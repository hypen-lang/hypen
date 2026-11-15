// The WASI surface a Hypen module may link, served by
// @bytecodealliance/preview2-shim (the shim generation jco-transpile's
// bindings are written against — keep the two versions aligned).
//
// Loaded lazily (first prepare()), so hosts that only use registerPrepared()
// never load the shim — its Node build starts an I/O worker thread on import.
// The cached value is a set of immutable module namespaces, not host state.
//
// wasi:filesystem is linked as an EMPTY filesystem (no preopened
// directories), exactly like the native host's empty WasiCtx: toolchains
// whose runtimes import it unconditionally (TinyGo `wasip2`,
// componentize-js) can load, but a module can never obtain a descriptor, so
// it has no file access. The shim's own filesystem is never loaded (its Node
// build is a real host-filesystem passthrough).
//
// Deliberately NOT included: wasi:sockets (never granted to modules), and
// wasi:http unless the manifest grants it (see buildImportMap).

export interface WasiImports {
  /** Always-linked interfaces (cli, clocks, io, random). */
  base: Record<string, unknown>;
  /** wasi:http/* — linked only for `http: true` manifests. */
  http: Record<string, unknown>;
}

let cached: Promise<WasiImports> | null = null;

/**
 * `wasi:filesystem/{preopens,types}` with nothing in it. `getDirectories()`
 * is empty and a descriptor can only be reached through a preopen, so the
 * resource classes exist only for jco's bindings to link against.
 */
export function emptyFilesystem(): Record<string, unknown> {
  class Descriptor {}
  class DirectoryEntryStream {}
  return {
    "wasi:filesystem/preopens": { getDirectories: (): [] => [] },
    "wasi:filesystem/types": {
      Descriptor,
      DirectoryEntryStream,
      // `option<error-code>`: an io error never comes from this filesystem.
      filesystemErrorCode: (): undefined => undefined,
    },
  };
}

type Ns = Record<string, unknown>;

export function loadWasiImports(): Promise<WasiImports> {
  cached ??= (async () => {
    const [cli, io, clocks, random, http] = (await Promise.all([
      import("@bytecodealliance/preview2-shim/cli"),
      import("@bytecodealliance/preview2-shim/io"),
      import("@bytecodealliance/preview2-shim/clocks"),
      import("@bytecodealliance/preview2-shim/random"),
      import("@bytecodealliance/preview2-shim/http"),
    ])) as unknown as Ns[];
    const base: Record<string, unknown> = {
      "wasi:cli/environment": cli!.environment,
      "wasi:cli/exit": cli!.exit,
      "wasi:cli/stderr": cli!.stderr,
      "wasi:cli/stdin": cli!.stdin,
      "wasi:cli/stdout": cli!.stdout,
      "wasi:cli/terminal-input": cli!.terminalInput,
      "wasi:cli/terminal-output": cli!.terminalOutput,
      "wasi:cli/terminal-stderr": cli!.terminalStderr,
      "wasi:cli/terminal-stdin": cli!.terminalStdin,
      "wasi:cli/terminal-stdout": cli!.terminalStdout,
      "wasi:clocks/monotonic-clock": clocks!.monotonicClock,
      "wasi:clocks/wall-clock": clocks!.wallClock,
      "wasi:io/error": io!.error,
      "wasi:io/poll": io!.poll,
      "wasi:io/streams": io!.streams,
      "wasi:random/random": random!.random,
      "wasi:random/insecure": random!.insecure,
      "wasi:random/insecure-seed": random!.insecureSeed,
      ...emptyFilesystem(),
    };
    const httpMap: Record<string, unknown> = {
      "wasi:http/types": http!.types,
      "wasi:http/outgoing-handler": http!.outgoingHandler,
    };
    for (const [k, v] of Object.entries({ ...base, ...httpMap })) {
      if (v === undefined) throw new Error(`preview2-shim does not export ${k}`);
    }
    return { base, http: httpMap };
  })();
  cached.catch(() => {
    cached = null; // allow retry after a failed load
  });
  return cached;
}
