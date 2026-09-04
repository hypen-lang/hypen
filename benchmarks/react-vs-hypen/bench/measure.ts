/**
 * The in-page measurement primitive, as a string of source injected into the
 * browser.
 *
 * Timing an interaction is the part of a framework benchmark that is easiest
 * to get subtly wrong, so the definition is explicit:
 *
 *   t0  — immediately before dispatching the click
 *   t1  — the moment after layout and paint of the frame that carried the
 *         LAST DOM mutation caused by that click
 *
 * `t1` comes from a `setTimeout(0)` scheduled inside a `requestAnimationFrame`
 * callback: rAF runs before style/layout/paint, so the timeout that follows it
 * lands after the browser has actually put pixels on the screen for that frame.
 * A run finishes once three consecutive frames arrive with no further
 * mutations — and the idle-detection window itself is NOT counted, because the
 * reported value is the last recorded post-paint timestamp, not the time the
 * detector gave up.
 *
 * Both frameworks are measured with this exact code. Hypen's action handlers
 * are async and its patches arrive from WASM; React's `setState` schedules
 * through its own scheduler. Waiting on the DOM rather than on either
 * framework's internals is what makes the two comparable.
 */
export const MEASURE_SOURCE = `
window.__bench = {
  root: () => document.getElementById("app"),

  /** DOM mutation tally from the most recent timed run. */
  lastWork: null,

  /** Click a control and resolve once the resulting DOM churn has painted. */
  run(selector, noChangeTimeout = 5000) {
    return new Promise((resolve, reject) => {
      const el = document.querySelector(selector);
      if (!el) return reject(new Error("no control: " + selector));

      let mutated = false;
      let dirtySinceFrame = false;
      let lastPainted = 0;
      let quietFrames = 0;

      // How much DOM the framework actually touched to satisfy this click.
      // Two runtimes can take the same wall-clock time while one rebuilt the
      // list and the other patched four attributes, and that difference is
      // the whole argument for a reconciler — so count it.
      const work = { added: 0, removed: 0, attrs: 0, text: 0, records: 0 };

      const observer = new MutationObserver((records) => {
        mutated = true;
        dirtySinceFrame = true;
        work.records += records.length;
        for (const r of records) {
          if (r.type === "childList") {
            work.added += r.addedNodes.length;
            work.removed += r.removedNodes.length;
          } else if (r.type === "attributes") {
            work.attrs++;
          } else {
            work.text++;
          }
        }
      });
      observer.observe(window.__bench.root(), {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });

      const t0 = performance.now();

      const frame = () => {
        const wasDirty = dirtySinceFrame;
        dirtySinceFrame = false;
        setTimeout(() => {
          // Post-paint for this frame.
          if (wasDirty) {
            lastPainted = performance.now();
            quietFrames = 0;
          } else if (mutated) {
            quietFrames++;
          }

          if (mutated && quietFrames >= 3) {
            observer.disconnect();
            window.__bench.lastWork = work;
            resolve(lastPainted - t0);
            return;
          }
          if (!mutated && performance.now() - t0 > noChangeTimeout) {
            observer.disconnect();
            reject(new Error("no DOM change for " + selector));
            return;
          }
          requestAnimationFrame(frame);
        }, 0);
      };

      requestAnimationFrame(frame);
      el.click();
    });
  },

  /** Click a control and wait for it to settle, without timing it. */
  async settle(selector) {
    try {
      await window.__bench.run(selector, 400);
    } catch (e) {
      // A no-op setup click (e.g. "clear" on an already-empty list) produces
      // no mutations; that is fine, there is nothing to wait for.
    }
  },

  stats: () => ({
    elements: window.__bench.root().querySelectorAll("*").length,
    rows: window.__bench.root().querySelectorAll('[aria-label="row-select"]').length,
  }),
};
`;
