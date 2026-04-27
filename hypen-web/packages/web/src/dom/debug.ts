/**
 * Debug utilities for DOM rendering visualization
 *
 * Provides heatmap overlays to visualize re-renders
 */

import { frameworkLoggers } from "@hypen-space/core/logger";

const log = frameworkLoggers.debug;

export interface DebugConfig {
  /** Enable debug mode */
  enabled: boolean;
  /** Show heatmap overlays on re-renders */
  showHeatmap: boolean;
  /** Increment per re-render (default: 5%) */
  heatmapIncrement: number;
  /** Maximum opacity for heatmap (default: 0.8) */
  maxOpacity: number;
  /** Fade out duration in ms (0 to disable) */
  fadeOutDuration: number;
}

export const defaultDebugConfig: DebugConfig = {
  enabled: false,
  showHeatmap: true,
  heatmapIncrement: 5,
  maxOpacity: 0.8,
  fadeOutDuration: 2000,
};

/**
 * Tracks re-render counts for each element
 */
export class RerenderTracker {
  private renderCounts = new Map<string, number>();
  private overlays = new Map<string, HTMLDivElement>();
  private config: DebugConfig;

  constructor(config: DebugConfig = defaultDebugConfig) {
    this.config = config;
  }

  /**
   * Update the configuration
   */
  setConfig(config: Partial<DebugConfig>): void {
    this.config = { ...this.config, ...config };

    // If debug mode is disabled, clean up all overlays
    if (!this.config.enabled) {
      this.cleanup();
    }
  }

  /**
   * Track a re-render for an element
   */
  trackRerender(id: string, element: HTMLElement, patchType: string): void {
    if (!this.config.enabled || !this.config.showHeatmap) {
      return;
    }

    log.debug(`Tracking re-render: ${id} - ${patchType}`);

    // Increment render count
    const currentCount = this.renderCounts.get(id) || 0;
    const newCount = currentCount + 1;
    this.renderCounts.set(id, newCount);

    // Create or update heatmap overlay
    this.updateHeatmap(id, element, newCount, patchType);
  }

  /**
   * Create or update the heatmap overlay for an element
   */
  private updateHeatmap(id: string, element: HTMLElement, renderCount: number, patchType: string): void {
    const doc = element.ownerDocument as Document;
    const win = doc.defaultView ?? window;
    // Calculate opacity based on render count (increment by heatmapIncrement% each time)
    const opacity = Math.min(
      (renderCount * this.config.heatmapIncrement) / 100,
      this.config.maxOpacity
    );

    log.debug(`Updating heatmap for ${id}, count: ${renderCount}, opacity: ${opacity}`);

    // For inline elements or text, use a simpler approach: background color + outline
    const isInline = win.getComputedStyle(element).display.includes('inline');

    if (isInline || element.tagName === 'SPAN') {
      // Store original styles if not already stored
      if (!element.dataset.hypenDebugOriginalBg) {
        element.dataset.hypenDebugOriginalBg = element.style.backgroundColor || '';
        element.dataset.hypenDebugOriginalOutline = element.style.outline || '';
        element.dataset.hypenDebugOriginalPosition = element.style.position || '';
      }

      // Apply red background and outline directly to the element
      element.style.backgroundColor = `rgba(255, 0, 0, ${Math.max(opacity, 0.15)})`;
      element.style.outline = `2px solid rgba(255, 0, 0, ${Math.max(opacity + 0.2, 0.3)})`;
      element.style.outlineOffset = '2px';
      element.style.position = 'relative';

      // Add count badge as ::before pseudo-element or data attribute
      element.setAttribute('data-hypen-renders', `${renderCount}× ${patchType}`);

      // Add CSS for the badge if not already added
      if (!doc.getElementById('hypen-debug-styles')) {
        const style = doc.createElement('style');
        style.id = 'hypen-debug-styles';
        style.textContent = `
          [data-hypen-renders]::before {
            content: attr(data-hypen-renders);
            position: absolute;
            top: -18px;
            left: 0;
            background: rgba(255, 0, 0, 0.9);
            color: white;
            padding: 2px 6px;
            font-size: 10px;
            font-family: 'Courier New', monospace;
            font-weight: bold;
            border-radius: 3px;
            z-index: 999999;
            pointer-events: none;
            white-space: nowrap;
            text-shadow: none;
          }
        `;
        doc.head.appendChild(style);
      }

      // Store in overlays map for cleanup
      this.overlays.set(id, element as any);

      // Fade out after duration if enabled
      if (this.config.fadeOutDuration > 0) {
        setTimeout(() => {
          const originalBg = element.dataset.hypenDebugOriginalBg || '';
          const originalOutline = element.dataset.hypenDebugOriginalOutline || '';
          element.style.backgroundColor = originalBg;
          element.style.outline = originalOutline;
          element.style.opacity = '1';
        }, this.config.fadeOutDuration);
      }
    } else {
      // For block elements, use overlay approach
      let overlay = this.overlays.get(id);

      if (!overlay) {
        overlay = doc.createElement("div");
        overlay.className = "hypen-debug-overlay";
        overlay.style.cssText = `
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          pointer-events: none;
          z-index: 999999 !important;
          transition: opacity ${this.config.fadeOutDuration}ms ease-out;
          border: 2px solid rgba(255, 0, 0, 0.7) !important;
          box-sizing: border-box;
          font-size: 11px;
          color: white;
          text-shadow: 0 0 3px black, 0 0 5px black;
          padding: 4px;
          font-family: 'Courier New', monospace;
          font-weight: bold;
          display: block !important;
          visibility: visible !important;
        `;

        const currentPosition = win.getComputedStyle(element).position;
        if (currentPosition === 'static') {
          element.style.position = 'relative';
        }

        element.appendChild(overlay);
        this.overlays.set(id, overlay);
      }

      overlay.style.backgroundColor = `rgba(255, 0, 0, ${Math.max(opacity, 0.15)})`;
      overlay.style.opacity = '1';
      overlay.textContent = `${renderCount}× ${patchType}`;

      if (this.config.fadeOutDuration > 0) {
        setTimeout(() => {
          if (overlay) {
            overlay.style.opacity = '0.2';
          }
        }, this.config.fadeOutDuration);
      }
    }
  }

  /**
   * Reset tracking for a specific element
   */
  reset(id: string): void {
    this.renderCounts.delete(id);
    const overlay = this.overlays.get(id);
    if (overlay) {
      overlay.remove();
      this.overlays.delete(id);
    }
  }

  /**
   * Reset tracking for all elements
   */
  resetAll(): void {
    this.renderCounts.clear();
    for (const overlay of this.overlays.values()) {
      overlay.remove();
    }
    this.overlays.clear();
  }

  /**
   * Get render count for an element
   */
  getRenderCount(id: string): number {
    return this.renderCounts.get(id) || 0;
  }

  /**
   * Clean up all overlays (called when debug mode is disabled)
   */
  private cleanup(): void {
    for (const overlay of this.overlays.values()) {
      overlay.remove();
    }
    this.overlays.clear();
  }

  /**
   * Get statistics about re-renders
   */
  getStats(): { totalRerenders: number; elementCount: number; avgRerenders: number } {
    const totalRerenders = Array.from(this.renderCounts.values()).reduce((sum, count) => sum + count, 0);
    const elementCount = this.renderCounts.size;
    const avgRerenders = elementCount > 0 ? totalRerenders / elementCount : 0;

    return {
      totalRerenders,
      elementCount,
      avgRerenders: Math.round(avgRerenders * 100) / 100,
    };
  }
}
