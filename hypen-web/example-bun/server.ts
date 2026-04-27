import index from "./index.html";

// Note: WASM is loaded from CDN by default (https://unpkg.com/@hypen-space/web-engine/...)
// No need to serve it locally unless you want offline support or faster loading.

const server = Bun.serve({
  port: 3000,
  routes: {
    "/": index,
    "/api/quote": {
      GET: async () => {
        const quotes = [
          "The only way to do great work is to love what you do. - Steve Jobs",
          "Innovation distinguishes between a leader and a follower. - Steve Jobs",
          "Stay hungry, stay foolish. - Steve Jobs",
          "Design is not just what it looks like. Design is how it works. - Steve Jobs",
          "Simplicity is the ultimate sophistication. - Leonardo da Vinci",
        ];
        const quote = quotes[Math.floor(Math.random() * quotes.length)];
        return Response.json({
          quote,
          timestamp: new Date().toISOString()
        });
      },
    },
  },
  development: {
    hmr: true,
    console: true,
  },
});

console.log(`🚀 Hypen Example App running at http://localhost:${server.port}`);
