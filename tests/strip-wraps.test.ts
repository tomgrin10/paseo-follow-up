// Invariant 155, nothing-hides-past-the-edge (client/home-chrome.tsx StatusStrip, client/pill.tsx). 2026-11-28, the
// search-wrap renders of 2.6.0-beta.5: on a phone Home's status strip ran off the right edge ("4 W" at 360 wide with a
// large font, "1 Qui" at 390). Root cause: on touch the strip was a sideways ScrollView with its scroll indicator
// hidden, so chips past the edge were cut with nothing saying more was there; the page itself never overflowed, so
// the no-overflow check (invariant 8) passed. The pill's Later chips on a phone were the same. A row of chips now
// wraps onto its own lines on every device, and no client view scrolls sideways out of sight.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createElement } from "react";

register("./support/native/hooks.mjs", import.meta.url);
type Node = { type: unknown; props: Record<string, unknown> };
const { create, act } = await import("react-test-renderer" as string) as {
  create: (el: unknown) => { root: { findAll(f: (n: Node) => boolean): Node[] } };
  act: (f: () => Promise<void> | void) => Promise<void>;
};
const { StatusStrip } = await import("../client/home-chrome");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const colors = new Proxy({}, { get: () => "#888888" });
const theme = { colors } as never;
const items = (n: number, extra: Record<string, unknown> = {}) => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, ...extra }));
// Every group has rows: the most chips a phone strip draws.
const model = { raised: 0, groups: [
  { id: "needs", items: items(4) }, { id: "sending", items: items(2) }, { id: "running", items: items(1) },
  { id: "waiting", items: items(4) }, { id: "quiet", items: items(3, { readyToArchive: true }) }, { id: "later", items: items(2) },
] };

test("nothing-hides-past-the-edge: Home's phone status strip wraps, never scrolls sideways", async () => {
  let r!: ReturnType<typeof create>;
  await act(() => { r = create(createElement(StatusStrip as never, { theme, model, filter: null, onFilter: () => {}, touch: true, dense: true } as never)); });
  const sideways = r.root.findAll(n => n.type === "ScrollView" && !!n.props.horizontal);
  assert.equal(sideways.length, 0, "no sideways scroller: chips past the edge would be cut with no hint");
  const bar = r.root.findAll(n => typeof n.type === "string" && n.props.accessibilityLabel === "Status")[0];
  assert.ok(bar, "the strip is a Status toolbar");
  const style = Object.assign({}, ...[bar!.props.style].flat(Infinity).filter(Boolean)) as Record<string, unknown>;
  assert.equal(style.flexWrap, "wrap", "its chips wrap onto their own lines");
  // Every group with rows is still a chip, each with its count.
  for (const label of ["Needs you, 4", "Sending, 2", "Working, 1", "Waiting, 4", "Quiet, 3", "Later, 2"])
    assert.ok(r.root.findAll(n => typeof n.props.accessibilityLabel === "string" && (n.props.accessibilityLabel as string).startsWith(label)).length, `${label} is drawn`);
  // "N to archive" holds the chips' 44 row with a box: a lineHeight would grow with a large font and push the next line down.
  const archive = r.root.findAll(n => typeof n.type === "string" && n.props.testID === "strip-archivable")[0];
  assert.ok(archive, "the archive note is drawn");
  assert.equal((Object.assign({}, ...[archive!.props.style].flat(Infinity).filter(Boolean)) as Record<string, unknown>).minHeight, 44);
  assert.ok(!r.root.findAll(n => [n.props.style].flat(Infinity).some(st => st && typeof st === "object" && "lineHeight" in st && (st as { lineHeight: number }).lineHeight >= 44)).length, "no text takes its row height from a lineHeight");
});

test("nothing-hides-past-the-edge: no client view scrolls sideways unless it says so", async () => {
  // A sideways scroller is allowed only with a visible sign that more is there, named here with why.
  const ALLOWED: Record<string, string> = {};
  const root = join(import.meta.dirname, "..");
  const files = ["index.client.tsx", ...(await readdir(join(root, "client"))).filter(f => /\.tsx?$/.test(f)).map(f => `client/${f}`)];
  const found: string[] = [];
  for (const f of files) {
    const src = await readFile(join(root, f), "utf8");
    for (const m of src.matchAll(/<(ScrollView|FlatList|HostScrollView)\b[^>]*\bhorizontal\b/g)) {
      const line = src.slice(0, m.index).split("\n").length;
      if (!ALLOWED[`${f}:${m[1]}`]) found.push(`${f}:${line} <${m[1]} horizontal>`);
    }
  }
  assert.deepEqual(found, [], "a row that doesn't fit wraps (invariant 8: chips go on their own wrapping line)");
});
