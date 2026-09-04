import { describe, expect, test } from "bun:test";

const root = import.meta.dir;

async function source(relativePath: string): Promise<string> {
  return Bun.file(`${root}/${relativePath}`).text();
}

function occurrences(input: string, fragment: string): number {
  return input.split(fragment).length - 1;
}

describe("Food ordering layout contracts", () => {
  test("Cloudflare state remains isolated by the recovered protocol session", async () => {
    const module = await source("food-ordering/cloudflare/src/module.ts");
    const wrangler = await source("food-ordering/cloudflare/wrangler.jsonc");

    expect(module).toContain(
      ".persist(durableObjectStore<AppState>(session<AppState>()))",
    );
    expect(wrangler).toContain(
      '"@hypen-space/core": "../../../hypen-web/packages/core/src/index.ts"',
    );
    expect(wrangler).toContain(
      '"@hypen-space/cf": "../../../hypen-web/packages/cf/src/index.ts"',
    );
  });

  test("home uses one centered content track with a bound responsive Grid", async () => {
    const home = await source(
      "food-ordering/cloudflare/src/components/HomePage.hypen",
    );

    expect(home).toContain('Grid(@state.restaurants, key: "id")');
    expect(home).toContain(
      ".gridColumns({default: 1, md: 2, lg: 3, xl: 4, 2xl: 5})",
    );
    expect(home).toContain('.tw("w-full xl:w-3/5")');
    expect(home).not.toContain(".maxWidth(1240)");
    expect(occurrences(home, '.alignSelf("center")')).toBe(1);
    expect(occurrences(home, ".fillMaxWidth(true)")).toBeGreaterThanOrEqual(4);
    expect(home).not.toContain(".display(");
    expect(occurrences(home, '.onClick(@router.push, to: "/search")')).toBe(2);

    const module = await source("food-ordering/cloudflare/src/module.ts");
    expect(module).toContain("const additionalRestaurantSeeds = [");
    expect(occurrences(module, '["')).toBeGreaterThanOrEqual(24);
    expect(module).toContain(
      "...restaurants.slice(featuredRestaurants.length).flatMap",
    );
    expect(module).toContain("matchingCategoryIds.has(restaurant.categoryId)");
  });

  test("restaurant menu fills its track area and the cart CTA docks outside the scroller", async () => {
    const detail = await source(
      "food-ordering/cloudflare/src/components/RestaurantDetail.hypen",
    );

    expect(detail).toContain('Grid(@state.menuItems, key: "id")');
    expect(detail).toContain(".gridColumns({default: 1, md: 2})");
    expect(detail).not.toContain(".gridColumns({default: 1, md: 2, lg: 3})");
    expect(detail).toContain(".fillMaxWidth(true)");
    expect(detail).toContain('.width("100%")');
    expect(detail).toContain(".maxWidth(384)");
    expect(detail).toContain('SafeArea(edges: ["top", "left", "right"])');
    expect(detail).toContain(
      '.tw("w-full px-4 pt-4 items-center justify-between")',
    );
    expect(detail).not.toContain("absolute top-4 left-4");
    expect(detail).not.toContain("absolute top-4 right-4");
    expect(detail).toContain(
      '.tw("w-full shrink-0 px-4 pb-4 md:px-8 md:pb-8 justify-end bg-stone-50")',
    );
    expect(detail.trimStart().startsWith("Column {")).toBe(true);
    expect(detail).not.toContain('.tw("absolute left-4 right-4 bottom-4');
    expect(detail).not.toContain('.tw("fixed ');
    expect(detail.indexOf(".scrollable(true)")).toBeLessThan(
      detail.indexOf('If(condition: "@{state.cartCount > 0}")'),
    );
  });

  test("search reacts while typing and renders results with a real bound Grid", async () => {
    const search = await source(
      "food-ordering/cloudflare/src/components/Search.hypen",
    );
    const module = await source("food-ordering/cloudflare/src/module.ts");

    expect(search).toContain(".bind(@state.searchQuery)");
    expect(search).toContain(".onInput(@actions.search)");
    expect(search).toContain('Grid(@state.searchResults, key: "id")');
    expect(search).toContain(
      ".gridColumns({default: 1, md: 2, lg: 3, xl: 4, 2xl: 5})",
    );
    expect(search).not.toContain(".display(");
    expect(search).not.toContain(".gridTemplateColumns(");
    expect(module).toContain('.onAction("search", ({ state }) => {');
    expect(module).toContain("matchingCategoryIds.has(restaurant.categoryId)");

    const bottomNav = await source(
      "food-ordering/cloudflare/src/components/BottomNav.hypen",
    );
    expect(bottomNav).not.toContain(".display(");
  });

  test("Pizza matches the pizza category instead of producing an empty result", async () => {
    const { searchRestaurants } = await import(
      "./food-ordering/cloudflare/src/module"
    );
    const results = searchRestaurants("Pizza");

    expect(results.length).toBeGreaterThanOrEqual(5);
    expect(results.every((restaurant) => restaurant.categoryId === "cat_pizza")).toBe(
      true,
    );
    expect(results.map((restaurant) => restaurant.name)).toContain(
      "Napoli Pizzeria",
    );
  });
});
