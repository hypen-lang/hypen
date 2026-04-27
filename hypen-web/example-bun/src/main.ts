/**
 * Main entry point for Hypen Shop Demo
 * Uses pre-generated component imports for browser compatibility
 */

import { renderWithComponents } from "@hypen-space/web-engine";
import * as Components from "./components.generated.js";

async function main() {
  try {
    console.log("🚀 Starting Hypen Shop...");

    // Use pre-generated components (browser-compatible, no Node.js APIs)
    const components: Record<string, { module: any; template: string }> = {
      App: Components.App,
      Header: Components.Header,
      Footer: Components.Footer,
      HomePage: Components.HomePage,
      ProductsPage: Components.ProductsPage,
      ProductCard: Components.ProductCard,
      ProductList: Components.ProductList,
      CartPage: Components.CartPage,
      AboutPage: Components.AboutPage,
    };

    console.log(`📦 Loaded ${Object.keys(components).length} components:`, Object.keys(components).join(", "));

    // Render the App component
    const hypen = await renderWithComponents(
      components,
      "App",
      "#app",
      {
        debug: true,
        debugHeatmap: false,
        heatmapIncrement: 5,
        heatmapFadeOut: 2000
      }
    );

    console.log("✅ Hypen Shop initialized!");
    console.log("📊 Initial state:", hypen.getState());
    console.log("🎯 Try clicking the buttons to see reactive state management in action!");

    // Make hypen instance available globally for debugging
    if (typeof window !== "undefined") {
      (window as any).hypen = hypen;
      console.log("💡 Debug: Access the Hypen instance via window.hypen");
    }

    // Wire up debug controls
    setupDebugControls(hypen);
  } catch (error) {
    console.error("❌ Failed to initialize app:", error);
    throw error;
  }
}

/**
 * Setup debug control UI
 */
function setupDebugControls(hypen: any) {
  const heatmapToggle = document.getElementById("heatmap-toggle") as HTMLInputElement;
  const resetButton = document.getElementById("reset-tracking") as HTMLButtonElement;
  const statsButton = document.getElementById("show-stats") as HTMLButtonElement;
  const statsDiv = document.getElementById("debug-stats") as HTMLDivElement;

  if (!heatmapToggle || !resetButton || !statsButton || !statsDiv) {
    console.warn("⚠️ Debug controls not found in DOM");
    return;
  }

  // Toggle heatmap
  heatmapToggle.addEventListener("change", () => {
    hypen.setDebugHeatmap(heatmapToggle.checked);
    console.log(`🐛 Heatmap ${heatmapToggle.checked ? "enabled" : "disabled"}`);
  });

  // Reset tracking
  resetButton.addEventListener("click", () => {
    hypen.resetDebugTracking();
    statsDiv.textContent = "";
    console.log("🧹 Debug tracking reset");
  });

  // Show stats
  statsButton.addEventListener("click", () => {
    const stats = hypen.getDebugStats();
    if (stats) {
      statsDiv.innerHTML = `
        <strong>Re-render Statistics:</strong><br>
        Total Re-renders: ${stats.totalRerenders}<br>
        Elements Tracked: ${stats.elementCount}<br>
        Avg Re-renders: ${stats.avgRerenders}
      `;
      console.log("📊 Debug stats:", stats);
    } else {
      statsDiv.textContent = "No stats available";
    }
  });
}

// Initialize the app
main();
