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

export class FakeStyle {
  private store: Record<string, string> = {};

  constructor() {
    return new Proxy(this, {
      get: (target, prop, receiver) => {
        if (prop === "setProperty" || prop === "getProperty") {
          return (target as any)[prop].bind(target);
        }
        if (typeof prop === "string") {
          if (prop in target) {
            return Reflect.get(target, prop, receiver);
          }
          return target.store[prop];
        }
        return Reflect.get(target, prop, receiver);
      },
      set: (target, prop, value) => {
        if (typeof prop === "string") {
          target.store[prop] = String(value);
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
    this.store[name] = value;
  }

  getProperty(name: string): string | undefined {
    return this.store[name];
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
