export type {
  Simulator,
  SimulatorState,
  ShellResult,
  Shell,
  BinaryShell,
  StreamerOptions,
  InputAction,
} from "./types.ts";

export {
  listDevices,
  boot,
  shutdown,
  screenshot,
  parseDevicesJson,
  formatRuntime,
  listDevicesCmd,
  bootCmd,
  shutdownCmd,
  screenshotCmd,
} from "./simctl.ts";

export {
  hasIdb,
  dispatch as dispatchInput,
  tapCmd,
  swipeCmd,
  textCmd,
  keyCmd,
} from "./idb.ts";

export {
  createMjpegStream,
  mjpegContentType,
  MJPEG_BOUNDARY,
} from "./stream.ts";

export {
  createMp4Stream,
  ffmpegFragmentedMp4Cmd,
  simctlRecordCmd,
  hasFfmpeg,
} from "./video.ts";

export { startServer, type StartedServer } from "./server.ts";

export { bunShell, bunBinaryShell, commandExists } from "./shell.ts";
