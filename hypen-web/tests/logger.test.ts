import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import {
  Logger,
  createLogger,
  logger,
  log,
  setLogLevel,
  getLogLevel,
  configureLogger,
  enableLogging,
  disableLogging,
  type LogLevel,
} from "../packages/core/src/logger";

describe("Logger", () => {
  // Store original level to restore after tests
  let originalLevel: LogLevel;

  beforeEach(() => {
    originalLevel = getLogLevel();
    setLogLevel("debug"); // Enable all logging for tests
  });

  afterEach(() => {
    setLogLevel(originalLevel);
  });

  describe("createLogger", () => {
    test("creates a logger with a tag", () => {
      const log = createLogger("TestComponent");
      expect(log).toBeInstanceOf(Logger);
    });
  });

  describe("log levels", () => {
    test("setLogLevel changes the log level", () => {
      setLogLevel("warn");
      expect(getLogLevel()).toBe("warn");
    });

    test("enableLogging sets level to debug", () => {
      setLogLevel("error");
      enableLogging();
      expect(getLogLevel()).toBe("debug");
    });

    test("disableLogging sets level to none", () => {
      setLogLevel("debug");
      disableLogging();
      expect(getLogLevel()).toBe("none");
    });
  });

  describe("Logger methods", () => {
    test("debug logs when level is debug", () => {
      const consoleSpy = mock(() => {});
      const originalLog = console.log;
      console.log = consoleSpy;

      try {
        setLogLevel("debug");
        const log = createLogger("Test");
        log.debug("test message");

        expect(consoleSpy).toHaveBeenCalled();
        expect(consoleSpy.mock.calls[0][0]).toContain("[Test]");
      } finally {
        console.log = originalLog;
      }
    });

    test("debug does not log when level is higher", () => {
      const consoleSpy = mock(() => {});
      const originalLog = console.log;
      console.log = consoleSpy;

      try {
        setLogLevel("warn");
        const log = createLogger("Test");
        log.debug("test message");

        expect(consoleSpy).not.toHaveBeenCalled();
      } finally {
        console.log = originalLog;
      }
    });

    test("error always logs unless level is none", () => {
      const consoleSpy = mock(() => {});
      const originalError = console.error;
      console.error = consoleSpy;

      try {
        setLogLevel("error");
        const log = createLogger("Test");
        log.error("error message");

        expect(consoleSpy).toHaveBeenCalled();
      } finally {
        console.error = originalError;
      }
    });

    test("no methods log when level is none", () => {
      const logSpy = mock(() => {});
      const infoSpy = mock(() => {});
      const warnSpy = mock(() => {});
      const errorSpy = mock(() => {});

      const originalLog = console.log;
      const originalInfo = console.info;
      const originalWarn = console.warn;
      const originalError = console.error;

      console.log = logSpy;
      console.info = infoSpy;
      console.warn = warnSpy;
      console.error = errorSpy;

      try {
        disableLogging();
        const log = createLogger("Test");
        log.debug("debug");
        log.info("info");
        log.warn("warn");
        log.error("error");

        expect(logSpy).not.toHaveBeenCalled();
        expect(infoSpy).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
      } finally {
        console.log = originalLog;
        console.info = originalInfo;
        console.warn = originalWarn;
        console.error = originalError;
      }
    });
  });

  describe("Logger.child", () => {
    test("creates a child logger with combined tag", () => {
      const consoleSpy = mock(() => {});
      const originalLog = console.log;
      console.log = consoleSpy;

      try {
        setLogLevel("debug");
        const parent = createLogger("Parent");
        const child = parent.child("Child");
        child.debug("test");

        expect(consoleSpy).toHaveBeenCalled();
        expect(consoleSpy.mock.calls[0][0]).toContain("[Parent:Child]");
      } finally {
        console.log = originalLog;
      }
    });
  });

  describe("Logger.warnOnce and debugOnce", () => {
    test("warnOnce only logs once per key", () => {
      const warnSpy = mock(() => {});
      const originalWarn = console.warn;
      console.warn = warnSpy;

      try {
        setLogLevel("warn");
        const log = createLogger("Test");
        log.warnOnce("deprecation", "This is deprecated");
        log.warnOnce("deprecation", "This is deprecated");
        log.warnOnce("deprecation", "This is deprecated");

        expect(warnSpy).toHaveBeenCalledTimes(1);
      } finally {
        console.warn = originalWarn;
      }
    });

    test("different keys log separately", () => {
      const warnSpy = mock(() => {});
      const originalWarn = console.warn;
      console.warn = warnSpy;

      try {
        setLogLevel("warn");
        const log = createLogger("Test");
        log.warnOnce("key1", "First warning");
        log.warnOnce("key2", "Second warning");

        expect(warnSpy).toHaveBeenCalledTimes(2);
      } finally {
        console.warn = originalWarn;
      }
    });
  });

  describe("Logger.debugIf and warnIf", () => {
    test("debugIf only logs when condition is true", () => {
      const consoleSpy = mock(() => {});
      const originalLog = console.log;
      console.log = consoleSpy;

      try {
        setLogLevel("debug");
        const log = createLogger("Test");
        log.debugIf(false, "should not log");
        expect(consoleSpy).not.toHaveBeenCalled();

        log.debugIf(true, "should log");
        expect(consoleSpy).toHaveBeenCalledTimes(1);
      } finally {
        console.log = originalLog;
      }
    });

    test("warnIf only logs when condition is true", () => {
      const warnSpy = mock(() => {});
      const originalWarn = console.warn;
      console.warn = warnSpy;

      try {
        setLogLevel("warn");
        const log = createLogger("Test");
        log.warnIf(false, "should not log");
        expect(warnSpy).not.toHaveBeenCalled();

        log.warnIf(true, "should log");
        expect(warnSpy).toHaveBeenCalledTimes(1);
      } finally {
        console.warn = originalWarn;
      }
    });
  });

  describe("Logger.time and timeAsync", () => {
    test("time measures function execution", () => {
      const consoleSpy = mock(() => {});
      const originalLog = console.log;
      console.log = consoleSpy;

      try {
        setLogLevel("debug");
        const log = createLogger("Test");
        const result = log.time("operation", () => 42);

        expect(result).toBe(42);
        expect(consoleSpy).toHaveBeenCalled();
        expect(consoleSpy.mock.calls[0][1]).toMatch(/operation: \d+\.\d+ms/);
      } finally {
        console.log = originalLog;
      }
    });

    test("timeAsync measures async function execution", async () => {
      const consoleSpy = mock(() => {});
      const originalLog = console.log;
      console.log = consoleSpy;

      try {
        setLogLevel("debug");
        const log = createLogger("Test");
        const result = await log.timeAsync("async-op", async () => {
          await new Promise((r) => setTimeout(r, 10));
          return "done";
        });

        expect(result).toBe("done");
        expect(consoleSpy).toHaveBeenCalled();
        expect(consoleSpy.mock.calls[0][1]).toMatch(/async-op: \d+\.\d+ms/);
      } finally {
        console.log = originalLog;
      }
    });

    test("time skips measurement when log level is higher", () => {
      const consoleSpy = mock(() => {});
      const originalLog = console.log;
      console.log = consoleSpy;

      try {
        setLogLevel("error");
        const log = createLogger("Test");
        const result = log.time("operation", () => 42);

        expect(result).toBe(42);
        expect(consoleSpy).not.toHaveBeenCalled();
      } finally {
        console.log = originalLog;
      }
    });
  });

  describe("log shorthand", () => {
    test("log.debug logs with tag", () => {
      const consoleSpy = mock(() => {});
      const originalLog = console.log;
      console.log = consoleSpy;

      try {
        setLogLevel("debug");
        log.debug("MyTag", "test message");

        expect(consoleSpy).toHaveBeenCalled();
        expect(consoleSpy.mock.calls[0][0]).toContain("[MyTag]");
      } finally {
        console.log = originalLog;
      }
    });
  });

  describe("configureLogger", () => {
    test("configures timestamps option", () => {
      const consoleSpy = mock(() => {});
      const originalLog = console.log;
      console.log = consoleSpy;

      try {
        setLogLevel("debug");
        configureLogger({ timestamps: true });
        const log = createLogger("Test");
        log.debug("test");

        // Should include ISO timestamp format
        expect(consoleSpy.mock.calls[0][0]).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

        // Reset
        configureLogger({ timestamps: false });
      } finally {
        console.log = originalLog;
      }
    });

    test("configures custom handler", () => {
      const customHandler = {
        debug: mock(() => {}),
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
      };

      configureLogger({ handler: customHandler });
      setLogLevel("debug");

      try {
        const log = createLogger("Custom");
        log.debug("test debug");
        log.info("test info");
        log.warn("test warn");
        log.error("test error");

        expect(customHandler.debug).toHaveBeenCalledWith("Custom", "test debug");
        expect(customHandler.info).toHaveBeenCalledWith("Custom", "test info");
        expect(customHandler.warn).toHaveBeenCalledWith("Custom", "test warn");
        expect(customHandler.error).toHaveBeenCalledWith("Custom", "test error");
      } finally {
        // Reset handler
        configureLogger({ handler: undefined });
      }
    });
  });

  describe("default logger instance", () => {
    test("logger is a default Hypen logger", () => {
      const consoleSpy = mock(() => {});
      const originalLog = console.log;
      console.log = consoleSpy;

      try {
        setLogLevel("debug");
        logger.debug("test");

        expect(consoleSpy).toHaveBeenCalled();
        expect(consoleSpy.mock.calls[0][0]).toContain("[Hypen]");
      } finally {
        console.log = originalLog;
      }
    });
  });
});
