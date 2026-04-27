import { describe, expect, test } from "bun:test";
import { keyCmd, swipeCmd, tapCmd, textCmd } from "../src/idb.ts";

describe("idb argv", () => {
  test("tapCmd rounds coordinates", () => {
    expect(tapCmd("UD", 100.7, 200.3)).toEqual([
      "idb",
      "ui",
      "tap",
      "--udid",
      "UD",
      "101",
      "200",
    ]);
  });

  test("swipeCmd without duration", () => {
    expect(swipeCmd("UD", 0, 0, 100, 100)).toEqual([
      "idb",
      "ui",
      "swipe",
      "--udid",
      "UD",
      "0",
      "0",
      "100",
      "100",
    ]);
  });

  test("swipeCmd with duration converts ms to seconds", () => {
    expect(swipeCmd("UD", 0, 0, 100, 100, 500)).toEqual([
      "idb",
      "ui",
      "swipe",
      "--udid",
      "UD",
      "0",
      "0",
      "100",
      "100",
      "--duration",
      "0.5",
    ]);
  });

  test("textCmd passes the literal string", () => {
    expect(textCmd("UD", "hello world")).toEqual([
      "idb",
      "ui",
      "text",
      "--udid",
      "UD",
      "hello world",
    ]);
  });

  test("keyCmd maps known keys", () => {
    expect(keyCmd("UD", "home")).toEqual(["idb", "ui", "button", "--udid", "UD", "HOME"]);
    expect(keyCmd("UD", "lock")).toEqual(["idb", "ui", "button", "--udid", "UD", "LOCK"]);
    expect(keyCmd("UD", "siri")).toEqual(["idb", "ui", "button", "--udid", "UD", "SIRI"]);
  });
});
