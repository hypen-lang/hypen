import { test, expect } from "bun:test";
import { isHypenDebugEnv } from "../src/dev-debug";

test("DEBUG namespaces that enable hypen", () => {
  for (const v of ["hypen:*", "hypen", "hypen:dev", "*", "express,hypen:*", "foo hypen*"]) {
    expect(isHypenDebugEnv(v)).toBe(true);
  }
});

test("DEBUG values that leave hypen off", () => {
  for (const v of [undefined, "", "express", "hypenx", "*,-hypen:*", "-hypen:*"]) {
    expect(isHypenDebugEnv(v)).toBe(false);
  }
});
