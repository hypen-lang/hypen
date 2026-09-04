export type Listener = (event: any) => void;

/**
 * Fake CSSRule for testing
 */
export class FakeCSSRule {
  constructor(public cssText: string) {}
}

/**
 * Fake CSSStyleSheet for testing variant handling
 */
export class FakeCSSStyleSheet {
  public cssRules: FakeCSSRule[] = [];

  insertRule(rule: string, index: number): number {
    const cssRule = new FakeCSSRule(rule);
    if (index >= this.cssRules.length) {
      this.cssRules.push(cssRule);
    } else {
      this.cssRules.splice(index, 0, cssRule);
    }
    return index;
  }

  deleteRule(index: number): void {
    this.cssRules.splice(index, 1);
  }
}

/**
 * Canonicalise a style property name the way a real `CSSStyleDeclaration`
 * does: `el.style.backgroundColor` and `el.style.setProperty("background-color")`
 * address the SAME declaration. Without this the fake stores them under two
 * separate keys, so code that writes camelCase and reads/removes kebab-case
 * (every applicator handler + the variant machinery) behaves differently in
 * tests than in a browser. Custom properties (`--x`) pass through untouched.
 */
function toStyleKey(name: string): string {
  if (name.startsWith("--")) return name;
  return name.replace(/([A-Z])/g, "-$1").toLowerCase();
}

export class FakeStyle {
  private store: Record<string, string> = {};

  constructor() {
    return new Proxy(this, {
      get: (target, prop, receiver) => {
        if (
          prop === "setProperty" ||
          prop === "getProperty" ||
          prop === "getPropertyValue" ||
          prop === "removeProperty"
        ) {
          return (target as any)[prop].bind(target);
        }
        if (typeof prop === "string") {
          // Indexed access (`style.length` / `style[i]`) mirrors the real
          // CSSStyleDeclaration, which is how the declaration set of an
          // element is enumerated.
          if (prop === "length") return Object.keys(target.store).length;
          if (/^\d+$/.test(prop)) return Object.keys(target.store)[Number(prop)];
          if (prop in target) {
            return Reflect.get(target, prop, receiver);
          }
          return target.store[toStyleKey(prop)];
        }
        return Reflect.get(target, prop, receiver);
      },
      set: (target, prop, value) => {
        if (typeof prop === "string") {
          target.store[toStyleKey(prop)] = String(value);
          return true;
        }
        return false;
      },
      ownKeys: (target) => Reflect.ownKeys(target.store),
      getOwnPropertyDescriptor: (target, prop) => {
        if (typeof prop === "string" && prop in target.store) {
          return { configurable: true, enumerable: true, writable: true };
        }
        return Object.getOwnPropertyDescriptor(target, prop);
      },
    }) as FakeStyle;
  }

  setProperty(name: string, value: string): void {
    this.store[toStyleKey(name)] = value;
  }

  getProperty(name: string): string | undefined {
    return this.store[toStyleKey(name)];
  }

  getPropertyValue(name: string): string {
    return this.store[toStyleKey(name)] ?? "";
  }

  removeProperty(name: string): void {
    delete this.store[toStyleKey(name)];
  }
}

export class FakeElement {
  public style: FakeStyle;
  public dataset: Record<string, string> = {};
  public parentNode: FakeElement | FakeDocument | null = null;
  public children: FakeElement[] = [];
  public textContent = "";
  public attributes: Record<string, string> = {};
  private classSet = new Set<string>();
  public classList = {
    add: (...names: string[]) => {
      for (const name of names) {
        this.classSet.add(name);
        this.attributes[name] = "";
      }
    },
    remove: (...names: string[]) => {
      for (const name of names) {
        this.classSet.delete(name);
        delete this.attributes[name];
      }
    },
    contains: (name: string) => this.classSet.has(name),
    toString: () => Array.from(this.classSet).join(' '),
  };
  public value = "";
  public placeholder = "";
  public type = "";
  public selectionStart: number | null = null;
  public selectionEnd: number | null = null;

  setSelectionRange(start: number, end: number, _direction?: string): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
  public ownerDocument: FakeDocument | null = null;
  public id = "";
  public sheet: FakeCSSStyleSheet | null = null;

  /**
   * Settable measurement hook for FLIP tests: a plain property, so a test
   * can overwrite it per-element (`el.getBoundingClientRect = () => rect`)
   * or even swap it between the renderer's First and Last reads. Defaults
   * to the all-zero rect a detached real element would report.
   */
  public getBoundingClientRect: () => {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  } = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });

  private listeners: Map<string, Set<Listener>> = new Map();

  constructor(public tagName: string) {
    this.style = new FakeStyle();
    // Style elements have a sheet property
    if (tagName.toUpperCase() === 'STYLE') {
      this.sheet = new FakeCSSStyleSheet();
    }
  }

  appendChild<T extends FakeElement>(child: T): T {
    if (child.parentNode && child.parentNode instanceof FakeElement) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  insertBefore<T extends FakeElement>(child: T, before: FakeElement | null): T {
    if (child.parentNode && child.parentNode instanceof FakeElement) {
      child.parentNode.removeChild(child);
    }
    const index = before ? this.children.indexOf(before) : -1;
    child.parentNode = this;
    if (index >= 0) {
      this.children.splice(index, 0, child);
    } else {
      this.children.push(child);
    }
    return child;
  }

  removeChild<T extends FakeElement>(child: T): T {
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.children.splice(index, 1);
    }
    child.parentNode = null;
    return child;
  }

  remove(): void {
    if (this.parentNode && this.parentNode instanceof FakeElement) {
      this.parentNode.removeChild(this);
    } else if (this.parentNode && this.parentNode instanceof FakeDocument) {
      this.parentNode.remove(this);
    }
  }

  /**
   * Structural clone, mirroring `Node.cloneNode` — the operation the DOM
   * renderer's template instantiation is built on (`registerTemplate` builds
   * one prototype, `instantiate` clones it per list row).
   *
   * Copied: tag, id, dataset, attributes, classes, inline styles, text and
   * (when `deep`) the child subtree. NOT copied: event listeners and every
   * other JS-side association — exactly the asymmetry that makes a component
   * keyed by a WeakMap-on-element go inert unless it re-adopts the clone.
   * Live element state a real DOM keeps outside the attribute space (a media
   * element's `src` property assignment, `currentTime`, `duration`) is not
   * carried either, so a clone starts from its recorded markers alone.
   */
  cloneNode(deep = false): FakeElement {
    const copy = new FakeElement(this.tagName);
    copy.ownerDocument = this.ownerDocument;
    copy.id = this.id;
    copy.dataset = { ...this.dataset };
    copy.attributes = { ...this.attributes };
    for (const name of this.classList.toString().split(" ")) {
      if (name) copy.classList.add(name);
    }
    const style = this.style as unknown as Record<string, string> & {
      getPropertyValue(name: string): string;
    };
    for (const key of Object.keys(style)) {
      copy.style.setProperty(key, style.getPropertyValue(key));
    }
    copy.textContent = this.textContent;
    copy.value = this.value;
    copy.placeholder = this.placeholder;
    copy.type = this.type;
    if (deep) {
      for (const child of this.children) {
        copy.appendChild(child.cloneNode(true));
      }
    }
    return copy;
  }

  contains(node: FakeElement): boolean {
    if (this === node) return true;
    return this.children.some((child) => child.contains(node));
  }

  addEventListener(type: string, handler: Listener): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(handler);
  }

  removeEventListener(type: string, handler: Listener): void {
    this.listeners.get(type)?.delete(handler);
  }

  dispatchEvent(type: string, event: any = {}): void {
    const listeners = this.listeners.get(type);
    if (!listeners || listeners.size === 0) return;
    if (!("target" in event)) {
      event.target = this;
    }
    if (!("type" in event)) {
      event.type = type;
    }
    for (const listener of listeners) {
      listener(event);
    }
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  removeAttribute(name: string): void {
    delete this.attributes[name];
  }

  /**
   * Minimal focus support: records this element as document.activeElement
   * and fires bubbling focusout (on the previous holder) / focusin — enough
   * for delegated focus handlers (e.g. the canvas mirror's FocusManager).
   */
  focus(_options?: unknown): void {
    const doc = (globalThis as any).document;
    if (!doc) return;
    const prev = doc.activeElement ?? null;
    if (prev === this) return;
    doc.activeElement = this;
    if (prev instanceof FakeElement) {
      prev.dispatchEvent("blur", { target: prev, relatedTarget: this });
      prev.bubbleEvent("focusout", { target: prev, relatedTarget: this });
    }
    this.bubbleEvent("focusin", { target: this, relatedTarget: prev });
  }

  blur(): void {
    const doc = (globalThis as any).document;
    if (!doc || doc.activeElement !== this) return;
    doc.activeElement = null;
    this.dispatchEvent("blur", { target: this, relatedTarget: null });
    this.bubbleEvent("focusout", { target: this, relatedTarget: null });
  }

  /** Dispatch an event on this element and every FakeElement ancestor. */
  bubbleEvent(type: string, event: any = {}): void {
    if (!("target" in event)) event.target = this;
    if (!("type" in event)) event.type = type;
    let el: FakeElement | FakeDocument | null = this;
    while (el instanceof FakeElement) {
      el.dispatchEvent(type, event);
      el = el.parentNode;
    }
  }

  getAttribute(name: string): string | null {
    return name in this.attributes ? this.attributes[name] : null;
  }

  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  set innerHTML(_: string) {
    for (const child of this.children) {
      child.parentNode = null;
    }
    this.children = [];
    this.textContent = "";
  }
}

export class FakeDocument {
  private nodes: FakeElement[] = [];
  public head: FakeElement;
  public body: FakeElement;
  /** Set by FakeElement.focus(); null until anything is focused. */
  public activeElement: FakeElement | null = null;

  constructor() {
    this.head = new FakeElement("HEAD");
    this.body = new FakeElement("BODY");
    this.head.parentNode = this;
    this.body.parentNode = this;
  }

  createElement(tag: string): FakeElement {
    const element = new FakeElement(tag.toUpperCase());
    element.ownerDocument = this;
    this.nodes.push(element);
    return element;
  }

  remove(node: FakeElement): void {
    const index = this.nodes.indexOf(node);
    if (index >= 0) {
      this.nodes.splice(index, 1);
    }
  }

  getElementById(id: string): FakeElement | null {
    return (
      [this.head, this.body, ...this.head.children, ...this.body.children, ...this.nodes].find(
        (node) => node.id === id
      ) ?? null
    );
  }

  querySelectorAll(selector: string): FakeElement[] {
    if (selector.startsWith('[data-hypen-type="')) {
      const type = selector.slice('[data-hypen-type="'.length, -2);
      return this.nodes.filter((node) => node.dataset.hypenType === type);
    }
    return [];
  }
}

export function ensureFakeDomGlobals(): void {
  const globalObj = globalThis as any;

  // Always force-set fake DOM globals.  Other test files (e.g.
  // router.history.test.ts) may run concurrently and pollute globals
  // with JSDOM objects.  By unconditionally overwriting we guarantee
  // that any test file calling this helper gets the lightweight fakes
  // it expects, regardless of execution order.

  const doc = new FakeDocument();
  globalObj.document = doc;

  globalObj.HTMLElement = FakeElement;

  // Mock HashChangeEvent for router tests
  globalObj.HashChangeEvent = class HashChangeEvent {
    type: string;
    newURL: string;
    oldURL: string;
    constructor(type: string, init?: { newURL?: string; oldURL?: string }) {
      this.type = type;
      this.newURL = init?.newURL ?? "";
      this.oldURL = init?.oldURL ?? "";
    }
  };

  globalObj.window = {
    document: doc,
    getComputedStyle: (element: FakeElement) => {
      const style = element.style as any;
      return {
        display: style.display ?? "block",
        position: style.position ?? "static",
      };
    },
    location: {
      hash: "",
      pathname: "/",
      search: "",
      href: "http://localhost/",
    },
    history: {
      pushState: () => {},
      replaceState: () => {},
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  };
}
