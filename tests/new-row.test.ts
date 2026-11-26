import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bundleStores, fakeHost, settle } from "./client-stores";
import { displayPreferences } from "../shared/display";
import { NEW_NAME, NEW_ROW } from "../shared/new-name";

/**
 * Invariant new-row-is-optional: the sidebar's New row follows the Display switch `enable_new_sidebar_row` (live, from
 * any device or an agent's set_display), and off removes only the row. The real client modules run against a fake host
 * that counts the sidebar registrations (tests/client-stores.ts).
 */
const root = join(import.meta.dirname, "..");

async function open() {
  const stores = await bundleStores();
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.parse("2026-11-25T10:00:00Z") });
  const host = fakeHost(true);
  const rows: { id: string; title: string; on: boolean }[] = [];
  host.client.addSidebarHeaderItem = (item: { id: string; title: string }) => { const r = { id: item.id, title: item.title, on: true }; rows.push(r); return () => { r.on = false; }; };
  const display = stores.contributeDisplay(host.client as never, { id: "follow-up-overview", title: "Follow-up", Component: () => null } as never);
  const key = { subscribe: () => () => undefined, label: () => null };
  const row = stores.contributeNewRow(host.client as never, key as never, (() => undefined) as never);
  const tick = async (ms: number) => { for (let t = 0; t < ms; t += 250) { mock.timers.tick(250); await settle(); } };
  await tick(500);
  const shown = () => rows.filter(r => r.id === "new" && r.on).length;
  const push = async (values: Record<string, unknown>) => { host.push("follow.display-feed", { status: "ready", revision: `r${Date.now()}`, values }); await tick(250); };
  const close = () => { row(); display(); mock.timers.reset(); };
  return { rows, shown, push, close };
}

test("the New row shows by default, and an unreadable or missing switch keeps it (unknown is not off)", { timeout: 60_000 }, async () => {
  const c = await open();
  try {
    assert.equal(c.shown(), 1, "registered at start");
    assert.equal(c.rows.find(r => r.id === "new")?.title, NEW_NAME, "Paseo's Settings → Sidebar lists it under the name");
    await c.push({});
    assert.equal(c.shown(), 1, "a document without the field keeps the row");
  } finally { c.close(); }
});

test("off removes the row and on brings it back, live, with nothing else unregistered", { timeout: 60_000 }, async () => {
  const c = await open();
  try {
    await c.push({ enable_new_sidebar_row: false });
    assert.equal(c.shown(), 0, "off: no New row");
    assert.equal(c.rows.filter(r => r.id === "follow-up-overview" && r.on).length, 1, "Follow-up's own row stays");
    await c.push({ enable_new_sidebar_row: true });
    assert.equal(c.shown(), 1, "on again: one row, never two");
    await c.push({ enable_new_sidebar_row: true });
    assert.equal(c.rows.filter(r => r.id === "new").length, 2, "an unchanged value registers nothing new");
  } finally { c.close(); }
});

test("one setting: a Display field (so set_display reaches it), on by default", () => {
  assert.equal(displayPreferences.schema.parse({}).enable_new_sidebar_row, true);
});

test("off still leaves Dispatch reachable: Home's + New, ⌘K and the key open it whatever the switch says", async () => {
  const index = await readFile(join(root, "index.client.tsx"), "utf8");
  assert.match(index, /addCommandCenterItem\(\{ id: "follow-up-new"/, "⌘K's New is registered unconditionally");
  assert.ok(!/enable_new_sidebar_row/.test(index), "nothing in the entry gates ⌘K or the key on the row's switch");
  const home = await readFile(join(root, "client/home.tsx"), "utf8");
  assert.ok(!/enable_new_sidebar_row/.test(home), "Home's + New never reads the row's switch");
  assert.match(NEW_ROW.hint("⌘⇧N"), /Home, under ⌘⇧N and in ⌘K/);
  assert.equal(NEW_ROW.hint(null, null), "A row at the top of the sidebar that opens Dispatch. Off: Dispatch stays on Home.", "a phone names no keys");
  for (const f of ["client/new-settings.tsx", "client/onboarding.tsx"]) assert.match(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"), /hint=\{compact \? NEW_ROW\.hint\(null, null\) : NEW_ROW\.hint\(/, `${f}: no keys on a phone`);
});

/**
 * The name (docs/dispatch.md#the-name): every user-facing name for this feature builds from shared/new-name.ts, so a
 * rename is one line. A string literal or JSX text saying "Dispatch", or the old "New", is refused unless it is
 * another thing's name.
 */
const OTHER_NEWS = /\bNew (source|worktree|agent|workspace|name|and existing|versions|features|work"|\$\{project)/;
const ALLOWED: Record<string, RegExp> = {
  // A queue row's change chip ("new in your queue"), not New.
  "shared/brief-since.ts": /text: "New", warn/,
  // A dispatch's fallback title for words with no sentence: "new work", not the feature.
  "shared/dispatch.ts": /\|\| "New work"/,
};
test("every user-facing name is built from the name module", async () => {
  const files = ["index.client.tsx", "server/dispatch.ts", "server/linear-issues.ts",
    ...(await readdir(join(root, "client"))).filter(f => /\.tsx?$/.test(f)).map(f => `client/${f}`),
    ...(await readdir(join(root, "shared"))).filter(f => /\.ts$/.test(f) && f !== "new-name.ts").map(f => `shared/${f}`)];
  const literal = /(["`])((?:(?!\1)[^\\\n]|\\.)*?\b(?:New|Dispatch)\b(?:(?!\1)[^\\\n]|\\.)*?)\1|>([^<>{}]*\b(?:New|Dispatch)\b[^<>{}]*)</g;
  const bad: string[] = [];
  for (const f of files) {
    const lines = (await readFile(join(root, f), "utf8")).split("\n");
    lines.forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
      for (const m of line.matchAll(literal)) {
        if (OTHER_NEWS.test(m[0]) || ALLOWED[f]?.test(line)) continue;
        bad.push(`${f}:${i + 1}: ${m[0].slice(0, 80)}`);
      }
    });
  }
  assert.deepEqual(bad, [], "say ${NEW_NAME}, ${NEW_OF} or ${NEW_WORK} (shared/new-name.ts) instead");
});
