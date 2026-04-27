import { describe, expect, test } from "bun:test";
import {
  Ok,
  Err,
  isOk,
  isErr,
  fromPromise,
  fromTry,
  map,
  mapErr,
  flatMap,
  unwrap,
  unwrapOr,
  unwrapOrElse,
  match,
  all,
  HypenError,
  ActionError,
  ConnectionError,
  StateError,
} from "../packages/core/src/result";

describe("Result Type", () => {
  describe("Ok and Err constructors", () => {
    test("Ok creates a successful result", () => {
      const result = Ok(42);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(42);
      }
    });

    test("Err creates a failed result", () => {
      const error = new Error("test error");
      const result = Err(error);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(error);
      }
    });

    test("Ok with undefined value", () => {
      const result = Ok(undefined);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeUndefined();
      }
    });

    test("Ok with null value", () => {
      const result = Ok(null);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });
  });

  describe("isOk and isErr type guards", () => {
    test("isOk returns true for Ok results", () => {
      const result = Ok(42);
      expect(isOk(result)).toBe(true);
      expect(isErr(result)).toBe(false);
    });

    test("isErr returns true for Err results", () => {
      const result = Err(new Error("test"));
      expect(isErr(result)).toBe(true);
      expect(isOk(result)).toBe(false);
    });
  });

  describe("fromPromise", () => {
    test("wraps resolved promise in Ok", async () => {
      const result = await fromPromise(Promise.resolve(42));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(42);
      }
    });

    test("wraps rejected promise in Err", async () => {
      const error = new Error("async error");
      const result = await fromPromise(Promise.reject(error));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(error);
      }
    });

    test("uses mapError to transform errors", async () => {
      const result = await fromPromise(
        Promise.reject(new Error("original")),
        (e) => new Error(`mapped: ${(e as Error).message}`)
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("mapped: original");
      }
    });

    test("handles non-Error rejections", async () => {
      const result = await fromPromise(Promise.reject("string error"));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("string error");
      }
    });
  });

  describe("fromTry", () => {
    test("wraps successful function in Ok", () => {
      const result = fromTry(() => 42);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(42);
      }
    });

    test("wraps throwing function in Err", () => {
      const error = new Error("sync error");
      const result = fromTry(() => {
        throw error;
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(error);
      }
    });

    test("uses mapError to transform errors", () => {
      const result = fromTry(
        () => {
          throw new Error("original");
        },
        (e) => new Error(`mapped: ${(e as Error).message}`)
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("mapped: original");
      }
    });
  });

  describe("map", () => {
    test("transforms Ok value", () => {
      const result = map(Ok(5), (x) => x * 2);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(10);
      }
    });

    test("passes through Err unchanged", () => {
      const error = new Error("test");
      const result = map(Err(error), (x: number) => x * 2);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(error);
      }
    });
  });

  describe("mapErr", () => {
    test("transforms Err error", () => {
      const result = mapErr(Err(new Error("original")), (e) => new Error(`wrapped: ${e.message}`));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("wrapped: original");
      }
    });

    test("passes through Ok unchanged", () => {
      const result = mapErr(Ok(42), (e: Error) => new Error(`wrapped: ${e.message}`));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(42);
      }
    });
  });

  describe("flatMap", () => {
    test("chains Ok results", () => {
      const result = flatMap(Ok(5), (x) => Ok(x * 2));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(10);
      }
    });

    test("short-circuits on Err", () => {
      const error = new Error("first error");
      const result = flatMap(Err(error), (x: number) => Ok(x * 2));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(error);
      }
    });

    test("propagates Err from chained function", () => {
      const error = new Error("second error");
      const result = flatMap(Ok(5), () => Err(error));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(error);
      }
    });
  });

  describe("unwrap", () => {
    test("returns value for Ok", () => {
      expect(unwrap(Ok(42))).toBe(42);
    });

    test("throws for Err", () => {
      const error = new Error("test");
      expect(() => unwrap(Err(error))).toThrow(error);
    });
  });

  describe("unwrapOr", () => {
    test("returns value for Ok", () => {
      expect(unwrapOr(Ok(42), 0)).toBe(42);
    });

    test("returns default for Err", () => {
      expect(unwrapOr(Err(new Error("test")), 0)).toBe(0);
    });
  });

  describe("unwrapOrElse", () => {
    test("returns value for Ok", () => {
      expect(unwrapOrElse(Ok(42), () => 0)).toBe(42);
    });

    test("returns computed default for Err", () => {
      expect(unwrapOrElse(Err(new Error("test")), (e) => e.message.length)).toBe(4);
    });
  });

  describe("match", () => {
    test("calls ok handler for Ok", () => {
      const result = match(Ok(42), {
        ok: (v) => `value: ${v}`,
        err: (e) => `error: ${e.message}`,
      });
      expect(result).toBe("value: 42");
    });

    test("calls err handler for Err", () => {
      const result = match(Err(new Error("test")), {
        ok: (v: number) => `value: ${v}`,
        err: (e) => `error: ${e.message}`,
      });
      expect(result).toBe("error: test");
    });
  });

  describe("all", () => {
    test("combines all Ok results", () => {
      const result = all([Ok(1), Ok(2), Ok(3)]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([1, 2, 3]);
      }
    });

    test("returns first Err", () => {
      const error = new Error("second failed");
      const result = all([Ok(1), Err(error), Ok(3)]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(error);
      }
    });

    test("handles empty array", () => {
      const result = all([]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });
  });
});

describe("Error Types", () => {
  describe("HypenError", () => {
    test("creates error with code and message", () => {
      const error = new HypenError("TEST_ERROR", "Test message");
      expect(error.code).toBe("TEST_ERROR");
      expect(error.message).toBe("Test message");
      expect(error.name).toBe("HypenError");
    });

    test("includes context and cause", () => {
      const cause = new Error("root cause");
      const error = new HypenError("TEST_ERROR", "Test message", {
        context: { key: "value" },
        cause,
      });
      expect(error.context).toEqual({ key: "value" });
      expect(error.cause).toBe(cause);
    });

    test("is instanceof Error", () => {
      const error = new HypenError("TEST", "test");
      expect(error instanceof Error).toBe(true);
      expect(error instanceof HypenError).toBe(true);
    });
  });

  describe("ActionError", () => {
    test("creates error with action name", () => {
      const error = new ActionError("increment", new Error("failed"));
      expect(error.actionName).toBe("increment");
      expect(error.code).toBe("ACTION_ERROR");
      expect(error.message).toContain("increment");
      expect(error.message).toContain("failed");
    });

    test("handles non-Error causes", () => {
      const error = new ActionError("test", "string error");
      expect(error.message).toContain("string error");
    });

    test("is instanceof HypenError", () => {
      const error = new ActionError("test", new Error());
      expect(error instanceof HypenError).toBe(true);
      expect(error instanceof ActionError).toBe(true);
    });
  });

  describe("ConnectionError", () => {
    test("creates error with URL", () => {
      const error = new ConnectionError("ws://localhost:3000", new Error("timeout"));
      expect(error.url).toBe("ws://localhost:3000");
      expect(error.code).toBe("CONNECTION_ERROR");
      expect(error.message).toContain("ws://localhost:3000");
    });

    test("includes attempt number", () => {
      const error = new ConnectionError("ws://localhost", new Error(), 3);
      expect(error.attempt).toBe(3);
      expect(error.message).toContain("attempt 3");
    });
  });

  describe("StateError", () => {
    test("creates error with path", () => {
      const error = new StateError("Invalid state", "user.profile.name");
      expect(error.path).toBe("user.profile.name");
      expect(error.code).toBe("STATE_ERROR");
    });

    test("works without path", () => {
      const error = new StateError("General state error");
      expect(error.path).toBeUndefined();
    });
  });
});
