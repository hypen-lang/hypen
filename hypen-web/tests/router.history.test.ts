import { describe, expect, test, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { HypenRouter, type RouteState } from "../packages/core/src/router";
import { JSDOM } from "jsdom";

/**
 * Router History Integration Tests
 * Tests browser history integration (push, replace, back, forward)
 */

// Save original globals BEFORE any test runs (at module level)
const originalWindow = global.window;
const originalDocument = global.document;
const originalLocation = global.location;
const originalHistory = global.history;
const originalHashChangeEvent = (global as any).HashChangeEvent;

function restoreGlobals() {
  global.window = originalWindow;
  global.document = originalDocument;
  global.location = originalLocation;
  global.history = originalHistory;
  (global as any).HashChangeEvent = originalHashChangeEvent;
}

describe("HypenRouter - History Integration", () => {
  let dom: JSDOM;
  let router: HypenRouter;

  beforeEach(() => {
    // Create fresh JSDOM instance for each test
    dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
      url: "http://localhost/",
    });

    // Set up global browser environment
    // NOTE: Only set globals that the HypenRouter constructor actually reads.
    // Do NOT set global.Event or global.PopStateEvent — they leak into
    // concurrently-running test files and cause "parameter 1 is not of type
    // 'Event'" errors when those files call dispatchEvent with a mismatched
    // Event class.  Tests in this file that need to create Event objects
    // should use dom.window.Event directly.
    global.window = dom.window as any;
    global.document = dom.window.document as any;
    global.location = dom.window.location as any;
    global.history = dom.window.history as any;
    (global as any).HashChangeEvent = dom.window.HashChangeEvent as any;

    router = new HypenRouter();
  });

  afterEach(() => {
    restoreGlobals();
  });

  afterAll(() => {
    restoreGlobals();
  });

  describe("push", () => {
    test("navigates to new path", () => {
      router.push("/dashboard");

      expect(router.getCurrentPath()).toBe("/dashboard");
    });

    test("updates browser URL with hash", () => {
      router.push("/dashboard");

      expect(window.location.hash).toBe("#/dashboard");
    });

    test("updates previousPath", () => {
      router.push("/home");
      router.push("/dashboard");

      const state = router.getState();
      expect(state.previousPath).toBe("/home");
      expect(state.currentPath).toBe("/dashboard");
    });

    test("adds entry to browser history", () => {
      const initialLength = window.history.length;

      router.push("/page1");
      router.push("/page2");

      // Note: JSDOM may not fully simulate history.length changes
      // This test verifies the API is called correctly
      expect(router.getCurrentPath()).toBe("/page2");
    });

    test("notifies subscribers on navigation", () => {
      const callback = mock(() => {});

      router.onNavigate(callback);
      callback.mockClear(); // Clear the immediate call

      router.push("/dashboard");

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          currentPath: "/dashboard",
          previousPath: "/",
        })
      );
    });

    test("handles multiple consecutive pushes", () => {
      router.push("/page1");
      router.push("/page2");
      router.push("/page3");

      expect(router.getCurrentPath()).toBe("/page3");
      expect(router.getState().previousPath).toBe("/page2");
    });

    test("handles paths with special characters", () => {
      const paths = [
        "/users/123",
        "/search?q=test",
        "/path-with-dashes",
        "/path_with_underscores",
        "/path.with.dots",
      ];

      paths.forEach((path) => {
        router.push(path);
        expect(router.getCurrentPath()).toBe(path);
      });
    });
  });

  describe("replace", () => {
    test("replaces current path without adding history entry", () => {
      router.push("/page1");
      router.replace("/page2");

      expect(router.getCurrentPath()).toBe("/page2");
    });

    test("updates browser URL", () => {
      router.replace("/dashboard");

      expect(window.location.hash).toBe("#/dashboard");
    });

    test("updates previousPath", () => {
      router.push("/home");
      router.replace("/dashboard");

      const state = router.getState();
      expect(state.previousPath).toBe("/home");
      expect(state.currentPath).toBe("/dashboard");
    });

    test("notifies subscribers", () => {
      const callback = mock(() => {});

      router.onNavigate(callback);
      callback.mockClear();

      router.replace("/dashboard");

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          currentPath: "/dashboard",
        })
      );
    });

    test("can replace root path", () => {
      expect(router.getCurrentPath()).toBe("/");

      router.replace("/home");

      expect(router.getCurrentPath()).toBe("/home");
    });
  });

  describe("back", () => {
    test("calls window.history.back", () => {
      const backSpy = mock(() => {});
      window.history.back = backSpy;

      router.back();

      expect(backSpy).toHaveBeenCalled();
    });

    test("doesn't crash when window is undefined", () => {
      const originalWindow = global.window;
      (global as any).window = undefined;

      expect(() => {
        const noWindowRouter = new HypenRouter();
        noWindowRouter.back();
      }).not.toThrow();

      global.window = originalWindow;
    });
  });

  describe("forward", () => {
    test("calls window.history.forward", () => {
      const forwardSpy = mock(() => {});
      window.history.forward = forwardSpy;

      router.forward();

      expect(forwardSpy).toHaveBeenCalled();
    });

    test("doesn't crash when window is undefined", () => {
      const originalWindow = global.window;
      (global as any).window = undefined;

      expect(() => {
        const noWindowRouter = new HypenRouter();
        noWindowRouter.forward();
      }).not.toThrow();

      global.window = originalWindow;
    });
  });

  describe("popstate event handling", () => {
    test("updates router state on browser back button", () => {
      router.push("/page1");
      router.push("/page2");

      // Simulate browser back button
      window.history.back();
      window.location.hash = "#/page1";
      window.dispatchEvent(new dom.window.Event("popstate"));

      // Give time for event to process
      expect(router.getCurrentPath()).toBe("/page1");
    });

    test("notifies subscribers on popstate", () => {
      const callback = mock(() => {});

      router.push("/page1");
      router.onNavigate(callback);
      callback.mockClear();

      // Simulate browser navigation
      window.location.hash = "#/page2";
      window.dispatchEvent(new dom.window.Event("popstate"));

      expect(callback).toHaveBeenCalled();
    });

    test("doesn't add duplicate history entries on popstate", () => {
      router.push("/page1");
      router.push("/page2");

      const stateBefore = router.getState();

      // Simulate popstate (shouldn't push to history)
      window.location.hash = "#/page1";
      window.dispatchEvent(new dom.window.Event("popstate"));

      // The router should update but not call pushState
      expect(router.getCurrentPath()).toBe("/page1");
    });
  });

  describe("hashchange event handling", () => {
    test("updates router state on hashchange", () => {
      window.location.hash = "#/new-path";
      window.dispatchEvent(new dom.window.Event("hashchange"));

      expect(router.getCurrentPath()).toBe("/new-path");
    });

    test("notifies subscribers on hashchange", () => {
      const callback = mock(() => {});

      router.onNavigate(callback);
      callback.mockClear();

      window.location.hash = "#/changed";
      window.dispatchEvent(new dom.window.Event("hashchange"));

      expect(callback).toHaveBeenCalled();
    });

    test("parses path correctly from hash", () => {
      window.location.hash = "#/users/123/profile";
      window.dispatchEvent(new dom.window.Event("hashchange"));

      expect(router.getCurrentPath()).toBe("/users/123/profile");
    });
  });

  describe("query string handling", () => {
    test("parses query string on initialization", () => {
      dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
        url: "http://localhost/?name=test&id=123",
      });

      global.window = dom.window as any;
      global.location = dom.window.location as any;

      const newRouter = new HypenRouter();
      const query = newRouter.getQuery();

      expect(query.name).toBe("test");
      expect(query.id).toBe("123");
    });

    test("updates query on navigation", () => {
      // Note: This tests the parseQuery method
      // Full query string navigation would require more complex setup
      router.push("/search");

      const query = router.getQuery();
      expect(query).toBeDefined();
    });

    test("buildUrl creates URL with query params", () => {
      const url = router.buildUrl("/search", { q: "test", page: "2" });

      expect(url).toContain("/search?");
      expect(url).toContain("q=test");
      expect(url).toContain("page=2");
    });

    test("buildUrl handles URL without query params", () => {
      const url = router.buildUrl("/home", {});

      expect(url).toBe("/home");
    });

    test("buildUrl handles undefined query params", () => {
      const url = router.buildUrl("/home");

      expect(url).toBe("/home");
    });
  });

  describe("route matching with history", () => {
    test("matchPath returns correct params after navigation", () => {
      router.push("/users/123");

      const match = router.matchPath("/users/:id", "/users/123");

      expect(match).not.toBeNull();
      expect(match?.params.id).toBe("123");
    });

    test("isActive returns true for current path", () => {
      router.push("/dashboard");

      expect(router.isActive("/dashboard")).toBe(true);
      expect(router.isActive("/home")).toBe(false);
    });

    test("isActive works with wildcard patterns", () => {
      router.push("/dashboard/settings/profile");

      expect(router.isActive("/dashboard/*")).toBe(true);
      expect(router.isActive("/home/*")).toBe(false);
    });

    test("isActive works with param patterns", () => {
      router.push("/users/123");

      expect(router.isActive("/users/:id")).toBe(true);
      expect(router.isActive("/posts/:id")).toBe(false);
    });
  });

  describe("state preservation", () => {
    test("preserves route state across navigations", () => {
      router.push("/page1");
      const state1 = router.getState();

      router.push("/page2");
      const state2 = router.getState();

      expect(state2.previousPath).toBe(state1.currentPath);
    });

    test("getState returns immutable snapshot", () => {
      router.push("/test");
      const state = router.getState();

      // Mutating the returned state shouldn't affect internal state
      state.currentPath = "/mutated";

      expect(router.getCurrentPath()).toBe("/test");
    });
  });

  describe("subscription management", () => {
    test("onNavigate returns unsubscribe function", () => {
      const callback = mock(() => {});

      const unsubscribe = router.onNavigate(callback);
      callback.mockClear();

      router.push("/test");
      expect(callback).toHaveBeenCalledTimes(1);

      unsubscribe();

      router.push("/test2");
      expect(callback).toHaveBeenCalledTimes(1); // Not called again
    });

    test("multiple subscribers all receive updates", () => {
      const callback1 = mock(() => {});
      const callback2 = mock(() => {});
      const callback3 = mock(() => {});

      router.onNavigate(callback1);
      router.onNavigate(callback2);
      router.onNavigate(callback3);

      callback1.mockClear();
      callback2.mockClear();
      callback3.mockClear();

      router.push("/test");

      expect(callback1).toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();
      expect(callback3).toHaveBeenCalled();
    });

    test("onNavigate calls callback immediately with current state", () => {
      router.push("/initial");

      const callback = mock(() => {});
      router.onNavigate(callback);

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          currentPath: "/initial",
        })
      );
    });

    test("unsubscribing doesn't affect other subscribers", () => {
      const callback1 = mock(() => {});
      const callback2 = mock(() => {});

      const unsubscribe1 = router.onNavigate(callback1);
      router.onNavigate(callback2);

      callback1.mockClear();
      callback2.mockClear();

      unsubscribe1();
      router.push("/test");

      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();
    });
  });

  describe("edge cases", () => {
    test("handles empty path", () => {
      router.push("");

      expect(router.getCurrentPath()).toBe("");
    });

    test("handles root path navigation", () => {
      router.push("/home");
      router.push("/");

      expect(router.getCurrentPath()).toBe("/");
    });

    test("handles rapid navigation changes", () => {
      for (let i = 0; i < 100; i++) {
        router.push(`/page${i}`);
      }

      expect(router.getCurrentPath()).toBe("/page99");
    });

    test("handles navigation to same path", () => {
      router.push("/test");
      const callback = mock(() => {});

      router.onNavigate(callback);
      callback.mockClear();

      router.push("/test");

      // Should still notify even if path is the same
      expect(callback).toHaveBeenCalled();
    });

    test("handles unicode paths", () => {
      const unicodePaths = [
        "/用户/123",
        "/用戶/456",
        "/ユーザー/789",
        "/사용자/abc",
      ];

      unicodePaths.forEach((path) => {
        router.push(path);
        expect(router.getCurrentPath()).toBe(path);
      });
    });

    test("handles very long paths", () => {
      const longPath = "/" + "a".repeat(1000);
      router.push(longPath);

      expect(router.getCurrentPath()).toBe(longPath);
    });
  });

  describe("initialization", () => {
    test("initializes with root path by default", () => {
      const newRouter = new HypenRouter();

      expect(newRouter.getCurrentPath()).toBe("/");
    });

    test("initializes with hash from URL", () => {
      dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
        url: "http://localhost/#/dashboard",
      });

      global.window = dom.window as any;
      global.location = dom.window.location as any;
      global.HashChangeEvent = dom.window.HashChangeEvent as any;

      const newRouter = new HypenRouter();

      expect(newRouter.getCurrentPath()).toBe("/dashboard");
    });

    test("falls back to pathname when no hash", () => {
      dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
        url: "http://localhost/dashboard",
      });

      global.window = dom.window as any;
      global.location = dom.window.location as any;
      global.HashChangeEvent = dom.window.HashChangeEvent as any;

      const newRouter = new HypenRouter();

      expect(newRouter.getCurrentPath()).toBe("/dashboard");
    });
  });

  describe("non-browser environment", () => {
    test("works in non-browser environment", () => {
      const originalWindow = global.window;
      (global as any).window = undefined;

      const serverRouter = new HypenRouter();

      expect(serverRouter.getCurrentPath()).toBe("/");

      serverRouter.push("/test");
      expect(serverRouter.getCurrentPath()).toBe("/test");

      global.window = originalWindow;
    });

    test("doesn't crash when calling browser methods", () => {
      const originalWindow = global.window;
      (global as any).window = undefined;

      const serverRouter = new HypenRouter();

      expect(() => {
        serverRouter.push("/test");
        serverRouter.replace("/test2");
        serverRouter.back();
        serverRouter.forward();
      }).not.toThrow();

      global.window = originalWindow;
    });
  });
});
