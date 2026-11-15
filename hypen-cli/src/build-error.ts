/**
 * Expected build failure (bad config, missing entry/toolchain, failed
 * compile). Library code throws it instead of exiting; `bin/hypen.ts` prints
 * the message and exits non-zero. Lives in its own module so the wasm build
 * (`build-wasm.ts`) can throw it without pulling in the SPA build.
 */
export class BuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildError";
  }
}
