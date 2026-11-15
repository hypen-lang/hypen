// Shared helpers for the end-to-end tests that drive the prebuilt component
// fixtures in hypen-engine-rs/tests/fixtures (read-only; tests skip when the
// files are absent, e.g. in a published tarball or a sparse checkout).
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Monorepo root, relative to this package. */
export const REPO_ROOT = resolve(here, "..", "..", "..", "..");

export const fixturePath = (file: string): string =>
  resolve(REPO_ROOT, "hypen-engine-rs", "tests", "fixtures", file);

export const hasFixture = (file: string): boolean => existsSync(fixturePath(file));

export const readFixture = (file: string): Uint8Array => new Uint8Array(readFileSync(fixturePath(file)));
