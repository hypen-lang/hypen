/**
 * Hypen Tagged Template Literal
 *
 * Enables single-file components with inline UI templates.
 *
 * The `hypen` tagged template preserves @{state.x} and @{item.x} bindings
 * instead of interpolating them, allowing you to write:
 *
 * @example
 * ```typescript
 * import { app, hypen, state } from "@hypen-space/core";
 *
 * export default app
 *   .defineState({ count: 0 })
 *   .onAction("increment", ({ state }) => {
 *     state.count += 1;
 *   })
 *   .ui(hypen`
 *     Column {
 *       Text("Count: @{state.count}")
 *       Button { Text("+") }
 *         .onClick("@actions.increment")
 *     }
 *   `);
 * ```
 */

/**
 * Creates a proxy that captures property access as a binding path string.
 *
 * When used in a template literal, the proxy's toString() returns the
 * full binding expression (e.g., "@{state.user.name}"). This lets you
 * interpolate JS variables into hypen templates without losing type safety.
 *
 * @example
 * ```typescript
 * const state = createBindingProxy('state');
 * String(state.user.name) // Returns: "@{state.user.name}"
 * ```
 */
function createBindingProxy(root: string): any {
  const handler: ProxyHandler<object> = {
    get(_, prop: string | symbol): any {
      // Handle Symbol.toPrimitive, toString, and valueOf for string conversion
      if (
        prop === Symbol.toPrimitive ||
        prop === "toString" ||
        prop === "valueOf"
      ) {
        return () => `@{${root}}`;
      }

      // Handle other Symbol properties (e.g., Symbol.toStringTag)
      if (typeof prop === "symbol") {
        return undefined;
      }

      // Handle JSON.stringify
      if (prop === "toJSON") {
        return () => `@{${root}}`;
      }

      // Chain to nested property: state.user -> state.user.name
      return createBindingProxy(`${root}.${prop}`);
    },

    // Support for `in` operator
    has() {
      return true;
    },

    // Support for Object.keys() - return empty to avoid enumeration issues
    ownKeys() {
      return [];
    },

    getOwnPropertyDescriptor() {
      return {
        configurable: true,
        enumerable: true,
      };
    },
  };

  return new Proxy({} as any, handler);
}

/**
 * Proxy for state bindings.
 *
 * In hypen templates, prefer the direct `@{state.x}` syntax. This proxy
 * exists for cases where you want to interpolate JS values into templates
 * — e.g., `hypen\`Text("${state.user.name}")\`` produces the same string
 * as `hypen\`Text("@{state.user.name}")\``.
 *
 * @example
 * ```typescript
 * // Preferred: direct syntax
 * hypen`Text("Hello, @{state.user.name}")`
 *
 * // Also works: proxy interpolation
 * hypen`Text("Hello, ${state.user.name}")`
 * ```
 */
export const state: any = createBindingProxy("state");

/**
 * Proxy for item bindings in list iteration.
 *
 * Use inside List components to reference the current item:
 *
 * @example
 * ```typescript
 * hypen`
 *   List(@state.items) {
 *     Text("@{item.name}: @{item.price}")
 *   }
 * `
 * ```
 */
export const item: any = createBindingProxy("item");

/**
 * Proxy for index in list iteration.
 *
 * Use inside List components to reference the current index:
 *
 * @example
 * ```typescript
 * hypen`
 *   List(@state.items) {
 *     Text("Item #@{index}: @{item.name}")
 *   }
 * `
 * ```
 */
export const index: any = {
  [Symbol.toPrimitive]: () => "@{index}",
  toString: () => "@{index}",
  valueOf: () => "@{index}",
  toJSON: () => "@{index}",
};

/**
 * Tagged template literal for Hypen DSL templates.
 *
 * Prefer the direct `@{state.x}` / `@{item.x}` syntax. The `state`, `item`,
 * and `index` proxies are available for interpolating JS variables or
 * mixing dynamic content with bindings.
 *
 * @example
 * ```typescript
 * import { hypen, state, item } from "@hypen-space/core";
 *
 * // Preferred: direct binding syntax
 * const t1 = hypen`Text("Count: @{state.count}")`;
 *
 * // Nested paths work the same way
 * const t2 = hypen`Text("Hello, @{state.user.profile.name}")`;
 *
 * // List with item binding
 * const t3 = hypen`
 *   List(@state.products) {
 *     Text("@{item.name} - $@{item.price}")
 *   }
 * `;
 *
 * // Interpolate JS variables alongside bindings
 * const title = "My App";
 * const t4 = hypen`Text("${title}: @{state.count}")`;
 * // Result: 'Text("My App: @{state.count}")'
 * ```
 *
 * @param strings - Template literal string parts
 * @param expressions - Interpolated JS values or binding proxies
 * @returns The template string with bindings preserved
 */
export function hypen(
  strings: TemplateStringsArray,
  ...expressions: unknown[]
): string {
  let result = strings[0];

  for (let i = 0; i < expressions.length; i++) {
    const expr = expressions[i];

    // Convert expression to string
    // Binding proxies will return "@{state.x}" via their toString()
    result += String(expr);
    result += strings[i + 1]!;
  }

  return result!.trim();
}

/**
 * Type helper for defining state shape.
 * Use with state proxy for better IDE support in complex scenarios.
 *
 * @example
 * ```typescript
 * type MyState = { user: { name: string; age: number } };
 * const typedState = state as StateProxy<MyState>;
 * ```
 */
export type StateProxy<T> = {
  [K in keyof T]: T[K] extends object
    ? StateProxy<T[K]> & { toString(): string }
    : { toString(): string };
} & { toString(): string };

/**
 * Type helper for item proxy in lists.
 */
export type ItemProxy<T> = StateProxy<T>;
