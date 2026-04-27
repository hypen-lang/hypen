/**
 * Built-in Hypen Components
 * Framework-provided components like Router and Route
 */

import { app } from "../app.js";
import { frameworkLoggers } from "../logger.js";

const log = frameworkLoggers.router;

/**
 * Interface for the engine methods needed by route visibility updates
 */
export interface RouteEngine {
  renderLazyRoute(path: string, component: string, element: HTMLElement): Promise<void>;
  getState(): Record<string, unknown>;
}

/**
 * Update route visibility based on the current path.
 * Shows the matching route element and hides all others.
 * For lazy routes (or routes without content), triggers rendering via the engine.
 *
 * @param currentPath - The path to match against route elements
 * @param engine - Optional engine for lazy route rendering
 * @param doc - Document to query for route elements (defaults to global document)
 */
export async function updateRouteVisibility(
  currentPath: string,
  engine?: RouteEngine,
  doc?: Document
): Promise<void> {
  const targetDoc = doc ?? document;
  const routeElements = targetDoc.querySelectorAll(
    '[data-hypen-type="route"]'
  );

  let matchFound = false;

  for (let index = 0; index < routeElements.length; index++) {
    const routeEl = routeElements[index];
    const htmlEl = routeEl as HTMLElement;
    const routePath = htmlEl.dataset.routePath || "/";

    // Simple path matching (exact match for now)
    const isMatch = routePath === currentPath;

    // Only show the matching route, hide all others
    htmlEl.style.display = isMatch ? "flex" : "none";

    if (isMatch) {
      matchFound = true;

      // Check if this route needs to be rendered
      const componentName = htmlEl.dataset.routeComponent;
      const isLazy = htmlEl.dataset.routeLazy === "true";
      const hasContent = htmlEl.children.length > 0;

      // Always re-render lazy routes; render non-lazy only if they have no content
      const shouldRender = componentName && engine && (isLazy || !hasContent);

      if (shouldRender) {
        try {
          await engine.renderLazyRoute(
            routePath,
            componentName,
            htmlEl
          );
        } catch (err) {
          log.error(`Failed to render route ${routePath}:`, err);
        }
      }
    }
  }

  if (!matchFound) {
    log.warn(
      `No route matched path: ${currentPath}. Available routes:`,
      Array.from(routeElements).map(
        (el: Element) => (el as HTMLElement).dataset.routePath
      )
    );
  }
}

/**
 * Router Component
 * Automatically matches routes and renders the appropriate child Route
 *
 * Usage in Hypen DSL:
 * Router {
 *   Route(path: "/") { HomePage }
 *   Route(path: "/products") { ProductList }
 *   Route(path: "/users/:id") { UserProfile }
 * }
 */
export const Router = app
  .defineState(
    {
      currentPath: "/",
      matchedRoute: null as any,
      routeParams: {} as Record<string, string>,
    },
    { name: "__Router" }
  )
  .onCreated((state, context) => {
    if (!context) {
      log.error("Requires global context");
      return;
    }

    // Subscribe to router changes
    const router = context.router;
    if (!router) {
      log.error("Router not found in context");
      return;
    }

    // Get access to the Hypen engine for lazy rendering
    const hypenEngine = (context as any).__hypenEngine as RouteEngine | undefined;

    // Initial route visibility (after DOM is ready)
    setTimeout(() => {
      updateRouteVisibility(state.currentPath, hypenEngine);
    }, 100);

    router.onNavigate((routeState) => {
      state.currentPath = routeState.currentPath;
      state.routeParams = routeState.params;

      // Update route visibility when path changes
      updateRouteVisibility(routeState.currentPath, hypenEngine);
    });
  })
  .build();

/**
 * Route Component
 * Defines a route pattern and its content
 * This is just a marker component - Router processes it
 *
 * Props:
 * - path: string - Route pattern (e.g., "/", "/users/:id", "/dashboard/*")
 *
 * Usage:
 * Route(path: "/products") {
 *   ProductList
 * }
 */
export const Route = app.defineState({}, { name: "__Route" }).build();

/**
 * Navigation Link Component
 * Navigates to a route when clicked
 *
 * Props:
 * - to: string - Target path
 *
 * Usage:
 * Link(to: "/products") {
 *   Text("View Products")
 * }
 */
export const Link = app
  .defineState(
    {
      to: "/",
      isActive: false,
    },
    { name: "__Link" }
  )
  .onAction("navigate", ({ state, context }) => {
    const router = context?.router;
    if (!router) {
      log.error("Link requires router context");
      return;
    }

    const targetPath = state.to;
    router.push(targetPath);
  })
  .onCreated((state, context) => {
    if (!context) return;

    // Check if current path matches this link's target
    const router = context.router;
    if (router) {
      router.onNavigate((routeState) => {
        state.isActive = routeState.currentPath === state.to;
      });
    }
  })
  .build();
