import {
  createConnection,
  TextDocuments,
  Diagnostic,
  DiagnosticSeverity,
  ProposedFeatures,
  InitializeParams,
  DidChangeConfigurationNotification,
  CompletionItem,
  CompletionItemKind,
  TextDocumentPositionParams,
  TextDocumentSyncKind,
  InitializeResult,
  DocumentSymbolParams,
  SymbolInformation,
  SymbolKind,
  Hover,
  HoverParams,
  DocumentFormattingParams,
  TextEdit,
  Range,
  Position,
  SignatureHelp,
  SignatureHelpParams,
  SignatureInformation,
  ParameterInformation,
  CodeAction,
  CodeActionKind,
  CodeActionParams
} from "vscode-languageserver/node";

import { TextDocument } from "vscode-languageserver-textdocument";
import { parseHypenDocument, getContextAtPosition, isInString, initWasmParser, isWasmParserAvailable } from "./parser";
import { a11yDiagnostics, initWasmEngine } from "./a11y";
import { computeQuickFix } from "./quickfix";

// Create a connection for the server
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

connection.onInitialize((params: InitializeParams) => {
  const capabilities = params.capabilities;

  // Does the client support the `workspace/configuration` request?
  hasConfigurationCapability = !!(
    capabilities.workspace && !!capabilities.workspace.configuration
  );
  hasWorkspaceFolderCapability = !!(
    capabilities.workspace && !!capabilities.workspace.workspaceFolders
  );
  hasDiagnosticRelatedInformationCapability = !!(
    capabilities.textDocument &&
    capabilities.textDocument.publishDiagnostics &&
    capabilities.textDocument.publishDiagnostics.relatedInformation
  );

  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: true,
        triggerCharacters: [".", "@", "(", ":", " "]
      },
      hoverProvider: true,
      documentSymbolProvider: true,
      documentFormattingProvider: true,
      codeActionProvider: true,
      signatureHelpProvider: {
        triggerCharacters: ["(", ","],
        retriggerCharacters: [","]
      }
    }
  };
  if (hasWorkspaceFolderCapability) {
    result.capabilities.workspace = {
      workspaceFolders: {
        supported: true
      }
    };
  }
  return result;
});

connection.onInitialized(async () => {
  if (hasConfigurationCapability) {
    connection.client.register(DidChangeConfigurationNotification.type, undefined);
  }
  if (hasWorkspaceFolderCapability) {
    connection.workspace.onDidChangeWorkspaceFolders(_event => {
      connection.console.log("Workspace folder change event received.");
    });
  }

  // Try to load WASM parser
  const wasmLoaded = await initWasmParser();
  if (wasmLoaded) {
    connection.console.log("Hypen LSP: WASM parser loaded successfully");
  } else {
    connection.console.log("Hypen LSP: Using regex-based parser (WASM not available)");
  }

  // Try to load the engine WASM for accessibility conformance squiggles.
  const engineLoaded = await initWasmEngine();
  if (engineLoaded) {
    connection.console.log("Hypen LSP: engine WASM loaded — a11y diagnostics active");
    // Documents validated before the engine finished loading have no a11y
    // findings yet — revalidate them now.
    documents.all().forEach(validateTextDocument);
  } else {
    connection.console.log("Hypen LSP: engine WASM not available — a11y diagnostics disabled");
  }
});

// The example settings
interface HypenSettings {
  maxNumberOfProblems: number;
  formatting: {
    enable: boolean;
  };
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
const defaultSettings: HypenSettings = { 
  maxNumberOfProblems: 100,
  formatting: {
    enable: true
  }
};
let globalSettings: HypenSettings = defaultSettings;

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<HypenSettings>> = new Map();

connection.onDidChangeConfiguration(change => {
  if (hasConfigurationCapability) {
    documentSettings.clear();
  } else {
    globalSettings = <HypenSettings>(
      (change.settings.hypen || defaultSettings)
    );
  }

  // Revalidate all open text documents
  documents.all().forEach(validateTextDocument);
});

function getDocumentSettings(resource: string): Thenable<HypenSettings> {
  if (!hasConfigurationCapability) {
    return Promise.resolve(globalSettings);
  }
  let result = documentSettings.get(resource);
  if (!result) {
    result = connection.workspace.getConfiguration({
      scopeUri: resource,
      section: "hypen"
    });
    documentSettings.set(resource, result);
  }
  return result;
}

// Only keep settings for open documents
documents.onDidClose(e => {
  documentSettings.delete(e.document.uri);
});

// The content of a text document has changed
documents.onDidChangeContent(change => {
  validateTextDocument(change.document);
});

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
  const settings = await getDocumentSettings(textDocument.uri);
  const text = textDocument.getText();
  const diagnostics: Diagnostic[] = [];

  // Parse the document and collect errors
  try {
    const parseResult = parseHypenDocument(text);
    
    // Add errors
    for (const error of parseResult.errors.slice(0, settings.maxNumberOfProblems)) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: error.range,
        message: error.message,
        source: "hypen"
      });
    }
    
    // Add warnings
    for (const warning of parseResult.warnings) {
      diagnostics.push({
        severity: DiagnosticSeverity.Warning,
        range: warning.range,
        message: warning.message,
        source: "hypen"
      });
    }
  } catch (e) {
    // If parsing completely fails, report a general error
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 }
      },
      message: `Parsing failed: ${e}`,
      source: "hypen"
    });
  }

  // Accessibility conformance squiggles (source: "hypen-a11y", code: rule).
  // No-op until the engine WASM has loaded; parse failures return [] so a
  // syntax error is never double-reported.
  diagnostics.push(...a11yDiagnostics(text));

  // Send the computed diagnostics to VSCode
  connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

// Parser functions imported from parser.ts module

// ─── Built-in Components ─────────────────────────────────────────────────────

const commonComponents = [
  // Layout
  "Column", "Row", "Container", "Box", "Center", "Stack", "Grid", "Spacer", "Divider",
  // Content
  "Text", "Heading", "Paragraph", "Image", "Avatar", "Badge", "Card", "Spinner", "ProgressBar",
  // Input
  "Button", "Input", "Textarea", "Checkbox", "Switch", "Select", "Slider", "Scrubber",
  // Navigation
  "Router", "Route", "Link",
  // Media
  "Video", "Audio"
];

// ─── Applicators ─────────────────────────────────────────────────────────────

const commonApplicators = [
  // Padding
  "padding", "paddingTop", "paddingBottom", "paddingLeft", "paddingRight",
  "paddingHorizontal", "paddingVertical",
  // Margin
  "margin", "marginTop", "marginBottom", "marginLeft", "marginRight",
  "marginHorizontal", "marginVertical",
  // Sizing
  "width", "height", "minWidth", "minHeight", "maxWidth", "maxHeight",
  "size", "aspectRatio", "flex", "flexGrow", "flexShrink",
  "fillMaxWidth", "fillMaxHeight", "fillMaxSize",
  // Colors
  "color", "backgroundColor", "borderColor",
  // Borders
  "border", "borderWidth", "borderStyle", "borderRadius",
  "borderTopLeftRadius", "borderTopRightRadius",
  "borderBottomLeftRadius", "borderBottomRightRadius",
  // Layout
  "gap", "rowGap", "columnGap",
  "horizontalAlignment", "verticalAlignment",
  "flexDirection", "justifyContent", "alignItems", "alignContent",
  "overflow", "scrollable", "weight",
  // Typography
  "fontSize", "fontWeight", "fontFamily", "fontStyle",
  "textAlign", "textDecoration", "textTransform",
  "lineHeight", "letterSpacing", "maxLines", "textOverflow",
  // Effects
  "opacity", "blur", "boxShadow", "filter", "backdropFilter", "elevation",
  // Transform
  "rotate", "scale", "scaleX", "scaleY", "translateX", "translateY", "transform",
  // Position
  "position", "offset", "zIndex",
  // Grid
  "gridColumns", "gridTemplateColumns", "gridAutoFlow", "gridAutoRows",
  // Background
  "linearGradient", "radialGradient",
  // Display
  "display", "visibility",
  // Transition
  "transition", "cursor",
  // Events
  "onClick", "onPress", "onChange", "onSubmit", "onInput",
  "onKey", "onScroll", "onLongClick", "onLongPress",
  "onFocus", "onBlur", "onMouseEnter", "onMouseLeave",
  // Binding
  "bind",
  // Composition
  "slot",
  // Renderer-local intents
  "videoIntent",
  // Tailwind
  "tw"
];

// ─── Component Signatures (for signature help) ──────────────────────────────

interface ComponentSignature {
  label: string;
  documentation: string;
  parameters: { label: string; documentation: string }[];
}

const componentSignatures: Record<string, ComponentSignature> = {
  // ── Layout ──
  Column: {
    label: "Column { children }",
    documentation: "Vertical flex container. Stacks children top-to-bottom.\n\n```hypen\nColumn {\n  Text(\"First\")\n  Text(\"Second\")\n}\n  .gap(12)\n  .padding(16)\n```",
    parameters: []
  },
  Row: {
    label: "Row { children }",
    documentation: "Horizontal flex container. Arranges children left-to-right.\n\n```hypen\nRow {\n  Text(\"Left\")\n  Spacer\n  Text(\"Right\")\n}\n  .gap(8)\n```",
    parameters: []
  },
  Container: {
    label: "Container { children }",
    documentation: "Generic wrapper for grouping and styling. Renders as a `div`.\n\n```hypen\nContainer {\n  Text(\"Content\")\n}\n  .padding(16)\n  .backgroundColor(\"#f0f0f0\")\n```",
    parameters: []
  },
  Box: {
    label: "Box { children }",
    documentation: "Alias for Container. Generic wrapper for grouping and styling.",
    parameters: []
  },
  Center: {
    label: "Center { children }",
    documentation: "Centers its children both horizontally and vertically.\n\n```hypen\nCenter {\n  Spinner\n}\n```",
    parameters: []
  },
  Stack: {
    label: "Stack { children }",
    documentation: "Overlays children on the z-axis. Later children appear on top.\n\n```hypen\nStack {\n  Image(src: \"bg.jpg\")\n  Text(\"Overlay\")\n}\n```",
    parameters: []
  },
  Grid: {
    label: "Grid { children }",
    documentation: "Grid layout container. Use `.gridColumns()` to set column count.\n\n```hypen\nGrid {\n  Card { Text(\"1\") }\n  Card { Text(\"2\") }\n  Card { Text(\"3\") }\n}\n  .gridColumns(3)\n  .gap(12)\n```",
    parameters: []
  },
  Spacer: {
    label: "Spacer",
    documentation: "Flexible space that expands to fill available room in a Row or Column. Takes no arguments or children.\n\n```hypen\nRow {\n  Text(\"Left\")\n  Spacer\n  Button { Text(\"Right\") }\n}\n```",
    parameters: []
  },
  Divider: {
    label: "Divider",
    documentation: "A thin horizontal line for visual separation. Style with `.color()` and `.height()`.\n\n```hypen\nColumn {\n  Text(\"Above\")\n  Divider\n  Text(\"Below\")\n}\n```",
    parameters: []
  },

  // ── Content ──
  Text: {
    label: "Text(content: String)",
    documentation: "Displays inline text. Supports `@{state.path}` interpolation.\n\n```hypen\nText(\"Hello, @{state.name}!\")\n  .fontSize(18)\n  .color(\"#333\")\n  .fontWeight(\"bold\")\n```",
    parameters: [
      { label: "content", documentation: "Text string. Supports `@{state.path}` for state interpolation." }
    ]
  },
  Heading: {
    label: "Heading(content: String)",
    documentation: "Heading text rendered as `<h1>`–`<h6>`. Use `.fontSize()` to control size.\n\n```hypen\nHeading(\"Page Title\")\n  .fontSize(32)\n```",
    parameters: [
      { label: "content", documentation: "Heading text content" }
    ]
  },
  Paragraph: {
    label: "Paragraph(content: String)",
    documentation: "Block-level text rendered as `<p>`. Suitable for body copy.\n\n```hypen\nParagraph(\"A longer block of descriptive text.\")\n  .lineHeight(1.6)\n```",
    parameters: [
      { label: "content", documentation: "Paragraph text content" }
    ]
  },
  Image: {
    label: "Image(src: String, alt?: String)",
    documentation: "Displays an image from a URL or asset path.\n\n```hypen\nImage(src: \"photo.jpg\", alt: \"Profile photo\")\n  .width(200)\n  .borderRadius(8)\n```",
    parameters: [
      { label: "src", documentation: "Image URL or asset path" },
      { label: "alt", documentation: "Accessible alternative text (optional)" }
    ]
  },
  Avatar: {
    label: "Avatar(src: String)",
    documentation: "Circular image for profile pictures or icons.\n\n```hypen\nAvatar(src: \"@{state.user.avatar}\")\n  .size(48)\n```",
    parameters: [
      { label: "src", documentation: "Image URL or asset path" }
    ]
  },
  Badge: {
    label: "Badge(content: String)",
    documentation: "Small label for counts, status, or tags.\n\n```hypen\nBadge(\"New\")\n  .backgroundColor(\"red\")\n  .color(\"white\")\n```",
    parameters: [
      { label: "content", documentation: "Badge label text" }
    ]
  },
  Card: {
    label: "Card { children }",
    documentation: "Elevated surface for grouping related content. Apply `.elevation()` for shadow depth.\n\n```hypen\nCard {\n  Text(\"Card Title\")\n    .fontWeight(\"bold\")\n  Text(\"Card content\")\n}\n  .padding(16)\n  .elevation(2)\n```",
    parameters: []
  },
  Spinner: {
    label: "Spinner",
    documentation: "Animated loading indicator. Takes no arguments.\n\n```hypen\nwhen(@{state.loading}) {\n  Center { Spinner }\n}\n```",
    parameters: []
  },
  ProgressBar: {
    label: "ProgressBar(value: Number)",
    documentation: "Horizontal progress bar. Value ranges from 0 to 1.\n\n```hypen\nProgressBar(value: @{state.progress})\n  .backgroundColor(\"#eee\")\n  .color(\"green\")\n```",
    parameters: [
      { label: "value", documentation: "Progress from 0.0 (empty) to 1.0 (full)" }
    ]
  },

  // ── Input ──
  Button: {
    label: "Button { children }",
    documentation: "Interactive button. Content goes in children. Attach actions with `.onClick(@actions.name)`.\n\n```hypen\nButton {\n  Text(\"Submit\")\n}\n  .onClick(@actions.submit)\n  .padding(12)\n  .backgroundColor(\"blue\")\n  .borderRadius(8)\n```",
    parameters: []
  },
  Input: {
    label: "Input(placeholder?: String, type?: String)",
    documentation: "Single-line text input. Use `.bind(@state.path)` for two-way binding, or `.onInput(@actions.name)` for manual handling.\n\n```hypen\nInput(placeholder: \"Enter your name\")\n  .bind(@state.name)\n  .padding(8)\n  .border(1, \"solid\", \"#ccc\")\n```",
    parameters: [
      { label: "placeholder", documentation: "Hint text shown when empty" },
      { label: "type", documentation: "HTML input type: text, password, email, number, etc." }
    ]
  },
  Textarea: {
    label: "Textarea(placeholder?: String)",
    documentation: "Multi-line text area. Use `.bind(@state.path)` for two-way binding.\n\n```hypen\nTextarea(placeholder: \"Write your message...\")\n  .bind(@state.message)\n  .height(120)\n```",
    parameters: [
      { label: "placeholder", documentation: "Hint text shown when empty" }
    ]
  },
  Checkbox: {
    label: "Checkbox { label }",
    documentation: "Checkbox toggle. Use `.bind(@state.path)` to sync with a boolean state.\n\n```hypen\nCheckbox {\n  Text(\"I agree to the terms\")\n}\n  .bind(@state.agreed)\n```",
    parameters: []
  },
  Switch: {
    label: "Switch { label }",
    documentation: "Toggle switch. Use `.bind(@state.path)` to sync with a boolean state.\n\n```hypen\nSwitch {\n  Text(\"Dark mode\")\n}\n  .bind(@state.darkMode)\n```",
    parameters: []
  },
  Select: {
    label: "Select { options }",
    documentation: "Dropdown select. Use `.bind(@state.path)` to sync the selected value.\n\n```hypen\nSelect {\n  // Options go here\n}\n  .bind(@state.country)\n```",
    parameters: []
  },
  Slider: {
    label: "Slider(min?: Number, max?: Number)",
    documentation: "Range slider input. Use `.bind(@state.path)` to sync the numeric value.\n\n```hypen\nSlider(min: 0, max: 100)\n  .bind(@state.volume)\n```",
    parameters: [
      { label: "min", documentation: "Minimum value (default 0)" },
      { label: "max", documentation: "Maximum value (default 100)" }
    ]
  },

  // ── Navigation ──
  Router: {
    label: "Router { routes }",
    documentation: "Top-level router container. Contains Route children.\n\n```hypen\nRouter {\n  Route(path: \"/\") { HomePage }\n  Route(path: \"/about\") { AboutPage }\n}\n```",
    parameters: []
  },
  Route: {
    label: "Route(path: String) { content }",
    documentation: "Defines a route within a Router.\n\n```hypen\nRoute(path: \"/users/:id\") {\n  UserProfile\n}\n```",
    parameters: [
      { label: "path", documentation: "URL path pattern. Supports `:param` dynamic segments." }
    ]
  },
  Link: {
    label: "Link(to: String) { children }",
    documentation: "Navigation link. Renders as `<a>` and integrates with the Router.\n\n```hypen\nLink(to: \"/about\") {\n  Text(\"About Us\")\n}\n```",
    parameters: [
      { label: "to", documentation: "Target path or URL" }
    ]
  },

  // ── Media ──
  Video: {
    label: "Video(src: String, playlist?: [String], poster?: String)",
    documentation: "Embeds a video player. Plays a resolved streamable URL, or an ordered `playlist` of URLs with auto-advance — only URLs cross the wire, never media payloads.\n\n```hypen\nVideo(\n  src: \"https://cdn.example.com/intro.mp4\",\n  poster: \"thumbnail.jpg\",\n  controls: true,\n  startPosition: 90,\n  onError: @actions.playbackFailed,\n)\n  .fillMaxWidth(true)\n  .height(220)\n```\n\n**Props:** `src` (or positional), `playlist`, `startIndex`, `startPosition`, `poster`, `controls`, `autoplay`, `loop`, `muted`, `preload`, `headers`, plus the `onPlay` / `onPause` / `onEnded` / `onTrackChange` / `onError` action refs.\n\n`startPosition: Number` seeks once, when the source first becomes seekable — \"resume where you left off\" without a full bind. It re-arms when `src`/`playlist`/`headers` change.\n\n**Playback control — `.bind(@state.playback)`**\n\nBinds a playback struct: `{ playing: Boolean, position: Number, duration: Number, state: String }`. `playing`/`position` are read-write (a `position` write seeks, applied only past a 1 s epsilon); `duration`/`state` are renderer-owned. `state` is one of `idle` | `loading` | `playing` | `paused` | `ended` | `error`. The module must initialize the struct in `defineState` — writes to a missing parent path drop silently. Position reports are throttled to 250 ms while playing; transitions report immediately.\n\n**Composition slots**\n\nChildren tagged `.slot(\"controls\")`, `.slot(\"loading\")`, `.slot(\"error\")` or `.slot(\"poster\")` compose into the player chrome, overlaid full-bleed and shown/hidden by player state. A present slot replaces the built-in for that concern (a `controls` slot suppresses native chrome regardless of the `controls` prop). Untagged children are invalid — Video is a leaf otherwise.\n\n```hypen\nVideo(src: \"@{state.url}\", autoplay: true) {\n  Row {\n    Button { Text(\"⏯\") }\n      .onClick(@actions.togglePlay)\n    Scrubber()\n  }\n    .slot(\"controls\")\n\n  Column { Spinner() }\n    .slot(\"loading\")\n}\n  .bind(@state.playback)\n```",
    parameters: [
      { label: "src", documentation: "Resolved streamable video URL (progressive MP4/WebM; HLS where the platform supports it)" },
      { label: "playlist", documentation: "Ordered array of URLs played in sequence. Supersedes src when non-empty; auto-advances when a track ends" },
      { label: "startIndex", documentation: "Index into playlist to start from (default 0, clamped to valid range)" },
      { label: "poster", documentation: "Image URL shown before playback starts" },
      { label: "controls", documentation: "Show native transport controls (default false)" },
      { label: "autoplay", documentation: "Start playback when ready (default false; browsers fall back to muted autoplay)" },
      { label: "loop", documentation: "Loop the video; with a playlist, wrap to track 0 after the last track (default false)" },
      { label: "muted", documentation: "Start muted (default false)" },
      { label: "preload", documentation: "Web preload hint: \"none\" | \"metadata\" | \"auto\" (default \"metadata\")" },
      { label: "headers", documentation: "Map of extra HTTP request headers for media fetches (auth-protected streams)" },
      { label: "onPlay", documentation: "@actions ref — playback starts/resumes. Payload: { type, src, index }" },
      { label: "onPause", documentation: "@actions ref — playback pauses. Payload: { type, src, index }" },
      { label: "onEnded", documentation: "@actions ref — a track finishes. Payload: { type, src, index, completed }" },
      { label: "onTrackChange", documentation: "@actions ref — the playlist advances to a new track. Payload: { type, src, index }" },
      { label: "onError", documentation: "@actions ref — the stream cannot be fetched or decoded. Payload: { type, src, index, status?, code?, message }" }
    ]
  },
  Scrubber: {
    label: "Scrubber(onSeek?: @actions.name, disabled?: Boolean)",
    documentation: "Media timeline for a Video's `controls` slot. Inside a Video it wires itself to the enclosing player renderer-side: the thumb tracks playback at frame rate without touching module state, dragging previews locally, and only the release commits.\n\nCommit resolution: the Scrubber's own `.bind(...)` wins, else the enclosing Video's `.bind(@state.playback)`, else the `onSeek` action (payload `{ type: \"seek\", position }`). The local seek applies in every case, so the playhead moves even with no wire commit. Outside a Video, `Scrubber` renders inert.\n\nExposes the `slider` accessibility role, with `aria-valuemin`/`aria-valuemax`/`aria-valuenow` tracking the timeline; arrow keys seek ±5 s and commit immediately.\n\n```hypen\nVideo(src: \"@{state.url}\") {\n  Row {\n    Scrubber()\n      .fillMaxWidth(true)\n  }\n    .slot(\"controls\")\n}\n  .bind(@state.playback)\n```",
    parameters: [
      { label: "onSeek", documentation: "@actions ref — fallback seek commit when neither the Scrubber nor the Video carries a bind. Payload: { type: \"seek\", position }" },
      { label: "disabled", documentation: "Render inert — not focusable, no commits (default false)" }
    ]
  },
  Audio: {
    label: "Audio(src: String)",
    documentation: "Embeds an audio player.\n\n```hypen\nAudio(src: \"track.mp3\")\n```",
    parameters: [
      { label: "src", documentation: "Audio URL or asset path" }
    ]
  }
};

// ─── Applicator Signatures (for signature help) ─────────────────────────────

const applicatorSignatures: Record<string, ComponentSignature> = {
  // Padding
  padding:            { label: ".padding(value: Number)", documentation: "Inner spacing on all sides", parameters: [{ label: "value", documentation: "Pixels" }] },
  paddingTop:         { label: ".paddingTop(value: Number)", documentation: "Inner spacing on top edge", parameters: [{ label: "value", documentation: "Pixels" }] },
  paddingBottom:      { label: ".paddingBottom(value: Number)", documentation: "Inner spacing on bottom edge", parameters: [{ label: "value", documentation: "Pixels" }] },
  paddingLeft:        { label: ".paddingLeft(value: Number)", documentation: "Inner spacing on left edge", parameters: [{ label: "value", documentation: "Pixels" }] },
  paddingRight:       { label: ".paddingRight(value: Number)", documentation: "Inner spacing on right edge", parameters: [{ label: "value", documentation: "Pixels" }] },
  paddingHorizontal:  { label: ".paddingHorizontal(value: Number)", documentation: "Inner spacing on left and right", parameters: [{ label: "value", documentation: "Pixels" }] },
  paddingVertical:    { label: ".paddingVertical(value: Number)", documentation: "Inner spacing on top and bottom", parameters: [{ label: "value", documentation: "Pixels" }] },
  // Margin
  margin:             { label: ".margin(value: Number)", documentation: "Outer spacing on all sides", parameters: [{ label: "value", documentation: "Pixels" }] },
  marginTop:          { label: ".marginTop(value: Number)", documentation: "Outer spacing on top edge", parameters: [{ label: "value", documentation: "Pixels" }] },
  marginBottom:       { label: ".marginBottom(value: Number)", documentation: "Outer spacing on bottom edge", parameters: [{ label: "value", documentation: "Pixels" }] },
  marginLeft:         { label: ".marginLeft(value: Number)", documentation: "Outer spacing on left edge", parameters: [{ label: "value", documentation: "Pixels" }] },
  marginRight:        { label: ".marginRight(value: Number)", documentation: "Outer spacing on right edge", parameters: [{ label: "value", documentation: "Pixels" }] },
  marginHorizontal:   { label: ".marginHorizontal(value: Number)", documentation: "Outer spacing on left and right", parameters: [{ label: "value", documentation: "Pixels" }] },
  marginVertical:     { label: ".marginVertical(value: Number)", documentation: "Outer spacing on top and bottom", parameters: [{ label: "value", documentation: "Pixels" }] },
  // Sizing
  width:              { label: ".width(value: Number | String)", documentation: "Sets width. Accepts a number (pixels) or string with unit: `%`, `vw`, `vh`, `vmin`, `vmax`, `em`, `rem`, `px`, `dp`, `pt`, or `\"auto\"`.", parameters: [{ label: "value", documentation: "Number (px) or string: \"100vw\", \"50%\", \"auto\", \"20rem\", etc." }] },
  height:             { label: ".height(value: Number | String)", documentation: "Sets height. Accepts a number (pixels) or string with unit: `%`, `vw`, `vh`, `vmin`, `vmax`, `em`, `rem`, `px`, `dp`, `pt`, or `\"auto\"`.", parameters: [{ label: "value", documentation: "Number (px) or string: \"100vh\", \"50%\", \"auto\", \"20rem\", etc." }] },
  minWidth:           { label: ".minWidth(value: Number | String)", documentation: "Minimum width constraint. Accepts same units as `.width()`.", parameters: [{ label: "value", documentation: "Number (px) or string with unit" }] },
  minHeight:          { label: ".minHeight(value: Number | String)", documentation: "Minimum height constraint. Accepts same units as `.height()`.", parameters: [{ label: "value", documentation: "Number (px) or string with unit" }] },
  maxWidth:           { label: ".maxWidth(value: Number | String)", documentation: "Maximum width constraint. Accepts same units as `.width()`.", parameters: [{ label: "value", documentation: "Number (px) or string with unit" }] },
  maxHeight:          { label: ".maxHeight(value: Number | String)", documentation: "Maximum height constraint. Accepts same units as `.height()`.", parameters: [{ label: "value", documentation: "Number (px) or string with unit" }] },
  size:               { label: ".size(value: Number)", documentation: "Sets both width and height to the same value", parameters: [{ label: "value", documentation: "Pixels" }] },
  aspectRatio:        { label: ".aspectRatio(ratio: Number)", documentation: "Constrains the aspect ratio (e.g. 16/9)", parameters: [{ label: "ratio", documentation: "Width/height ratio" }] },
  flex:               { label: ".flex(value: Number)", documentation: "Sets CSS flex shorthand", parameters: [{ label: "value", documentation: "Flex value" }] },
  flexGrow:           { label: ".flexGrow(value: Number)", documentation: "How much the item grows relative to siblings", parameters: [{ label: "value", documentation: "Growth factor (default 0)" }] },
  flexShrink:         { label: ".flexShrink(value: Number)", documentation: "How much the item shrinks relative to siblings", parameters: [{ label: "value", documentation: "Shrink factor (default 1)" }] },
  fillMaxWidth:       { label: ".fillMaxWidth()", documentation: "Expands to fill all available width (width: 100%)", parameters: [] },
  fillMaxHeight:      { label: ".fillMaxHeight()", documentation: "Expands to fill all available height (height: 100%)", parameters: [] },
  fillMaxSize:        { label: ".fillMaxSize()", documentation: "Expands to fill all available space (width: 100%, height: 100%)", parameters: [] },
  // Colors
  color:              { label: ".color(value: Color)", documentation: "Text / foreground color", parameters: [{ label: "value", documentation: "Color name, hex (#fff), or rgb()" }] },
  backgroundColor:    { label: ".backgroundColor(value: Color)", documentation: "Background fill color", parameters: [{ label: "value", documentation: "Color name, hex (#fff), or rgb()" }] },
  borderColor:        { label: ".borderColor(value: Color)", documentation: "Border stroke color", parameters: [{ label: "value", documentation: "Color name, hex (#fff), or rgb()" }] },
  // Borders
  border:             { label: ".border(width: Number, style?: String, color?: Color)", documentation: "Shorthand for border width, style, and color", parameters: [{ label: "width", documentation: "Border width in pixels" }, { label: "style", documentation: "solid, dashed, dotted, none" }, { label: "color", documentation: "Border color" }] },
  borderWidth:        { label: ".borderWidth(value: Number)", documentation: "Border thickness on all sides", parameters: [{ label: "value", documentation: "Pixels" }] },
  borderStyle:        { label: ".borderStyle(style: String)", documentation: "Border line style", parameters: [{ label: "style", documentation: "solid, dashed, dotted, none" }] },
  borderRadius:       { label: ".borderRadius(value: Number)", documentation: "Corner rounding on all corners", parameters: [{ label: "value", documentation: "Radius in pixels" }] },
  borderTopLeftRadius:     { label: ".borderTopLeftRadius(value: Number)", documentation: "Top-left corner rounding", parameters: [{ label: "value", documentation: "Radius in pixels" }] },
  borderTopRightRadius:    { label: ".borderTopRightRadius(value: Number)", documentation: "Top-right corner rounding", parameters: [{ label: "value", documentation: "Radius in pixels" }] },
  borderBottomLeftRadius:  { label: ".borderBottomLeftRadius(value: Number)", documentation: "Bottom-left corner rounding", parameters: [{ label: "value", documentation: "Radius in pixels" }] },
  borderBottomRightRadius: { label: ".borderBottomRightRadius(value: Number)", documentation: "Bottom-right corner rounding", parameters: [{ label: "value", documentation: "Radius in pixels" }] },
  // Layout
  gap:                { label: ".gap(value: Number)", documentation: "Space between children in a flex/grid container", parameters: [{ label: "value", documentation: "Pixels" }] },
  rowGap:             { label: ".rowGap(value: Number)", documentation: "Vertical gap between rows in grid", parameters: [{ label: "value", documentation: "Pixels" }] },
  columnGap:          { label: ".columnGap(value: Number)", documentation: "Horizontal gap between columns", parameters: [{ label: "value", documentation: "Pixels" }] },
  horizontalAlignment: { label: ".horizontalAlignment(value: Alignment)", documentation: "Aligns children on the horizontal axis", parameters: [{ label: "value", documentation: "start, center, end, stretch" }] },
  verticalAlignment:  { label: ".verticalAlignment(value: Alignment)", documentation: "Aligns children on the vertical axis", parameters: [{ label: "value", documentation: "start, center, end, spaceBetween, spaceAround, spaceEvenly" }] },
  flexDirection:      { label: ".flexDirection(value: Direction)", documentation: "Main axis direction for flex layout", parameters: [{ label: "value", documentation: "row, column, rowReverse, columnReverse" }] },
  justifyContent:     { label: ".justifyContent(value: String)", documentation: "Distribution of items along the main axis", parameters: [{ label: "value", documentation: "start, center, end, spaceBetween, spaceAround, spaceEvenly" }] },
  alignItems:         { label: ".alignItems(value: String)", documentation: "Alignment of items along the cross axis", parameters: [{ label: "value", documentation: "start, center, end, stretch, baseline" }] },
  alignContent:       { label: ".alignContent(value: String)", documentation: "Distribution of wrapped lines", parameters: [{ label: "value", documentation: "start, center, end, stretch, spaceBetween, spaceAround" }] },
  overflow:           { label: ".overflow(value: String)", documentation: "How overflowing content is handled", parameters: [{ label: "value", documentation: "visible, hidden, scroll, auto" }] },
  scrollable:         { label: ".scrollable(enabled?: Boolean)", documentation: "Enables scrolling when content overflows", parameters: [{ label: "enabled", documentation: "true (default) or false" }] },
  weight:             { label: ".weight(value: Number)", documentation: "Flex grow factor (alias for flexGrow)", parameters: [{ label: "value", documentation: "Growth factor" }] },
  // Typography
  fontSize:           { label: ".fontSize(value: Number)", documentation: "Font size in pixels", parameters: [{ label: "value", documentation: "Pixels" }] },
  fontWeight:         { label: ".fontWeight(value: String | Number)", documentation: "Font boldness", parameters: [{ label: "value", documentation: "normal, bold, or 100–900" }] },
  fontFamily:         { label: ".fontFamily(name: String)", documentation: "Font family name", parameters: [{ label: "name", documentation: "Font name, e.g. \"Inter\", \"monospace\"" }] },
  fontStyle:          { label: ".fontStyle(value: String)", documentation: "Font style variant", parameters: [{ label: "value", documentation: "normal, italic" }] },
  textAlign:          { label: ".textAlign(value: String)", documentation: "Horizontal text alignment", parameters: [{ label: "value", documentation: "left, center, right, justify" }] },
  textDecoration:     { label: ".textDecoration(value: String)", documentation: "Text decoration line", parameters: [{ label: "value", documentation: "none, underline, lineThrough, overline" }] },
  textTransform:      { label: ".textTransform(value: String)", documentation: "Text capitalization", parameters: [{ label: "value", documentation: "none, uppercase, lowercase, capitalize" }] },
  lineHeight:         { label: ".lineHeight(value: Number)", documentation: "Spacing between lines of text", parameters: [{ label: "value", documentation: "Multiplier (e.g. 1.5) or pixels" }] },
  letterSpacing:      { label: ".letterSpacing(value: Number)", documentation: "Spacing between characters", parameters: [{ label: "value", documentation: "Pixels" }] },
  maxLines:           { label: ".maxLines(value: Number)", documentation: "Truncates text after N lines with ellipsis", parameters: [{ label: "value", documentation: "Maximum number of lines" }] },
  textOverflow:       { label: ".textOverflow(value: String)", documentation: "How overflowing text is handled", parameters: [{ label: "value", documentation: "clip, ellipsis" }] },
  // Effects
  opacity:            { label: ".opacity(value: Number)", documentation: "Transparency level", parameters: [{ label: "value", documentation: "0.0 (invisible) to 1.0 (opaque)" }] },
  blur:               { label: ".blur(radius: Number)", documentation: "Gaussian blur effect", parameters: [{ label: "radius", documentation: "Blur radius in pixels" }] },
  boxShadow:          { label: ".boxShadow(x: Number, y: Number, blur: Number, color: Color)", documentation: "Drop shadow effect", parameters: [{ label: "x", documentation: "Horizontal offset" }, { label: "y", documentation: "Vertical offset" }, { label: "blur", documentation: "Blur radius" }, { label: "color", documentation: "Shadow color" }] },
  elevation:          { label: ".elevation(level: Number)", documentation: "Material-style elevation shadow (higher = more shadow)", parameters: [{ label: "level", documentation: "Shadow depth (1–24)" }] },
  filter:             { label: ".filter(value: String)", documentation: "CSS filter function", parameters: [{ label: "value", documentation: "CSS filter string, e.g. \"grayscale(100%)\"" }] },
  backdropFilter:     { label: ".backdropFilter(value: String)", documentation: "Backdrop blur/filter behind the element", parameters: [{ label: "value", documentation: "CSS filter string, e.g. \"blur(10px)\"" }] },
  // Transform
  rotate:             { label: ".rotate(degrees: Number)", documentation: "Rotates the element", parameters: [{ label: "degrees", documentation: "Rotation in degrees" }] },
  scale:              { label: ".scale(factor: Number)", documentation: "Scales the element uniformly", parameters: [{ label: "factor", documentation: "Scale multiplier (1.0 = normal)" }] },
  scaleX:             { label: ".scaleX(factor: Number)", documentation: "Scales horizontally", parameters: [{ label: "factor", documentation: "Horizontal scale" }] },
  scaleY:             { label: ".scaleY(factor: Number)", documentation: "Scales vertically", parameters: [{ label: "factor", documentation: "Vertical scale" }] },
  translateX:         { label: ".translateX(value: Number)", documentation: "Shifts horizontally", parameters: [{ label: "value", documentation: "Pixels" }] },
  translateY:         { label: ".translateY(value: Number)", documentation: "Shifts vertically", parameters: [{ label: "value", documentation: "Pixels" }] },
  transform:          { label: ".transform(value: String)", documentation: "Raw CSS transform string", parameters: [{ label: "value", documentation: "CSS transform, e.g. \"rotate(45deg) scale(1.2)\"" }] },
  // Position
  position:           { label: ".position(value: String)", documentation: "CSS positioning scheme", parameters: [{ label: "value", documentation: "relative, absolute, fixed, sticky" }] },
  offset:             { label: ".offset(x: Number, y: Number)", documentation: "Position offset (requires position: absolute/relative)", parameters: [{ label: "x", documentation: "Horizontal offset pixels" }, { label: "y", documentation: "Vertical offset pixels" }] },
  zIndex:             { label: ".zIndex(value: Number)", documentation: "Stacking order (higher = in front)", parameters: [{ label: "value", documentation: "Integer z-index" }] },
  // Grid
  gridColumns:        { label: ".gridColumns(count: Number)", documentation: "Number of grid columns", parameters: [{ label: "count", documentation: "Column count" }] },
  gridTemplateColumns: { label: ".gridTemplateColumns(template: String)", documentation: "CSS grid-template-columns", parameters: [{ label: "template", documentation: "e.g. \"1fr 2fr 1fr\", \"repeat(3, 1fr)\"" }] },
  gridAutoFlow:       { label: ".gridAutoFlow(value: String)", documentation: "How auto-placed items flow", parameters: [{ label: "value", documentation: "row, column, dense" }] },
  gridAutoRows:       { label: ".gridAutoRows(value: String)", documentation: "Default size of auto-created rows", parameters: [{ label: "value", documentation: "e.g. \"minmax(100px, auto)\"" }] },
  // Background
  linearGradient:     { label: ".linearGradient(direction: String, ...colors)", documentation: "Linear gradient background", parameters: [{ label: "direction", documentation: "Angle or direction, e.g. \"to right\", \"135deg\"" }] },
  radialGradient:     { label: ".radialGradient(...colors)", documentation: "Radial gradient background", parameters: [] },
  // Display
  display:            { label: ".display(value: String)", documentation: "CSS display mode", parameters: [{ label: "value", documentation: "flex, grid, block, none, inline, etc." }] },
  visibility:         { label: ".visibility(value: String)", documentation: "Visibility without removing from layout", parameters: [{ label: "value", documentation: "visible, hidden" }] },
  // Transition
  transition:         { label: ".transition(value: String)", documentation: "CSS transition for animated property changes", parameters: [{ label: "value", documentation: "e.g. \"all 0.3s ease\", \"opacity 200ms\"" }] },
  cursor:             { label: ".cursor(value: String)", documentation: "Mouse cursor style", parameters: [{ label: "value", documentation: "pointer, default, grab, text, not-allowed, etc." }] },
  // Events
  onClick:            { label: ".onClick(action: @actions.name)", documentation: "Fires when clicked or tapped", parameters: [{ label: "action", documentation: "@actions.actionName" }] },
  onPress:            { label: ".onPress(action: @actions.name)", documentation: "Alias for onClick", parameters: [{ label: "action", documentation: "@actions.actionName" }] },
  onChange:           { label: ".onChange(action: @actions.name)", documentation: "Fires when a form element value changes (after blur)", parameters: [{ label: "action", documentation: "@actions.actionName" }] },
  onSubmit:           { label: ".onSubmit(action: @actions.name)", documentation: "Fires on form submission (prevents default)", parameters: [{ label: "action", documentation: "@actions.actionName" }] },
  onInput:            { label: ".onInput(action: @actions.name)", documentation: "Fires on every keystroke. Payload includes `value`.", parameters: [{ label: "action", documentation: "@actions.actionName" }] },
  onKey:              { label: ".onKey(key: String, action: @actions.name)", documentation: "Fires when a specific key is pressed (default: Enter)", parameters: [{ label: "key", documentation: "Key name, e.g. \"Enter\"" }, { label: "action", documentation: "@actions.actionName" }] },
  onScroll:           { label: ".onScroll(action: @actions.name)", documentation: "Fires on scroll (throttled). Payload includes `scrollTop`, `atBottom`.", parameters: [{ label: "action", documentation: "@actions.actionName" }] },
  onLongClick:        { label: ".onLongClick(action: @actions.name)", documentation: "Fires after a 500ms press-and-hold", parameters: [{ label: "action", documentation: "@actions.actionName" }] },
  onLongPress:        { label: ".onLongPress(action: @actions.name)", documentation: "Alias for onLongClick", parameters: [{ label: "action", documentation: "@actions.actionName" }] },
  onFocus:            { label: ".onFocus(action: @actions.name)", documentation: "Fires when the element gains focus", parameters: [{ label: "action", documentation: "@actions.actionName" }] },
  onBlur:             { label: ".onBlur(action: @actions.name)", documentation: "Fires when the element loses focus", parameters: [{ label: "action", documentation: "@actions.actionName" }] },
  onMouseEnter:       { label: ".onMouseEnter(action: @actions.name)", documentation: "Fires when the mouse enters the element (desktop)", parameters: [{ label: "action", documentation: "@actions.actionName" }] },
  onMouseLeave:       { label: ".onMouseLeave(action: @actions.name)", documentation: "Fires when the mouse leaves the element (desktop)", parameters: [{ label: "action", documentation: "@actions.actionName" }] },
  // Binding
  bind:               { label: ".bind(stateRef: @state.path)", documentation: "Two-way data binding. Syncs the element's value with the given state path automatically.\n\nWorks with: Input, Textarea, Checkbox, Switch, Select, Slider.\n\nOn **Video** it binds a playback struct instead of a scalar — `{ playing, position, duration, state }`. `playing`/`position` are read-write (a `position` write seeks); `duration`/`state` are renderer-owned. Initialize the struct in `defineState` or the writes drop.\n\n```hypen\nVideo(src: \"@{state.url}\")\n  .bind(@state.playback)\n```\n\nOn **Scrubber** it overrides which struct a seek commits to (otherwise the enclosing Video's bind is used).", parameters: [{ label: "stateRef", documentation: "@state.fieldName — the state path to bind to" }] },
  // Composition
  slot:               { label: ".slot(name: String)", documentation: "Assigns the element to a named slot of its parent.\n\nOn a **component** with `Children().slot(\"name\")` placeholders, it routes the child into that placeholder.\n\nOn a **Video** child it selects a composition slot — `\"controls\"`, `\"loading\"`, `\"error\"` or `\"poster\"` — overlaid full-bleed on the video surface and shown/hidden by player state. A present slot replaces the built-in for that concern.\n\n```hypen\nVideo(src: \"@{state.url}\") {\n  Row { Scrubber() }\n    .slot(\"controls\")\n  Column { Spinner() }\n    .slot(\"loading\")\n}\n```", parameters: [{ label: "name", documentation: "Slot name. On Video: \"controls\", \"loading\", \"error\", \"poster\"" }] },
  // Renderer-local intents
  videoIntent:        { label: ".videoIntent(intent: String)", documentation: "Renderer-local video intent. Tag any element inside a **Video**'s subtree — typically a `controls`-slot button — and the renderer handles the tap itself: no action, no module, no round trip (platforms gate fullscreen behind a user gesture, which a network hop can lose).\n\n**`\"fullscreen\"`** — the only intent today. Toggles fullscreen on the **video container** (the wrapper hosting the surface *and* the composition slots), never on the raw platform video element, so custom controls stay overlaid instead of being replaced by native player chrome. The same tagged element toggles back out. Player state and events are unaffected — fullscreen is presentation only.\n\nInert outside a Video subtree, and inert on renderers that have not implemented it — so it is safe to author everywhere.\n\n```hypen\nVideo(src: \"@{state.url}\") {\n  Row {\n    Scrubber()\n    Button { Icon(@resources.fullscreen) }\n      .videoIntent(\"fullscreen\")\n      .label(\"Toggle fullscreen\")\n  }\n    .slot(\"controls\")\n}\n```", parameters: [{ label: "intent", documentation: "\"fullscreen\" — toggle the enclosing Video's container fullscreen" }] },
  // Tailwind
  tw:                 { label: ".tw(classes: String)", documentation: "Apply Tailwind CSS utility classes.\n\n```hypen\nContainer {\n  Text(\"Styled\")\n}\n  .tw(\"p-4 bg-blue-500 rounded-lg\")\n```", parameters: [{ label: "classes", documentation: "Space-separated Tailwind class names" }] }
};

// ─── Component Argument Names (for argument completion) ──────────────────────

const componentArguments: Record<string, string[]> = {
  Text: ["text"],
  Heading: ["text"],
  Paragraph: ["text"],
  Image: ["src", "alt"],
  Avatar: ["src"],
  Badge: ["text"],
  ProgressBar: ["value"],
  Input: ["placeholder", "type", "value"],
  Textarea: ["placeholder", "value"],
  Slider: ["min", "max", "step", "value"],
  Route: ["path"],
  Link: ["to"],
  Video: ["src", "playlist", "startIndex", "startPosition", "poster", "controls", "autoplay", "loop", "muted", "preload", "headers", "onPlay", "onPause", "onEnded", "onTrackChange", "onError"],
  Scrubber: ["onSeek", "disabled"],
  Audio: ["src", "autoplay", "controls", "loop"]
};

// ─── Value Suggestions ───────────────────────────────────────────────────────

const colorValues = [
  "red", "blue", "green", "yellow", "orange", "purple", "pink",
  "black", "white", "gray", "transparent",
  "primary", "secondary", "accent", "background", "surface", "error"
];
const alignmentValues = ["start", "center", "end", "stretch", "baseline"];
const justifyValues = ["start", "center", "end", "spaceBetween", "spaceAround", "spaceEvenly"];
const fontWeightValues = ["normal", "bold", "100", "200", "300", "400", "500", "600", "700", "800", "900"];
const textAlignValues = ["left", "center", "right", "justify"];
const flexDirectionValues = ["row", "column", "rowReverse", "columnReverse"];
const borderStyleValues = ["solid", "dashed", "dotted", "none"];
const overflowValues = ["visible", "hidden", "scroll", "auto"];
const positionValues = ["relative", "absolute", "fixed", "sticky"];
const displayValues = ["flex", "grid", "block", "none", "inline", "inlineFlex"];
const visibilityValues = ["visible", "hidden"];
const textTransformValues = ["none", "uppercase", "lowercase", "capitalize"];
const textDecorationValues = ["none", "underline", "lineThrough", "overline"];
const textOverflowValues = ["clip", "ellipsis"];
const cursorValues = ["pointer", "default", "grab", "grabbing", "text", "move", "not-allowed", "crosshair"];
const fontStyleValues = ["normal", "italic"];
const inputTypeValues = ["text", "password", "email", "number", "tel", "url", "search", "date"];

const valueCompletions: Record<string, string[]> = {
  color: colorValues,
  backgroundColor: colorValues,
  borderColor: colorValues,
  horizontalAlignment: alignmentValues,
  alignment: alignmentValues,
  verticalAlignment: justifyValues,
  justifyContent: justifyValues,
  alignItems: alignmentValues,
  alignContent: justifyValues,
  fontWeight: fontWeightValues,
  fontStyle: fontStyleValues,
  textAlign: textAlignValues,
  textDecoration: textDecorationValues,
  textTransform: textTransformValues,
  textOverflow: textOverflowValues,
  flexDirection: flexDirectionValues,
  borderStyle: borderStyleValues,
  overflow: overflowValues,
  position: positionValues,
  display: displayValues,
  visibility: visibilityValues,
  cursor: cursorValues,
  type: inputTypeValues
};

// Helper to find the component or applicator context at position
function findContextDetails(text: string, line: number, character: number): {
  componentName: string | null;
  applicatorName: string | null;
  argumentName: string | null;
  inValue: boolean;
} {
  const lines = text.split("\n");
  const currentLine = lines[line] || "";
  const beforeCursor = currentLine.substring(0, character);

  let componentName: string | null = null;
  let applicatorName: string | null = null;
  let argumentName: string | null = null;
  let inValue = false;

  // Check if we're in an applicator call: .applicatorName(
  const applicatorMatch = beforeCursor.match(/\.(\w+)\s*\([^)]*$/);
  if (applicatorMatch) {
    applicatorName = applicatorMatch[1];
  }

  // Check if we're in a component call: ComponentName(
  const componentMatch = beforeCursor.match(/([A-Z]\w*)\s*\([^)]*$/);
  if (componentMatch) {
    componentName = componentMatch[1];
  }

  // Check if we're after an argument name: argName:
  const argNameMatch = beforeCursor.match(/(\w+)\s*:\s*[^,)]*$/);
  if (argNameMatch) {
    argumentName = argNameMatch[1];
    inValue = true;
  }

  // If no component found on current line, search backwards
  if (!componentName && !applicatorName) {
    for (let i = line; i >= 0; i--) {
      const searchLine = lines[i];
      const compMatch = searchLine.match(/([A-Z]\w*)\s*(\(|\{)/);
      if (compMatch) {
        componentName = compMatch[1];
        break;
      }
    }
  }

  return { componentName, applicatorName, argumentName, inValue };
}

connection.onCompletion(
  (_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
    const document = documents.get(_textDocumentPosition.textDocument.uri);
    if (!document) {
      return [];
    }

    const text = document.getText();
    const pos = _textDocumentPosition.position;

    // Don't provide completions inside strings
    if (isInString(text, pos.line, pos.character)) {
      return [];
    }

    const context = getContextAtPosition(text, pos.line, pos.character);
    const details = findContextDetails(text, pos.line, pos.character);

    // Applicator completions
    if (context === "applicator") {
      return commonApplicators.map(name => {
        const sig = applicatorSignatures[name];
        return {
          label: name,
          kind: CompletionItemKind.Method,
          detail: sig?.label || `Hypen applicator`,
          documentation: sig?.documentation || `Apply ${name} styling to the component`,
          insertText: `${name}($1)$0`,
          insertTextFormat: 2 // Snippet
        };
      });
    }

    // Reference completions
    if (context === "reference") {
      return [
        {
          label: "state",
          kind: CompletionItemKind.Variable,
          detail: "State reference",
          documentation: "Reference to component state",
          insertText: "state."
        },
        {
          label: "actions",
          kind: CompletionItemKind.Function,
          detail: "Actions reference",
          documentation: "Reference to component actions",
          insertText: "actions."
        }
      ];
    }

    // Argument context - provide argument names or values
    if (context === "argument") {
      const completions: CompletionItem[] = [];

      // If we're after an argument name (e.g., "color: "), provide value completions
      if (details.inValue && details.argumentName) {
        const values = valueCompletions[details.argumentName];
        if (values) {
          return values.map(value => ({
            label: value,
            kind: CompletionItemKind.Value,
            detail: `${details.argumentName} value`,
            documentation: `Set ${details.argumentName} to ${value}`
          }));
        }
      }

      // If inside a component's parentheses, suggest argument names
      if (details.componentName && componentArguments[details.componentName]) {
        const args = componentArguments[details.componentName];
        for (const arg of args) {
          const hasValues = valueCompletions[arg];
          completions.push({
            label: arg,
            kind: CompletionItemKind.Property,
            detail: `${details.componentName} argument`,
            documentation: `Set the ${arg} property`,
            insertText: hasValues ? `${arg}: $0` : `${arg}: $1$0`,
            insertTextFormat: 2
          });
        }
        return completions;
      }

      // If inside an applicator's parentheses, suggest values
      if (details.applicatorName) {
        const values = valueCompletions[details.applicatorName];
        if (values) {
          return values.map(value => ({
            label: value,
            kind: CompletionItemKind.Value,
            detail: `${details.applicatorName} value`,
            documentation: `Set ${details.applicatorName} to ${value}`
          }));
        }
      }

      return completions;
    }

    // Component completions
    return commonComponents.map(name => {
      const sig = componentSignatures[name];
      return {
        label: name,
        kind: CompletionItemKind.Class,
        detail: sig?.label || `Hypen component`,
        documentation: sig?.documentation || `${name} component`,
        insertText: `${name} {\n\t$1\n}$0`,
        insertTextFormat: 2 // Snippet
      };
    });
  }
);

connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
  return item;
});

// Signature help handler
connection.onSignatureHelp((params: SignatureHelpParams): SignatureHelp | null => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }

  const text = document.getText();
  const pos = params.position;
  const lines = text.split("\n");
  const currentLine = lines[pos.line] || "";
  const beforeCursor = currentLine.substring(0, pos.character);

  // Find the nearest unclosed parenthesis
  let parenDepth = 0;
  let signatureStart = -1;
  let activeParameter = 0;

  for (let i = beforeCursor.length - 1; i >= 0; i--) {
    const char = beforeCursor[i];
    if (char === ")") {
      parenDepth++;
    } else if (char === "(") {
      if (parenDepth === 0) {
        signatureStart = i;
        break;
      }
      parenDepth--;
    } else if (char === "," && parenDepth === 0) {
      activeParameter++;
    }
  }

  if (signatureStart === -1) {
    return null;
  }

  // Extract the name before the parenthesis
  const textBeforeParen = beforeCursor.substring(0, signatureStart);

  // Check for applicator: .name(
  const applicatorMatch = textBeforeParen.match(/\.(\w+)\s*$/);
  if (applicatorMatch) {
    const applicatorName = applicatorMatch[1];
    const sig = applicatorSignatures[applicatorName];
    if (sig) {
      const signatureInfo: SignatureInformation = {
        label: sig.label,
        documentation: sig.documentation,
        parameters: sig.parameters.map(p => ({
          label: p.label,
          documentation: p.documentation
        }))
      };
      return {
        signatures: [signatureInfo],
        activeSignature: 0,
        activeParameter: Math.min(activeParameter, sig.parameters.length - 1)
      };
    }
  }

  // Check for component: ComponentName(
  const componentMatch = textBeforeParen.match(/([A-Z]\w*)\s*$/);
  if (componentMatch) {
    const componentName = componentMatch[1];
    const sig = componentSignatures[componentName];
    if (sig) {
      const signatureInfo: SignatureInformation = {
        label: sig.label,
        documentation: sig.documentation,
        parameters: sig.parameters.map(p => ({
          label: p.label,
          documentation: p.documentation
        }))
      };
      return {
        signatures: [signatureInfo],
        activeSignature: 0,
        activeParameter: Math.min(activeParameter, sig.parameters.length - 1)
      };
    }
  }

  return null;
});

connection.onHover((params: HoverParams): Hover | null => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }

  const line = document.getText({
    start: { line: params.position.line, character: 0 },
    end: { line: params.position.line + 1, character: 0 }
  });
  const character = params.position.character;

  // Find the word at the cursor position
  let wordStart = character;
  let wordEnd = character;
  while (wordStart > 0 && /\w/.test(line[wordStart - 1])) wordStart--;
  while (wordEnd < line.length && /\w/.test(line[wordEnd])) wordEnd++;
  const word = line.substring(wordStart, wordEnd);
  if (!word) return null;

  // Check if hovering over a component name (starts with uppercase)
  if (/^[A-Z]/.test(word) && commonComponents.includes(word)) {
    const sig = componentSignatures[word];
    const label = sig?.label || word;
    const doc = sig?.documentation || "";
    return {
      contents: {
        kind: "markdown",
        value: `**${label}**\n\n${doc}`
      }
    };
  }

  // Check if preceded by a dot → applicator
  const charBefore = wordStart > 0 ? line[wordStart - 1] : "";
  if (charBefore === "." && commonApplicators.includes(word)) {
    const sig = applicatorSignatures[word];
    const label = sig?.label || `.${word}()`;
    const doc = sig?.documentation || "";
    return {
      contents: {
        kind: "markdown",
        value: `**${label}**\n\n${doc}`
      }
    };
  }

  // Check for @state / @actions references
  if (charBefore === "@" || (wordStart >= 1 && line[wordStart - 1] === "@")) {
    if (word === "state") {
      return {
        contents: {
          kind: "markdown",
          value: "**@state** — Module state reference\n\nAccess reactive state values: `@state.fieldName`\n\nIn strings use interpolation: `@{state.fieldName}`"
        }
      };
    }
    if (word === "actions") {
      return {
        contents: {
          kind: "markdown",
          value: "**@actions** — Module action reference\n\nReference an action handler: `@actions.actionName`\n\nUsed with event applicators: `.onClick(@actions.submit)`"
        }
      };
    }
  }

  // Control flow keywords
  if (word === "forEach") {
    return {
      contents: {
        kind: "markdown",
        value: "**forEach**(items, item) { ... }\n\nIterates over a list and renders children for each item.\n\n```hypen\nforEach(@{state.items}, item) {\n  Text(\"@{item.name}\")\n}\n```"
      }
    };
  }
  if (word === "when") {
    return {
      contents: {
        kind: "markdown",
        value: "**when**(condition) { ... }\n\nConditionally renders children when the condition is truthy.\n\n```hypen\nwhen(@{state.isLoggedIn}) {\n  Text(\"Welcome back!\")\n}\n```"
      }
    };
  }
  if (word === "module") {
    return {
      contents: {
        kind: "markdown",
        value: "**module** Name(args) { ... }\n\nDeclares a stateful module with its own state and action handlers.\n\n```hypen\nmodule Counter {\n  Text(\"Count: @{state.count}\")\n  Button { Text(\"+1\") }\n    .onClick(@actions.increment)\n}\n```"
      }
    };
  }
  if (word === "component") {
    return {
      contents: {
        kind: "markdown",
        value: "**component** Name { ... }\n\nDeclares a reusable stateless component.\n\n```hypen\ncomponent Header {\n  Row {\n    Text(\"My App\")\n      .fontSize(24)\n  }\n    .padding(16)\n}\n```"
      }
    };
  }

  return null;
});

connection.onDocumentSymbol((params: DocumentSymbolParams): SymbolInformation[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return [];
  }

  const text = document.getText();
  const parseResult = parseHypenDocument(text);
  
  return parseResult.components.map(component => ({
    name: component.name,
    kind: SymbolKind.Class,
    location: {
      uri: params.textDocument.uri,
      range: component.range
    }
  }));
});

connection.onDocumentFormatting((params: DocumentFormattingParams): TextEdit[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return [];
  }

  const text = document.getText();
  const formatted = formatHypenDocument(text, params.options.tabSize);
  
  return [
    {
      range: {
        start: { line: 0, character: 0 },
        end: { line: document.lineCount - 1, character: Number.MAX_SAFE_INTEGER }
      },
      newText: formatted
    }
  ];
});

// Quick fixes for accessibility diagnostics (source "hypen-a11y", code =
// kebab rule id). Edit computation lives in quickfix.ts; here we only map
// LSP ranges to string offsets and wrap the result in a WorkspaceEdit.
connection.onCodeAction((params: CodeActionParams): CodeAction[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return [];
  }

  const text = document.getText();
  const actions: CodeAction[] = [];

  for (const diagnostic of params.context.diagnostics) {
    if (diagnostic.source !== "hypen-a11y" || typeof diagnostic.code !== "string") {
      continue;
    }
    const fix = computeQuickFix(text, {
      code: diagnostic.code,
      startOffset: document.offsetAt(diagnostic.range.start),
      endOffset: document.offsetAt(diagnostic.range.end)
    });
    if (!fix) {
      continue;
    }
    actions.push({
      title: fix.title,
      kind: CodeActionKind.QuickFix,
      diagnostics: [diagnostic],
      edit: {
        changes: {
          [params.textDocument.uri]: [
            TextEdit.insert(document.positionAt(fix.insertOffset), fix.newText)
          ]
        }
      }
    });
  }

  return actions;
});

function formatHypenDocument(text: string, tabSize: number): string {
  const lines = text.split("\n");
  const formatted: string[] = [];
  let indentLevel = 0;
  const indent = " ".repeat(tabSize);

  for (let line of lines) {
    const trimmed = line.trim();
    
    // Skip empty lines
    if (trimmed === "") {
      formatted.push("");
      continue;
    }

    // Count opening and closing braces on this line to determine net effect
    let opens = 0;
    let closes = 0;
    let inStr = false;
    let strCh = "";
    let esc = false;
    for (const ch of trimmed) {
      if (ch === "\\" && !esc) { esc = true; continue; }
      if ((ch === '"' || ch === "'") && !esc) {
        if (!inStr) { inStr = true; strCh = ch; }
        else if (ch === strCh) { inStr = false; }
      }
      if (!inStr) {
        if (ch === "{") opens++;
        else if (ch === "}") closes++;
      }
      esc = false;
    }

    // Dedent before printing for closing braces
    indentLevel = Math.max(0, indentLevel - closes);

    // Add indented line
    formatted.push(indent.repeat(indentLevel) + trimmed);

    // Indent after printing for opening braces
    indentLevel += opens;
  }

  return formatted.join("\n");
}

// Make the text document manager listen on the connection
documents.listen(connection);

// Listen on the connection
connection.listen();

