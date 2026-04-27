#!/usr/bin/env bun
/**
 * Reset all WebSocket connections and kill zombie Puppeteer processes
 */

import { $ } from "bun";

const PORT = process.env.PORT ?? 6555;

// Kill zombie Puppeteer/Chrome processes
try {
  await $`pkill -9 -f "puppeteer" 2>/dev/null`.quiet();
} catch {}
try {
  await $`pkill -9 -f "Chrome for Testing" 2>/dev/null`.quiet();
} catch {}

const killed = await $`ps aux | grep -i puppeteer | grep -v grep | wc -l`.text();
console.log(`Killed Puppeteer processes (${killed.trim()} remaining)`);

// Reset server connections
try {
  const res = await fetch(`http://localhost:${PORT}/reset`);
  const data = await res.json();
  console.log(`Disconnected ${data.disconnected} WebSocket clients`);
} catch {
  console.log("Server not running (skipped WebSocket reset)");
}
