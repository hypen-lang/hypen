/**
 * Template-patch expansion.
 *
 * The engine always emits `registerTemplate`/`instantiate` for plannable
 * iterable rows — that IS the wire format. Boundaries whose consumers
 * cannot exploit template cloning (Canvas renderer, remote streaming)
 * lower the stream back into the exact `create`+`insert` run the
 * pre-template wire carried, using {@link TemplateExpander}.
 *
 * This file MIRRORS the canonical Rust implementation in
 * `hypen-engine-rs/src/portable/patch_expand.rs` — output ordering and
 * prop merging must match it exactly. Unlike `portable.ts` (a DI seam
 * over engine-backed helpers), the expander is a real TypeScript class:
 * it must run where no WASM exists (CanvasRenderer in the browser,
 * RemoteSession on Cloudflare).
 *
 * The expander is *stateful*: registered skeletons persist for the
 * lifetime of a session (a `registerTemplate` goes over the wire once,
 * then every later batch's `instantiate`s reference it), so each
 * boundary owns one `TemplateExpander` per engine session.
 *
 * # Expansion contract
 *
 * For each `instantiate`, walk the registered skeleton in DFS preorder
 * with counter `i`; the element's id is `nodes[i]`. Emit, per element:
 * `create { id, elementType, props, semantics }` immediately followed by
 * `insert` — the same interleaved preorder run the engine's
 * `create_element_node` produces. `create.props` is the skeleton node's
 * static props merged with the `subs` entries for index `i` (subs win on
 * key collision; in practice disjoint — the skeleton excludes dynamic
 * keys). Engine-internal props were already stripped from both sides
 * when the template was planned, so the expander never re-filters. The
 * root's `insert` uses the `instantiate`'s `parentId`/`beforeId`; every
 * other element inserts under its template-parent's assigned id with
 * `beforeId: undefined` (append).
 *
 * `registerTemplate` is consumed (stored) and dropped from the output.
 * An `instantiate` that can't be expanded — unknown template id, or a
 * node-count mismatch against the skeleton — passes through unchanged
 * with a warning, never a throw. A malformed skeleton also passes its
 * `registerTemplate` through, so a downstream consumer that does speak
 * templates still receives the pair intact. All other patch kinds pass
 * through untouched, order preserved.
 */

import { frameworkLoggers } from "./logger.js";
import type { Patch, Semantics } from "./types.js";

const log = frameworkLoggers.engine;

/** One element of a parsed skeleton tree. */
interface SkeletonNode {
  elementType: string;
  /** Static props, in skeleton order. */
  props: Array<[string, any]>;
  children: SkeletonNode[];
}

function countNodes(node: SkeletonNode): number {
  let count = 1;
  for (const child of node.children) count += countNodes(child);
  return count;
}

/**
 * Parse a `registerTemplate.root` payload
 * (`{elementType, props, children: [...]}`). `null` = malformed.
 */
function parseSkeleton(value: any): SkeletonNode | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const elementType = value.elementType;
  if (typeof elementType !== "string") return null;

  let props: Array<[string, any]>;
  const rawProps = value.props;
  if (rawProps === undefined || rawProps === null) {
    props = [];
  } else if (typeof rawProps === "object" && !Array.isArray(rawProps)) {
    props = Object.entries(rawProps);
  } else {
    return null;
  }

  let children: SkeletonNode[];
  const rawChildren = value.children;
  if (rawChildren === undefined || rawChildren === null) {
    children = [];
  } else if (Array.isArray(rawChildren)) {
    children = [];
    for (const child of rawChildren) {
      const parsed = parseSkeleton(child);
      if (parsed === null) return null;
      children.push(parsed);
    }
  } else {
    return null;
  }

  return { elementType, props, children };
}

/**
 * Lowers template patches (`registerTemplate`/`instantiate`) back into the
 * plain `create`+`insert` runs they replace. One instance per engine
 * session per boundary — see the module docs for the full contract.
 */
export class TemplateExpander {
  /** Registered skeletons with their precomputed element counts. */
  private templates = new Map<string, { skeleton: SkeletonNode; count: number }>();

  /**
   * Store a skeleton for later `instantiate` expansion. Returns `false`
   * (and warns) when the skeleton is malformed and was not stored.
   */
  register(templateId: string, root: any): boolean {
    const skeleton = parseSkeleton(root);
    if (skeleton === null) {
      log.warn(
        `template expander: malformed skeleton for template "${templateId}"; ` +
          `passing template patches through unexpanded`,
      );
      return false;
    }
    this.templates.set(templateId, { skeleton, count: countNodes(skeleton) });
    return true;
  }

  /**
   * Process one patch batch: consume `registerTemplate`s, expand
   * `instantiate`s in place, pass every other patch through untouched.
   * Order is preserved.
   */
  expand(patches: Patch[]): Patch[] {
    if (
      !patches.some(
        (p) => p.type === "registerTemplate" || p.type === "instantiate",
      )
    ) {
      return patches;
    }

    const out: Patch[] = [];
    for (const patch of patches) {
      if (patch.type === "registerTemplate") {
        if (!this.register(patch.templateId!, patch.root)) {
          out.push(patch);
        }
      } else if (patch.type === "instantiate") {
        const entry = this.templates.get(patch.templateId!);
        const nodes = patch.nodes ?? [];
        if (!entry) {
          log.warn(
            `template expander: instantiate for unknown template ` +
              `"${patch.templateId}"; passing through`,
          );
          out.push(patch);
        } else if (entry.count !== nodes.length) {
          log.warn(
            `template expander: instantiate for "${patch.templateId}" carries ` +
              `${nodes.length} node ids but the skeleton has ${entry.count} ` +
              `elements; passing through`,
          );
          out.push(patch);
        } else {
          expandInstantiate(entry.skeleton, patch, out);
        }
      } else {
        out.push(patch);
      }
    }
    return out;
  }
}

/**
 * Emit the interleaved `create`+`insert` preorder run for one instance.
 * Caller guarantees `patch.nodes.length` equals the skeleton's element
 * count.
 */
function expandInstantiate(
  skeleton: SkeletonNode,
  patch: Patch,
  out: Patch[],
): void {
  const nodes = patch.nodes!;
  const subsByNode = new Map<number, Array<[string, any]>>();
  for (const [index, key, value] of patch.subs ?? []) {
    let list = subsByNode.get(index);
    if (!list) {
      list = [];
      subsByNode.set(index, list);
    }
    list.push([key, value]);
  }
  const semanticsByNode = new Map<number, Semantics>(patch.nodeSemantics ?? []);

  let dfs = 0;
  const walk = (
    node: SkeletonNode,
    parentId: string,
    beforeId: string | undefined,
  ): void => {
    const myIndex = dfs;
    dfs += 1;
    const id = nodes[myIndex]!;

    const props: Record<string, any> = {};
    for (const [key, value] of node.props) {
      props[key] = value;
    }
    // Dynamic props travel per instance; they win on (theoretical)
    // key collision because they carry the instance's resolved value.
    for (const [key, value] of subsByNode.get(myIndex) ?? []) {
      props[key] = value;
    }

    const create: Patch = { type: "create", id, elementType: node.elementType, props };
    const semantics = semanticsByNode.get(myIndex);
    if (semantics !== undefined) {
      create.semantics = semantics;
    }
    out.push(create);
    const insert: Patch = { type: "insert", parentId, id };
    if (beforeId !== undefined) {
      insert.beforeId = beforeId;
    }
    out.push(insert);

    for (const child of node.children) {
      // Non-root elements always append under their parent.
      walk(child, id, undefined);
    }
  };

  walk(skeleton, patch.parentId!, patch.beforeId);
}
