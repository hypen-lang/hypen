const build = await Bun.build({ entrypoints: [new URL("./client.ts", import.meta.url).pathname], target: "browser", conditions: ["bun"], format: "esm" });
if (!build.success) throw new Error(build.logs.join("\n"));
const js = await build.outputs[0].text();
Bun.serve({ port: Number(process.env.WEB_PORT || 3189), fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === "/client.js") return new Response(js, { headers: { "Content-Type": "text/javascript" } });
  if (path === "/comparison" || path === "/comparison.html") return new Response(Bun.file(new URL("../comparison.html", import.meta.url)));
  if (path === "/README.md") return new Response(Bun.file(new URL("../README.md", import.meta.url)));
  if (/^\/screenshots\/[a-z-]+\.png$/.test(path)) return new Response(Bun.file(new URL(".." + path, import.meta.url)));
  if (path === "/") return new Response(Bun.file(new URL("./index.html", import.meta.url)));
  return new Response("Not found", { status: 404 });
} });
console.log("Orbit web: http://localhost:3189 · add ?renderer=canvas for canvas");
