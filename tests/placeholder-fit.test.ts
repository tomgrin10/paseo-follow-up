// Invariant 153, a-placeholder-never-wraps (shared/placeholder-fit.ts, client/field.tsx). 2026-11-28, the developer on
// an Android phone with a large font size, 2.6.0-beta.5: Home's search sits beside four icon buttons at about half the
// width, and its placeholder "Search or ask the Overseer" broke after "the", the second line clipped under the first.
// Root cause: React Native on Android draws a one-line TextInput's placeholder as a wrapping hint (React Native issue
// 14839: the field is one line, its hint isn't), and Follow-up handed every field its full wording whatever the width
// and font scale. The field now fits its hint to its own text room: the longest wording that fits, else the shortest
// cut with "…". These render the real Field and QueryField under the strict Android stand-in.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createElement } from "react";
import { estimateTextWidth, fitPlaceholder, drawnFontSize, textRoom } from "../shared/placeholder-fit";

register("./support/native/hooks.mjs", import.meta.url);
const { create, act } = await import("react-test-renderer" as string) as {
  create: (el: unknown) => { root: { findAll(f: (n: { type: unknown; props: Record<string, unknown> }) => boolean): { props: Record<string, unknown> }[] } };
  act: (f: () => Promise<void> | void) => Promise<void>;
};
const { Field } = await import("../client/field");
const { QueryField } = await import("../client/home-chrome");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const setFontScale = (s: number) => { (globalThis as { __nativeFontScale?: number }).__nativeFontScale = s; };

const colors = new Proxy({}, { get: () => "#888888" });
const theme = { colors } as never;
/** Android's own pad where a style sets none (client/field.tsx). */
const ANDROID_PAD = 12;

/** Renders `el`, lays its text input out `width` px wide, and returns what the input was handed. */
async function laidOut(el: unknown, width: number) {
  let r!: ReturnType<typeof create>;
  await act(() => { r = create(el); });
  const input = () => r.root.findAll(n => n.type === "TextInput")[0]!;
  const onLayout = input().props.onLayout as ((e: unknown) => void) | undefined;
  await act(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width, height: 44 } } }); });
  return input().props;
}
/** Whether `props.placeholder` fits the input's text room in its drawn font (the field's own estimate is the yardstick). */
function fitsRoom(props: Record<string, unknown>, width: number, fontScale: number) {
  const style = Object.assign({}, ...[props.style].flat(Infinity).filter(Boolean)) as Record<string, unknown>;
  const text = String(props.placeholder ?? "");
  const room = textRoom(width, style, ANDROID_PAD);
  return { text, room, width: estimateTextWidth(text, drawnFontSize(style, fontScale)), fits: estimateTextWidth(text, drawnFontSize(style, fontScale)) <= room };
}

test("a-placeholder-never-wraps: Home's phone search, large font, half width: the hint fits its one line", async () => {
  // Home's dense field: 44 px high, 15 px text. Beside + Filters Stats Settings a 360 px phone leaves its input ~130 px.
  setFontScale(1.3);
  const el = createElement(QueryField as never, { theme, value: "", onChange: () => {}, placeholder: ["Search or ask the Overseer", "Search or ask", "Search"], icon: "Search", dense: true, inputRef: { current: null }, slashHint: false } as never);
  const props = await laidOut(el, 130);
  const fit = fitsRoom(props, 130, 1.3);
  assert.ok(fit.fits, `"${fit.text}" (~${Math.round(fit.width)} px) fits the field's ${fit.room} px`);
  assert.equal(props.accessibilityLabel, "Search or ask the Overseer", "a screen reader still hears the full hint");
  assert.equal(props.numberOfLines, 1);
  setFontScale(1);
});

test("a-placeholder-never-wraps: Home's hint, a plain string, fits too (the field cuts it with …)", async () => {
  setFontScale(1.3);
  const el = createElement(Field as never, { placeholder: "Search or ask the Overseer", style: { flex: 1, fontSize: 15, paddingVertical: 0 } } as never);
  const props = await laidOut(el, 130);
  const fit = fitsRoom(props, 130, 1.3);
  assert.ok(fit.fits, `"${fit.text}" fits ${fit.room} px`);
  assert.match(fit.text, /…$|^$/, "a cut hint ends with …");
  setFontScale(1);
});

test("a-placeholder-never-wraps: every width and font scale a phone has, every one-line field's hint fits", async () => {
  const wordings = [["Search or ask the Overseer", "Search or ask", "Search"], ["Search workspaces, branches, PRs", "Search workspaces", "Search"], ["Filter workspaces", "Filter"],
    "Filter, or paste a link or key", "Search 140 workspaces", "Another repository: owner/repo", "Automatic: this device's zone"];
  for (const scale of [0.85, 1, 1.15, 1.3, 1.5, 2]) for (const width of [40, 80, 130, 180, 260, 360]) for (const placeholder of wordings) {
    setFontScale(scale);
    const props = await laidOut(createElement(Field as never, { placeholder, style: { fontSize: 15, paddingHorizontal: 10 } } as never), width);
    const fit = fitsRoom(props, width, scale);
    assert.ok(fit.fits, `${JSON.stringify(placeholder)} at ${width} px ×${scale}: "${fit.text}" (~${Math.round(fit.width)} px) over ${fit.room} px`);
  }
  setFontScale(1);
});

test("a-placeholder-never-wraps: a field with room keeps its full hint; a multi-line field is never cut", async () => {
  setFontScale(1);
  const wide = await laidOut(createElement(Field as never, { placeholder: ["Search or ask the Overseer", "Search"], style: { fontSize: 15 } } as never), 360);
  assert.equal(wide.placeholder, "Search or ask the Overseer");
  assert.equal(wide.accessibilityLabel, "Search or ask the Overseer", "one name whatever the width shows");
  const named = await laidOut(createElement(Field as never, { placeholder: "Search", accessibilityLabel: "Search workspaces", style: { fontSize: 15 } } as never), 40);
  assert.equal(named.accessibilityLabel, "Search workspaces", "a field's own label rules");
  const multi = await laidOut(createElement(Field as never, { multiline: true, placeholder: "Tell the agent something about this long enough to wrap", style: { fontSize: 15 } } as never), 60);
  assert.equal(multi.placeholder, "Tell the agent something about this long enough to wrap");
});

test("fitPlaceholder: the first wording that fits, else the last cut after a whole word with …, else none", () => {
  const m = (t: string) => t.length * 10;
  assert.equal(fitPlaceholder(["Search or ask", "Search"], 200, m), "Search or ask");
  assert.equal(fitPlaceholder(["Search or ask", "Search"], 100, m), "Search");
  assert.equal(fitPlaceholder(["Search or ask", "Search"], 50, m), "", "never cut inside a word: no hint over \"Sear…\"");
  assert.equal(fitPlaceholder("Filter, or paste a link or key", 180, m), "Filter, or paste…");
  assert.equal(fitPlaceholder("Filter, or paste a link or key", 80, m), "Filter…", "a cut drops the comma before …");
  assert.equal(fitPlaceholder("Search or ask", null, m), "Search or ask", "before layout: the full wording");
  assert.equal(fitPlaceholder(["Search or ask", "Search"], null, m, "shortest"), "Search", "before layout on a phone: the shortest");
});

test("a-placeholder-never-wraps: before its width is known a phone field shows its shortest wording", async () => {
  let r!: { root: { findAll(f: (n: { type: unknown }) => boolean): { props: Record<string, unknown> }[] } };
  await act(() => { r = create(createElement(Field as never, { placeholder: ["Search or ask the Overseer", "Search or ask", "Search"], style: { fontSize: 15 } } as never)) as never; });
  assert.equal(r.root.findAll(n => n.type === "TextInput")[0]!.props.placeholder, "Search");
});

test("drawnFontSize and textRoom read the style the platform draws", () => {
  assert.equal(drawnFontSize({ fontSize: 15 }, 1.3), 19.5);
  assert.equal(drawnFontSize({ fontSize: 15 }, 1.3, { allowFontScaling: false }), 15);
  assert.equal(drawnFontSize({ fontSize: 15 }, 2, { maxFontSizeMultiplier: 1.5 }), 22.5);
  assert.equal(drawnFontSize({}, 1), 14);
  assert.equal(textRoom(100, { paddingHorizontal: 8 }), 84);
  assert.equal(textRoom(100, { paddingVertical: 0 }, 12), 76, "Android's own pad where the style sets none");
  assert.equal(textRoom(100, { padding: 4, paddingLeft: 10, borderWidth: 1 }), 84);
});
