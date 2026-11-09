/**
 * Stop a running playground server started by `bun run playground`.
 *
 * Only signals the PID recorded in the server's PID file, and only if that
 * process is still a playground server — it never kills whatever else happens
 * to be listening on the port.
 *
 * Usage: PORT=3000 bun playground/stop.ts
 */
import { unlinkSync } from "node:fs";
import { pidFileFor } from "./pidfile";

const port = Number(process.env.PORT) || 3000;
const pidFile = pidFileFor(port);
const file = Bun.file(pidFile);

if (!(await file.exists())) {
  process.exit(0);
}

const pid = Number((await file.text()).trim());
const removePidFile = () => {
  try {
    unlinkSync(pidFile);
  } catch {}
};

function commandLine(p: number): string | null {
  const res = Bun.spawnSync(["ps", "-p", String(p), "-o", "command="]);
  if (res.exitCode !== 0) return null;
  return res.stdout.toString().trim() || null;
}

const cmd = Number.isInteger(pid) && pid > 0 ? commandLine(pid) : null;
if (!cmd) {
  removePidFile(); // stale
  process.exit(0);
}
if (!cmd.includes("playground/server.ts")) {
  console.warn(`PID ${pid} from ${pidFile} is not a playground server (${cmd}); leaving it alone.`);
  removePidFile();
  process.exit(0);
}

process.kill(pid, "SIGTERM");
for (let i = 0; i < 50 && commandLine(pid); i++) await Bun.sleep(100);
removePidFile();
console.log(`Stopped playground server (PID ${pid}) on port ${port}.`);
