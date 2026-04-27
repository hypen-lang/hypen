/**
 * Renderer abstraction interface
 *
 * Renderers are pluggable and can be implemented for different platforms
 * (DOM, Canvas, Native, etc.)
 */

import type { Patch } from "./types.js";
import { frameworkLoggers } from "./logger.js";

const log = frameworkLoggers.renderer;

/**
 * Renderer interface that all platform renderers must implement
 */
export interface Renderer {
  /**
   * Apply a batch of patches to the render tree
   */
  applyPatches(patches: Patch[]): void;

  /**
   * Get a node by its ID (optional, for debugging)
   */
  getNode?(id: string): any;

  /**
   * Clear the entire render tree
   */
  clear?(): void;
}

/**
 * Base renderer class with common utilities
 */
export abstract class BaseRenderer implements Renderer {
  protected nodes: Map<string, any> = new Map();

  abstract applyPatches(patches: Patch[]): void;

  getNode(id: string): any {
    return this.nodes.get(id);
  }

  clear(): void {
    this.nodes.clear();
  }

  /**
   * Apply a single patch
   */
  protected applyPatch(patch: Patch): void {
    switch (patch.type) {
      case "create":
        this.onCreate(patch.id!, patch.elementType!, patch.props || {});
        break;
      case "setProp":
        this.onSetProp(patch.id!, patch.name!, patch.value);
        break;
      case "setText":
        this.onSetText(patch.id!, patch.text!);
        break;
      case "insert":
        this.onInsert(patch.parentId!, patch.id!, patch.beforeId);
        break;
      case "move":
        this.onMove(patch.parentId!, patch.id!, patch.beforeId);
        break;
      case "remove":
        this.onRemove(patch.id!);
        break;
      case "attachEvent":
        this.onAttachEvent(patch.id!, patch.eventName!);
        break;
      case "detachEvent":
        this.onDetachEvent(patch.id!, patch.eventName!);
        break;
    }
  }

  /**
   * Platform-specific patch handlers
   */
  protected abstract onCreate(id: string, elementType: string, props: Record<string, any>): void;
  protected abstract onSetProp(id: string, name: string, value: any): void;
  protected abstract onSetText(id: string, text: string): void;
  protected abstract onInsert(parentId: string, id: string, beforeId?: string): void;
  protected abstract onMove(parentId: string, id: string, beforeId?: string): void;
  protected abstract onRemove(id: string): void;
  protected abstract onAttachEvent(id: string, eventName: string): void;
  protected abstract onDetachEvent(id: string, eventName: string): void;
}

/**
 * Console/Debug renderer that logs patches
 */
export class ConsoleRenderer implements Renderer {
  applyPatches(patches: Patch[]): void {
    console.group("Hypen Patches");
    for (const patch of patches) {
      console.log(patch);
    }
    console.groupEnd();
  }
}
