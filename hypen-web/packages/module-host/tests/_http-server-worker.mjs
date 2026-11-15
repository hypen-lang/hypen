// One-shot HTTP server run in a worker thread for e2e-http-gate.test.ts.
// It MUST live off the main thread: preview2-shim services the module's
// blocking wasi:io poll by parking the main thread (Atomics.wait), so a
// server on the main event loop could never accept the connection.
import { createServer } from "node:http";
import { parentPort, workerData } from "node:worker_threads";

const server = createServer((req, res) => {
  parentPort.postMessage({ hit: req.url });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(workerData.body);
});
server.listen(0, "127.0.0.1", () => {
  parentPort.postMessage({ port: server.address().port });
});
