import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import {
  getOnboardingMarkerPath,
  hasSeenOnboarding,
  markOnboardingSeen,
  shouldRunOnboarding,
  maybeRunOnboarding,
} from "../src/onboarding.js";

describe("onboarding", () => {
  const testHome = `/tmp/hypen-onboarding-test-${Date.now()}`;
  let savedHome: string | undefined;
  let savedNoOnboarding: string | undefined;
  let savedForce: string | undefined;
  let savedCi: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
    savedNoOnboarding = process.env.HYPEN_NO_ONBOARDING;
    savedForce = process.env.HYPEN_FORCE_ONBOARDING;
    savedCi = process.env.CI;
    delete process.env.HYPEN_NO_ONBOARDING;
    delete process.env.HYPEN_FORCE_ONBOARDING;
    delete process.env.CI;
    process.env.HOME = testHome;
    mkdirSync(testHome, { recursive: true });
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedNoOnboarding === undefined) delete process.env.HYPEN_NO_ONBOARDING;
    else process.env.HYPEN_NO_ONBOARDING = savedNoOnboarding;
    if (savedForce === undefined) delete process.env.HYPEN_FORCE_ONBOARDING;
    else process.env.HYPEN_FORCE_ONBOARDING = savedForce;
    if (savedCi === undefined) delete process.env.CI;
    else process.env.CI = savedCi;
    if (existsSync(testHome)) rmSync(testHome, { recursive: true, force: true });
  });

  test("marker path lives under ~/.hypen", () => {
    expect(getOnboardingMarkerPath()).toBe(
      join(testHome, ".hypen", "onboarding.json")
    );
  });

  test("hasSeenOnboarding flips after marking", () => {
    expect(hasSeenOnboarding()).toBe(false);
    markOnboardingSeen("1.2.3");
    expect(hasSeenOnboarding()).toBe(true);

    const marker = JSON.parse(
      readFileSync(getOnboardingMarkerPath(), "utf-8")
    );
    expect(marker.version).toBe("1.2.3");
    expect(typeof marker.seenAt).toBe("string");
  });

  test("does not run when stdin is not a TTY (CI/pipe/teleport)", () => {
    // The test runner pipes stdin, so isTTY is undefined here.
    expect(shouldRunOnboarding()).toBe(false);
  });

  test("does not run when HYPEN_NO_ONBOARDING is set", () => {
    process.env.HYPEN_NO_ONBOARDING = "1";
    expect(shouldRunOnboarding()).toBe(false);
  });

  test("does not run when CI is set", () => {
    process.env.CI = "true";
    expect(shouldRunOnboarding()).toBe(false);
  });

  test("maybeRunOnboarding is a no-op (and does not mark) when skipped", async () => {
    // Non-TTY in tests → should bail before showing anything or writing a marker.
    await maybeRunOnboarding("9.9.9");
    expect(hasSeenOnboarding()).toBe(false);
  });
});
