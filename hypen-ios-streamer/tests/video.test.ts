import { describe, expect, test } from "bun:test";
import { ffmpegFragmentedMp4Cmd, simctlRecordCmd } from "../src/video.ts";

describe("video argv", () => {
  test("simctlRecordCmd builds the recordVideo invocation", () => {
    expect(simctlRecordCmd("UD", "/tmp/p.h264")).toEqual([
      "xcrun", "simctl", "io", "UD", "recordVideo", "--codec=h264", "/tmp/p.h264",
    ]);
  });

  test("ffmpegFragmentedMp4Cmd uses copy + fragmented MP4 movflags", () => {
    const cmd = ffmpegFragmentedMp4Cmd("/tmp/p.h264");
    expect(cmd[0]).toBe("ffmpeg");
    expect(cmd).toContain("-i");
    expect(cmd[cmd.indexOf("-i") + 1]).toBe("/tmp/p.h264");
    expect(cmd).toContain("-c:v");
    expect(cmd[cmd.indexOf("-c:v") + 1]).toBe("copy");
    expect(cmd).toContain("-f");
    expect(cmd[cmd.indexOf("-f") + 1]).toBe("mp4");
    const movflags = cmd[cmd.indexOf("-movflags") + 1]!;
    expect(movflags).toContain("frag_keyframe");
    expect(movflags).toContain("empty_moov");
    expect(movflags).toContain("default_base_moof");
    expect(cmd[cmd.length - 1]).toBe("pipe:1");
  });
});
