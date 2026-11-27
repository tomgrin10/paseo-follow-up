import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { arrangeHome, DEFAULT_HOME_VIEW, parseHomeView, rowTitle, type HomeView } from "../shared/home-arrange";
import { listEntries } from "../shared/list-entries";
import { legacyProjectSort } from "../shared/display";
import { GROUP_TITLE, type HomeModel, type PaseoWorkspaceLite, type Workstream } from "../shared/home";
import { rowMenu } from "../shared/row-menu";

/**
 * sidebar-view-is-paseo-s-sidebar-plus-follow-up-s-line (invariant 144): Home and the sidebar view arrange rows with one
 * Display model, Paseo's pins are their Pinned section, and a host without pins draws none.
 */
const row = (id: string, group: Workstream["group"], project: string | null, extra: Partial<Workstream> = {}): Workstream =>
  ({ key: `ws:${id}`, agentId: null, workspaceId: id, title: `T ${id}`, agent: null, project, group, tier: null, icon: "Circle", tone: "muted", line: "", word: null, badges: [], pr: null, at: null, readyToArchive: false, sig: id, ...extra }) as Workstream;
const model = (rows: Workstream[]): HomeModel => {
  const groups = (["needs", "running", "waiting", "quiet"] as const).map(id => ({ id, title: GROUP_TITLE[id], items: rows.filter(r => r.group === id) })).filter(g => g.items.length);
  return { groups, needs: rows.filter(r => r.group === "needs").length, byKey: new Map(rows.map(r => [r.key, r])), hold: null, sort: "priority", rankedAt: null } as HomeModel;
};
const rows = [row("a", "needs", "acme/app"), row("b", "needs", "acme/api"), row("c", "running", "acme/app"), row("d", "waiting", "acme/api"), row("e", "quiet", "acme/app")];
const facts = (f: Record<string, Partial<PaseoWorkspaceLite>>) => (id: string) => f[id] ? { id, name: id, project: null, activityAt: null, ...f[id] } as PaseoWorkspaceLite : undefined;
const view = (patch: Partial<HomeView> = {}) => ({ ...DEFAULT_HOME_VIEW, ...patch });
const keys = (xs: Workstream[]) => xs.map(x => x.workspaceId);

test("Paseo's pins are Pinned: newest pin first, lifted out of their group, which still counts them", () => {
  const pins = facts({ a: { pinnedAt: "2026-11-01T00:00:00Z" }, c: { pinnedAt: "2026-11-02T00:00:00Z" }, b: { pinnedAt: null }, d: { pinnedAt: null }, e: { pinnedAt: null } });
  const out = arrangeHome(model(rows), view(), pins);
  assert.deepEqual(keys(out.pinned!), ["c", "a"]);
  const needs = out.sections.find(s => s.group === "needs")!;
  assert.deepEqual(keys(needs.items), ["b"], "a pinned row leaves Needs you…");
  assert.equal(needs.count, 2, "…and still counts in it");
  assert.ok(!out.sections.some(s => s.group === "running"), "a group whose rows were all pinned draws no header");
});

test("a host without pins (no pinnedAt on its descriptors) has no Pinned section; the Overseer stays on top", () => {
  const out = arrangeHome(model(rows), view(), facts({ a: {}, b: {} }));
  assert.equal(out.pinned, null);
  const entries = listEntries({ model: model(rows), closed: new Set(), openProjects: new Set(), pages: {}, briefLine: undefined, results: null, hits: null, filter: null, overseer: true, touch: false, afterNeeds: false, arranged: out });
  assert.equal(entries[0]!.type, "overseer");
  assert.ok(!entries.some(e => e.type === "section" && e.title === "Pinned"));
});

test("with pins, the Overseer is the first row of Pinned", () => {
  const out = arrangeHome(model(rows), view(), facts({ e: { pinnedAt: "2026-11-01T00:00:00Z" } }));
  const entries = listEntries({ model: model(rows), closed: new Set(), openProjects: new Set(), pages: {}, briefLine: undefined, results: null, hits: null, filter: null, overseer: true, touch: false, afterNeeds: false, arranged: out });
  assert.deepEqual(entries.slice(0, 3).map(e => e.key), ["h:pinned", "overseer", "ws:e"]);
});

test("Grouping › Project keeps the sort inside each project, projects in order of their first row; None is one list", () => {
  const byProject = arrangeHome(model(rows), view({ grouping: "project" }), facts({}));
  assert.deepEqual(byProject.sections.map(s => [s.title, keys(s.items)]), [["acme/app", ["a", "c", "e"]], ["acme/api", ["b", "d"]]]);
  const flat = arrangeHome(model(rows), view({ grouping: "none" }), facts({}));
  assert.deepEqual(flat.sections.map(s => keys(s.items)), [["a", "b", "c", "d", "e"]]);
  const entries = listEntries({ model: model(rows), closed: new Set(["project:acme/api"]), openProjects: new Set(), pages: {}, briefLine: undefined, results: null, hits: null, filter: null, overseer: false, touch: false, afterNeeds: false, arranged: byProject });
  assert.deepEqual(entries.map(e => e.key), ["h:project:acme/app", "ws:a", "ws:c", "ws:e", "h:project:acme/api"], "a folded project shows its header only");
});

test("Project and Labels filters and Show background narrow both lists; an emptied list says the filters did it", () => {
  const f = facts({ a: { labels: ["bug"] }, b: { labels: ["docs"] }, c: { background: true }, d: {}, e: {} });
  const out = arrangeHome(model(rows), view({ projects: ["acme/app"] }), f);
  assert.deepEqual(out.sections.flatMap(s => keys(s.items)), ["a", "e"], "c is a background workspace");
  assert.deepEqual(out.projects, ["acme/api", "acme/app"], "the Project page lists every project, not just the filtered ones");
  assert.deepEqual(keys(arrangeHome(model(rows), view({ labels: ["docs"] }), f).sections.flatMap(s => s.items)), ["b"]);
  assert.ok(arrangeHome(model(rows), view({ show_background: true }), f).sections.some(s => s.items.some(i => i.workspaceId === "c")));
  const none = arrangeHome(model(rows), view({ labels: ["nope"] }), f);
  const entries = listEntries({ model: model(rows), closed: new Set(), openProjects: new Set(), pages: {}, briefLine: undefined, results: null, hits: null, filter: null, overseer: false, touch: false, afterNeeds: false, arranged: none });
  assert.deepEqual(entries.map(e => e.key), ["l:filtered"]);
});

test("the status strip's one-group filter and a search ignore the arrangement", () => {
  const out = arrangeHome(model(rows), view({ grouping: "project" }), facts({ a: { pinnedAt: "2026-11-01T00:00:00Z" } }));
  const entries = listEntries({ model: model(rows), closed: new Set(), openProjects: new Set(), pages: {}, briefLine: undefined, results: null, hits: null, filter: "needs", overseer: true, touch: false, afterNeeds: false, arranged: out });
  assert.deepEqual(entries.map(e => e.key), ["h:needs", "ws:a", "ws:b"]);
});

test("Title › Branch name shows the branch, the title when there is none", () => {
  const f = facts({ a: { branch: "feat/login" }, b: { branch: null } });
  assert.equal(rowTitle(rows[0]!, view({ title: "branch" }), f), "feat/login");
  assert.equal(rowTitle(rows[1]!, view({ title: "branch" }), f), "T b");
  assert.equal(rowTitle(rows[0]!, view(), f), "T a");
});

test("a saved By project sort becomes Grouping › Project with Priority; a bad saved view falls back to the defaults", () => {
  assert.deepEqual(legacyProjectSort({ home_sort: "project" }), { home_sort: "priority", home_view: { ...DEFAULT_HOME_VIEW, grouping: "project" } });
  assert.equal(legacyProjectSort({ home_sort: "recent" }), null);
  assert.deepEqual(parseHomeView({ grouping: "loudest" }), DEFAULT_HOME_VIEW);
  assert.deepEqual(parseHomeView({ show: { branch: true } }).show, { ...DEFAULT_HOME_VIEW.show, branch: true });
});

test("Pin to top and Unpin are in the row menu only where the host has pins", () => {
  const s = rows[0]!;
  const items = (pinnedAt?: string | null) => rowMenu({ s, flagged: false, ...(pinnedAt !== undefined ? { pinnedAt } : {}) }).flatMap(x => x.items).map(i => i.label);
  assert.ok(items(null).includes("Pin to top"));
  assert.ok(items("2026-11-01T00:00:00Z").includes("Unpin"));
  assert.ok(!items().some(l => /^(Pin to top|Unpin)$/.test(l)), "no pins on this host, no item");
});

test("the sidebar view and Home both draw the arrangement and the Display menu, not a sort menu of their own", async () => {
  for (const f of ["client/sidebar-view.tsx", "client/home.tsx"]) {
    const src = await readFile(join(import.meta.dirname, "..", f), "utf8");
    assert.match(src, /useArranged\(/, `${f} arranges its list`);
    assert.match(src, /arranged=\{arranged\}/, `${f} hands the arrangement to HomeList`);
    assert.match(src, /<DisplayMenu /, `${f} has the Display menu`);
    assert.doesNotMatch(src, /<SortMenu/, `${f}: one menu for both`);
  }
});

test("a sidebar row is three lines at most: title and time, Follow-up's line cut with an ellipsis, Paseo's meta line", async () => {
  const src = await readFile(join(import.meta.dirname, "..", "client/home-list.tsx"), "utf8");
  const dense = src.slice(src.indexOf(": dense ? <View"), src.indexOf("<MetaLine s={s} d={detail}", src.indexOf(": dense ? <View")));
  assert.ok(dense.length > 0, "the dense row is found");
  assert.equal((dense.match(/numberOfLines=\{(\d)\}/g) ?? []).filter(m => m !== "numberOfLines={1}").length, 0, "every dense line is one line");
  assert.match(dense, /!detail && !!why && <PriorityLine/, "the reason line gives way to the meta line");
});
