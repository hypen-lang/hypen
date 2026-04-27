/**
 * Route Component - Lazy rendering container for route content
 * Stores component name as metadata, Router handles actual rendering
 */

import type { ComponentHandler } from "./index.js";
import { frameworkLoggers } from "@hypen-space/core/logger";

const log = frameworkLoggers.router;

export const routeHandler: ComponentHandler = {
  create(doc: Document): HTMLElement {
    const el = doc.createElement("div");
    el.style.display = "flex";
    el.style.flexDirection = "column";
    el.style.width = "100%";
    el.dataset.hypenType = "route";
    el.dataset.routeRendered = "false"; // Track if component has been rendered
    return el;
  },

  applyProps(el: HTMLElement, props: Record<string, any>): void {
    // Extract route path from props
    const path = props.path || props["0"] || "/";
    el.dataset.routePath = String(path);
    
    // Check if this is a lazy route (has __lazy flag)
    const isLazy = props.__lazy === true;
    el.dataset.routeLazy = String(isLazy);
    
    // Store component name - either from explicit prop or from lazy child
    const componentName = props.component || props.__lazy_child;
    if (componentName) {
      el.dataset.routeComponent = String(componentName);
    }
    
    log.debug(`Route created: path="${path}", lazy=${isLazy}, component="${el.dataset.routeComponent || 'none'}"`);
  },
};

