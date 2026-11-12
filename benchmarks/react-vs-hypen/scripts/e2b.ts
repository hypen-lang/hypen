/**
 * Runs the version matrix in E2B sandboxes, so the numbers come from a
 * machine of a known, fixed shape instead of whatever laptop or CI runner
 * happened to be at hand.
 *
 *   E2B_API_KEY=… bun scripts/e2b.ts template        # once: build the image
 *   E2B_API_KEY=… bun scripts/e2b.ts run [--rounds=8] [--replicas=2]
 *                                    [--variants=a,b] [--name=develop]
 *
 * What "equal ground" means here, concretely:
 *
 *   - The template pins the sandbox shape (vCPUs, memory) and the software
 *     (Chromium, Bun). Every sandbox started from it is the same VM spec.
 *   - A VM spec is not a CPU: two sandboxes can land on different physical
 *     hosts. So builds are never compared ACROSS sandboxes. Each sandbox runs
 *     the whole matrix — every build, interleaved — and all comparisons are
 *     made within it (see bench/matrix.ts).
 *   - `--replicas=2` runs the whole matrix again in a second sandbox, at the
 *     same time. It is a cross-check, not extra samples: if the ratios between
 *     builds agree across two machines, they are a property of the builds.
 *
 * The variants must already be built (`bun scripts/build-variants.ts …`);
 * they are uploaded as-is, so the sandbox measures exactly those bytes.
 * Results land in `results/matrix.json` (replica 1) and `results/matrix-b.json`.
 */

import { Sandbox, Template, defaultBuildLogger } from "e2b";
import { $ } from "bun";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const CPUS = Number(arg("cpus", "4"));
const MEMORY_MB = Number(arg("memory", "8192"));
const TEMPLATE = `hypen-bench-${CPUS}c-${MEMORY_MB}m`;
const playwright = JSON.parse(
  await readFile(resolve(root, "node_modules/playwright-core/package.json"), "utf8"),
).version as string;

if (!process.env.E2B_API_KEY) {
  console.error("E2B_API_KEY is not set");
  process.exit(1);
}

async function buildTemplate() {
  const template = Template()
    .fromNodeImage("22")
    .setUser("root")
    .runCmd([
      `npm install -g bun@${Bun.version}`,
      `PLAYWRIGHT_BROWSERS_PATH=/opt/pw npx -y playwright-core@${playwright} install --with-deps chromium`,
      "chmod -R a+rX /opt/pw",
    ])
    .setUser("user");
  const built = await Template.build(template, {
    alias: TEMPLATE,
    cpuCount: CPUS,
    memoryMB: MEMORY_MB,
    onBuildLogs: defaultBuildLogger(),
  });
  console.log(`built template ${TEMPLATE} (${built.templateId})`);
}

async function runReplica(label: string, tarball: Buffer, matrixArgs: string, outFile: string) {
  const log = (line: string) => console.log(`[${label}] ${line}`);
  // Ask for three hours; plans capped at one hour reject that, so fall back.
  const sbx = await Sandbox.create(TEMPLATE, { timeoutMs: 3 * 60 * 60 * 1000 }).catch(() =>
    Sandbox.create(TEMPLATE, { timeoutMs: 60 * 60 * 1000 }),
  );
  log(`sandbox ${sbx.sandboxId}`);
  try {
    await sbx.files.write("/home/user/bench.tgz", tarball.buffer as ArrayBuffer);
    const setup = await sbx.commands.run(
      "mkdir -p bench && tar xzf bench.tgz -C bench && cd bench && " +
        `bun add playwright-core@${playwright} 2>&1 | tail -1 && nproc && free -m | sed -n 2p`,
      { cwd: "/home/user", timeoutMs: 180_000 },
    );
    log(setup.stdout.trim().replace(/\n/g, " | "));

    let buffered = "";
    await sbx.commands.run(
      `bun bench/matrix.ts ${matrixArgs}`,
      {
        cwd: "/home/user/bench",
        envs: {
          PLAYWRIGHT_BROWSERS_PATH: "/opt/pw",
          BENCH_HOST: `E2B ${TEMPLATE} (sandbox ${label})`,
        },
        timeoutMs: 0,
        onStdout: (chunk) => {
          buffered += chunk;
          const parts = buffered.split("\n");
          buffered = parts.pop() ?? "";
          for (const line of parts) log(line);
        },
        onStderr: (chunk) => log(`stderr: ${chunk.trimEnd()}`),
      },
    );
    const json = await sbx.files.read("/home/user/bench/results/matrix.json");
    await writeFile(resolve(root, outFile), json);
    log(`saved ${outFile}`);
  } finally {
    await sbx.kill().catch(() => {});
  }
}

const command = process.argv[2];
if (command === "template") {
  await buildTemplate();
} else if (command === "run") {
  // `--variants=a,b` limits the run to some builds; `--name=x` writes
  // results/matrix-x.json (and -x-b.json) instead of results/matrix.json.
  const variants = arg("variants", "");
  const name = arg("name", "");
  const matrixArgs =
    `--rounds=${arg("rounds", "8")}` + (variants ? ` --variants=${variants}` : "");
  const replicas = Number(arg("replicas", "2"));
  const tgz = resolve(root, ".vendor/bench-upload.tgz");
  await $`mkdir -p .vendor && tar czf ${tgz} bench shared scripts/build-variants.ts variants`.cwd(root);
  const tarball = await readFile(tgz);
  console.log(`uploading ${(tarball.byteLength / 1048576).toFixed(1)} MB to ${replicas} sandbox(es)`);
  const stem = `results/matrix${name ? `-${name}` : ""}`;
  const outputs = [`${stem}.json`, `${stem}-b.json`, `${stem}-c.json`];
  const settled = await Promise.allSettled(
    Array.from({ length: replicas }, (_, i) =>
      runReplica(String.fromCharCode(65 + i), tarball, matrixArgs, outputs[i] ?? `${stem}-${i}.json`),
    ),
  );
  for (const s of settled) if (s.status === "rejected") console.error(s.reason);
  process.exit(settled.some((s) => s.status === "rejected") ? 1 : 0);
} else {
  console.error("usage: bun scripts/e2b.ts template | run [--rounds=8] [--replicas=2]");
  process.exit(1);
}
