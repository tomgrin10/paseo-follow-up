// Compass PR 4: suggestions, the brief and the daytime read (docs/compass.md, AGENTS.md invariants 78, 86, 91, 95).
// - nobody-s-on-it-is-needs-you (86 amended): a raised issue and an urgent Compass ask about an issue with no workspace
//   are one Needs-you row kind, one row per issue, one Remove, one count.
// - The rest sort first in New's My issues with their reason; `{why}` carries the quote (91); a taken issue is never a
//   suggestion (95).
// - The brief's one Since block says what Compass heard; the daytime read runs only while the app is open (78).
// Fake mcpproxy and model; fictional people only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiJobs } from "../server/ai-jobs";
import { CompassStore } from "../server/compass";
import { MorningBriefStore } from "../server/morning-brief";
import { rm, testStore } from "./support/store-temp-dir";
import { CHAT_TOOLS, DANA, fakeMcpproxy, fakeModel, testCompass, historyText } from "./support/compass-fakes";
import { compassSettingsSchema, type CompassChange, type CompassNote } from "../shared/compass";
import { compassSince, heardWords, nobodyNeeds, nobodyRow, suggestions, whyText, workdaysUntil } from "../shared/nobody";
import { sinceBlock } from "../shared/brief-since";
import { PLACEHOLDERS, builtinAction, currentBuiltin, renderAction } from "../shared/dispatch";
import { newRows } from "../shared/new-view";

const NOW = Date.parse("2026-11-24T09:00:00Z"); // a Tuesday
const CLOCK = { timeZone: "UTC", workdays: ["Mon", "Tue", "Wed", "Thu", "Fri"] as const };
const SOURCE = { id: "s-dana1", label: "Dana · product", who: { kind: "person", person: { id: DANA, name: "Dana" } }, places: [{ kind: "conversation", sub: "dm", id: DANA, name: "Dana" }], roles: ["priorities"], enable_needs_you: true };
const settingsWith = (over: Record<string, unknown> = {}, source: Record<string, unknown> = {}) => compassSettingsSchema.parse({ sources: [{ ...SOURCE, ...source }], ...over });

function note(over: Partial<CompassNote> = {}): CompassNote {
  return {
    id: "n-1", source: "s-dana1", place: `conversation:${DANA}`, role: "priorities", by: { id: DANA, name: "Dana" }, at: "2026-11-24T08:00:00.000Z", link: "https://chat.example/p1",
    quote: "ACME-18 has to be ready for the renewal call", what: "renewal call", keys: ["ACME-18"], kind: "issue", strength: "high", until: "2026-11-26", untilWords: "Thursday",
    state: "live", endedAt: null, supersededBy: null, match: { issue: "ACME-18", score: 1, how: "key" }, restatedAt: "2026-11-24T08:00:00.000Z", ...over,
  };
}
const ctx = (over: Partial<Parameters<typeof suggestions>[2]> = {}) => ({ now: NOW, clock: CLOCK, taken: () => false, removed: new Set<string>(), ...over });

test("a strong ask due within the workdays, from a source with Needs you on, is urgent; anything weaker sorts into New", () => {
  assert.equal(workdaysUntil("2026-11-24", NOW, CLOCK), 0);
  assert.equal(workdaysUntil("2026-11-26", NOW, CLOCK), 2, "Wed and Thu");
  assert.equal(workdaysUntil("2026-12-01", NOW, CLOCK), 5, "the weekend doesn't count");
  const urgent = suggestions([note()], settingsWith(), ctx());
  assert.equal(urgent.length, 1);
  assert.equal(urgent[0].urgent, true);
  assert.equal(urgent[0].reason, "Dana: renewal call Thu");
  assert.equal(urgent[0].source, "Dana · product");

  assert.equal(suggestions([note({ strength: "normal" })], settingsWith(), ctx())[0].urgent, false, "normal is not high");
  assert.equal(suggestions([note({ strength: "normal" })], settingsWith({ routing: { urgentStrength: "normal" } }), ctx())[0].urgent, true, "unless routing says normal is enough");
  assert.equal(suggestions([note({ until: "2026-12-04" })], settingsWith(), ctx())[0].urgent, false, "too far out");
  assert.equal(suggestions([note({ until: null })], settingsWith(), ctx())[0].urgent, false, "no date is never urgent");
  assert.equal(suggestions([note()], settingsWith({}, { enable_needs_you: false }), ctx())[0].urgent, false, "the source's Needs-you switch");
  assert.equal(suggestions([note()], settingsWith({ routing: { suggestions: "new-only" } }), ctx())[0].urgent, false, "new-only sends nothing to Needs you");
  assert.deepEqual(suggestions([note()], settingsWith({ routing: { suggestions: "off" } }), ctx()), [], "off: no suggestion at all");
});

test("a-taken-issue-is-not-a-suggestion: an issue with a workspace, a placed note, a removed one or a disabled source suggests nothing", () => {
  const s = settingsWith();
  assert.deepEqual(suggestions([note()], s, ctx({ taken: k => k === "ACME-18" })), [], "invariant 95's one predicate");
  assert.deepEqual(suggestions([note({ match: { workspace: "ws-1", score: 1, how: "key" } })], s, ctx()), [], "a note on a workspace reorders AI priority instead");
  assert.deepEqual(suggestions([note()], s, ctx({ removed: new Set(["n-1"]) })), [], "removed by the developer");
  assert.deepEqual(suggestions([note()], settingsWith({}, { enabled: false }), ctx()), []);
  assert.deepEqual(suggestions([note({ state: "retracted" })], s, ctx()), [], "an ended note suggests nothing");
  // One per issue: the soonest, then strongest, note.
  const two = suggestions([note({ id: "n-a", until: "2026-12-10", strength: "high" }), note({ id: "n-b", until: "2026-11-25", strength: "normal" })], s, ctx());
  assert.deepEqual(two.map(x => x.note), ["n-b"]);
  // The queue's title wins over the note's words, so New and Needs you name the issue.
  assert.equal(suggestions([note()], s, ctx({ issue: () => ({ title: "Renewal export", url: "https://linear.example/ACME-18" }) }))[0].title, "Renewal export");
});

test("nobody-s-on-it-is-needs-you: a raise and a Compass ask on the same issue are one row, raises first, every reason kept", () => {
  const raised = [{ key: "ACME-142", title: "Retry failed charges", url: null, priority: 1, priorityBefore: 4, due: null, at: "2026-11-24T07:00:00.000Z" },
    { key: "ACME-18", title: "Renewal export", url: null, priority: 2, priorityBefore: 3, due: null, at: "2026-11-24T06:00:00.000Z" }];
  const asks = suggestions([note(), note({ id: "n-2", match: { issue: "ACME-40", score: 1, how: "key" }, keys: ["ACME-40"], what: "SSO for acme", until: "2026-11-25" })], settingsWith(), ctx());
  const rows = nobodyNeeds(raised, asks);
  assert.deepEqual(rows.map(r => r.key), ["ACME-142", "ACME-18", "ACME-40"], "one row per issue");
  assert.deepEqual(rows[1].reasons.map(r => r.from), ["queue", "compass"], "both reasons on the one row");
  assert.equal(rows[1].due, "2026-11-26", "the ask lends its date");
  const head = nobodyRow(rows[0], NOW, "UTC");
  assert.deepEqual([head.word, head.line, head.reason], ["Nobody's on it", "Retry failed charges", "Raised Low → Urgent · Linear queue"]);
  const ask = nobodyRow(rows[2], NOW, "UTC");
  assert.equal(ask.reason, "Dana: SSO for acme tomorrow · Compass");
  assert.equal(ask.compass, true);
  assert.match(nobodyRow(rows[1], NOW, "UTC").label, /Raised Medium → High, from Linear queue; Dana: renewal call Thu, from Compass, Dana · product/, "a screen reader hears every reason");
  // A non-urgent suggestion never reaches Needs you.
  assert.deepEqual(nobodyNeeds([], suggestions([note({ strength: "low" })], settingsWith(), ctx())), []);
});

test("an-action-is-data: {why} is a known placeholder, the built-ins carry it, and an unedited beta copy upgrades", () => {
  assert.ok((PLACEHOLDERS as readonly string[]).includes("why"));
  const pr = builtinAction("pr");
  assert.match(pr.instructions, /\{why\}/);
  const why = whyText(note(), "Dana · product");
  assert.equal(why, 'Why this matters, from Compass: Dana (Dana · product), 2026-11-24 08:00 UTC: "ACME-18 has to be ready for the renewal call"\nUntil 2026-11-26.');
  const text = renderAction(pr, { key: "ACME-18", title: "Renewal export", url: "https://linear.example/ACME-18", repo: "acme/app", base: "main", branch: "acme-18", why });
  assert.match(text, /Why this matters, from Compass: Dana/);
  assert.doesNotMatch(renderAction(pr, { key: "ACME-18", title: "Renewal export", url: null, repo: "acme/app", base: "main", branch: "acme-18", why: "" }), /\{why\}|Why this matters/, "empty for anything that isn't a suggestion");
  const beta = "Work on {key} “{title}” ({url}).\nRead {key} yourself, all of it: comments, attachments, linked docs and threads.\nBuild it and open a PR from {branch} against {base} in {repo}; register it with Follow-up.\n\n{words}";
  assert.equal(currentBuiltin({ ...pr, instructions: beta }).instructions, pr.instructions, "a saved copy nobody edited reads as the current built-in");
});

test("My issues: Compass's suggestions first with their reason, one not assigned joins, a taken one never", () => {
  const issue = (key: string, title: string) => ({ key, title, url: null, state: "Todo", stateType: "unstarted", priority: 3, updatedAt: "2026-11-23T10:00:00.000Z", team: "ACME" });
  const sources = {
    linear: { issues: [issue("ACME-7", "Billing page"), issue("ACME-18", "Renewal export")], error: null } as never,
    routes: { "ACME-7": { project: "app", guess: false, existing: null }, "ACME-18": { project: "app", guess: false, existing: null }, "ACME-99": { project: "app", guess: false, existing: { workspaceId: "w", title: "w", state: "idle" } } } as never,
    compass: [{ key: "ACME-18", title: "Renewal export", url: null, reason: "Dana: renewal call Thu", source: "Dana · product", note: "n-1", urgent: false },
      { key: "ACME-40", title: "SSO for acme", url: null, reason: "Dana: SSO for acme", source: "Dana · product", note: "n-2", urgent: false },
      { key: "ACME-99", title: "Taken", url: null, reason: "Dana: x", source: "Dana · product", note: "n-3", urgent: false }],
  };
  const { rows, selected } = newRows(sources, "", NOW);
  const issues = rows.filter(r => r.kind === "issue") as Extract<(typeof rows)[number], { kind: "issue" }>[];
  assert.deepEqual(issues.map(r => r.key), ["ACME-18", "ACME-40", "ACME-7"]);
  assert.equal(issues[0].reason, "Dana: renewal call Thu");
  assert.equal(issues[1].icon, "Compass", "not in the developer's list: it joins with the compass glyph");
  assert.equal(issues[2].reason, undefined);
  assert.equal(selected, "ACME-18");
  assert.deepEqual(newRows(sources, "billing", NOW).rows.filter(r => r.kind === "issue").map(r => (r as { key: string }).key), ["ACME-7"], "a search is the developer's own words: no suggestion");
});

test("the one Since block: Compass first (heard, Needs you, suggestions), then the queue, then dropped, unplaced and a failed read", () => {
  const since = "2026-11-23T18:00:00.000Z";
  const notes = [
    note({ id: "n-w", match: { workspace: "ws-inv", score: 1, how: "key" }, what: "invoice export", quote: "invoice export is really important for the client call", until: "2026-11-26" }),
    note({ id: "n-old", at: "2026-11-20T08:00:00.000Z", match: { workspace: "ws-inv", score: 1, how: "key" } }),
    note({ id: "n-d", state: "retracted", endedAt: "2026-11-24T08:30:00.000Z", what: "Okta SSO" }),
    note({ id: "n-u", match: { score: 0, how: "none" }, keys: [], what: "the board deck" }),
  ];
  const list = suggestions([note({ id: "n-s" }), note({ id: "n-t", match: { issue: "ACME-40", score: 1, how: "key" }, strength: "low" })], settingsWith(), ctx());
  const c = compassSince(notes, { settings: settingsWith(), since, now: NOW, clock: CLOCK, suggestions: list, titles: new Map([["ws-inv", "Invoice export for acme"]]), lastRead: { at: since, ok: false, error: "The chat tool didn't answer in time." } });
  assert.deepEqual(c.lines.map(l => l.kind), ["heard", "needs", "suggestion", "dropped", "unplaced", "failed"]);
  assert.equal(c.lines[0].head, "Dana on Invoice export for acme");
  assert.equal(c.lines[0].meta, "until Thu", "the old note on the same workspace isn't news");
  assert.equal(c.lines[1].source, null, "in Needs you: named once, no second set of actions");
  assert.equal(c.lines[2].source, "ACME-40", "a suggestion carries Start…");
  assert.equal(c.lines[3].head, "Dana dropped Okta SSO");
  assert.deepEqual(c.from, ["Dana"]);
  assert.equal(heardWords(c), "3 from Dana");

  const block = sinceBlock({ since, changes: [], counts: { all: 4 }, compass: c }, NOW, "UTC");
  assert.equal(block.title, "Since yesterday · Dana, your Linear queue");
  assert.deepEqual(block.lines.map(l => l.icon), ["Compass", "Compass", "Compass", "X", "MapPinOff", "AlertTriangle"]);
  assert.equal(block.empty, null);
  const quiet = sinceBlock({ since, changes: [], counts: { all: 4 }, compass: { from: [], lines: [], heard: 0 } }, NOW, "UTC");
  assert.equal(quiet.empty, "Nothing new since yesterday.");
  assert.equal(heardWords({ from: [], lines: [] }), null);
});

// ---------- the worker: Remove, why_suggested, the daytime read ----------

const DANA_SOURCE: CompassChange = { source: { label: "Dana · product", who: { kind: "person", person: { id: DANA, name: "Dana" } }, places: [{ kind: "conversation", sub: "dm", id: DANA, name: "Dana" }], roles: ["priorities"] } };

async function setup(open: { value: boolean }) {
  const dir = await mkdtemp(join(tmpdir(), "compass-suggest-"));
  let reads = 0;
  const mcp = fakeMcpproxy({ tools: CHAT_TOOLS(true), answer: () => { reads++; return historyText([{ by: DANA, name: "Dana", at: "2026-11-24T07:30:00Z", text: "ACME-18 has to be ready for the renewal call Thursday" }]); } });
  const model = fakeModel(() => ({ notes: [{ item: "m1", what: "renewal call", keys: ["ACME-18"], kind: "issue", strength: "high", untilWords: "Thursday", until: null, quote: "ACME-18 has to be ready for the renewal call" }], retracts: [], nothing: false }));
  let clock = NOW; let n = 0;
  const compass = testCompass(dir, {
    settings: testStore(MorningBriefStore, dir), store: testStore(CompassStore, dir), tools: mcp.tools,
    jobs: new AiJobs({ runner: model.runner, logPath: join(dir, "ai-jobs.jsonl") }),
    role: async () => ({ provider: "claude", model: "haiku", thinking: null, label: "Claude" }),
    clock: async () => CLOCK, sweepAt: async () => "08:00",
    index: async () => ({ workspaces: [], issueWorkspace: () => null }),
    appOpen: () => open.value,
    now: () => clock, newId: () => `s-test${++n}`,
  });
  return { dir, compass, reads: () => reads, setNow: (t: number) => { clock = t; } };
}

test("Remove: one click ends the suggestion (and the Nobody's-on-it row), undo brings it back; why_suggested says why", async () => {
  const open = { value: false };
  const t = await setup(open);
  try {
    await t.compass.set(DANA_SOURCE, "developer");
    await t.compass.read("manual");
    const [s] = await t.compass.suggestions();
    assert.equal(s?.key, "ACME-18");
    assert.equal(s.urgent, true, "high, Thursday, Needs you on by the role's default");
    const why = await t.compass.why({ issue: "ACME-18" });
    assert.equal(why.needsYou.urgent, true);
    assert.match(why.needsYou.why, /In Needs you as "Nobody's on it": Dana: renewal call Thu/);

    await t.compass.removeSuggestion(s.note, false);
    assert.deepEqual(await t.compass.suggestions(), []);
    await assert.rejects(t.compass.removeSuggestion(s.note, false), /isn't removed|already gone/);
    await t.compass.removeSuggestion(s.note, true);
    assert.equal((await t.compass.suggestions()).length, 1, "undo brings it back");
    assert.equal(await t.compass.removeIssue("acme-18", false), 1, "the row's Remove takes every ask on the issue");
    assert.deepEqual(await t.compass.suggestions(), []);
    assert.match((await t.compass.why({ issue: "ACME-18" })).needsYou.why, /removed the suggestion/);
  } finally { await rm(t.dir, { recursive: true, force: true }); }
});

test("the-brief-has-one-timer: the daytime read runs every cadence only while the app is open, on workdays 08:00-20:00", async () => {
  const open = { value: false };
  const t = await setup(open);
  try {
    await t.compass.set(DANA_SOURCE, "developer");
    await t.compass.idle(); // the new place's week read
    const base = t.reads();
    // The morning read (09:00, after the 08:00 sweep) runs with the app closed: it's the brief's own read.
    await t.compass.tick();
    const morning = t.reads();
    assert.ok(morning > base, "the morning read ran");
    // Two hours later, app closed: nothing.
    t.setNow(NOW + 2 * 3_600_000 + 60_000);
    await t.compass.tick();
    assert.equal(t.reads(), morning, "the app is closed: nothing is read");
    // App open: the daytime read runs once, then waits for the next period.
    open.value = true;
    await t.compass.tick();
    const day = t.reads();
    assert.ok(day > morning, "the daytime read ran");
    t.setNow(NOW + 3 * 3_600_000);
    await t.compass.tick();
    assert.equal(t.reads(), day, "within the period: no second read");
    // After 20:00: none.
    t.setNow(Date.parse("2026-11-24T20:30:00Z"));
    await t.compass.tick();
    assert.equal(t.reads(), day, "after hours");
    // Saturday: none.
    t.setNow(Date.parse("2026-11-28T12:00:00Z"));
    await t.compass.tick();
    assert.equal(t.reads(), day, "not a workday");
    // Off: mornings only.
    await t.compass.set({ cadence: "off" }, "developer");
    t.setNow(Date.parse("2026-11-25T15:00:00Z"));
    await t.compass.tick(); // Wednesday's morning read
    const wed = t.reads();
    t.setNow(Date.parse("2026-11-25T19:00:00Z"));
    await t.compass.tick();
    assert.equal(t.reads(), wed, "cadence off: no daytime read");
  } finally { await rm(t.dir, { recursive: true, force: true }); }
});
