/**
 * Host-owned UI for the browser DeviceHost (RFC 001 §2.6 / §5): the consent
 * dialog, the camera capture dialog, and the always-visible recording
 * indicator. All of it lives outside the patch tree, renders server-supplied
 * text only as plain data, and arms its activating controls against input
 * meant for the app (keyjacking / click-through, review2 #6).
 */

export const DEFAULT_INPUT_PROTECTION_MS = 500;

/**
 * Input protection for one activating control: it is never focused
 * automatically, stays disabled for `protectionMs` after it becomes visible
 * (restarted whenever the page becomes visible again or the window regains
 * focus), and accepts only a trusted activation that STARTED on the enabled
 * control (a trusted pointer-down or Enter/Space key-down on it). A trusted
 * click that did not start there is ignored; an untrusted (synthetic) click
 * is a refusal.
 */
export function protectActivation(
  doc: Document,
  button: HTMLButtonElement,
  protectionMs: number,
  handlers: { activate(ev: Event): void; refuse(): void }
): { rearm(): void; teardown(): void } {
  let fresh = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let live = true;
  const view = doc.defaultView;
  const arm = () => {
    button.disabled = true;
    button.setAttribute("aria-disabled", "true");
    fresh = false;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!live) return;
      button.disabled = false;
      button.removeAttribute("aria-disabled");
    }, protectionMs);
  };
  const onVisibility = () => {
    if (doc.visibilityState === "hidden") {
      button.disabled = true;
      fresh = false;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    } else {
      arm();
    }
  };
  const onBlur = () => {
    button.disabled = true;
    fresh = false;
  };
  doc.addEventListener("visibilitychange", onVisibility);
  view?.addEventListener("focus", arm);
  view?.addEventListener("blur", onBlur);

  button.addEventListener("pointerdown", (ev) => {
    fresh = ev.isTrusted && !button.disabled;
  });
  button.addEventListener("mousedown", (ev) => {
    // Engines without pointer events on buttons (older WebViews).
    if (ev.isTrusted && !button.disabled) fresh = true;
  });
  button.addEventListener("keydown", (ev) => {
    const key = (ev as KeyboardEvent).key;
    if (key === "Enter" || key === " " || key === "Spacebar") {
      // A held key's auto-repeat is not a new activation.
      fresh = ev.isTrusted && !button.disabled && !(ev as KeyboardEvent).repeat;
    }
  });
  button.addEventListener("click", (ev) => {
    if (!live) return;
    if (!ev.isTrusted) {
      handlers.refuse();
      return;
    }
    if (button.disabled || !fresh) return;
    fresh = false;
    handlers.activate(ev);
  });
  arm();
  return {
    rearm: arm,
    teardown: () => {
      live = false;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      doc.removeEventListener("visibilitychange", onVisibility);
      view?.removeEventListener("focus", arm);
      view?.removeEventListener("blur", onBlur);
    },
  };
}

/**
 * Host-side look of the consent and capture dialogs. Every field is optional
 * and maps to a `--hypen-device-*` CSS custom property on the dialog, so the
 * same values can also be set from page CSS (e.g. on `:root`). This is a
 * client option: the app server never styles host UI.
 */
export interface DeviceDialogTheme {
  /** "auto" (default) follows `prefers-color-scheme`. */
  colorScheme?: "auto" | "light" | "dark";
  /** Primary button and drop-zone highlight. `--hypen-device-accent` */
  accent?: string;
  /** Text on the primary button. `--hypen-device-accent-text` */
  accentText?: string;
  /** Panel background. `--hypen-device-background` */
  background?: string;
  /** Panel text. `--hypen-device-text` */
  text?: string;
  /** Secondary text. `--hypen-device-muted` */
  muted?: string;
  /** Secondary button, detail rows. `--hypen-device-surface` */
  surface?: string;
  /** Hairlines and the drop zone's dashed edge. `--hypen-device-border` */
  border?: string;
  /** Page dimming behind the dialog. `--hypen-device-backdrop` */
  backdrop?: string;
  /** Panel corner radius, e.g. "20px". `--hypen-device-radius` */
  radius?: string;
  /** Font stack. `--hypen-device-font` */
  fontFamily?: string;
}

const THEME_VARS: Record<Exclude<keyof DeviceDialogTheme, "colorScheme">, string> = {
  accent: "--hypen-device-accent",
  accentText: "--hypen-device-accent-text",
  background: "--hypen-device-background",
  text: "--hypen-device-text",
  muted: "--hypen-device-muted",
  surface: "--hypen-device-surface",
  border: "--hypen-device-border",
  backdrop: "--hypen-device-backdrop",
  radius: "--hypen-device-radius",
  fontFamily: "--hypen-device-font",
};

type Palette = Record<"bg" | "fg" | "muted" | "surface" | "border" | "accent" | "accentFg" | "backdrop" | "danger", string>;
const LIGHT: Palette = {
  bg: "#ffffff",
  fg: "#0f172a",
  muted: "#64748b",
  surface: "#f1f5f9",
  border: "rgba(15,23,42,0.12)",
  accent: "#2563eb",
  accentFg: "#ffffff",
  backdrop: "rgba(15,23,42,0.38)",
  danger: "#dc2626",
};
const DARK: Palette = {
  bg: "#1c1c21",
  fg: "#f4f4f5",
  muted: "#a1a1aa",
  surface: "#2a2a31",
  border: "rgba(255,255,255,0.12)",
  accent: "#3b82f6",
  accentFg: "#ffffff",
  backdrop: "rgba(0,0,0,0.55)",
  danger: "#f87171",
};
const palette = (p: Palette) =>
  `--_bg:var(--hypen-device-background,${p.bg});--_fg:var(--hypen-device-text,${p.fg});` +
  `--_muted:var(--hypen-device-muted,${p.muted});--_surface:var(--hypen-device-surface,${p.surface});` +
  `--_border:var(--hypen-device-border,${p.border});--_accent:var(--hypen-device-accent,${p.accent});` +
  `--_accent-fg:var(--hypen-device-accent-text,${p.accentFg});--_backdrop:var(--hypen-device-backdrop,${p.backdrop});` +
  `--_danger:${p.danger};`;

const DIALOGS = "[data-hypen-device-dialog],[data-hypen-device-capture]";
const DIALOG_CSS =
  `${DIALOGS}{${palette(LIGHT)}--_radius:var(--hypen-device-radius,18px);` +
  `--_font:var(--hypen-device-font,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif);` +
  "background:var(--_backdrop);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);" +
  "font:14px/1.5 var(--_font);color-scheme:light;animation:hypen-device-fade .16s ease-out}" +
  `@media (prefers-color-scheme:dark){:is(${DIALOGS}):not([data-hypen-device-scheme=light]){${palette(DARK)}color-scheme:dark}}` +
  `:is(${DIALOGS})[data-hypen-device-scheme=dark]{${palette(DARK)}color-scheme:dark}` +
  ".hypen-device-panel{box-sizing:border-box;width:min(380px,calc(100vw - 32px));max-height:calc(100vh - 32px);" +
  "overflow:auto;background:var(--_bg);color:var(--_fg);border-radius:var(--_radius);padding:24px;" +
  "border:1px solid var(--_border);box-shadow:0 24px 64px -12px rgba(0,0,0,0.35),0 2px 6px rgba(0,0,0,0.08);" +
  "outline:none;animation:hypen-device-rise .2s cubic-bezier(.2,.9,.3,1.2)}" +
  ".hypen-device-panel.hypen-device-wide{width:min(460px,calc(100vw - 32px))}" +
  ".hypen-device-title{margin:0 0 16px;font-size:15px;line-height:1.45;color:var(--_fg)}" +
  ".hypen-device-origin{display:block;margin:0 0 2px;font-weight:650;font-size:16px;word-break:break-all}" +
  ".hypen-device-detail{margin:0 0 12px;padding:8px 10px;background:var(--_surface);border-radius:10px;" +
  "font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--_muted);word-break:break-all;unicode-bidi:isolate}" +
  ".hypen-device-drop{display:flex;flex-direction:column;align-items:center;gap:8px;margin:4px 0 20px;" +
  "padding:24px 16px;border:1.5px dashed var(--_border);border-radius:14px;text-align:center;color:var(--_muted);" +
  "font-size:13px;transition:background .15s,border-color .15s,opacity .15s,transform .15s}" +
  ".hypen-device-drop svg{width:28px;height:28px;opacity:.7}" +
  ".hypen-device-drop[data-state=disarmed]{opacity:.55}" +
  ".hypen-device-drop[data-state=hot]{border-color:var(--_accent);color:var(--_accent);transform:scale(1.01);" +
  "background:color-mix(in srgb,var(--_accent) 9%,transparent)}" +
  ".hypen-device-actions{display:flex;gap:10px;margin-top:4px}" +
  ".hypen-device-btn{all:unset;box-sizing:border-box;flex:1;display:inline-flex;align-items:center;justify-content:center;" +
  "min-height:42px;padding:0 16px;border-radius:12px;font:600 14px/1 var(--_font);cursor:pointer;" +
  "background:var(--_surface);color:var(--_fg);transition:filter .12s,opacity .2s,transform .06s}" +
  ".hypen-device-btn:hover:not(:disabled){filter:brightness(0.96)}" +
  ".hypen-device-btn:active:not(:disabled){transform:scale(0.98)}" +
  ".hypen-device-btn:focus-visible{outline:2px solid var(--_accent);outline-offset:2px}" +
  ".hypen-device-btn:disabled{opacity:.45;cursor:default}" +
  ".hypen-device-btn-primary{background:var(--_accent);color:var(--_accent-fg)}" +
  ".hypen-device-btn-primary:hover:not(:disabled){filter:brightness(1.08)}" +
  ".hypen-device-preview{display:block;width:100%;max-height:300px;background:#000;border-radius:12px;margin:0 0 12px;object-fit:cover}" +
  ".hypen-device-status{margin:0 0 16px;font-size:13px;color:var(--_muted)}" +
  ".hypen-device-status[data-recording]{color:var(--_danger);font-weight:600}" +
  "@keyframes hypen-device-fade{from{opacity:0}}" +
  "@keyframes hypen-device-rise{from{opacity:0;transform:translateY(8px) scale(.98)}}" +
  `@media (prefers-reduced-motion:reduce){:is(${DIALOGS}),.hypen-device-panel{animation:none}.hypen-device-btn,.hypen-device-drop{transition:none}}`;

const STYLED = new WeakSet<Document>();

/**
 * Install the dialog stylesheet once per document. A constructable sheet
 * where supported (CSP style-src does not apply to it), a `<style>` otherwise.
 * Layout that keeps the dialog over the page stays inline, so a page whose
 * CSP blocks both still gets a working, if plain, dialog.
 */
function ensureStyles(doc: Document): void {
  if (STYLED.has(doc)) return;
  STYLED.add(doc);
  const view = doc.defaultView as (Window & { CSSStyleSheet?: typeof CSSStyleSheet }) | null;
  const adopted = (doc as Document & { adoptedStyleSheets?: CSSStyleSheet[] }).adoptedStyleSheets;
  if (view?.CSSStyleSheet && Array.isArray(adopted)) {
    try {
      const sheet = new view.CSSStyleSheet();
      sheet.replaceSync(DIALOG_CSS);
      (doc as Document & { adoptedStyleSheets: CSSStyleSheet[] }).adoptedStyleSheets = [...adopted, sheet];
      return;
    } catch {
      /* fall back to a <style> element */
    }
  }
  const style = doc.createElement("style");
  style.setAttribute("data-hypen-device-styles", "");
  style.textContent = DIALOG_CSS;
  (doc.head ?? doc.documentElement).append(style);
}

function applyTheme(root: HTMLElement, theme: DeviceDialogTheme | undefined): void {
  if (!theme) return;
  if (theme.colorScheme && theme.colorScheme !== "auto") root.setAttribute("data-hypen-device-scheme", theme.colorScheme);
  for (const [key, prop] of Object.entries(THEME_VARS)) {
    const value = theme[key as keyof typeof THEME_VARS];
    if (value) root.style.setProperty(prop, value);
  }
}

function overlay(doc: Document, attr: string, theme?: DeviceDialogTheme): { root: HTMLElement; panel: HTMLElement } {
  ensureStyles(doc);
  const root = doc.createElement("div");
  root.setAttribute(attr, "");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.className = "hypen-device-overlay";
  // Inline on purpose: the dialog must cover the page even without the sheet.
  root.style.cssText =
    "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:2147483647";
  applyTheme(root, theme);
  const panel = doc.createElement("div");
  panel.className = "hypen-device-panel";
  root.append(panel);
  return { root, panel };
}

function titleLine(doc: Document, id: string, origin: string, verb: string): HTMLElement {
  const title = doc.createElement("p");
  title.id = id;
  title.className = "hypen-device-title";
  const strong = doc.createElement("strong");
  strong.className = "hypen-device-origin";
  strong.textContent = origin;
  title.append(strong, doc.createTextNode(`wants to ${verb}.`));
  return title;
}

function detailLine(doc: Document, line: string): HTMLElement {
  const info = doc.createElement("p");
  info.setAttribute("data-hypen-device", "detail");
  info.className = "hypen-device-detail";
  // Plain text, left-to-right isolated: server text cannot reorder it.
  info.dir = "ltr";
  info.textContent = line;
  return info;
}

function hostButton(doc: Document, label: string, role: string, primary = false): HTMLButtonElement {
  const b = doc.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.setAttribute("data-hypen-device", role);
  b.className = primary ? "hypen-device-btn hypen-device-btn-primary" : "hypen-device-btn";
  return b;
}

function actionRow(doc: Document): HTMLElement {
  const row = doc.createElement("div");
  row.className = "hypen-device-actions";
  return row;
}

/** Tray-with-arrow glyph for the drop zone (static markup, no server data). */
function uploadIcon(doc: Document): SVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = doc.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of ["M12 15V4", "M7.5 8.5 12 4l4.5 4.5", "M4 14v3.5A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5V14"]) {
    const path = doc.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/** Files the user dropped onto the host dialog's drop zone. */
export interface DroppedFiles {
  kind: "drop";
  files: File[];
}

/** Opt-in drop target for a picker's consent dialog. */
export interface DropZoneOptions {
  /** `<input accept>`-style filter ("image/*", ".pdf", "text/plain"); "" = any. */
  accept: string;
  /** Whether more than one file may be dropped (extra files are ignored). */
  multiple: boolean;
}

/**
 * Whether `file` passes an `<input accept>`-style filter. Entries are MIME
 * types (`image/png`), MIME wildcards (`image/*`) or extensions (`.pdf`),
 * compared case-insensitively. An empty filter accepts everything.
 */
export function fileMatchesAccept(file: { name: string; type: string }, accept: string): boolean {
  const entries = accept
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);
  if (entries.length === 0) return true;
  const type = (file.type || "").toLowerCase();
  const name = file.name.toLowerCase();
  return entries.some((entry) => {
    if (entry.startsWith(".")) return name.endsWith(entry);
    if (entry.endsWith("/*")) return type.startsWith(entry.slice(0, -1));
    return type === entry;
  });
}

function dragHasFiles(ev: DragEvent): boolean {
  const types = ev.dataTransfer?.types;
  if (!types) return false;
  return Array.prototype.indexOf.call(types, "Files") !== -1;
}

/**
 * Host-owned drop zone inside the consent dialog. Dropping files here is the
 * per-use choice, exactly like picking them in the OS picker — the files go
 * straight to the host and never pass through app UI.
 *
 * Armed like Continue (RFC 001 §2.6 step 3): disabled for `protectionMs`
 * after it appears and again whenever the page is hidden or the window loses
 * focus, and a drop counts only when the drag ENTERED the armed zone (a
 * trusted `dragenter` after arming). A drag the user was already holding when
 * the dialog popped up under the pointer therefore cannot land by accident:
 * the zone must be armed and then entered first.
 */
function dropZone(
  doc: Document,
  protectionMs: number,
  opts: DropZoneOptions,
  onFiles: (files: File[]) => void
): { element: HTMLElement; teardown(): void } {
  const zone = doc.createElement("div");
  zone.setAttribute("data-hypen-device", "drop-zone");
  zone.setAttribute("aria-label", opts.multiple ? "Drop files here" : "Drop a file here");
  zone.className = "hypen-device-drop";
  const label = doc.createElement("span");
  zone.append(uploadIcon(doc), label);
  const idleText = opts.multiple ? "Drop files here, or Continue to browse" : "Drop a file here, or Continue to browse";
  label.textContent = idleText;

  let armed = false;
  let entered = false;
  let depth = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let live = true;
  const view = doc.defaultView;
  const paint = () => {
    zone.setAttribute("data-state", !armed ? "disarmed" : entered ? "hot" : "armed");
  };
  const arm = () => {
    armed = false;
    entered = false;
    depth = 0;
    paint();
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!live) return;
      armed = true;
      paint();
    }, protectionMs);
  };
  const disarm = () => {
    armed = false;
    entered = false;
    depth = 0;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    paint();
  };
  const onVisibility = () => (doc.visibilityState === "hidden" ? disarm() : arm());
  doc.addEventListener("visibilitychange", onVisibility);
  view?.addEventListener("focus", arm);
  view?.addEventListener("blur", disarm);

  zone.addEventListener("dragenter", (ev) => {
    const e = ev as DragEvent;
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    depth += 1;
    if (e.isTrusted && armed) entered = true;
    paint();
  });
  zone.addEventListener("dragover", (ev) => {
    const e = ev as DragEvent;
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = armed && entered ? "copy" : "none";
  });
  zone.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) entered = false;
    paint();
  });
  zone.addEventListener("drop", (ev) => {
    const e = ev as DragEvent;
    e.preventDefault();
    e.stopPropagation();
    const accepted = live && e.isTrusted && armed && entered;
    entered = false;
    depth = 0;
    paint();
    if (!accepted) return;
    const all = Array.from(e.dataTransfer?.files ?? []);
    const files = all.filter((f) => fileMatchesAccept(f, opts.accept));
    if (files.length === 0) {
      label.textContent = all.length > 0 ? "That file type isn't accepted here" : idleText;
      return;
    }
    onFiles(opts.multiple ? files : files.slice(0, 1));
  });
  arm();
  return {
    element: zone,
    teardown: () => {
      live = false;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      doc.removeEventListener("visibilitychange", onVisibility);
      view?.removeEventListener("focus", arm);
      view?.removeEventListener("blur", disarm);
    },
  };
}

/**
 * Host-owned consent dialog: outside the patch tree, keyboard-operable, one
 * at a time, Continue protected by `protectActivation`.
 */
export class ConsentDialog {
  private root: HTMLElement | null = null;
  /** Settles the open `present()` promise when the dialog is torn down externally. */
  private settlePending: (() => void) | null = null;
  /** Removes the open dialog's document/window listeners and timer. */
  private teardown: (() => void) | null = null;

  constructor(
    private readonly mount: HTMLElement,
    private readonly protectionMs: number = DEFAULT_INPUT_PROTECTION_MS,
    private readonly theme?: DeviceDialogTheme
  ) {}

  get open(): boolean {
    return this.root !== null;
  }

  /**
   * Present the interaction. Resolves with the trusted `MouseEvent`/`Event`
   * of the Continue click (inside the activation window), `null` on the
   * user's Cancel/Escape/untrusted click, or `"dismissed"` when the host tore
   * the dialog down itself (server cancel, deadline, detach) — so the promise
   * and its DOM closures never outlive the dialog. `detail` is rendered as
   * plain text data (e.g. a download's name and size), visually separated
   * from the host's own label.
   */
  present(
    origin: string,
    verb: string,
    detail?: string[],
    drop?: DropZoneOptions
  ): Promise<Event | DroppedFiles | null | "dismissed"> {
    this.dismiss();
    return new Promise((resolve) => {
      const doc = this.mount.ownerDocument;
      const { root, panel } = overlay(doc, "data-hypen-device-dialog", this.theme);
      root.setAttribute("aria-labelledby", "hypen-device-dialog-title");
      panel.append(titleLine(doc, "hypen-device-dialog-title", origin, verb));
      for (const line of detail ?? []) panel.append(detailLine(doc, line));

      const row = actionRow(doc);
      const cancel = hostButton(doc, "Cancel", "cancel");
      const cont = hostButton(doc, "Continue", "continue", true);

      let settled = false;
      const finish = (ev: Event | DroppedFiles | null | "dismissed") => {
        // One acceptance consumes only this pending request (§2.6 step 3).
        if (settled) return;
        settled = true;
        if (this.settlePending === onDismiss) this.settlePending = null;
        this.dismiss();
        resolve(ev);
      };
      const onDismiss = () => finish("dismissed");

      const guard = protectActivation(doc, cont, this.protectionMs, {
        activate: (ev) => finish(ev),
        refuse: () => finish(null),
      });
      let zoneTeardown: (() => void) | null = null;
      if (drop) {
        const zone = dropZone(doc, this.protectionMs, drop, (files) => finish({ kind: "drop", files }));
        panel.append(zone.element);
        zoneTeardown = zone.teardown;
        // A file released anywhere else on the overlay must not fall through
        // to the page (the browser would navigate to it) — swallow it.
        const swallow = (ev: Event) => {
          if (dragHasFiles(ev as DragEvent)) ev.preventDefault();
        };
        root.addEventListener("dragover", swallow);
        root.addEventListener("drop", swallow);
      }
      this.teardown = () => {
        guard.teardown();
        zoneTeardown?.();
      };

      cancel.addEventListener("click", () => finish(null));
      root.addEventListener("keydown", (ev) => {
        if ((ev as KeyboardEvent).key === "Escape") finish(null);
      });

      row.append(cancel, cont);
      panel.append(row);
      this.mount.append(root);
      this.root = root;
      this.settlePending = onDismiss;
      // Focus the dialog itself — never Continue — so a keystroke typed for
      // the app cannot activate it; Tab reaches Cancel, then Continue.
      panel.tabIndex = -1;
      panel.focus();
    });
  }

  dismiss(): void {
    this.teardown?.();
    this.teardown = null;
    if (this.root) {
      this.root.remove();
      this.root = null;
    }
    const pending = this.settlePending;
    this.settlePending = null;
    pending?.();
  }
}

/** What the user did in the capture dialog. */
export type CaptureAction = "capture" | "record" | "stop" | "cancel";

/**
 * Host-owned camera capture UI (RFC 001 §5 "capture UI is the consent
 * gate"): origin label, a live preview, and Capture (photo) or Record/Stop
 * (video) plus Cancel. Capture and Record are armed like Continue; Stop is
 * not (ending a recording early is always safe). While recording the dialog
 * is the visible recording indicator, naming the origin.
 */
export class CaptureDialog {
  readonly root: HTMLElement;
  readonly video: HTMLVideoElement;
  private readonly status: HTMLElement;
  private readonly primary: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  private guard: { rearm(): void; teardown(): void } | null = null;
  private recording = false;
  private closed = false;

  constructor(
    private readonly mount: HTMLElement,
    origin: string,
    readonly mode: "photo" | "video",
    private readonly protectionMs: number,
    private readonly onAction: (action: CaptureAction) => void,
    theme?: DeviceDialogTheme
  ) {
    const doc = mount.ownerDocument;
    const { root, panel } = overlay(doc, "data-hypen-device-capture", theme);
    root.setAttribute("aria-labelledby", "hypen-device-capture-title");
    panel.classList.add("hypen-device-wide");
    panel.append(
      titleLine(doc, "hypen-device-capture-title", origin, mode === "photo" ? "take a photo with your camera" : "record a video with your camera")
    );
    const video = doc.createElement("video");
    video.setAttribute("data-hypen-device", "preview");
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.className = "hypen-device-preview";
    panel.append(video);
    const status = doc.createElement("p");
    status.setAttribute("data-hypen-device", "capture-status");
    status.setAttribute("role", "status");
    status.className = "hypen-device-status";
    status.textContent = "Starting camera…";
    panel.append(status);

    const row = actionRow(doc);
    const cancel = hostButton(doc, "Cancel", "cancel");
    const primary = hostButton(doc, mode === "photo" ? "Capture" : "Record", mode === "photo" ? "capture" : "record", true);
    primary.disabled = true;
    row.append(cancel, primary);
    panel.append(row);

    cancel.addEventListener("click", () => {
      if (!this.closed) this.onAction("cancel");
    });
    root.addEventListener("keydown", (ev) => {
      if ((ev as KeyboardEvent).key === "Escape" && !this.closed && !this.recording) this.onAction("cancel");
    });
    this.root = root;
    this.video = video;
    this.status = status;
    this.primary = primary;
    this.cancelButton = cancel;
    mount.append(root);
    panel.tabIndex = -1;
    panel.focus();
  }

  /** The preview is live: arm Capture/Record. */
  ready(): void {
    if (this.closed) return;
    this.status.textContent = this.mode === "photo" ? "Camera ready." : "Camera ready. Press Record to start.";
    const doc = this.mount.ownerDocument;
    this.guard = protectActivation(doc, this.primary, this.protectionMs, {
      activate: () => {
        if (this.closed || this.recording) return;
        this.onAction(this.mode === "photo" ? "capture" : "record");
      },
      refuse: () => {
        if (!this.closed && !this.recording) this.onAction("cancel");
      },
    });
  }

  /** Recording started: Record becomes Stop (no arming), Cancel stays. */
  startedRecording(): void {
    if (this.closed) return;
    this.recording = true;
    this.guard?.teardown();
    this.guard = null;
    const doc = this.mount.ownerDocument;
    const stop = hostButton(doc, "Stop", "stop", true);
    stop.addEventListener("click", () => {
      if (!this.closed) this.onAction("stop");
    });
    this.primary.replaceWith(stop);
    this.status.textContent = "● Recording";
    this.status.setAttribute("data-recording", "");
  }

  /** Show a busy state (encoding / uploading) after capture. */
  busy(text: string): void {
    if (this.closed) return;
    this.status.textContent = text;
    this.primary.disabled = true;
    this.cancelButton.disabled = false;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.guard?.teardown();
    this.guard = null;
    try {
      (this.video as HTMLVideoElement & { srcObject: unknown }).srcObject = null;
    } catch {
      /* not supported */
    }
    this.root.remove();
  }
}

/**
 * The always-visible recording indicator (RFC 001 §5): host UI outside the
 * patch tree, shown for the whole of a `mic.record`, naming the app origin,
 * with a Stop control that ends the recording normally.
 */
export class RecordingIndicator {
  private readonly root: HTMLElement;
  private closed = false;

  constructor(mount: HTMLElement, origin: string, onStop: () => void) {
    const doc = mount.ownerDocument;
    const root = doc.createElement("div");
    root.setAttribute("data-hypen-device-indicator", "");
    root.setAttribute("role", "status");
    root.setAttribute("aria-live", "polite");
    const set = (prop: string, value: string) => root.style.setProperty(prop, value, "important");
    set("position", "fixed");
    set("top", "12px");
    set("right", "12px");
    set("z-index", "2147483647");
    set("display", "flex");
    set("align-items", "center");
    set("gap", "8px");
    set("padding", "6px 10px");
    set("background", "#b91c1c");
    set("color", "#fff");
    set("border-radius", "999px");
    set("font", "600 12px system-ui,sans-serif");
    set("visibility", "visible");
    set("opacity", "1");
    set("pointer-events", "auto");
    const label = doc.createElement("span");
    const strong = doc.createElement("strong");
    strong.textContent = origin;
    label.append(doc.createTextNode("● Recording audio for "), strong);
    const stop = doc.createElement("button");
    stop.type = "button";
    stop.textContent = "Stop";
    stop.setAttribute("data-hypen-device", "stop-recording");
    stop.addEventListener("click", () => {
      if (!this.closed) onStop();
    });
    root.append(label, stop);
    mount.append(root);
    this.root = root;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.root.remove();
  }
}
