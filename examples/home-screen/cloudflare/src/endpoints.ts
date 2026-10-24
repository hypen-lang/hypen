// Where the launcher's embedded apps (and its own wallpaper assets) live.
//
// Local by default: every icon points at `ws://localhost:<port>/ws`, the port
// `scripts/dev-examples.sh` (and the README's port map) gives that example's
// `wrangler dev`. Nothing in a fresh clone talks to anyone's deployed workers.
//
// For a deploy, set HYPEN_WORKERS_SUBDOMAIN to your `<subdomain>.workers.dev`
// subdomain and every URL becomes `wss://<worker-name>.<subdomain>.workers.dev/ws`
// (worker names are each example's wrangler.jsonc `name`):
//
//   bunx wrangler deploy --var HYPEN_WORKERS_SUBDOMAIN:<your-subdomain>
//
// HYPEN_LOCAL_HOST swaps `localhost` (e.g. for a LAN IP when testing on a
// phone), and HYPEN_HOME_ORIGIN pins the wallpaper origin outright.
//
// The values are read from `process.env`, which Workers populate from
// wrangler vars / `.dev.vars` under `nodejs_compat` (compat date >= 2025-04-01),
// so they are available while the launcher template is generated at import.

const env: Record<string, string | undefined> =
  (globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } })
    .process?.env ?? {};

const subdomain = (env.HYPEN_WORKERS_SUBDOMAIN ?? "").trim().replace(/\.workers\.dev$/, "");
const localHost = (env.HYPEN_LOCAL_HOST ?? "").trim() || "localhost";

/** True when the launcher points at deployed `*.workers.dev` workers. */
export const DEPLOYED = subdomain !== "";

/** The launcher's own local `wrangler dev` port. */
export const LAUNCHER_PORT = 8787;

/** WebSocket endpoint for an example worker: local port in dev, workers.dev when deployed. */
export function appEndpoint(worker: string, localPort: number): string {
  return DEPLOYED
    ? `wss://${worker}.${subdomain}.workers.dev/ws`
    : `ws://${localHost}:${localPort}/ws`;
}

/** Absolute origin serving this worker's `public/` assets (wallpapers). */
export const HOME_ORIGIN = (env.HYPEN_HOME_ORIGIN ?? "").trim().replace(/\/$/, "")
  || (DEPLOYED ? `https://hypen-home-screen.${subdomain}.workers.dev` : `http://${localHost}:${LAUNCHER_PORT}`);
