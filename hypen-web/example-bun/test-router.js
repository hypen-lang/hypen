/**
 * Test script to verify Router/Route passthrough fix
 * Run this in the browser console after the page loads
 */

setTimeout(() => {
  console.log("🧪 Testing Router/Route structure...");
  
  const router = document.querySelector('[data-hypen-type="router"]');
  if (!router) {
    console.error("❌ Router element not found!");
    return;
  }
  
  console.log("✅ Router element found");
  
  const routes = document.querySelectorAll('[data-hypen-type="route"]');
  console.log(`✅ Found ${routes.length} route elements`);
  
  routes.forEach((route, index) => {
    const path = route.dataset.routePath;
    const childCount = route.children.length;
    const textContent = route.textContent.substring(0, 50);
    
    console.log(`🧭 Route ${index}:`);
    console.log(`   - Path: ${path}`);
    console.log(`   - Children: ${childCount}`);
    console.log(`   - Text preview: "${textContent}..."`);
    
    if (childCount === 0) {
      console.error(`   ❌ Route ${path} has NO children! (Expected page content)`);
    } else {
      console.log(`   ✅ Route ${path} has ${childCount} children`);
    }
  });
  
  // Test visibility
  const currentPath = window.location.pathname;
  console.log(`\n🔍 Current path: ${currentPath}`);
  
  routes.forEach((route) => {
    const path = route.dataset.routePath;
    const isVisible = route.style.display !== "none";
    const shouldBeVisible = path === currentPath;
    
    if (isVisible === shouldBeVisible) {
      console.log(`✅ Route ${path}: visibility correct (${isVisible ? 'visible' : 'hidden'})`);
    } else {
      console.error(`❌ Route ${path}: visibility incorrect! Expected ${shouldBeVisible ? 'visible' : 'hidden'}, got ${isVisible ? 'visible' : 'hidden'}`);
    }
  });
  
  console.log("\n🧪 Test complete!");
}, 2000);

