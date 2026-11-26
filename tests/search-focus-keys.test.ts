import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

/**
 * every-search-request-lands-in-the-visible-search, the keys (2026-11-26, the developer on 2.4.0-rc.0: "right now I
 * [used] the shortcut and it goes to the follow up home but not focuses the search box"). A held request ends only on
 * the developer's own act. 2.4.0-rc.0 ended it on any keydown heard on the window, so the request's own key ended it:
 * a Mac auto-repeats a held ⌘⇧K once its key-repeat delay passes (a repeat keydown, before a large Home has mounted),
 * a modifier re-pressed around the chord is a keydown too, and the first letter of a query typed while Home mounted
 * ended it as well. Each left Home open with the caret nowhere.
 */
register("./support/native/hooks.mjs", import.meta.url);
const rn = await import("react-native" as string) as { Platform: { OS: string } };
rn.Platform.OS = "web";

type Listener = (e: unknown) => void;
function fakeWindow() {
  const listeners = new Map<string, Listener[]>();
  const win = {
    addEventListener: (t: string, f: Listener) => { listeners.set(t, [...listeners.get(t) ?? [], f]); },
    removeEventListener: (t: string, f: Listener) => { listeners.set(t, (listeners.get(t) ?? []).filter(x => x !== f)); },
    matchMedia: () => ({ matches: false }),
  };
  const fire = (t: string, e: Record<string, unknown> = {}) => {
    let prevented = false; let stopped = false;
    const ev = { target: null, preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; }, ...e };
    for (const f of listeners.get(t) ?? []) f(ev);
    return { prevented, stopped };
  };
  return { win, fire };
}

async function setup() {
  const { win, fire } = fakeWindow();
  const saved = { add: (globalThis as Record<string, unknown>).addEventListener, remove: (globalThis as Record<string, unknown>).removeEventListener, mm: (globalThis as Record<string, unknown>).matchMedia };
  Object.assign(globalThis, { addEventListener: win.addEventListener, removeEventListener: win.removeEventListener, matchMedia: win.matchMedia });
  const { createWebSearchFocus } = await import("../client/search-focus");
  const focus = createWebSearchFocus();
  const off = focus.install();
  let caret = false; let shown = false; let query = "";
  focus.register({ shown: () => shown, focused: () => caret, focus: () => { if (shown) caret = true; }, type: (t: string) => { query = t; } } as never);
  return {
    focus, fire,
    mount: () => { shown = true; focus.changed(); },
    caret: () => caret, query: () => query,
    done: () => { off(); Object.assign(globalThis, { addEventListener: saved.add, removeEventListener: saved.remove, matchMedia: saved.mm }); },
  };
}

// The search key's chord: keydowns for the modifiers, then K (the request is made by K's own handler, after the window
// listener has heard it).
const chord = (s: Awaited<ReturnType<typeof setup>>, mac = true) => {
  s.fire("keydown", { key: mac ? "Meta" : "Control", metaKey: mac, ctrlKey: !mac });
  s.fire("keydown", { key: "Shift", shiftKey: true, metaKey: mac, ctrlKey: !mac });
  s.fire("keydown", { key: "K", shiftKey: true, metaKey: mac, ctrlKey: !mac });
  s.focus.request();
};

test("a Mac repeating the held ⌘⇧K before Home mounts never drops the request", async () => {
  const s = await setup();
  chord(s);
  for (let i = 0; i < 5; i++) s.fire("keydown", { key: "K", shiftKey: true, metaKey: true, repeat: true });
  s.mount();
  assert.equal(s.caret(), true, "the caret lands in the search once it is on screen");
  s.done();
});

test("a modifier pressed again around the chord is not the developer acting", async () => {
  const s = await setup();
  chord(s);
  s.fire("keydown", { key: "Shift", shiftKey: true });
  s.fire("keydown", { key: "Meta", metaKey: true });
  s.mount();
  assert.equal(s.caret(), true);
  s.done();
});

test("a query typed while Home mounts lands in the search, and its keys go nowhere else", async () => {
  const s = await setup();
  chord(s);
  for (const key of ["a", "c", "m", "x"]) assert.deepEqual(s.fire("keydown", { key }), { prevented: true, stopped: true }, `${key} is kept for the search`);
  s.fire("keydown", { key: "Backspace" });
  s.fire("keydown", { key: "e" });
  s.mount();
  assert.equal(s.caret(), true);
  assert.equal(s.query(), "acme");
  s.done();
});

test("a key that does something is still the developer's: Escape, an arrow or a chord ends the request", async () => {
  for (const e of [{ key: "Escape" }, { key: "ArrowDown" }, { key: "Tab" }, { key: "1", metaKey: true }, { key: "e", altKey: true }]) {
    const s = await setup();
    chord(s);
    s.fire("keydown", e);
    s.mount();
    assert.equal(s.caret(), false, `${JSON.stringify(e)} ends it`);
    s.done();
  }
});

test("once the caret has landed, typing is the field's own (nothing is intercepted)", async () => {
  const s = await setup();
  s.mount();
  chord(s);
  assert.equal(s.caret(), true);
  assert.deepEqual(s.fire("keydown", { key: "a" }), { prevented: false, stopped: false });
  s.done();
});

test("Enter typed before the caret lands is held back, never sent to the chat being left", async () => {
  const s = await setup();
  chord(s);
  s.fire("keydown", { key: "a" });
  assert.deepEqual(s.fire("keydown", { key: "Enter" }), { prevented: true, stopped: true }, "the composer behind never sees it");
  s.mount();
  assert.equal(s.caret(), true);
  assert.equal(s.query(), "a");
  s.done();
});

test("a plain key held down repeats into the search; AltGr's characters are typing", async () => {
  const s = await setup();
  chord(s);
  s.fire("keydown", { key: "a" }); s.fire("keydown", { key: "a", repeat: true });
  s.fire("keydown", { key: "@", ctrlKey: true, altKey: true, getModifierState: (k: string) => k === "AltGraph" });
  s.fire("keydown", { key: "b" });
  s.fire("keydown", { key: "Backspace" }); s.fire("keydown", { key: "Backspace", repeat: true });
  s.mount();
  assert.equal(s.query(), "aa");
  s.done();
});
