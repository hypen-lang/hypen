/**
 * Shared animation module (`@hypen-space/core/animation`) — the
 * renderer-agnostic half of the `__anim.*` prop channel contract.
 *
 * The vocabulary and whitelist pinned here are normative: the Rust mirror in
 * `hypen-engine-rs/src/ir/anim.rs` must match, and a conformance fixture in
 * `engine-compatibility-tests/` pins the engine-side filtering.
 */
import { describe, expect, test } from "bun:test";
import {
  ANIM_PROP_PREFIX,
  ANIM_TRANSITION_PROP,
  ANIM_ENTER_PROP,
  ANIM_EXIT_PROP,
  ANIM_LAYOUT_PROP,
  ANIM_PROP_ANIMATE,
  ANIM_CURVES,
  ANIM_PRESETS,
  ANIM_DIRECTIONS,
  ANIMATE_PRESETS,
  CURVE_TO_CSS,
  ANIMATABLE_PROPS,
  SLIDE_OFFSET_PX,
  SCALE_HIDDEN_FACTOR,
  CURVE_BEZIER_POINTS,
  cssPropertiesFor,
  presetHiddenStyles,
  parseAnimProps,
  cubicBezier,
  curveFunction,
} from "../packages/core/src/animation";
import type { AnimCurve, AnimatePreset } from "../packages/core/src/animation";
import type { Patch } from "../packages/core/src/types";

describe("channel keys", () => {
  test("all five channels share the routing prefix", () => {
    expect(ANIM_PROP_PREFIX).toBe("__anim.");
    expect(ANIM_TRANSITION_PROP).toBe("__anim.transition");
    expect(ANIM_ENTER_PROP).toBe("__anim.enter");
    expect(ANIM_EXIT_PROP).toBe("__anim.exit");
    expect(ANIM_LAYOUT_PROP).toBe("__anim.layout");
    expect(ANIM_PROP_ANIMATE).toBe("__anim.animate");
    for (const key of [
      ANIM_TRANSITION_PROP,
      ANIM_ENTER_PROP,
      ANIM_EXIT_PROP,
      ANIM_LAYOUT_PROP,
      ANIM_PROP_ANIMATE,
    ]) {
      expect(key.startsWith(ANIM_PROP_PREFIX)).toBe(true);
    }
  });
});

describe("vocabulary (normative — Rust ir/anim.rs mirrors these)", () => {
  test("curves", () => {
    expect(ANIM_CURVES).toEqual([
      "linear",
      "easeIn",
      "easeOut",
      "easeInOut",
      "spring",
    ]);
  });

  test("presets", () => {
    expect(ANIM_PRESETS).toEqual(["fade", "slide", "scale"]);
  });

  test("directions", () => {
    expect(ANIM_DIRECTIONS).toEqual(["top", "bottom", "leading", "trailing"]);
  });

  test("curve → CSS timing function, spring as fixed overshoot bezier", () => {
    expect(CURVE_TO_CSS).toEqual({
      linear: "linear",
      easeIn: "ease-in",
      easeOut: "ease-out",
      easeInOut: "ease-in-out",
      spring: "cubic-bezier(0.34,1.56,0.64,1)",
    });
  });

  test("animate presets and their normative defaults (Option E table)", () => {
    expect(ANIMATE_PRESETS).toEqual({
      pulse: { duration: 1200, repeat: "loop", curve: "easeInOut" },
      spin: { duration: 800, repeat: "loop", curve: "linear" },
      shimmer: { duration: 1500, repeat: "loop", curve: "linear" },
      shake: { duration: 400, repeat: 1, curve: "easeInOut" },
    });
  });

  test("animate preset default curves stay inside the curve vocabulary", () => {
    for (const defaults of Object.values(ANIMATE_PRESETS)) {
      expect(ANIM_CURVES).toContain(defaults.curve);
    }
  });
});

describe("ANIMATABLE_PROPS whitelist", () => {
  test("keys are exactly the normative v1 whitelist", () => {
    expect(Object.keys(ANIMATABLE_PROPS).sort()).toEqual(
      [
        "opacity",
        "translateX",
        "translateY",
        "scale",
        "rotate",
        "color",
        "backgroundColor",
        "borderColor",
        "cornerRadius",
        "padding",
        "paddingTop",
        "paddingBottom",
        "paddingLeft",
        "paddingRight",
        "paddingHorizontal",
        "paddingVertical",
        "margin",
        "marginTop",
        "marginBottom",
        "marginLeft",
        "marginRight",
        "marginHorizontal",
        "marginVertical",
        "width",
        "height",
        "gap",
        "fontSize",
      ].sort()
    );
  });

  // The single artifact BOTH sides pin to: the conformance fixture's
  // scoped-props list is what the engine (Rust runner natively, TS runner
  // through the WASM wire) is asserted to emit, and here the TS whitelist
  // keys are asserted against the same list — so the two "must match
  // exactly" whitelists can only drift by breaking one of the suites.
  test("keys match the transition-scoped-props conformance fixture exactly", async () => {
    const fixture = await Bun.file(
      new URL(
        "../../engine-compatibility-tests/fixtures/animation/transition-scoped-props.json",
        import.meta.url
      ).pathname
    ).json();
    const pinned = fixture.expected.patches[0].props["__anim.transition"].props;
    expect(Object.keys(ANIMATABLE_PROPS)).toEqual(pinned);
  });

  test("transform-ish props collapse onto transform", () => {
    for (const prop of ["translateX", "translateY", "scale", "rotate"]) {
      expect(ANIMATABLE_PROPS[prop]).toEqual(["transform"]);
    }
  });

  test("renamed and directional-shorthand mappings", () => {
    expect(ANIMATABLE_PROPS.cornerRadius).toEqual(["border-radius"]);
    expect(ANIMATABLE_PROPS.backgroundColor).toEqual(["background-color"]);
    expect(ANIMATABLE_PROPS.fontSize).toEqual(["font-size"]);
    expect(ANIMATABLE_PROPS.paddingHorizontal).toEqual([
      "padding-left",
      "padding-right",
    ]);
    expect(ANIMATABLE_PROPS.marginVertical).toEqual([
      "margin-top",
      "margin-bottom",
    ]);
  });

  test("cssPropertiesFor dedupes shared CSS properties, preserving order", () => {
    expect(
      cssPropertiesFor(["translateX", "translateY", "scale", "opacity"])
    ).toEqual(["transform", "opacity"]);
  });

  test("cssPropertiesFor ignores unknown Hypen props", () => {
    expect(cssPropertiesFor(["tw", "opacity", "onClick"])).toEqual(["opacity"]);
  });

  test("cssPropertiesFor with no scope resolves the full deduped whitelist", () => {
    const all = cssPropertiesFor();
    expect(all).toContain("transform");
    expect(all).toContain("border-radius");
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("parseAnimProps — well-formed wire shapes", () => {
  test("all five channels from a create-props object", () => {
    const specs = parseAnimProps({
      "__anim.transition": { duration: 200, curve: "easeOut" },
      "__anim.enter": {
        presets: ["slide", "fade"],
        from: "bottom",
        duration: 200,
        curve: "easeOut",
      },
      "__anim.exit": { presets: ["fade"], duration: 150, curve: "easeIn" },
      "__anim.layout": { duration: 300, curve: "spring" },
      "__anim.animate": {
        preset: "spin",
        duration: 800,
        repeat: "loop",
        curve: "linear",
      },
    });
    expect(specs.transition).toEqual({ duration: 200, curve: "easeOut" });
    expect(specs.enter).toEqual({
      presets: ["slide", "fade"],
      from: "bottom",
      duration: 200,
      curve: "easeOut",
    });
    expect(specs.exit).toEqual({
      presets: ["fade"],
      duration: 150,
      curve: "easeIn",
    });
    expect(specs.layout).toEqual({ duration: 300, curve: "spring" });
    expect(specs.animate).toEqual({
      preset: "spin",
      duration: 800,
      repeat: "loop",
      curve: "linear",
    });
  });

  test("absent props → all channels null", () => {
    for (const input of [undefined, null, {}] as const) {
      expect(parseAnimProps(input)).toEqual({
        transition: null,
        enter: null,
        exit: null,
        layout: null,
        animate: null,
      });
    }
  });

  test("transition keeps delay and whitelist-scoped props", () => {
    const specs = parseAnimProps({
      "__anim.transition": {
        duration: 300,
        curve: "spring",
        delay: 50,
        props: ["opacity", "translateY"],
      },
    });
    expect(specs.transition).toEqual({
      duration: 300,
      curve: "spring",
      delay: 50,
      props: ["opacity", "translateY"],
    });
  });

  test("exit keeps its direction under `to`", () => {
    const specs = parseAnimProps({
      "__anim.exit": {
        presets: ["slide"],
        to: "trailing",
        duration: 150,
        curve: "easeIn",
      },
    });
    expect(specs.exit).toEqual({
      presets: ["slide"],
      to: "trailing",
      duration: 150,
      curve: "easeIn",
    });
  });

  test("zero duration is valid (snap-configured, not malformed)", () => {
    const specs = parseAnimProps({
      "__anim.transition": { duration: 0, curve: "linear" },
    });
    expect(specs.transition).toEqual({ duration: 0, curve: "linear" });
  });

  test("a JSON-stringified channel value is tolerated", () => {
    const specs = parseAnimProps({
      "__anim.transition": '{"duration":200,"curve":"easeOut"}',
      "__anim.animate":
        '{"preset":"pulse","duration":1200,"repeat":"loop","curve":"easeInOut"}',
    });
    expect(specs.transition).toEqual({ duration: 200, curve: "easeOut" });
    expect(specs.animate).toEqual({
      preset: "pulse",
      duration: 1200,
      repeat: "loop",
      curve: "easeInOut",
    });
  });

  test("animate keeps delay and a finite repeat count", () => {
    const specs = parseAnimProps({
      "__anim.animate": {
        preset: "shake",
        duration: 400,
        repeat: 3,
        curve: "easeInOut",
        delay: 100,
      },
    });
    expect(specs.animate).toEqual({
      preset: "shake",
      duration: 400,
      repeat: 3,
      curve: "easeInOut",
      delay: 100,
    });
  });

  test("every preset's engine-default wire object round-trips", () => {
    for (const preset of Object.keys(ANIMATE_PRESETS) as AnimatePreset[]) {
      const defaults = ANIMATE_PRESETS[preset];
      const specs = parseAnimProps({
        "__anim.animate": { preset, ...defaults },
      });
      expect(specs.animate).toEqual({ preset, ...defaults });
    }
  });
});

describe("parseAnimProps — malformed-input tolerance", () => {
  test("non-object channel values → null, never throw", () => {
    for (const bad of [42, true, [], "not json", "[1,2]", '"str"', null]) {
      const specs = parseAnimProps({ "__anim.transition": bad });
      expect(specs.transition).toBeNull();
    }
  });

  test("invalid duration voids the channel", () => {
    for (const duration of [-1, NaN, Infinity, "200", undefined]) {
      const specs = parseAnimProps({
        "__anim.transition": { duration, curve: "easeOut" },
      });
      expect(specs.transition).toBeNull();
    }
  });

  test("unknown curve voids the channel", () => {
    const specs = parseAnimProps({
      "__anim.layout": { duration: 300, curve: "bounce" },
    });
    expect(specs.layout).toBeNull();
  });

  test("invalid delay is dropped, not channel-voiding", () => {
    const specs = parseAnimProps({
      "__anim.transition": { duration: 200, curve: "easeOut", delay: -5 },
    });
    expect(specs.transition).toEqual({ duration: 200, curve: "easeOut" });
  });

  test("unknown props are filtered from a transition scope", () => {
    const specs = parseAnimProps({
      "__anim.transition": {
        duration: 200,
        curve: "easeOut",
        props: ["opacity", "tw", 7, "boxShadow"],
      },
    });
    expect(specs.transition).toEqual({
      duration: 200,
      curve: "easeOut",
      props: ["opacity"],
    });
  });

  test("a scope that filters to nothing voids the channel", () => {
    for (const props of [["tw", "boxShadow"], [], "opacity"]) {
      const specs = parseAnimProps({
        "__anim.transition": { duration: 200, curve: "easeOut", props },
      });
      expect(specs.transition).toBeNull();
    }
  });

  test("enter without recognizable presets → null", () => {
    for (const presets of [undefined, [], ["wobble"], "fade", 3]) {
      const specs = parseAnimProps({
        "__anim.enter": { presets, duration: 200, curve: "easeOut" },
      });
      expect(specs.enter).toBeNull();
    }
  });

  test("unknown presets are filtered when known ones remain", () => {
    const specs = parseAnimProps({
      "__anim.enter": {
        presets: ["wobble", "fade", 3],
        duration: 200,
        curve: "easeOut",
      },
    });
    expect(specs.enter).toEqual({
      presets: ["fade"],
      duration: 200,
      curve: "easeOut",
    });
  });

  test("invalid direction is dropped, presets still play", () => {
    const specs = parseAnimProps({
      "__anim.enter": {
        presets: ["slide"],
        from: "sideways",
        duration: 200,
        curve: "easeOut",
      },
    });
    expect(specs.enter).toEqual({
      presets: ["slide"],
      duration: 200,
      curve: "easeOut",
    });
  });

  test("one malformed channel does not poison the others", () => {
    const specs = parseAnimProps({
      "__anim.transition": "garbage",
      "__anim.exit": { presets: ["fade"], duration: 150, curve: "easeIn" },
      "__anim.animate": {
        preset: "spin",
        duration: 800,
        repeat: "loop",
        curve: "linear",
      },
    });
    expect(specs.transition).toBeNull();
    expect(specs.exit).toEqual({
      presets: ["fade"],
      duration: 150,
      curve: "easeIn",
    });
    expect(specs.animate).toEqual({
      preset: "spin",
      duration: 800,
      repeat: "loop",
      curve: "linear",
    });
  });

  test("non-object animate values → null, never throw", () => {
    for (const bad of [42, true, [], "not json", "[1,2]", '"spin"', null]) {
      const specs = parseAnimProps({ "__anim.animate": bad });
      expect(specs.animate).toBeNull();
    }
  });

  test("unknown or missing animate preset voids the channel", () => {
    for (const preset of ["bounce", "", 7, undefined, null, ["spin"]]) {
      const specs = parseAnimProps({
        "__anim.animate": {
          preset,
          duration: 800,
          repeat: "loop",
          curve: "linear",
        },
      });
      expect(specs.animate).toBeNull();
    }
  });

  test("invalid animate duration or curve voids the channel", () => {
    for (const duration of [-1, NaN, Infinity, "800", undefined]) {
      const specs = parseAnimProps({
        "__anim.animate": { preset: "spin", duration, repeat: "loop", curve: "linear" },
      });
      expect(specs.animate).toBeNull();
    }
    const badCurve = parseAnimProps({
      "__anim.animate": {
        preset: "spin",
        duration: 800,
        repeat: "loop",
        curve: "bounce",
      },
    });
    expect(badCurve.animate).toBeNull();
  });

  test("repeat accepts only 'loop' or a positive integer", () => {
    for (const repeat of [0, -1, 2.5, NaN, Infinity, "3", "forever", true, [], undefined]) {
      const specs = parseAnimProps({
        "__anim.animate": { preset: "pulse", duration: 1200, repeat, curve: "easeInOut" },
      });
      expect(specs.animate).toBeNull();
    }
    for (const repeat of ["loop", 1, 3] as const) {
      const specs = parseAnimProps({
        "__anim.animate": { preset: "pulse", duration: 1200, repeat, curve: "easeInOut" },
      });
      expect(specs.animate?.repeat).toBe(repeat);
    }
  });

  test("invalid animate delay is dropped, not channel-voiding", () => {
    const specs = parseAnimProps({
      "__anim.animate": {
        preset: "shimmer",
        duration: 1500,
        repeat: "loop",
        curve: "linear",
        delay: -5,
      },
    });
    expect(specs.animate).toEqual({
      preset: "shimmer",
      duration: 1500,
      repeat: "loop",
      curve: "linear",
    });
  });
});

describe("enter/exit preset hidden styles", () => {
  test("fade → opacity 0", () => {
    expect(presetHiddenStyles(["fade"])).toEqual({ opacity: "0" });
  });

  test("scale → scale(0.95)", () => {
    expect(SCALE_HIDDEN_FACTOR).toBe(0.95);
    expect(presetHiddenStyles(["scale"])).toEqual({ transform: "scale(0.95)" });
  });

  test("slide offsets 24px along the given axis", () => {
    expect(SLIDE_OFFSET_PX).toBe(24);
    expect(presetHiddenStyles(["slide"], "top")).toEqual({
      transform: "translateY(-24px)",
    });
    expect(presetHiddenStyles(["slide"], "bottom")).toEqual({
      transform: "translateY(24px)",
    });
  });

  test("leading/trailing are RTL-aware", () => {
    expect(presetHiddenStyles(["slide"], "leading", false)).toEqual({
      transform: "translateX(-24px)",
    });
    expect(presetHiddenStyles(["slide"], "leading", true)).toEqual({
      transform: "translateX(24px)",
    });
    expect(presetHiddenStyles(["slide"], "trailing", false)).toEqual({
      transform: "translateX(24px)",
    });
    expect(presetHiddenStyles(["slide"], "trailing", true)).toEqual({
      transform: "translateX(-24px)",
    });
  });

  test("directionless slide defaults to leading", () => {
    expect(presetHiddenStyles(["slide"])).toEqual({
      transform: "translateX(-24px)",
    });
  });

  test("composed presets merge: transforms join, fade contributes opacity", () => {
    expect(presetHiddenStyles(["slide", "fade", "scale"], "bottom")).toEqual({
      opacity: "0",
      transform: "translateY(24px) scale(0.95)",
    });
  });
});

describe("Patch.transition flag", () => {
  test("a flagged remove is a plain remove plus the optional flag", () => {
    const flagged: Patch = { type: "remove", id: "7", transition: true };
    const plain: Patch = { type: "remove", id: "8" };
    expect(flagged.transition).toBe(true);
    expect(plain.transition).toBeUndefined();
  });
});

describe("numeric easing (curveFunction / cubicBezier)", () => {
  // Independent reference implementation: evaluate the parametric bezier
  // (P0=(0,0), P3=(1,1)) and invert x(t) by pure bisection — no code shared
  // with the solver under test.
  const refBezier = (x1: number, y1: number, x2: number, y2: number) => {
    const axis = (p1: number, p2: number) => (t: number) =>
      3 * (1 - t) * (1 - t) * t * p1 + 3 * (1 - t) * t * t * p2 + t * t * t;
    const fx = axis(x1, x2);
    const fy = axis(y1, y2);
    return (x: number) => {
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (fx(mid) < x) lo = mid;
        else hi = mid;
      }
      return fy((lo + hi) / 2);
    };
  };

  test("control points match the shipped CURVE_TO_CSS beziers", () => {
    // spring's points are literally the CSS string's — one source of truth.
    expect(CURVE_TO_CSS.spring).toBe(
      `cubic-bezier(${CURVE_BEZIER_POINTS.spring.join(",")})`
    );
    // ease-in / ease-out / ease-in-out are the CSS Easing spec's fixed
    // bezier definitions of those keywords.
    expect(CURVE_BEZIER_POINTS.easeIn).toEqual([0.42, 0, 1, 1]);
    expect(CURVE_BEZIER_POINTS.easeOut).toEqual([0, 0, 0.58, 1]);
    expect(CURVE_BEZIER_POINTS.easeInOut).toEqual([0.42, 0, 0.58, 1]);
    expect(CURVE_BEZIER_POINTS.linear).toEqual([0, 0, 1, 1]);
  });

  test("every curve token resolves to a function", () => {
    for (const curve of ANIM_CURVES) {
      expect(typeof curveFunction(curve)).toBe("function");
    }
  });

  test("endpoints are exact for every curve: f(0) === 0, f(1) === 1", () => {
    for (const curve of ANIM_CURVES) {
      const f = curveFunction(curve);
      expect(f(0)).toBe(0);
      expect(f(1)).toBe(1);
    }
  });

  test("out-of-range input clamps to the exact endpoints", () => {
    for (const curve of ANIM_CURVES) {
      const f = curveFunction(curve);
      expect(f(-0.5)).toBe(0);
      expect(f(1.5)).toBe(1);
    }
  });

  test("linear is the identity", () => {
    const f = curveFunction("linear");
    for (const t of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      expect(f(t)).toBe(t);
    }
  });

  test("monotone curves are non-decreasing and stay in [0,1]", () => {
    const monotone: AnimCurve[] = ["linear", "easeIn", "easeOut", "easeInOut"];
    for (const curve of monotone) {
      const f = curveFunction(curve);
      let prev = -Infinity;
      for (let i = 0; i <= 200; i++) {
        const y = f(i / 200);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(1);
        expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = y;
      }
    }
  });

  test("spring overshoots above 1 mid-range, then settles to 1", () => {
    const f = curveFunction("spring");
    // y1=1.56 pushes the curve past 1; peak ≈ 1.0978 near x ≈ 0.573.
    expect(f(0.5)).toBeGreaterThan(1);
    expect(f(0.6)).toBeGreaterThan(1);
    let max = 0;
    for (let i = 0; i <= 1000; i++) max = Math.max(max, f(i / 1000));
    expect(max).toBeGreaterThan(1.09);
    expect(max).toBeLessThan(1.11);
    expect(f(1)).toBe(1);
  });

  test("solver matches known CSS reference values (spot checks)", () => {
    // Reference values computed independently by dense bisection of the
    // parametric curves (6-decimal pins).
    const expected: Record<AnimCurve, [x: number, y: number][]> = {
      linear: [
        [0.25, 0.25],
        [0.5, 0.5],
        [0.75, 0.75],
      ],
      easeIn: [
        [0.1, 0.017027],
        [0.25, 0.093465],
        [0.5, 0.315357],
        [0.75, 0.621862],
        [0.9, 0.839428],
      ],
      easeOut: [
        [0.1, 0.160572],
        [0.25, 0.378138],
        [0.5, 0.684643],
        [0.75, 0.906535],
        [0.9, 0.982973],
      ],
      easeInOut: [
        [0.1, 0.019722],
        [0.25, 0.129162],
        [0.5, 0.5],
        [0.75, 0.870838],
        [0.9, 0.980278],
      ],
      spring: [
        [0.1, 0.403933],
        [0.25, 0.816289],
        [0.5, 1.087401],
        [0.75, 1.059647],
        [0.9, 1.012616],
      ],
    };
    for (const [curve, points] of Object.entries(expected) as [
      AnimCurve,
      [number, number][],
    ][]) {
      const f = curveFunction(curve);
      for (const [x, y] of points) {
        expect(Math.abs(f(x) - y)).toBeLessThan(1e-4);
      }
    }
  });

  test("ease-in and ease-out are exact mirrors; ease-in-out is symmetric", () => {
    const easeIn = curveFunction("easeIn");
    const easeOut = curveFunction("easeOut");
    const easeInOut = curveFunction("easeInOut");
    for (let i = 0; i <= 100; i++) {
      const t = i / 100;
      // (x2,y2) of ease-in reflects (x1,y1) of ease-out: f_in(t) = 1 - f_out(1-t).
      expect(Math.abs(easeIn(t) - (1 - easeOut(1 - t)))).toBeLessThan(1e-5);
      expect(Math.abs(easeInOut(t) + easeInOut(1 - t) - 1)).toBeLessThan(1e-5);
    }
  });

  test("cubicBezier matches an independent reference across arbitrary curves", () => {
    const cases: [number, number, number, number][] = [
      [0.25, 0.1, 0.25, 1], // CSS `ease`
      [0.68, -0.55, 0.265, 1.55], // easeInOutBack (under- and overshoot)
      [0.42, 0, 0.58, 1],
      [0.34, 1.56, 0.64, 1],
      [0.7, 0.2, 0.3, 0.8],
    ];
    for (const [x1, y1, x2, y2] of cases) {
      const f = cubicBezier(x1, y1, x2, y2);
      const ref = refBezier(x1, y1, x2, y2);
      for (let i = 0; i <= 100; i++) {
        const x = i / 100;
        expect(Math.abs(f(x) - ref(x))).toBeLessThan(1e-4);
      }
    }
  });

  test("degenerate control points (flat derivative regions) still solve", () => {
    // x1=x2=0 and x1=x2=1 give zero x-derivative at an endpoint — the
    // bisection fallback path.
    for (const [x1, y1, x2, y2] of [
      [0, 0, 0, 1],
      [1, 0, 1, 1],
      [0, 1.2, 1, -0.2],
    ] as const) {
      const f = cubicBezier(x1, y1, x2, y2);
      const ref = refBezier(x1, y1, x2, y2);
      expect(f(0)).toBe(0);
      expect(f(1)).toBe(1);
      for (let i = 1; i < 100; i++) {
        const x = i / 100;
        expect(Number.isFinite(f(x))).toBe(true);
        expect(Math.abs(f(x) - ref(x))).toBeLessThan(1e-3);
      }
    }
  });

  test("mirrored y control points collapse to the identity", () => {
    // When y1=x1 and y2=x2 the curve is y = x for any control x's.
    const f = cubicBezier(0.42, 0.42, 0.58, 0.58);
    for (let i = 0; i <= 100; i++) {
      const t = i / 100;
      expect(Math.abs(f(t) - t)).toBeLessThan(1e-5);
    }
  });

  test("an unknown token degrades to linear instead of throwing", () => {
    const f = curveFunction("bounce" as AnimCurve);
    expect(f(0)).toBe(0);
    expect(f(0.5)).toBe(0.5);
    expect(f(1)).toBe(1);
  });

  test("curveFunction is cached per token", () => {
    expect(curveFunction("spring")).toBe(curveFunction("spring"));
    expect(curveFunction("easeInOut")).toBe(curveFunction("easeInOut"));
  });
});

describe("barrel export", () => {
  test("animation module is reachable from both core barrels", async () => {
    const barrel = await import("../packages/core/src/index");
    const browserBarrel = await import("../packages/core/src/index.browser");
    for (const mod of [barrel, browserBarrel]) {
      expect(mod.ANIM_PROP_PREFIX).toBe("__anim.");
      expect(mod.ANIM_PROP_ANIMATE).toBe("__anim.animate");
      expect(typeof mod.parseAnimProps).toBe("function");
      expect(typeof mod.cubicBezier).toBe("function");
      expect(typeof mod.curveFunction).toBe("function");
      expect(mod.curveFunction("linear")(0.5)).toBe(0.5);
      expect(mod.CURVE_BEZIER_POINTS.spring).toEqual([0.34, 1.56, 0.64, 1]);
      expect(mod.CURVE_TO_CSS.spring).toBe("cubic-bezier(0.34,1.56,0.64,1)");
      expect(mod.ANIMATE_PRESETS.spin).toEqual({
        duration: 800,
        repeat: "loop",
        curve: "linear",
      });
    }
  });
});
