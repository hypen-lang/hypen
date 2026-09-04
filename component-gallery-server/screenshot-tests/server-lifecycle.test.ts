import { describe, expect, test } from "bun:test";
import { ensureServerLifecycle, type ServerProcess } from "./server-lifecycle";

function process(exitCode: number | null = null): ServerProcess & { exitCode: number | null } {
  return { exitCode };
}

describe("server lifecycle", () => {
  test("reuses a healthy service without inspecting or spawning", async () => {
    let occupiedChecks = 0;
    let spawns = 0;
    const result = await ensureServerLifecycle({
      label: "test server",
      port: 1234,
      probe: async () => true,
      portOccupied: async () => { occupiedChecks++; return true; },
      ownerDetails: async () => "unused",
      spawn: () => { spawns++; return process(); },
    });
    expect(result.reused).toBe(true);
    expect(occupiedChecks).toBe(0);
    expect(spawns).toBe(0);
  });

  test("spawns an absent service and waits for health", async () => {
    let probes = 0;
    const spawned = process();
    const result = await ensureServerLifecycle({
      label: "test server",
      port: 1234,
      probe: async () => ++probes >= 3,
      portOccupied: async () => false,
      ownerDetails: async () => "unused",
      spawn: () => spawned,
      sleep: async () => {},
    });
    expect(result).toEqual({ reused: false, process: spawned });
    expect(probes).toBe(3);
  });

  test("reports an occupied unhealthy port with owner guidance", async () => {
    expect(ensureServerLifecycle({
      label: "test server",
      port: 1234,
      probe: async () => false,
      portOccupied: async () => true,
      ownerDetails: async () => "node 4242 user 18u IPv4 TCP *:1234 (LISTEN)",
      spawn: () => process(),
    })).rejects.toThrow("node 4242");
  });

  test("reports a process that exits before health", async () => {
    const spawned = process();
    let probes = 0;
    expect(ensureServerLifecycle({
      label: "test server",
      port: 1234,
      probe: async () => {
        probes++;
        if (probes === 2) spawned.exitCode = 7;
        return false;
      },
      portOccupied: async () => false,
      ownerDetails: async () => "unused",
      spawn: () => spawned,
      sleep: async () => {},
    })).rejects.toThrow("exited with code 7");
  });
});
