/**
 * The "weather service" the example talks to: a local HTTP server, so the
 * example runs offline.
 *
 *   bun scripts/api.ts            # http://127.0.0.1:8787
 *
 *   GET /forecast/<city>   200 { city, tempC, summary }
 *   GET /old/<city>        302 → /forecast/<city>      (followed by the host)
 *   GET /away              302 → http://example.com/   (outside httpHosts: refused)
 *   GET /slow              answers after 5 s           (for a short timeoutMs)
 *   anything else          404
 */

const FORECASTS: Record<string, { city: string; tempC: number; summary: string }> = {
  oslo: { city: "Oslo", tempC: 7, summary: "light rain" },
  zagreb: { city: "Zagreb", tempC: 14, summary: "clear" },
};

export function startApi(port = Number(process.env.API_PORT ?? 8787)) {
  const hits: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      hits.push(`${request.method} ${pathname}`);
      const [, kind, city = ""] = pathname.split("/");
      if (kind === "forecast" && FORECASTS[city]) return Response.json(FORECASTS[city]);
      if (kind === "old") return Response.redirect(`http://127.0.0.1:${server.port}/forecast/${city}`, 302);
      if (kind === "away") return Response.redirect("http://example.com/", 302);
      if (kind === "slow") {
        await Bun.sleep(5000);
        return Response.json(FORECASTS.oslo);
      }
      return new Response("no such forecast", { status: 404 });
    },
  });
  return { server, hits };
}

if (import.meta.main) {
  const { server } = startApi();
  console.log(`weather API on http://127.0.0.1:${server.port} (try /forecast/oslo)`);
}
