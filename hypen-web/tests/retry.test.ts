import { describe, expect, test, mock, beforeEach } from "bun:test";
import {
  retry,
  retryResult,
  withRetry,
  RetryConditions,
  RetryPresets,
} from "../packages/core/src/retry";

describe("Retry Utility", () => {
  describe("retry", () => {
    test("returns value on first success", async () => {
      const fn = mock(() => Promise.resolve(42));

      const result = await retry(fn);

      expect(result).toBe(42);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test("retries on failure and succeeds", async () => {
      let attempts = 0;
      const fn = mock(() => {
        attempts++;
        if (attempts < 3) {
          return Promise.reject(new Error("fail"));
        }
        return Promise.resolve("success");
      });

      const result = await retry(fn, { maxAttempts: 5, delayMs: 10 });

      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(3);
    });

    test("throws after max attempts exceeded", async () => {
      const fn = mock(() => Promise.reject(new Error("always fails")));

      await expect(
        retry(fn, { maxAttempts: 3, delayMs: 10 })
      ).rejects.toThrow("always fails");

      expect(fn).toHaveBeenCalledTimes(3);
    });

    test("calls onRetry callback on each retry", async () => {
      let attempts = 0;
      const fn = () => {
        attempts++;
        if (attempts < 3) {
          throw new Error(`fail ${attempts}`);
        }
        return "success";
      };

      const onRetry = mock((_attempt: number, _error: Error) => {});

      await retry(fn, { maxAttempts: 5, delayMs: 10, onRetry });

      expect(onRetry).toHaveBeenCalledTimes(2);
      // First retry: attempt 1 failed
      expect(onRetry.mock.calls[0]![0]).toBe(1);
      expect(onRetry.mock.calls[0]![1].message).toBe("fail 1");
      // Second retry: attempt 2 failed
      expect(onRetry.mock.calls[1]![0]).toBe(2);
      expect(onRetry.mock.calls[1]![1].message).toBe("fail 2");
    });

    test("respects shouldRetry predicate", async () => {
      const retryableError = new Error("retryable");
      const nonRetryableError = new Error("non-retryable");

      let callCount = 0;
      const fn = () => {
        callCount++;
        if (callCount === 1) throw retryableError;
        throw nonRetryableError;
      };

      const shouldRetry = (err: Error) => err.message === "retryable";

      await expect(
        retry(fn, { maxAttempts: 5, delayMs: 10, shouldRetry })
      ).rejects.toThrow("non-retryable");

      // Should have stopped after second attempt (non-retryable)
      expect(callCount).toBe(2);
    });

    test("respects abort signal", async () => {
      const controller = new AbortController();
      const fn = mock(() => Promise.reject(new Error("fail")));

      // Abort after a short delay
      setTimeout(() => controller.abort(), 30);

      await expect(
        retry(fn, { maxAttempts: 10, delayMs: 50, signal: controller.signal })
      ).rejects.toThrow("Retry aborted");
    });

    test("handles synchronous functions", async () => {
      let attempts = 0;
      const fn = () => {
        attempts++;
        if (attempts < 2) throw new Error("fail");
        return 42;
      };

      const result = await retry(fn, { delayMs: 10 });

      expect(result).toBe(42);
    });

    test("converts non-Error throws to Error", async () => {
      const fn = () => {
        throw "string error";
      };

      await expect(retry(fn, { maxAttempts: 1 })).rejects.toThrow("string error");
    });
  });

  describe("retry backoff strategies", () => {
    test("exponential backoff increases delay", async () => {
      const delays: number[] = [];
      const fn = mock(() => Promise.reject(new Error("fail")));

      const onRetry = (_attempt: number, _error: Error, delayMs: number) => {
        delays.push(delayMs);
      };

      await expect(
        retry(fn, {
          maxAttempts: 4,
          delayMs: 100,
          backoff: "exponential",
          jitter: 0,
          onRetry,
        })
      ).rejects.toThrow();

      // Exponential: 100, 200, 400
      expect(delays[0]).toBe(100);
      expect(delays[1]).toBe(200);
      expect(delays[2]).toBe(400);
    });

    test("linear backoff increases delay linearly", async () => {
      const delays: number[] = [];
      const fn = mock(() => Promise.reject(new Error("fail")));

      const onRetry = (_attempt: number, _error: Error, delayMs: number) => {
        delays.push(delayMs);
      };

      await expect(
        retry(fn, {
          maxAttempts: 4,
          delayMs: 100,
          backoff: "linear",
          jitter: 0,
          onRetry,
        })
      ).rejects.toThrow();

      // Linear: 100, 200, 300
      expect(delays[0]).toBe(100);
      expect(delays[1]).toBe(200);
      expect(delays[2]).toBe(300);
    });

    test("no backoff keeps delay constant", async () => {
      const delays: number[] = [];
      const fn = mock(() => Promise.reject(new Error("fail")));

      const onRetry = (_attempt: number, _error: Error, delayMs: number) => {
        delays.push(delayMs);
      };

      await expect(
        retry(fn, {
          maxAttempts: 4,
          delayMs: 100,
          backoff: "none",
          jitter: 0,
          onRetry,
        })
      ).rejects.toThrow();

      // No backoff: 100, 100, 100
      expect(delays.every((d) => d === 100)).toBe(true);
    });

    test("respects maxDelayMs cap", async () => {
      const delays: number[] = [];
      const fn = mock(() => Promise.reject(new Error("fail")));

      const onRetry = (_attempt: number, _error: Error, delayMs: number) => {
        delays.push(delayMs);
      };

      await expect(
        retry(fn, {
          maxAttempts: 5,
          delayMs: 100,
          backoff: "exponential",
          maxDelayMs: 250,
          jitter: 0,
          onRetry,
        })
      ).rejects.toThrow();

      // Should cap at 250: 100, 200, 250, 250
      expect(delays[0]).toBe(100);
      expect(delays[1]).toBe(200);
      expect(delays[2]).toBe(250);
      expect(delays[3]).toBe(250);
    });
  });

  describe("retryResult", () => {
    test("returns Ok on success", async () => {
      const result = await retryResult(() => Promise.resolve(42));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(42);
      }
    });

    test("returns Err after all retries fail", async () => {
      const result = await retryResult(
        () => Promise.reject(new Error("failed")),
        { maxAttempts: 2, delayMs: 10 }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("failed");
      }
    });
  });

  describe("withRetry", () => {
    test("creates retryable function wrapper", async () => {
      let attempts = 0;
      const originalFn = (x: number) => {
        attempts++;
        if (attempts < 2) throw new Error("fail");
        return x * 2;
      };

      const retryableFn = withRetry(originalFn, { delayMs: 10 });

      const result = await retryableFn(21);

      expect(result).toBe(42);
      expect(attempts).toBe(2);
    });

    test("preserves function arguments", async () => {
      const fn = mock((a: string, b: number) => `${a}:${b}`);
      const retryableFn = withRetry(fn);

      const result = await retryableFn("test", 42);

      expect(result).toBe("test:42");
      expect(fn).toHaveBeenCalledWith("test", 42);
    });
  });

  describe("RetryConditions", () => {
    test("networkErrors matches network-related errors", () => {
      expect(RetryConditions.networkErrors(new Error("Network request failed"))).toBe(true);
      expect(RetryConditions.networkErrors(new Error("fetch failed"))).toBe(true);
      expect(RetryConditions.networkErrors(new Error("timeout"))).toBe(true);
      expect(RetryConditions.networkErrors(new Error("ECONNREFUSED"))).toBe(true);
      expect(RetryConditions.networkErrors(new Error("socket hang up"))).toBe(true);
      expect(RetryConditions.networkErrors(new Error("regular error"))).toBe(false);
    });

    test("httpRetryable matches retryable status codes", () => {
      const makeError = (status: number) => {
        const err = new Error("HTTP Error") as Error & { status: number };
        err.status = status;
        return err;
      };

      expect(RetryConditions.httpRetryable(makeError(408))).toBe(true);
      expect(RetryConditions.httpRetryable(makeError(429))).toBe(true);
      expect(RetryConditions.httpRetryable(makeError(500))).toBe(true);
      expect(RetryConditions.httpRetryable(makeError(502))).toBe(true);
      expect(RetryConditions.httpRetryable(makeError(503))).toBe(true);
      expect(RetryConditions.httpRetryable(makeError(504))).toBe(true);
      expect(RetryConditions.httpRetryable(makeError(400))).toBe(false);
      expect(RetryConditions.httpRetryable(makeError(404))).toBe(false);
      expect(RetryConditions.httpRetryable(new Error("no status"))).toBe(false);
    });

    test("websocketErrors matches WebSocket-related errors", () => {
      expect(RetryConditions.websocketErrors(new Error("WebSocket closed"))).toBe(true);
      expect(RetryConditions.websocketErrors(new Error("connection failed"))).toBe(true);
      expect(RetryConditions.websocketErrors(new Error("regular error"))).toBe(false);
    });

    test("any combines conditions with OR logic", () => {
      const condition = RetryConditions.any(
        (e) => e.message.includes("foo"),
        (e) => e.message.includes("bar")
      );

      expect(condition(new Error("foo"))).toBe(true);
      expect(condition(new Error("bar"))).toBe(true);
      expect(condition(new Error("foobar"))).toBe(true);
      expect(condition(new Error("baz"))).toBe(false);
    });

    test("all combines conditions with AND logic", () => {
      const condition = RetryConditions.all(
        (e) => e.message.includes("foo"),
        (e) => e.message.includes("bar")
      );

      expect(condition(new Error("foobar"))).toBe(true);
      expect(condition(new Error("foo"))).toBe(false);
      expect(condition(new Error("bar"))).toBe(false);
    });
  });

  describe("RetryPresets", () => {
    test("aggressive preset has high max attempts", () => {
      expect(RetryPresets.aggressive.maxAttempts).toBe(10);
      expect(RetryPresets.aggressive.backoff).toBe("exponential");
    });

    test("conservative preset has low max attempts", () => {
      expect(RetryPresets.conservative.maxAttempts).toBe(3);
      expect(RetryPresets.conservative.backoff).toBe("linear");
    });

    test("fast preset has short delays", () => {
      expect(RetryPresets.fast.delayMs).toBe(100);
      expect(RetryPresets.fast.maxDelayMs).toBe(2000);
    });

    test("websocket preset includes shouldRetry condition", () => {
      expect(RetryPresets.websocket.maxAttempts).toBe(10);
      expect(typeof RetryPresets.websocket.shouldRetry).toBe("function");
    });
  });
});
