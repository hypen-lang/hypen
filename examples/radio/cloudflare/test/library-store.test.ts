import { describe, expect, test } from "bun:test";
import { libraryStore } from "../src/library-store";

// One Durable Object per visitor, one store object per isolate: the store
// must hand each DO a copy bound to its own storage (`__forStorage`).

interface S {
  favourites: string[];
  now: string | null;
  streamUrl: string;
}

const memStorage = () => {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (k: string) => data.get(k),
    put: async (k: string, v: unknown) => void data.set(k, v),
    delete: async (k: string) => data.delete(k),
  };
};

type Bindable = {
  __forStorage(s: unknown): ReturnType<typeof libraryStore<S, "favourites" | "now">>;
  __bindStorage(s: unknown): void;
};

describe("libraryStore", () => {
  test("saves only the library fields, to each visitor's own DO", async () => {
    const store = libraryStore<S, "favourites" | "now">(["favourites", "now"]) as unknown as Bindable;
    const a = memStorage();
    const b = memStorage();
    const forA = store.__forStorage(a);
    const forB = store.__forStorage(b);
    expect(store.__forStorage(a)).toBe(forA);
    const key = forA.resolveKey({ favourites: [], now: null, streamUrl: "" }, "App", "s")!;

    store.__bindStorage(a);
    const saveA = forA.save(key, { favourites: ["x"], now: "x", streamUrl: "http://stream" });
    store.__bindStorage(b);
    await saveA;
    await forB.save(key, { favourites: ["y"], now: null, streamUrl: "" });

    expect(a.data.get(`hypen:${key}`)).toEqual({ favourites: ["x"], now: "x" });
    expect(b.data.get(`hypen:${key}`)).toEqual({ favourites: ["y"], now: null });
    expect(await forA.load(key)).toEqual({ favourites: ["x"], now: "x" } as never);
  });
});
