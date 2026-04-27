/**
 * Hypen Playground - Monaco Editor Setup
 */

import { Engine } from "../packages/web-engine/src/engine.js";
import { app } from "../packages/core/src/app.js";
import { DOMRenderer } from "../packages/web/src/dom/index.js";
import { createObservableState, getStateSnapshot } from "../packages/core/src/state.js";
import { samples } from "./samples.js";

console.log("📚 Available samples:", Object.keys(samples));

declare const monaco: any;
declare const ts: typeof import("typescript");

interface RequireConfig {
  paths: Record<string, string>;
}

interface RequireFunc {
  (modules: string[], callback: () => void): void;
  config: (config: RequireConfig) => void;
}

declare const require: RequireFunc;

let hypenEditor: any;
let logicEditor: any;
let renderer: DOMRenderer | null = null;
let engine: Engine | null = null;
let currentModule: any = null;
let currentState: any = null; // Preserve state across DSL edits
let isLoadingSample = false; // Flag to prevent auto-render during sample load

/**
 * Recursively convert Maps to plain objects
 */
function convertMapsToObjects(value: any): any {
  if (value instanceof Map) {
    if (value.size === 0) {
      return {};
    }
    
    // Check if this is a nested Map structure like Map(5) { Map{"key" => value}, ... }
    const entries = Array.from(value.entries());
    const values = Array.from(value.values());
    const firstEntry = values[0];
    
    if (firstEntry instanceof Map) {
      // Nested Map structure - flatten it
      const plainObj: Record<string, any> = {};
      for (const entry of values) {
        if (entry instanceof Map) {
          for (const [key, val] of entry.entries()) {
            plainObj[key] = convertMapsToObjects(val);
          }
        }
      }
      return plainObj;
    } else {
      // Regular Map - convert using entries (key-value pairs)
      const obj: Record<string, any> = {};
      for (const [key, val] of entries) {
        obj[key] = convertMapsToObjects(val);
      }
      return obj;
    }
  } else if (Array.isArray(value)) {
    return value.map(item => convertMapsToObjects(item));
  } else if (value && typeof value === 'object' && !(value instanceof Date) && !(value instanceof RegExp)) {
    const obj: Record<string, any> = {};
    for (const [key, val] of Object.entries(value)) {
      obj[key] = convertMapsToObjects(val);
    }
    return obj;
  }
  return value;
}

/**
 * Initialize Monaco editors
 */
function initEditors() {
  // Use window.require to access Monaco's AMD loader
  const amdRequire = (window as any).require;

  amdRequire.config({ paths: { vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs" } });

  amdRequire(["vs/editor/editor.main"], () => {
    const commonOptions = {
      theme: "vs-dark",
      minimap: { enabled: false },
      fontSize: 13,
      lineNumbers: "on",
      scrollBeyondLastLine: false,
      automaticLayout: true,
    };

    // Hypen DSL Editor
    hypenEditor = monaco.editor.create(document.getElementById("hypen-editor")!, {
      ...commonOptions,
      language: "javascript", // closest syntax highlighting for Hypen
      value: samples.counter.hypen,
    });

    // TypeScript Logic Editor
    logicEditor = monaco.editor.create(document.getElementById("logic-editor")!, {
      ...commonOptions,
      language: "typescript",
      value: samples.counter.logic,
    });

    // Listen for changes
    let debounceTimer: number | null = null;
    const triggerUpdate = () => {
      // Skip auto-render during sample loading
      if (isLoadingSample) {
        console.log("⏭️ Skipping auto-render during sample load");
        return;
      }
      
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        renderPreview();
      }, 500) as unknown as number;
    };

    hypenEditor.onDidChangeModelContent(triggerUpdate);
    logicEditor.onDidChangeModelContent(triggerUpdate);

    // Initial render (with delay to ensure editors are ready)
    console.log("🚀 Starting initial render...");
    setTimeout(() => {
      console.log("⏰ Initial render timeout triggered");
      renderPreview(true); // Full rebuild on initial load
    }, 100);
  });
}

/**
 * Load a sample into the editors
 */
function loadSample(sampleKey: string) {
  console.log("📥 Loading sample:", sampleKey);
  const sample = samples[sampleKey];
  if (!sample) {
    console.error("❌ Sample not found:", sampleKey);
    return;
  }

  console.log("📝 Sample found:", sample.name);
  
  // Set flag to prevent editor change listeners from triggering during load
  isLoadingSample = true;
  
  if (hypenEditor) {
    console.log("✏️ Setting Hypen code");
    hypenEditor.setValue(sample.hypen);
  }
  if (logicEditor) {
    console.log("✏️ Setting logic code");
    logicEditor.setValue(sample.logic);
  }

  // Trigger a full rebuild after loading the sample
  console.log("🔄 Triggering full rebuild...");
  renderPreview(true);
  
  // Clear flag after render
  isLoadingSample = false;
}

/**
 * Render the current code in the preview pane
 * @param forceFullRebuild - If true, clear everything for a fresh render
 */
async function renderPreview(forceFullRebuild = false) {
  console.log("🎬 Starting renderPreview...", forceFullRebuild ? "(full rebuild)" : "(incremental)");
  const hypenCode = hypenEditor?.getValue() || "";
  const logicCode = logicEditor?.getValue() || "";
  const previewEl = document.getElementById("preview")!;
  const errorBanner = document.getElementById("error-banner")!;

  console.log("📝 Hypen code length:", hypenCode.length);
  console.log("📝 Logic code length:", logicCode.length);

  // Clear error banner
  errorBanner.textContent = "";
  errorBanner.classList.remove("show");
  
  // Only clear for full rebuilds (e.g., when switching samples)
  if (forceFullRebuild) {
    console.log("🧹 Full rebuild: clearing DOM, renderer, engine, and state");
    console.log("🧹 Previous currentState:", currentState);
    console.log("🧹 Previous currentModule:", currentModule?.name);
    console.log("🧹 Preview DOM children before clear:", previewEl.children.length);
    
    previewEl.innerHTML = "";
    console.log("🧹 Preview DOM children after innerHTML clear:", previewEl.children.length);
    
    if (renderer) {
      console.log("🧹 Clearing renderer node registry...");
      renderer.clear();
    }
    
    if (engine) {
      console.log("🧹 Clearing engine tree...");
      engine.clearTree();
    }
    
    // Clean up previous module and state
    currentModule = null;
    currentState = null; // Reset state for fresh start
    console.log("🧹 Cleared currentState:", currentState);
    console.log("🧹 Final preview DOM children:", previewEl.children.length);
  }

  try {
    // Initialize engine if needed
    if (!engine) {
      engine = new Engine();
      await engine.init();
    }

    // Initialize renderer if needed
    if (!renderer) {
      renderer = new DOMRenderer(previewEl, engine);
      engine.setRenderCallback((patches) => {
        console.log("🔧 Received patches:", patches.length);
        console.log("📋 Patch types:", patches.map(p => p.type));

        const rootInserts = patches.filter(p => p.type === 'insert' && p.parentId === 'root');
        console.log("🌳 Root inserts:", rootInserts.length);

        renderer!.applyPatches(patches);

        // Update renderer with current state (fallback to current module's initial state)
        const fallbackState = currentModule?.initialState || {};
        renderer!.updateState(currentState || fallbackState);
      });
    }

    // Compile TypeScript to JavaScript using the TypeScript compiler
    const jsCode = ts.transpileModule(logicCode, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
        removeComments: true,
      }
    }).outputText;

    // Remove import statements and replace export default
    const moduleCode = jsCode
      .replace(/import\s+.*?from\s+['"].*?['"];?\s*/g, "")
      .replace(/export default/, "return");

    const createModule = new Function("app", moduleCode);
    const moduleDef = createModule(app);

    // Initialize module with engine
    const moduleName = moduleDef.name || "main";
    engine.setModule(
      moduleName,
      moduleDef.actions,
      moduleDef.stateKeys,
      convertMapsToObjects(moduleDef.initialState)
    );

    // Create observable state that triggers re-renders
    // Use existing state if available (to preserve state across DSL edits), otherwise use initial state
    // Convert any Maps to plain objects for proper serialization
    console.log("🔧 Creating observable state. currentState:", currentState);
    console.log("🔧 Module initial state:", moduleDef.initialState);
    const initialStateToUse = convertMapsToObjects(currentState || moduleDef.initialState);
    console.log("🔧 Using initial state:", initialStateToUse);
    const observableState = createObservableState(initialStateToUse, {
      onChange: (change) => {
        const snapshot = convertMapsToObjects(getStateSnapshot(observableState));
        console.log(`📸 [Observable onChange] State snapshot:`, snapshot, `Changes:`, change.paths);
        if (snapshot.tasks && Array.isArray(snapshot.tasks)) {
          console.log(`📸 [Observable onChange] First task:`, snapshot.tasks[0]);
          console.log(`📸 [Observable onChange] First task type:`, snapshot.tasks[0]?.constructor?.name);
        }
        currentState = snapshot; // Preserve state for next render
        engine.updateState(snapshot);
      },
    });

    // Register action handlers with observable state
    if (moduleDef.handlers?.onAction) {
      for (const [actionName, handler] of moduleDef.handlers.onAction) {
        engine.onAction(actionName, async (action) => {
          console.log(`🎯 [Action ${actionName}] Received action:`, action);
          
          // Convert payload from Map to plain object if needed
          let payload = action.payload;
          console.log(`🔍 [Action ${actionName}] Raw payload type:`, payload?.constructor?.name, 'Size:', payload instanceof Map ? payload.size : 'N/A');
          if (payload instanceof Map) {
            console.log(`🔍 [Action ${actionName}] Map entries:`, Array.from(payload.entries()));
            console.log(`🔍 [Action ${actionName}] Map values:`, Array.from(payload.values()));
            payload = convertMapsToObjects(payload);
            console.log(`🔄 [Action ${actionName}] Converted payload to plain object:`, payload);
          }
          
          // Pass action with plain object payload to handler
          await handler({ ...action, payload }, observableState);

          // Force state sync immediately after handler completes (to avoid microtask timing issues)
          const snapshot = convertMapsToObjects(getStateSnapshot(observableState));
          console.log(`📸 [Action ${actionName}] State snapshot after handler:`, snapshot);
          currentState = snapshot;
          engine.updateState(snapshot);
        });
      }
    }

    // Set currentModule BEFORE rendering so callbacks can access it
    currentModule = moduleDef;
    
    // Debug: Test parsing a simple Button with onClick
    try {
      const debugResult = engine.debugParseComponent(`Button { Text("Test") }.onClick("@actions.test")`);
      console.log("🔍 Debug parse result:", debugResult);
    } catch (e) {
      console.log("🔍 Debug parse failed:", e);
    }

    // Render the Hypen DSL FIRST - this sets up the UI tree in the engine
    console.log("🎨 Rendering Hypen code:", hypenCode.substring(0, 100) + "...");
    engine.renderSource(hypenCode);
    
    // THEN call onCreated lifecycle if it exists - this can safely modify state
    // because the DSL has already been rendered and the engine knows the correct UI structure
    if (moduleDef.handlers?.onCreated) {
      console.log("🌱 Calling onCreated lifecycle...");
      await moduleDef.handlers.onCreated(observableState);
      console.log("✅ onCreated completed, state:", getStateSnapshot(observableState));
    }
    
    // Update with current state (not initial state, to preserve changes)
    const currentStateSnapshot = convertMapsToObjects(getStateSnapshot(observableState));
    console.log("📊 Updating state:", currentStateSnapshot);
    console.log("📊 State tasks type:", currentStateSnapshot.tasks?.constructor?.name);
    if (Array.isArray(currentStateSnapshot.tasks)) {
      console.log("📊 First task:", currentStateSnapshot.tasks[0]);
      console.log("📊 First task type:", currentStateSnapshot.tasks[0]?.constructor?.name);
    }
    engine.updateState(currentStateSnapshot);
  } catch (error: any) {
    console.error("Playground error:", error);
    errorBanner.textContent = `Error: ${error.message || String(error)}`;
    errorBanner.classList.add("show");
  }
}

/**
 * Setup sample selector dropdown
 */
function setupSampleSelector() {
  const selector = document.getElementById("sample-selector") as HTMLSelectElement;

  selector.addEventListener("change", (e) => {
    const target = e.target as HTMLSelectElement;
    const sampleKey = target.value;
    if (sampleKey) {
      loadSample(sampleKey);
    }
  });
}

/**
 * Setup debug mode controls
 */
function setupDebugControls() {
  const debugToggle = document.getElementById("debug-toggle") as HTMLInputElement;
  const resetButton = document.getElementById("reset-debug") as HTMLButtonElement;

  // Toggle debug mode
  debugToggle.addEventListener("change", () => {
    if (renderer) {
      renderer.setDebugConfig({
        enabled: debugToggle.checked,
        showHeatmap: true,
        heatmapIncrement: 5,
        fadeOutDuration: 2000,
      });
      console.log(`🐛 Debug mode ${debugToggle.checked ? 'enabled' : 'disabled'}`);

      // Show stats if enabled
      if (debugToggle.checked) {
        const stats = renderer.getDebugStats();
        console.log(`📊 Debug stats:`, stats);
      }
    }
  });

  // Reset tracking
  resetButton.addEventListener("click", () => {
    if (renderer) {
      renderer.resetDebugTracking();
      console.log("🧹 Debug tracking reset");
    }
  });
}

/**
 * Initialize playground
 */
window.addEventListener("DOMContentLoaded", () => {
  initEditors();
  setupSampleSelector();
  setupDebugControls();
});
