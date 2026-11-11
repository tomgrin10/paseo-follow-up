import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { findSvgIconProblem, PLUGIN_SVG_ICON_MAX_BYTES } from "@getpaseo/plugin";
import { emptyLinkedFile, emptyWorkspaceLinks, linkedSearchIndex, linkedView, upsertItem, type LinkedViewItem } from "../shared/linked";
import { CHIP_MAX, FOLD_SHOW, LINKED_EMPTY, linkedChip, linkedGroups, linkedRow, linkedSearchText, linkedSpec, pasteToAdd, referencesShown } from "../shared/linked-display";
import { LIMITS } from "../shared/linked";
import { homeSearchDocs, indexDocs, search } from "../shared/search";
import { PARITY } from "../server/agent-parity";
import { BRAND_ICONS } from "../client/brand-icons";
import type { HomeModel } from "../shared/home";

/** Linked items PR 3 (design §5): the chip, the sheet's groups and paste-to-add, row copy, and Home's search. */

const T0 = Date.parse("2026-11-01T10:00:00Z");
let n = 0;
function item(over: Partial<LinkedViewItem> & Pick<LinkedViewItem, "key" | "kind">): LinkedViewItem {
  const at = new Date(T0 + (n++) * 60_000).toISOString();
  return { url: null, title: null, status: null, statusTone: null, origin: "registered", by: null, why: null, firstSeen: at, lastSeen: at, checkedAt: null, spec: false, ...over };
}

test("chip: kinds in the fixed order, counts, and nothing when there's nothing", () => {
  assert.equal(linkedChip({}, 4), null);
  assert.equal(linkedChip(undefined, 4), null);
  const m = linkedChip({ artifact: 1, slack: 2, linear: 6 }, CHIP_MAX.desktop)!;
  assert.deepEqual(m.parts, [{ kind: "linear", count: 6 }, { kind: "slack", count: 2 }, { kind: "artifact", count: 1 }]);
  assert.equal(m.more, 0);
  assert.equal(m.tooltip, "6 Linear issues · 2 Slack threads · 1 artifact");
  assert.equal(m.label, "Linked: 6 Linear issues, 2 Slack threads, 1 artifact. Opens the list.");
});

test("chip: past the cap the rest fold into +N, N being the hidden items, and the label spells them out", () => {
  const counts = { link: 1, doc: 1, linear: 3, slack: 1, artifact: 2, issue: 4 };
  const desk = linkedChip(counts, CHIP_MAX.desktop)!;
  assert.deepEqual(desk.parts.map(p => p.kind), ["linear", "slack", "artifact", "doc"]);
  assert.equal(desk.more, 5);
  assert.equal(desk.total, 12);
  assert.match(desk.label, /and 5 more: 4 GitHub issues, 1 link\. Opens the list\.$/);
  const phone = linkedChip(counts, CHIP_MAX.phone)!;
  assert.deepEqual(phone.parts.map(p => p.kind), ["linear", "slack", "artifact"]);
  assert.equal(phone.more, 6);
});

test("chip counts come from the view: done and cancelled count, the spec, PRs and candidates don't", () => {
  const ws = emptyWorkspaceLinks();
  upsertItem(ws, { key: "HER-1", kind: "linear", url: null, origin: "registered", status: "Done", statusTone: "done" }, T0);
  upsertItem(ws, { key: "HER-2", kind: "linear", url: null, origin: "registered", status: "Canceled", statusTone: "cancelled" }, T0);
  upsertItem(ws, { key: "HER-3", kind: "linear", url: null, origin: "registered" }, T0);
  ws.candidates.push({ key: "HER-9", seen: 1, firstSeen: new Date(T0).toISOString(), retryAt: null, failures: 0, strong: true });
  const spec = "https://claude.ai/code/artifact/spec-1";
  const view = linkedView("w1", ws, { spec: { url: spec, title: "Spec" }, artifacts: [{ url: spec, title: "Spec", firstAt: null, lastAt: null, by: null }, { url: "https://github.com/o/r/pull/5", title: "PR", firstAt: null, lastAt: null, by: null }] });
  assert.deepEqual(linkedChip(view.counts, 4)!.parts, [{ kind: "linear", count: 3 }]);
  assert.ok(view.items.some(i => i.spec), "the spec is still listed in the sheet");
});

test("references line: hidden with no spec and nothing linked, shown for either", () => {
  assert.equal(referencesShown(null, {}), false);
  assert.equal(referencesShown(undefined, undefined), false);
  assert.equal(referencesShown(null, { linear: 0 }), false);
  assert.equal(referencesShown("https://claude.ai/code/artifact/x", {}), true);
  assert.equal(referencesShown(null, { slack: 1 }), true);
});

test("groups: chip order, open first and newest first, done folded; the spec stands alone, so every head equals its rows", () => {
  const items = [
    item({ key: "slack:C1/1730000000.000100", kind: "slack", title: "#eng-identity" }),
    item({ key: "HER-1", kind: "linear", statusTone: "done", status: "Done" }),
    item({ key: "HER-2", kind: "linear", statusTone: "active", status: "In Progress" }),
    item({ key: "HER-3", kind: "linear", statusTone: "cancelled", status: "Canceled" }),
    item({ key: "HER-4", kind: "linear", statusTone: "todo", status: "Todo" }),
    item({ key: "https://claude.ai/code/artifact/spec", kind: "artifact", spec: true, origin: "spec" }),
    item({ key: "https://claude.ai/code/artifact/other", kind: "artifact", origin: "published" }),
  ];
  const g = linkedGroups(items);
  assert.deepEqual(g.map(x => x.kind), ["linear", "slack", "artifact"]);
  assert.deepEqual(g[0].rows.map(i => i.key), ["HER-4", "HER-2"]);
  assert.deepEqual(g[0].done.map(i => i.key), ["HER-3", "HER-1"]);
  assert.equal(g[0].count, 4);
  // The spec isn't counted (the chip leaves it out), so it isn't a row under a head either: a head says 1 above 1 row.
  assert.deepEqual(g[2].rows.map(i => i.key), ["https://claude.ai/code/artifact/other"]);
  for (const x of g) assert.equal(x.count, x.rows.length + x.moreOpen + x.done.length, `${x.head}: the head counts exactly its rows`);
  assert.equal(linkedSpec(items)?.key, "https://claude.ai/code/artifact/spec");
  assert.equal(linkedSpec(items, "spec")?.spec, true, "the filter finds it by 'spec'");
  assert.equal(linkedSpec(items, "slack"), null);
  assert.equal(linkedSpec(items.filter(i => !i.spec)), null);
});

test("groups: more than 10 open rows show 8 plus Show N more; 10 or fewer never fold", () => {
  const many = (k: number) => Array.from({ length: k }, (_, i) => item({ key: `HER-${100 + i}`, kind: "linear" }));
  const eleven = linkedGroups(many(11))[0];
  assert.equal(eleven.rows.length, FOLD_SHOW);
  assert.equal(eleven.moreOpen, 3);
  assert.equal(linkedGroups(many(10))[0].moreOpen, 0);
  assert.equal(linkedGroups(many(10))[0].rows.length, 10);
  const open = linkedGroups(many(11), { expanded: new Set(["linear"]) })[0];
  assert.equal(open.rows.length, 11);
  assert.equal(open.moreOpen, 0);
});

test("groups: the filter matches key, title and why, and shows done matches unfolded", () => {
  const items = [
    item({ key: "HER-1312", kind: "linear", title: "Okta SCIM sync drops nested groups", statusTone: "done" }),
    item({ key: "HER-1290", kind: "linear", title: "Retry budget", why: "split out of the SCIM work" }),
    item({ key: "slack:C1/1730000000.000100", kind: "slack", title: "#cs-escalations" }),
  ];
  assert.deepEqual(linkedGroups(items, { query: "scim" }).flatMap(g => g.rows.map(i => i.key)), ["HER-1290", "HER-1312"]);
  assert.deepEqual(linkedGroups(items, { query: "her-1312" })[0].done, []);
  assert.deepEqual(linkedGroups(items, { query: "nothing like it" }), []);
});

test("paste to add: a new key or URL is an Add row, a known one filters, a PR is refused, words are a filter", () => {
  const items = [item({ key: "HER-1312", kind: "linear" })];
  assert.deepEqual(pasteToAdd("her-1388", items), { action: "add", ref: "her-1388", key: "HER-1388", kind: "linear", label: "HER-1388", hint: "Linear issue · checked with Linear" });
  assert.equal(pasteToAdd("HER-1312", items), null, "already linked: the filter shows it");
  assert.equal(pasteToAdd("okta sync", items), null);
  assert.equal(pasteToAdd("", items), null);
  const pr = pasteToAdd("https://github.com/acme/app/pull/1402", items)!;
  assert.equal(pr.action, "refuse");
  const slack = pasteToAdd("https://acme.slack.com/archives/C0123ABCD/p1730000000000100", items)!;
  assert.equal(slack.action === "add" && slack.kind, "slack");
  // Generic URLs count only when linked explicitly, and pasting one is explicit.
  const generic = pasteToAdd("https://example.com/runbooks/scim", items)!;
  assert.equal(generic.action === "add" && generic.kind, "link");
  assert.equal(generic.action === "add" && generic.label, "example.com › scim");
});

test("paste to add: at the cap there's no Add row, only the reason, and the spec doesn't count toward it", () => {
  const full = Array.from({ length: LIMITS.items }, (_, i) => item({ key: `HER-${2000 + i}`, kind: "linear" }));
  const refused = pasteToAdd("https://example.com/runbooks/retention", full)!;
  assert.equal(refused.action, "refuse");
  assert.match(refused.action === "refuse" ? refused.message : "", /50 linked\. Remove one/);
  assert.equal(pasteToAdd("HER-2000", full), null, "a known key still just filters at the cap");
  const withSpec = [...full.slice(1), item({ key: "https://claude.ai/code/artifact/spec", kind: "artifact", spec: true, origin: "spec" })];
  assert.equal(pasteToAdd("HER-9", withSpec)?.action, "add", "49 items plus the spec: room for one more");
});

test("rows: who linked it and why, Linear state glyphs, brand marks, no personal names", () => {
  const main = "agent-main";
  const lin = linkedRow(item({ key: "HER-1312", kind: "linear", title: "Okta SCIM sync drops nested groups", status: "In Progress", statusTone: "active", by: main, why: "started from this" }), main);
  assert.deepEqual([lin.lead, lin.title, lin.meta, lin.glyph], ["HER-1312", "Okta SCIM sync drops nested groups", "In Progress · main agent: started from this", { type: "state", tone: "active" }]);
  assert.equal(linkedRow(item({ key: "HER-1", kind: "linear", origin: "manual", by: "developer" }), main).meta, "Added by you");
  assert.equal(linkedRow(item({ key: "HER-2", kind: "linear", by: "agent-other" }), main).meta, "Linked by another agent");
  const slack = linkedRow(item({ key: "slack:C1/1730592000.000100", kind: "slack", title: "#eng-identity", origin: "extracted" }), main);
  assert.equal(slack.meta, "Thread from Nov 3 · seen in this workspace's work");
  assert.deepEqual(slack.glyph, { type: "brand", icon: "slack" });
  assert.deepEqual(linkedRow(item({ key: "https://www.notion.so/acme/Plan-1", kind: "doc", url: "https://www.notion.so/acme/Plan-1" }), main).glyph, { type: "brand", icon: "notion" });
  assert.deepEqual(linkedRow(item({ key: "https://docs.google.com/document/d/1/edit", kind: "doc", url: "https://docs.google.com/document/d/1/edit" }), main).glyph, { type: "brand", icon: "googleDocs" });
  assert.deepEqual(linkedRow(item({ key: "https://acme.dev/x", kind: "doc", url: "https://acme.dev/x" }), main).glyph, { type: "lucide", name: "File" });
  const spec = linkedRow(item({ key: "https://claude.ai/code/artifact/s", kind: "artifact", spec: true, origin: "spec", title: "Plan" }), main);
  assert.equal(spec.spec, true);
  assert.equal(spec.meta, "This workspace's spec");
  for (const copy of [LINKED_EMPTY, lin.meta, slack.meta]) assert.doesNotMatch(copy, /\bTom\b/);
});

test("Home search: a linked key or title finds the workspace and says why on the second line", () => {
  const model = { groups: [{ id: "working", items: [{ key: "ws:w1", workspaceId: "w1", title: "Vendor sync", agent: null, at: null, activityAt: null, project: null, line: null }] }], byKey: new Map() } as unknown as HomeModel;
  const linked = { w1: [{ key: "HER-1312", kind: "linear" as const, title: "Vendor sync drops SCIM groups" }, { key: "slack:C1/1.2", kind: "slack" as const, title: null }] };
  const index = indexDocs(homeSearchDocs({ model, paseo: [], tracked: [], linked }));
  const [hit] = search(index, "HER-1312");
  assert.equal(hit?.key, "ws:w1");
  assert.equal(hit.via?.field, "linked");
  assert.equal(hit.via?.text, "HER-1312 Vendor sync drops SCIM groups");
  assert.equal(search(index, "slack").length, 0, "a Slack id with no title is never searchable or shown");
  assert.equal(search(indexDocs(homeSearchDocs({ model, paseo: [], tracked: [] })), "HER-1312").length, 0, "without the index nothing matches");
  assert.equal(linkedSearchText({ key: "https://example.com/a/b", kind: "link", title: null }), "example.com › b");
});

test("Home search: a key matches exactly; numbers never match by a one-digit typo", () => {
  const row = (id: string, title: string) => ({ key: `ws:${id}`, workspaceId: id, title, agent: null, at: null, activityAt: null, project: null, line: null });
  const model = { groups: [{ id: "working", items: [row("w1", "Vendor sync"), row("w2", "CSV export for vendor risk scores")] }], byKey: new Map() } as unknown as HomeModel;
  const linked = { w1: [{ key: "HER-1312", kind: "linear" as const, title: "Okta SCIM sync drops nested groups" }], w2: [{ key: "HER-1352", kind: "linear" as const, title: "CSV columns" }] };
  const index = indexDocs(homeSearchDocs({ model, paseo: [], tracked: [], linked }));
  assert.deepEqual(search(index, "HER-1312").map(h => h.key), ["ws:w1"], "HER-1352 is a different issue");
  assert.deepEqual(search(index, "her-13").map(h => h.key).sort(), ["ws:w1", "ws:w2"], "a prefix still finds both while typing");
  assert.deepEqual(search(index, "vendr").map(h => h.key).sort(), ["ws:w1", "ws:w2"], "words keep their typo tolerance");
});

test("Home search index: stored items only, per workspace, from one read", () => {
  const file = emptyLinkedFile();
  file.workspaces.w1 = emptyWorkspaceLinks();
  upsertItem(file.workspaces.w1, { key: "HER-7", kind: "linear", url: null, title: "Seven", origin: "registered" }, T0);
  file.workspaces.w2 = emptyWorkspaceLinks();
  assert.deepEqual(linkedSearchIndex(file), { w1: [{ key: "HER-7", kind: "linear", title: "Seven" }] });
});

test("brand marks are valid inline SVG for the host Icon and well under the size cap", () => {
  for (const [name, icon] of Object.entries(BRAND_ICONS)) {
    assert.equal(findSvgIconProblem(icon.svg), null, name);
    assert.ok(new TextEncoder().encode(icon.svg).byteLength < PLUGIN_SVG_ICON_MAX_BYTES / 16, `${name} is small`);
    assert.match(icon.svg, /fill="currentColor"/, `${name} takes the host colour`);
  }
  assert.deepEqual(Object.keys(BRAND_ICONS).sort(), ["claude", "github", "googleDocs", "linear", "notion", "slack"]);
});

test("parity: the client's linked RPCs map to the agent tools", () => {
  assert.deepEqual(PARITY["follow.linked-items"], { tools: ["link_items"] });
  assert.deepEqual(PARITY["follow.set-linked-items"], { tools: ["set_linked_items", "link_item", "unlink_item"] });
  assert.ok("tools" in PARITY["follow.linked-index"]);
});

test("placement: the Spec chip left the title row for the references line, on phones too (never the 44px bar)", async () => {
  const header = await readFile("client/header.tsx", "utf8");
  assert.doesNotMatch(header, /<SpecChip/, "the header no longer draws SpecChip itself");
  assert.doesNotMatch(header.slice(header.indexOf("const controls"), header.indexOf("const tail")), /ReferencesLine/, "nothing but icons in the bar's controls");
  assert.equal(header.match(/<ReferencesLine /g)?.length, 2, "the phone panel and the desktop header each draw the line once");
  const home = await readFile("client/home.tsx", "utf8");
  assert.match(home, /<ReferencesLine/, "Home's detail pane shows the same line");
  const panel = await readFile("client/panel.tsx", "utf8");
  assert.match(panel, /<SpecRow[^\n]*\/>\n\s*<LinkedItemsRow/, "the Linked items row sits under the spec row");
});
