import { describe, expect, test } from "bun:test";
import { buildLauncherTemplate } from "./src/launcher";

describe("home screen layout", () => {
  test("centers the clock and weather card explicitly", () => {
    const template = buildLauncherTemplate();
    const widget = template.slice(
      template.indexOf("// ----- Clock + weather widget -----"),
      template.indexOf("// ----- App grid -----"),
    );

    expect(widget).toContain('.alignSelf("center")');
  });

  test("scales each app tile by seven percent while hovered", () => {
    const template = buildLauncherTemplate();

    expect(template).toContain(".scale(\"@{state.hoveredIcon == 'grid:/app/todo' ? 1.07 : 1}\")");
    expect(template).toContain(".scale(\"@{state.hoveredIcon == 'dock:/app/todo' ? 1.07 : 1}\")");
    expect(template).toContain(".transition(duration: 150, curve: easeOut, props: [scale])");
    expect(template).toContain('.onHover(@actions.iconHover, icon: "grid:/app/todo", hovered: true)');
    expect(template).toContain('.onMouseLeave(@actions.iconHover, icon: "grid:/app/todo", hovered: false)');
  });
});

describe("app endpoints", () => {
  test("default to the local wrangler dev ports, never a deployed workers.dev host", () => {
    // Run in a clean env so a developer's own HYPEN_WORKERS_SUBDOMAIN can't leak in.
    const out = Bun.spawnSync({
      cmd: [process.execPath, "-e", `
        const { APPS, buildLauncherTemplate } = await import("./src/launcher.ts");
        const { wallpaperAssetUrl, WALLPAPER_PHOTOS } = await import("./src/unsplash.ts");
        console.log(JSON.stringify({ urls: Object.fromEntries(APPS.map((a) => [a.slug, a.url])),
          template: buildLauncherTemplate(), wallpaper: wallpaperAssetUrl(WALLPAPER_PHOTOS[0], "md") }));
      `],
      cwd: import.meta.dir,
      env: { PATH: process.env.PATH ?? "" },
    });
    const { urls, template, wallpaper } = JSON.parse(out.stdout.toString());
    expect(urls).toEqual({
      todo: "ws://localhost:8789/ws",
      calculator: "ws://localhost:8794/ws",
      calories: "ws://localhost:8790/ws",
      movies: "ws://localhost:8791/ws",
      food: "ws://localhost:8792/ws",
      social: "ws://localhost:8793/ws",
      hypeflix: "ws://localhost:8795/ws",
      weather: "ws://localhost:8796/ws",
      photos: "ws://localhost:8797/ws",
      messages: "ws://localhost:8798/ws",
      radio: "ws://localhost:8799/ws",
      news: "ws://localhost:8800/ws",
    });
    expect(template).not.toContain("workers.dev");
    expect(wallpaper.startsWith("http://localhost:8787/wallpapers/")).toBe(true);
  });

  test("HYPEN_WORKERS_SUBDOMAIN switches every URL to the deployed workers", () => {
    const out = Bun.spawnSync({
      cmd: [process.execPath, "-e", `
        const { APPS } = await import("./src/launcher.ts");
        const { wallpaperAssetUrl, WALLPAPER_PHOTOS } = await import("./src/unsplash.ts");
        console.log(JSON.stringify({ todo: APPS.find((a) => a.slug === "todo").url,
          wallpaper: wallpaperAssetUrl(WALLPAPER_PHOTOS[0], "md") }));
      `],
      cwd: import.meta.dir,
      env: { PATH: process.env.PATH ?? "", HYPEN_WORKERS_SUBDOMAIN: "example" },
    });
    const { todo, wallpaper } = JSON.parse(out.stdout.toString());
    expect(todo).toBe("wss://hypen-todo.example.workers.dev/ws");
    expect(wallpaper.startsWith("https://hypen-home-screen.example.workers.dev/wallpapers/")).toBe(true);
  });
});

describe("settings persistence (one Durable Object per visitor)", () => {
  // Imported lazily so the layout tests above stay independent of it.
  const memStorage = () => {
    const data = new Map<string, unknown>();
    return {
      data,
      get: async (k: string) => data.get(k),
      put: async (k: string, v: unknown) => void data.set(k, v),
      delete: async (k: string) => data.delete(k),
    };
  };
  const tick = () => new Promise<void>((r) => setTimeout(r, 1));

  test("each visitor's DO copy saves and loads its own wallpaper + accent", async () => {
    const { launcherStore } = await import("./src/launcher");
    const a = memStorage();
    const b = memStorage();
    const forA = launcherStore.__forStorage(a);
    const forB = launcherStore.__forStorage(b);
    expect(launcherStore.__forStorage(a)).toBe(forA);

    const key = forA.resolveKey({} as never, "App", "s")!;
    const fresh = (await forA.load(key)) ?? null;
    expect(fresh).toBeNull(); // nothing saved yet: defaults

    // Visitor A saves while visitor B's DO binds the class-wide fallback.
    launcherStore.__bindStorage(a);
    const saveA = forA.save(key, { location: "/settings", wallpaperId: "sunset", accentId: "pink" } as never);
    launcherStore.__bindStorage(b);
    await tick();
    const saveB = forB.save(key, { location: "/", wallpaperId: "graphite", accentId: "mint" } as never);
    await Promise.all([saveA, saveB]);

    const loadedA = await forA.load(key);
    const loadedB = await forB.load(key);
    expect(loadedA?.wallpaperId).toBe("sunset");
    expect(loadedA?.accentId).toBe("pink");
    expect(loadedA?.wallpaper).toContain("#7c2d12");
    expect(loadedB?.wallpaperId).toBe("graphite");
    expect(loadedB?.accentId).toBe("mint");
    // Only the choices are stored, never the whole state.
    expect(Object.keys(a.data.get(`hypen:${key}`) as object).sort()).toEqual(
      ["accentId", "filesSortDesc", "filesSortKey", "filesView", "location", "wallpaperId"].sort(),
    );
  });

  test("a third visitor's fresh DO starts from the defaults", async () => {
    const { launcherStore } = await import("./src/launcher");
    const c = memStorage();
    const forC = launcherStore.__forStorage(c);
    expect(await forC.load(forC.resolveKey({} as never, "App", "s")!)).toBeNull();
  });
});
