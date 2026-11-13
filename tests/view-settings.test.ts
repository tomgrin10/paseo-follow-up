import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CATEGORY_KEY, collapseKey, deviceStorage, homeFoldKey, homeGroupOpen, isViewKey, readCategory, setDeviceBackend, subscribeView, viewSnapshot,
  writeCategory, writeHomeGroupOpen, type KeyValue,
} from "../shared/settings-nav";
import { documentBackend, seedValues, viewDefinition, VIEW_SCHEMA } from "../client/view-store";
import { deviceSeenFrom, LAST_SEEN_KEY } from "../shared/changelog";

/**
 * view-state-is-per-device-settings-are-per-host (2026-11-13, Paseo 0.16 plan #11). View state (the settings category,
 * settings folds, Home group folds, What's new "seen") lives in the device document `follow-up-view`; anything an agent
 * can set (Display, home_sort) stays host-scoped, where the worker and set_display reach it.
 */
const root = join(import.meta.dirname, "..");
const store = (seed: Record<string, string> = {}): KeyValue & { data: Map<string, string> } => {
  const data = new Map(Object.entries(seed));
  return { data, get: k => data.get(k) ?? null, set: (k, v) => { data.set(k, v); } };
};

test("view-state-is-per-device-settings-are-per-host: home_sort stays in the host-scoped Display document", async () => {
  const display = await readFile(join(root, "shared/display.ts"), "utf8");
  const def = display.slice(display.indexOf("export const displayPreferences = defineSettings({"));
  const head = def.slice(0, def.indexOf("schema:"));
  assert.match(head, /scope: "host"/, "Display (home_sort, set_display) is host-scoped");
  assert.match(def.slice(0, def.indexOf("})")), /home_sort/, "home_sort is a Display field");
  assert.ok(!isViewKey("home_sort") && !isViewKey("follow-up.home.sort"), "home_sort is never view state");
  // No device-scoped document anywhere may carry home_sort.
  for (const file of ["shared/display.ts", "client/view-store.ts", "shared/settings-nav.ts", "client/home-view.ts"]) {
    const src = await readFile(join(root, file), "utf8");
    for (const m of src.matchAll(/scope: "device"/g)) {
      const block = src.slice(m.index!, src.indexOf(")", m.index!));
      assert.doesNotMatch(block, /home_sort|sort/i, `${file}: a device-scoped document never holds the Home sort`);
    }
  }
});

test("view-state-is-per-device-settings-are-per-host: which keys are view state", () => {
  for (const key of [CATEGORY_KEY, collapseKey("reviewers"), homeFoldKey("quiet"), homeFoldKey("waiting"), LAST_SEEN_KEY]) assert.ok(isViewKey(key), key);
  for (const key of [homeFoldKey("needs"), "follow-up.home.sort", "follow-up.pending-answers", "other.key"]) assert.ok(!isViewKey(key), key);
});

test("Home folds: every group persists except Needs you, which always opens on mount; Quiet starts closed", () => {
  const s = store();
  assert.equal(homeGroupOpen("needs", s), true);
  assert.equal(homeGroupOpen("quiet", s), false, "Quiet: closed by default");
  assert.equal(homeGroupOpen("waiting", s), true, "other groups: open by default");
  writeHomeGroupOpen("needs", false, s);
  assert.equal(s.data.size, 0, "closing Needs you is never saved");
  assert.equal(homeGroupOpen("needs", store({ [homeFoldKey("needs")]: "0" })), true, "even a stale saved fold opens it");
  writeHomeGroupOpen("quiet", true, s); writeHomeGroupOpen("waiting", false, s);
  assert.equal(homeGroupOpen("quiet", s), true); assert.equal(homeGroupOpen("waiting", s), false);
});

test("Home folds: the list keeps Needs you in session state only", async () => {
  const list = await readFile(join(root, "client/home-list.tsx"), "utf8");
  assert.match(list, /const \[needsClosed, setNeedsClosed\] = useState\(false\)/, "Needs you opens on every mount");
  assert.match(list, /if \(key === "needs"\) setNeedsClosed/, "and its toggle never writes storage");
  assert.doesNotMatch(list, /new Set\(\["quiet"\]\)/, "Quiet's default comes from homeGroupOpen, not per-mount state");
});

test("no flash: before the document loads reads take the localStorage cache; then the document; writes reach both", () => {
  setDeviceBackend(null);
  writeCategory("reviewers");
  assert.equal(readCategory(), "reviewers", "first paint: the cached category, not the default");
  let renders = 0; const off = subscribeView(() => { renders++; });
  const before = viewSnapshot();
  const doc = documentBackend({ migrated: true, entries: { [CATEGORY_KEY]: "agents" } }, () => undefined);
  setDeviceBackend(doc);
  assert.equal(readCategory(), "agents", "the document wins once it loads");
  assert.ok(renders > 0 && viewSnapshot() !== before, "and readers re-render");
  const saved: unknown[] = [];
  setDeviceBackend(documentBackend({ migrated: true, entries: {} }, v => saved.push(v)));
  assert.equal(readCategory(), "reviewers", "a key the document lacks falls back to the cache");
  deviceStorage.set(CATEGORY_KEY, "display");
  assert.deepEqual(saved, [{ migrated: true, entries: { [CATEGORY_KEY]: "display" } }], "a write saves the document");
  setDeviceBackend(null);
  assert.equal(readCategory(), "display", "and the localStorage cache (kept one release)");
  off();
});

test("no flash: surfaces read view state on every render, not from per-mount state", async () => {
  const shell = await readFile(join(root, "client/settings-shell.tsx"), "utf8");
  const settings = await readFile(join(root, "client/settings.tsx"), "utf8");
  assert.match(shell, /useViewVersion\(\);\s*const open = readOpen\(id, defaultOpen\);/);
  assert.match(settings, /useViewSync\(\); useViewVersion\(\);\s*const category = readCategory\(\);/);
  assert.doesNotMatch(settings, /useState<SettingsCategory>/);
  for (const [file, mark] of [["client/home.tsx", "<ViewSync />"], ["client/panel.tsx", "<ViewSync />"], ["client/live.tsx", "<ViewSync />"]]) {
    assert.ok((await readFile(join(root, file), "utf8")).includes(mark), `${file} mounts the device document sync`);
  }
});

test("migration: seeds once from the localStorage cache, never overwrites a saved document, skips non-view keys", () => {
  const cache = store({ [CATEGORY_KEY]: "agents", [collapseKey("x")]: "0", [homeFoldKey("needs")]: "0", "follow-up.home.sort": "recent", other: "1" });
  const fresh = VIEW_SCHEMA.parse({});
  assert.deepEqual(fresh, { migrated: false, entries: {} });
  const first = seedValues(fresh, { keys: () => [...cache.data.keys()], get: k => cache.get(k) });
  assert.equal(first.changed, true);
  assert.deepEqual(first.values, { migrated: true, entries: { [CATEGORY_KEY]: "agents", [collapseKey("x")]: "0" } });
  const again = seedValues({ migrated: true, entries: { [CATEGORY_KEY]: "general" } }, { keys: () => [...cache.data.keys()], get: k => cache.get(k) });
  assert.deepEqual(again, { values: { migrated: true, entries: { [CATEGORY_KEY]: "general" } }, changed: false }, "a migrated document is left alone");
  const mixed = seedValues({ migrated: false, entries: { [CATEGORY_KEY]: "display" } }, { keys: () => [...cache.data.keys()], get: k => cache.get(k) });
  assert.equal(mixed.values.entries[CATEGORY_KEY], "display", "document entries win over the cache");
});

test("0.15 fallback: no defineSettings, or one that throws on device scope, means no device document", () => {
  assert.equal(viewDefinition(null), null, "no defineSettings");
  assert.equal(viewDefinition(() => { throw new Error("unknown scope device"); }), null);
  const def = viewDefinition((d: unknown) => d) as { id: string; scope: string };
  assert.equal(def.id, "follow-up-view"); assert.equal(def.scope, "device");
});

test("What's new seen: the device document on 0.16 (phone too), else localStorage, else the host; waits while loading", () => {
  const stored = () => "2.0.0";
  assert.equal(deviceSeenFrom({ status: "loading", local: true, stored, hostSeen: "1.9.0" }), undefined, "no decision while the document loads");
  assert.equal(deviceSeenFrom({ status: "ready", local: false, stored, hostSeen: "1.9.0" }), "2.0.0", "phone on 0.16: the device document");
  assert.equal(deviceSeenFrom({ status: "none", local: true, stored, hostSeen: "1.9.0" }), "2.0.0", "0.15 web: localStorage");
  assert.equal(deviceSeenFrom({ status: "none", local: false, stored, hostSeen: "1.9.0" }), "1.9.0", "0.15 phone: the host's record");
  assert.equal(deviceSeenFrom({ status: "failed", local: false, stored, hostSeen: "1.9.0" }), "1.9.0", "a failed load falls back too");
});
