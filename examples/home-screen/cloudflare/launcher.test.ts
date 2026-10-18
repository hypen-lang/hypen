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
