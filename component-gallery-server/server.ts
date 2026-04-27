/**
 * Hypen Component Gallery Server
 *
 * A showcase of all Hypen components and applicators.
 * Single server with path-based routing.
 *
 * Run with: bun run server.ts
 *
 * Routes:
 *   ws://localhost:6555/components/video
 *   ws://localhost:6555/applicators/padding
 *   http://localhost:6555/api/list - JSON list of all examples
 */

import { Engine } from "../hypen-web/packages/server/src/engine.ts";
import { HypenModuleInstance } from "../hypen-web/packages/core/src/app.ts";
import type { ServerWebSocket } from "bun";

// Import component examples
import { columnExample } from "./components/column.ts";
import { rowExample } from "./components/row.ts";
import { textExample } from "./components/text.ts";
import { buttonExample } from "./components/button.ts";
import { imageExample } from "./components/image.ts";
import { containerExample } from "./components/container.ts";
import { centerExample } from "./components/center.ts";
import { listExample } from "./components/list.ts";
import { inputExample } from "./components/input.ts";
import { linkExample } from "./components/link.ts";
import { textareaExample } from "./components/textarea.ts";
import { checkboxExample } from "./components/checkbox.ts";
import { selectExample } from "./components/select.ts";
import { spacerExample } from "./components/spacer.ts";
import { stackExample } from "./components/stack.ts";
import { dividerExample } from "./components/divider.ts";
import { gridExample } from "./components/grid.ts";
import { cardExample } from "./components/card.ts";
import { headingExample } from "./components/heading.ts";
import { switchExample } from "./components/switch.ts";
import { sliderExample } from "./components/slider.ts";
import { spinnerExample } from "./components/spinner.ts";
import { badgeExample } from "./components/badge.ts";
import { avatarExample } from "./components/avatar.ts";
import { progressbarExample } from "./components/progressbar.ts";
import { videoExample } from "./components/video.ts";
import { audioExample } from "./components/audio.ts";
import { paragraphExample } from "./components/paragraph.ts";
import { counterExample } from "./components/counter.ts";
import { calculatorExample } from "./components/calculator.ts";
import { onboardingExample } from "./components/onboarding.ts";
import { todoExample } from "./components/todo.ts";

// Import applicator examples
import { paddingExample } from "./applicators/padding.ts";
import { marginExample } from "./applicators/margin.ts";
import { colorExample } from "./applicators/color.ts";
import { backgroundColorExample } from "./applicators/backgroundColor.ts";
import { opacityExample } from "./applicators/opacity.ts";
import { widthExample } from "./applicators/width.ts";
import { heightExample } from "./applicators/height.ts";
import { sizeExample } from "./applicators/size.ts";
import { fillMaxSizeExample } from "./applicators/fillMaxSize.ts";
import { borderExample } from "./applicators/border.ts";
import { borderRadiusExample } from "./applicators/borderRadius.ts";
import { cornerRadiusExample } from "./applicators/cornerRadius.ts";
import { fontSizeExample } from "./applicators/fontSize.ts";
import { fontWeightExample } from "./applicators/fontWeight.ts";
import { fontFamilyExample } from "./applicators/fontFamily.ts";
import { textAlignExample } from "./applicators/textAlign.ts";
import { lineHeightExample } from "./applicators/lineHeight.ts";
import { gapExample } from "./applicators/gap.ts";
import { weightExample } from "./applicators/weight.ts";
import { flexExample } from "./applicators/flex.ts";
import { verticalAlignmentExample } from "./applicators/justifyContent.ts";
import { horizontalAlignmentExample } from "./applicators/alignItems.ts";
import { shadowExample } from "./applicators/shadow.ts";
import { elevationExample } from "./applicators/elevation.ts";
import { blurExample } from "./applicators/blur.ts";
import { transformExample } from "./applicators/transform.ts";
import { rotateExample } from "./applicators/rotate.ts";
import { scaleExample } from "./applicators/scale.ts";
import { transitionExample } from "./applicators/transition.ts";
import { overflowExample } from "./applicators/overflow.ts";
import { zIndexExample } from "./applicators/zIndex.ts";
import { gridColumnsExample } from "./applicators/gridColumns.ts";
import { linearGradientExample } from "./applicators/linearGradient.ts";
import { maxLinesExample } from "./applicators/maxLines.ts";

// Server Configuration
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 6555;

interface GalleryExample {
  key: string;
  name: string;
  category: "component" | "applicator";
  module: any;
  ui: string;
}

const COMPONENTS: GalleryExample[] = [
  { key: "column", name: "Column", category: "component", ...columnExample },
  { key: "row", name: "Row", category: "component", ...rowExample },
  { key: "text", name: "Text", category: "component", ...textExample },
  { key: "button", name: "Button", category: "component", ...buttonExample },
  { key: "image", name: "Image", category: "component", ...imageExample },
  { key: "container", name: "Container", category: "component", ...containerExample },
  { key: "center", name: "Center", category: "component", ...centerExample },
  { key: "list", name: "List", category: "component", ...listExample },
  { key: "input", name: "Input", category: "component", ...inputExample },
  { key: "link", name: "Link", category: "component", ...linkExample },
  { key: "textarea", name: "TextArea", category: "component", ...textareaExample },
  { key: "checkbox", name: "Checkbox", category: "component", ...checkboxExample },
  { key: "select", name: "Select", category: "component", ...selectExample },
  { key: "spacer", name: "Spacer", category: "component", ...spacerExample },
  { key: "stack", name: "Stack", category: "component", ...stackExample },
  { key: "divider", name: "Divider", category: "component", ...dividerExample },
  { key: "grid", name: "Grid", category: "component", ...gridExample },
  { key: "card", name: "Card", category: "component", ...cardExample },
  { key: "heading", name: "Heading", category: "component", ...headingExample },
  { key: "switch", name: "Switch", category: "component", ...switchExample },
  { key: "slider", name: "Slider", category: "component", ...sliderExample },
  { key: "spinner", name: "Spinner", category: "component", ...spinnerExample },
  { key: "badge", name: "Badge", category: "component", ...badgeExample },
  { key: "avatar", name: "Avatar", category: "component", ...avatarExample },
  { key: "progressbar", name: "ProgressBar", category: "component", ...progressbarExample },
  { key: "video", name: "Video", category: "component", ...videoExample },
  { key: "audio", name: "Audio", category: "component", ...audioExample },
  { key: "paragraph", name: "Paragraph", category: "component", ...paragraphExample },
  { key: "counter", name: "Counter", category: "component", ...counterExample },
  { key: "calculator", name: "Calculator", category: "component", ...calculatorExample },
  { key: "onboarding", name: "Onboarding", category: "component", ...onboardingExample },
  { key: "todo", name: "Todo", category: "component", ...todoExample },
];

const APPLICATORS: GalleryExample[] = [
  { key: "padding", name: "padding", category: "applicator", ...paddingExample },
  { key: "margin", name: "margin", category: "applicator", ...marginExample },
  { key: "color", name: "color", category: "applicator", ...colorExample },
  { key: "backgroundColor", name: "backgroundColor", category: "applicator", ...backgroundColorExample },
  { key: "opacity", name: "opacity", category: "applicator", ...opacityExample },
  { key: "width", name: "width", category: "applicator", ...widthExample },
  { key: "height", name: "height", category: "applicator", ...heightExample },
  { key: "size", name: "size", category: "applicator", ...sizeExample },
  { key: "fillMaxSize", name: "fillMaxSize", category: "applicator", ...fillMaxSizeExample },
  { key: "border", name: "border", category: "applicator", ...borderExample },
  { key: "borderRadius", name: "borderRadius", category: "applicator", ...borderRadiusExample },
  { key: "cornerRadius", name: "cornerRadius", category: "applicator", ...cornerRadiusExample },
  { key: "fontSize", name: "fontSize", category: "applicator", ...fontSizeExample },
  { key: "fontWeight", name: "fontWeight", category: "applicator", ...fontWeightExample },
  { key: "fontFamily", name: "fontFamily", category: "applicator", ...fontFamilyExample },
  { key: "textAlign", name: "textAlign", category: "applicator", ...textAlignExample },
  { key: "lineHeight", name: "lineHeight", category: "applicator", ...lineHeightExample },
  { key: "gap", name: "gap", category: "applicator", ...gapExample },
  { key: "weight", name: "weight", category: "applicator", ...weightExample },
  { key: "flex", name: "flex", category: "applicator", ...flexExample },
  { key: "justifyContent", name: "verticalAlignment", category: "applicator", ...verticalAlignmentExample },
  { key: "alignItems", name: "horizontalAlignment", category: "applicator", ...horizontalAlignmentExample },
  { key: "shadow", name: "shadow", category: "applicator", ...shadowExample },
  { key: "elevation", name: "elevation", category: "applicator", ...elevationExample },
  { key: "blur", name: "blur", category: "applicator", ...blurExample },
  { key: "transform", name: "transform", category: "applicator", ...transformExample },
  { key: "rotate", name: "rotate", category: "applicator", ...rotateExample },
  { key: "scale", name: "scale", category: "applicator", ...scaleExample },
  { key: "transition", name: "transition", category: "applicator", ...transitionExample },
  { key: "overflow", name: "overflow", category: "applicator", ...overflowExample },
  { key: "zIndex", name: "zIndex", category: "applicator", ...zIndexExample },
  { key: "gridColumns", name: "gridColumns", category: "applicator", ...gridColumnsExample },
  { key: "linearGradient", name: "linearGradient", category: "applicator", ...linearGradientExample },
  { key: "maxLines", name: "maxLines", category: "applicator", ...maxLinesExample },
];

// Build lookup maps for quick access
const examplesByPath = new Map<string, GalleryExample>();
COMPONENTS.forEach(ex => examplesByPath.set(`/components/${ex.key}`, ex));
APPLICATORS.forEach(ex => examplesByPath.set(`/applicators/${ex.key}`, ex));

// Also support case-insensitive lookup by name
const examplesByName = new Map<string, GalleryExample>();
[...COMPONENTS, ...APPLICATORS].forEach(ex => {
  examplesByName.set(ex.name.toLowerCase(), ex);
  examplesByName.set(ex.key.toLowerCase(), ex);
});

// Client data stored per WebSocket connection
interface ClientData {
  id: string;
  example: GalleryExample;
  engine: Engine;
  moduleInstance: HypenModuleInstance<any>;
  revision: number;
  connectedAt: Date;
}

let nextClientId = 1;
const clients = new Map<ServerWebSocket<ClientData>, ClientData>();

// Start the server
Bun.serve<ClientData>({
  port: PORT,
  hostname: "0.0.0.0",

  fetch(req, server) {
    const url = new URL(req.url);

    // Try to upgrade WebSocket connections
    // Parse path to find the example
    let example: GalleryExample | undefined;

    // Path format: /components/video or /applicators/padding
    example = examplesByPath.get(url.pathname);

    // Also support /<name> directly (e.g., /Video, /padding)
    if (!example) {
      const name = url.pathname.slice(1).toLowerCase();
      example = examplesByName.get(name);
    }

    if (example && server.upgrade(req, { data: { example } })) {
      return; // Connection upgraded
    }

    // HTTP endpoints
    if (url.pathname === "/health") {
      return new Response("OK", { status: 200 });
    }

    // Reset endpoint - disconnect all clients (useful for testing)
    if (url.pathname === "/reset" || url.pathname === "/api/reset") {
      let disconnected = 0;
      for (const [ws, clientData] of clients) {
        try {
          console.log(`[${clientData.example.name}] Force disconnect: ${clientData.id}`);
          ws.close(1000, "Server reset");
          disconnected++;
        } catch {}
      }
      clients.clear();
      nextClientId = 1;
      console.log(`[Server] Reset: disconnected ${disconnected} clients`);
      return new Response(JSON.stringify({ disconnected }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/api/list") {
      const list = {
        components: COMPONENTS.map(ex => ({
          key: ex.key,
          name: ex.name,
          path: `/components/${ex.key}`,
        })),
        applicators: APPLICATORS.map(ex => ({
          key: ex.key,
          name: ex.name,
          path: `/applicators/${ex.key}`,
        })),
      };
      return new Response(JSON.stringify(list, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/" || url.pathname === "/api") {
      return new Response(`Hypen Component Gallery Server

WebSocket Routes:
  /components/<name>  - e.g., /components/video
  /applicators/<name> - e.g., /applicators/padding
  /<name>             - e.g., /Video (case-insensitive)

HTTP Endpoints:
  /api/list  - JSON list of all examples
  /reset     - Disconnect all clients
  /health    - Health check

Examples: ${COMPONENTS.length} components, ${APPLICATORS.length} applicators
`, { status: 200 });
    }

    return new Response("Not found. Try /api/list for available routes.", { status: 404 });
  },

  websocket: {
    async open(ws) {
      const upgradeData = ws.data as { example: GalleryExample };
      const example = upgradeData.example;

      if (!example) {
        ws.close(1008, "Invalid route");
        return;
      }

      try {
        const clientId = `client_${nextClientId++}`;

        // Create engine instance for this client
        const engine = new Engine();
        await engine.init();

        // Create module instance
        const moduleInstance = new HypenModuleInstance(engine, example.module);

        const clientData: ClientData = {
          id: clientId,
          example,
          engine,
          moduleInstance,
          revision: 0,
          connectedAt: new Date(),
        };

        clients.set(ws, clientData);

        // Set up render callback for streaming patches
        engine.setRenderCallback((patches) => {
          const data = clients.get(ws);
          if (!data) return;

          data.revision++;
          const message = {
            type: "patch",
            module: data.example.name,
            patches,
            revision: data.revision,
          };
          ws.send(JSON.stringify(message));
        });

        // Render initial tree
        const initialPatches: any[] = [];
        engine.setRenderCallback((patches) => {
          initialPatches.push(...patches);
        });
        engine.renderSource(example.ui);

        // Restore streaming callback
        engine.setRenderCallback((patches) => {
          const data = clients.get(ws);
          if (!data) return;

          data.revision++;
          const message = {
            type: "patch",
            module: data.example.name,
            patches,
            revision: data.revision,
          };
          ws.send(JSON.stringify(message));
        });

        // Send initial tree
        const initialMessage = {
          type: "initialTree",
          module: example.name,
          state: moduleInstance.getState(),
          patches: initialPatches,
          revision: 0,
        };
        ws.send(JSON.stringify(initialMessage));

        console.log(`[${example.name}] Connected: ${clientId}`);

      } catch (error) {
        console.error("Error handling WebSocket open:", error);
        ws.close(1011, "Internal server error");
      }
    },

    message(ws, message) {
      try {
        const clientData = clients.get(ws);
        if (!clientData) return;

        const msg = JSON.parse(message.toString());

        if (msg.type === "dispatchAction") {
          clientData.engine.dispatchAction(msg.action, msg.payload);
        }
      } catch (error) {
        console.error("Error handling WebSocket message:", error);
      }
    },

    async close(ws) {
      const clientData = clients.get(ws);
      if (!clientData) return;

      console.log(`[${clientData.example.name}] Disconnected: ${clientData.id}`);

      await clientData.moduleInstance.destroy();
      clients.delete(ws);
    },
  },
});

// Print server info
console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║                     Hypen Component Gallery Server                           ║
╠══════════════════════════════════════════════════════════════════════════════╣
║  Server: ws://localhost:${PORT}                                                ║
╠══════════════════════════════════════════════════════════════════════════════╣
║  COMPONENTS (${COMPONENTS.length})                                                            ║
╠══════════════════════════════════════════════════════════════════════════════╣
${COMPONENTS.map(ex => `║  ${ex.name.padEnd(18)} /components/${ex.key}`.padEnd(78) + '║').join('\n')}
╠══════════════════════════════════════════════════════════════════════════════╣
║  APPLICATORS (${APPLICATORS.length})                                                           ║
╠══════════════════════════════════════════════════════════════════════════════╣
${APPLICATORS.map(ex => `║  ${ex.name.padEnd(18)} /applicators/${ex.key}`.padEnd(78) + '║').join('\n')}
╠══════════════════════════════════════════════════════════════════════════════╣
║  Emulator:  ws://10.0.2.2:${PORT}/<path>                                        ║
║  Device:    ws://<your-ip>:${PORT}/<path>                                       ║
║  API List:  http://localhost:${PORT}/api/list                                   ║
╚══════════════════════════════════════════════════════════════════════════════╝
`);
