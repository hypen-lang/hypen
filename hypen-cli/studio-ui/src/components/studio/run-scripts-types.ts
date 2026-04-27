/**
 * Mirror of the RunScript types from hypen-cli/src/studio/run-scripts.ts.
 * Duplicated here so browser-built code doesn't pull in the server-only
 * executor module (which imports Bun APIs for shell spawning). If the
 * server-side shape changes, update both places — they're structurally
 * checked at the API boundary anyway.
 */

export type Platform = "android" | "ios";

export type InstallGalleryStep = {
  type: "install-gallery";
  platform: Platform;
};

export type ShellStep = {
  type: "shell";
  cmd: string;
  cwd?: string;
};

export type OpenInGalleryStep = {
  type: "open-in-gallery";
  url: string;
  platform: Platform;
  deviceId?: string;
};

export type HypenRunStep = {
  type: "hypen-run";
  platform: Platform;
  url?: string;
};

export type Step = InstallGalleryStep | ShellStep | OpenInGalleryStep | HypenRunStep;

export interface RunScript {
  id: string;
  name: string;
  description?: string;
  steps: Step[];
}

export const STEP_KINDS: Array<Step["type"]> = [
  "shell",
  "install-gallery",
  "open-in-gallery",
  "hypen-run",
];

export function defaultStep(kind: Step["type"]): Step {
  switch (kind) {
    case "install-gallery": return { type: "install-gallery", platform: "android" };
    case "shell":           return { type: "shell", cmd: "" };
    case "open-in-gallery": return { type: "open-in-gallery", url: "localhost:5173/ws/engine", platform: "android" };
    case "hypen-run":       return { type: "hypen-run", platform: "android" };
  }
}
