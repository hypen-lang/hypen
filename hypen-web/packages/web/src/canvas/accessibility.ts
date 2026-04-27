/**
 * Accessibility Layer
 *
 * Maintain shadow DOM for screen readers
 */

import type { VirtualNode } from "./types.js";
import { walkTree } from "./utils.js";

/**
 * Accessibility Manager
 */
export class AccessibilityLayer {
  private shadowRoot: HTMLElement;
  private nodeMap = new Map<string, HTMLElement>();
  private enabled: boolean;

  constructor(container: HTMLElement | null, enabled: boolean = true) {
    this.enabled = enabled && typeof document !== "undefined";

    // Create shadow root container (only in browser)
    if (this.enabled && typeof document !== "undefined") {
      this.shadowRoot = document.createElement("div");
      this.shadowRoot.setAttribute("role", "application");
      this.shadowRoot.setAttribute("aria-label", "Hypen Canvas Application");
      this.shadowRoot.style.position = "absolute";
      this.shadowRoot.style.left = "-9999px";
      this.shadowRoot.style.width = "1px";
      this.shadowRoot.style.height = "1px";
      this.shadowRoot.style.overflow = "hidden";

      if (container) {
        container.appendChild(this.shadowRoot);
      }
    } else {
      // Fallback for non-browser environments
      this.shadowRoot = {} as HTMLElement;
    }
  }

  /**
   * Sync shadow DOM with virtual tree
   */
  syncTree(root: VirtualNode): void {
    if (!this.enabled) return;

    // Clear existing
    this.shadowRoot.innerHTML = "";
    this.nodeMap.clear();

    // Build shadow DOM
    const shadowNode = this.createShadowNode(root);
    if (shadowNode) {
      this.shadowRoot.appendChild(shadowNode);
    }
  }

  /**
   * Create shadow DOM element for virtual node
   */
  private createShadowNode(node: VirtualNode): HTMLElement | null {
    if (!node.visible) return null;

    let element: HTMLElement;

    // Create appropriate HTML element
    switch (node.type.toLowerCase()) {
      case "button":
        element = document.createElement("button");
        element.textContent = this.getNodeText(node);
        if (node.props.onclick) {
          element.setAttribute("aria-label", "Clickable button");
        }
        break;

      case "input":
        element = document.createElement("input");
        (element as HTMLInputElement).type = node.props.type || "text";
        (element as HTMLInputElement).value = node.props.value || "";
        if (node.props.placeholder) {
          (element as HTMLInputElement).placeholder = node.props.placeholder;
        }
        break;

      case "textarea":
        element = document.createElement("textarea");
        (element as HTMLTextAreaElement).value = node.props.value || "";
        if (node.props.placeholder) {
          (element as HTMLTextAreaElement).placeholder = node.props.placeholder;
        }
        break;

      case "image":
        element = document.createElement("img");
        (element as HTMLImageElement).src = node.props.src || "";
        (element as HTMLImageElement).alt = node.props.alt || "Image";
        break;

      case "text":
        element = document.createElement("span");
        element.textContent = String(node.props[0] || node.props.text || "");
        break;

      case "column":
      case "row":
      case "container":
      case "box":
        element = document.createElement("div");
        element.setAttribute("role", node.type === "column" ? "group" : "group");
        break;

      default:
        element = document.createElement("div");
    }

    // Set common attributes
    element.setAttribute("data-hypen-id", node.id);

    if (node.props["aria-label"]) {
      element.setAttribute("aria-label", node.props["aria-label"]);
    }

    if (node.focusable) {
      element.tabIndex = 0;
    }

    // Store mapping
    this.nodeMap.set(node.id, element);

    // Add children
    for (const child of node.children) {
      const childElement = this.createShadowNode(child);
      if (childElement) {
        element.appendChild(childElement);
      }
    }

    return element;
  }

  /**
   * Get text content from node tree
   */
  private getNodeText(node: VirtualNode): string {
    if (node.type === "text") {
      return String(node.props[0] || node.props.text || "");
    }

    let text = "";
    for (const child of node.children) {
      text += this.getNodeText(child);
    }
    return text;
  }

  /**
   * Focus node in shadow DOM
   */
  focusNode(nodeId: string): void {
    if (!this.enabled) return;

    const element = this.nodeMap.get(nodeId);
    if (element) {
      element.focus();
    }
  }

  /**
   * Update single node
   */
  updateNode(node: VirtualNode): void {
    if (!this.enabled) return;

    const element = this.nodeMap.get(node.id);
    if (!element) return;

    // Update text content
    if (node.type === "text") {
      element.textContent = String(node.props[0] || node.props.text || "");
    }

    // Update input value
    if (node.type === "input" || node.type === "textarea") {
      (element as HTMLInputElement | HTMLTextAreaElement).value = node.props.value || "";
    }

    // Update visibility
    element.style.display = node.visible ? "" : "none";
  }

  /**
   * Get shadow element by node ID
   */
  getElement(nodeId: string): HTMLElement | undefined {
    return this.nodeMap.get(nodeId);
  }

  /**
   * Enable or disable accessibility layer
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled && this.shadowRoot.parentElement) {
      this.shadowRoot.remove();
    }
  }

  /**
   * Cleanup
   */
  destroy(): void {
    if (this.shadowRoot.parentElement) {
      this.shadowRoot.remove();
    }
    this.nodeMap.clear();
  }
}

