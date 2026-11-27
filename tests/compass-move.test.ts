// one-place-for-priority-inputs (AGENTS.md invariant 108). Everything AI priority reads is an input in one list
// (Settings → Compass, or set_compass); there is no second setting for the same input, and the move from the Morning
// brief tab carries every setting over once, losing nothing (invariant 7). Plans come from Compass on arrival. Fake
// mcpproxy and a fake model; fictional people only (Dana, Avi, acme).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiJobs } from "../server/ai-jobs";
import { CompassStore } from "../server/compass";
import { MorningBriefStore } from "../server/morning-brief";
import { RPC_TOOLS } from "../server/agent-parity";
import { SETTINGS_CATEGORIES } from "../shared/settings-nav";
import { emptyCompass, type CompassSettings } from "../shared/compass";
import { compassSetSchema, matchPlan, moveToCompass, planSettingsSchema, type PlanSettings } from "../shared/morning-brief";
import { inputLabel, inputRole } from "../shared/brief-sources";
import { rm, testStore } from "./support/store-temp-dir";
import { AVI, CHAT_TOOLS, DANA, DEV, fakeMcpproxy, fakeModel, testCompass, historyText, type Msg } from "./support/compass-fakes";

const NOW = Date.parse("2026-11-24T09:00:00Z");
const ids = () => { let n = 0; return () => `s-moved${++n}`; };
const findItForMe = (o: Partial<PlanSettings> = {}): PlanSettings => ({ ...planSettingsSchema.parse({}), mode: "compass", person: { id: DANA, name: "Dana" }, channels: [{ id: "C0ROADMAP", name: "roadmap" }], ...o });

test("the move: Find it for me's person and channels become one Compass source that posts the plan, in their DM and those channels", () => {
  const r = moveToCompass(findItForMe(), emptyCompass(), { now: NOW, newId: ids() });
  assert.equal(r.moved, true);
  assert.deepEqual(r.plan.person, null); assert.deepEqual(r.plan.channels, []); assert.deepEqual(r.plan.unmoved, []);
  assert.equal(r.plan.movedAt, new Date(NOW).toISOString());
  const [s] = r.compass.sources;
  assert.deepEqual([s.label, s.roles, s.enable_needs_you, s.places.map(p => p.kind === "conversation" ? `${p.sub}:${p.id}` : p.id)],
    ["Dana · plan", ["priorities", "plan"], true, [`dm:${DANA}`, "channel:C0ROADMAP"]]);
});

test("the move: the same person already a source gains the plan role and the places it lacks, listed once", () => {
  const before: CompassSettings = { ...emptyCompass(), sources: [{ id: "s-dana01", label: "Dana · product", who: { kind: "person", person: { id: DANA, name: "Dana" } }, places: [{ kind: "conversation", sub: "dm", id: DANA, name: "Dana" }], roles: ["priorities"], instructions: "P0 means today.", enable_needs_you: true, enabled: true, addedBy: "developer", addedAt: null }] };
  const r = moveToCompass(findItForMe(), before, { now: NOW, newId: ids() });
  assert.equal(r.compass.sources.length, 1, "no second source for the same person");
  const [s] = r.compass.sources;
  assert.deepEqual(s.roles, ["priorities", "plan"]);
  assert.deepEqual(s.places.map(p => p.id), [DANA, "C0ROADMAP"]);
  assert.equal(s.instructions, "P0 means today.", "the developer's words stay");
});

test("the move loses nothing: a name the chat search finds gets its id; one it can't stays, by name, for Settings to show", () => {
  const plan = findItForMe({ person: { id: null, name: "Dana" }, channels: [{ id: null, name: "roadmap" }, { id: null, name: "ghost" }] });
  const r = moveToCompass(plan, emptyCompass(), { now: NOW, newId: ids(), resolve: new Map([["@dana", DANA], ["#roadmap", "C0ROADMAP"]]) });
  assert.equal(r.moved, true);
  assert.deepEqual(r.compass.sources[0].places.map(p => p.id), [DANA, "C0ROADMAP"]);
  assert.deepEqual(r.plan.unmoved, ["#ghost"]);
  // No one to read: nothing becomes a source that reads everyone; the names stay.
  const nobody = moveToCompass(findItForMe({ person: { id: null, name: "Dana" } }), emptyCompass(), { now: NOW, newId: ids() });
  assert.equal(nobody.moved, false);
  assert.deepEqual(nobody.compass.sources, []);
  assert.deepEqual(nobody.plan.unmoved, ["@Dana", "#roadmap"]);
  // Compass full: the move waits by name rather than drop a source.
  const full: CompassSettings = { ...emptyCompass(), sources: Array.from({ length: 8 }, (_, i) => ({ id: `s-full0${i}`, label: `S${i}`, who: { kind: "me" as const }, places: [{ kind: "conversation" as const, sub: "channel" as const, id: `C0FULL0${i}`, name: `f${i}` }], roles: ["self" as const], instructions: "", enable_needs_you: true, enabled: true, addedBy: "developer", addedAt: null })) };
  const capped = moveToCompass(findItForMe(), full, { now: NOW, newId: ids() });
  assert.equal(capped.compass.sources.length, 8);
  assert.deepEqual(capped.plan.unmoved, ["@Dana", "#roadmap"]);
  // Nothing to move: only the mark.
  const empty = moveToCompass(planSettingsSchema.parse({}), emptyCompass(), { now: NOW, newId: ids() });
  assert.deepEqual([empty.moved, empty.compass.sources.length, !!empty.plan.movedAt], [false, 0, true]);
});

test("plans come from Compass on arrival: a plan source's newest claude.ai artifact goes to the brief as it is read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "compass-move-"));
  try {
    const msgs: Msg[] = [
      { by: DANA, name: "Dana", at: "2026-11-22T10:00:00Z", text: "old plan https://claude.ai/artifact/aaaa-last-week" },
      { by: DANA, name: "Dana", at: "2026-11-23T18:05:00Z", text: "This week's plan: <https://claude.ai/artifact/bbbb-this-week?share=K|roadmap>" },
      { by: AVI, name: "Avi", at: "2026-11-23T18:06:00Z", text: "mine https://claude.ai/artifact/cccc-not-a-plan" },
      { by: DEV, name: "Me", at: "2026-11-23T18:07:00Z", text: "thanks" },
    ];
    const mcp = fakeMcpproxy({ tools: CHAT_TOOLS(), answer: () => historyText(msgs) });
    const model = fakeModel(() => ({ notes: [], retracts: [], nothing: true }));
    const plans: unknown[] = [];
    const store = testStore(CompassStore, dir);
    const compass = testCompass(dir, {
      settings: testStore(MorningBriefStore, dir), store, tools: mcp.tools, jobs: new AiJobs({ runner: model.runner, logPath: join(dir, "ai-jobs.jsonl") }),
      role: async () => ({ provider: "claude", model: "haiku", thinking: null, label: "Claude" }),
      clock: async () => ({ timeZone: "UTC", workdays: ["Mon", "Tue", "Wed", "Thu", "Fri"] }), sweepAt: async () => "08:00",
      index: async () => ({ workspaces: [], issueWorkspace: () => null }), now: () => NOW, newId: ids(),
      onPlan: async f => { plans.push(f); return true; },
    });
    await compass.set({ source: { label: "Dana · product", who: { kind: "person", person: { id: DANA, name: "Dana" } }, places: [{ kind: "conversation", sub: "dm", id: DANA, name: "Dana" }], roles: ["priorities"] } }, "developer");
    await compass.read("manual");
    assert.deepEqual(plans, [], "a source without Posts the plan brings no plan");
    await compass.set({ source: { id: "s-moved1", roles: ["priorities", "plan"] } }, "developer");
    await store.mutate(f => { f.cursors = {}; });
    await compass.read("manual", { plans: true });
    assert.deepEqual(plans, [{ url: "https://claude.ai/artifact/bbbb-this-week", postedAt: "2026-11-23T18:05:00.000Z", where: "their DM", source: "s-moved1" }],
      "the newest of the source's own links, no share key; another person's link is not the plan");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("plan items are matched to issues and workspaces: an item with no key has no issue", () => {
  const m = matchPlan([{ title: "Invoice export", keys: ["acme-12"] }, { title: "SSO", keys: ["ACME-40"] }, { title: "Pricing page" }], k => k === "ACME-12" ? "ws-invoice" : null);
  assert.deepEqual(m.items, [{ title: "Invoice export", issue: "ACME-12", workspace: "ws-invoice" }, { title: "SSO", issue: "ACME-40", workspace: null }, { title: "Pricing page", issue: null, workspace: null }]);
  assert.equal(m.withoutIssue, 1);
});

test("one place: Settings has one Compass tab and no Morning brief tab; set_compass takes every input; the brief's tools are aliases", async () => {
  const brief = SETTINGS_CATEGORIES.find(c => c.id === "brief")!;
  assert.equal(brief.title, "Compass", "the old id, so saved links land here");
  assert.ok(!SETTINGS_CATEGORIES.some(c => /morning brief/i.test(c.title)));
  const set = RPC_TOOLS.find(t => t.name === "set_compass")!;
  assert.equal(set.kind, "planned");
  for (const change of [{ plan: { mode: "link", link: "https://claude.ai/artifact/x" } }, { inputs: { on: { gh: false } } }, { queue: { states: ["triage"], chatHours: 24, calendarDays: 2 } }])
    assert.ok(compassSetSchema.safeParse(change).success && set.input.safeParse({ ...change, confirm: false }).success, JSON.stringify(change));
  assert.equal(compassSetSchema.safeParse({ queue: { sweepAt: "07:00" } }).success, false, "the brief's own time stays with set_brief_settings");
  const mcp = await readFile("server/mcp.mjs", "utf8");
  for (const alias of ["brief_plan", "set_brief_plan", "brief_sources", "set_brief_sources", "brief_chat_search"]) assert.match(mcp, new RegExp(`\\["${alias}", "Alias of `), alias);
  // No second editor: the client no longer picks who posts the plan (that's a source), and nothing in it calls the old chat picker.
  for (const f of (await readdir("client")).filter(f => f.endsWith(".tsx"))) {
    const src = await readFile(join("client", f), "utf8");
    assert.doesNotMatch(src, /briefChatSearchRpc|Find it for me/, f);
  }
});

test("every built-in input is listed with a role", () => {
  const rows = [{ id: "mcp:a", recipe: "linear" as const, kind: "recipe" as const, label: "Linear" }, { id: "mcp:b", recipe: "chat" as const, kind: "recipe" as const, label: "Chat" }, { id: "gh", recipe: null, kind: "builtin" as const, label: "GitHub" }];
  assert.deepEqual(rows.map(r => [inputLabel(r), inputRole(r)]), [["Your Linear queue", "Sets your priorities"], ["Your DMs and mentions", "Background"], ["Review requests", "Sets your priorities"]]);
});
