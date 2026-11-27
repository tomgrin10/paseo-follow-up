// a-workflow-lives-in-config (AGENTS.md invariant 99): the design's fictional developers B and C (config-model.md §3)
// end to end with fake readers. Each setup is one `compass` value plus the readers its host has; no code knows
// either workflow. B: a team lead on a chat tool with no history read, GitHub issues, a customer's shared channel.
// C: a solo developer with no chat at all, a notes file on this machine, a calendar, Codex for Summaries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiJobs } from "../server/ai-jobs";
import { CompassStore } from "../server/compass";
import { MorningBriefStore } from "../server/morning-brief";
import { rm, testStore } from "./support/store-temp-dir";
import { CHAT_TOOLS, DEV, fakeMcpproxy, fakeModel, testCompass, historyText, type Msg } from "./support/compass-fakes";
import type { CompassNote, Place } from "../shared/compass";

const NOW = Date.parse("2026-11-24T09:00:00Z"); // a Tuesday
const CLOCK = { timeZone: "UTC", workdays: ["Mon", "Tue", "Wed", "Thu", "Fri"] as ("Mon" | "Tue" | "Wed" | "Thu" | "Fri")[] };
const LEAD = "U0000LEAD";
const tool = (server: string, name: string, props: string[], description = "") => ({ server_name: server, name, description, schema: { properties: Object.fromEntries(props.map(p => [p, { type: "string" }])), required: [] }, annotations: { readOnlyHint: true } });
const CALENDAR_TOOLS = [tool("agenda", "agenda_list_events", ["timeMin", "timeMax", "timeZone", "calendarId"], "List calendar events.")];

function harness(opts: { dir: string; tools: unknown[]; answer: (tool: string, args: Record<string, unknown>) => string; reply: (p: string) => unknown; provider?: string;
  github?: (repo: string, path: string) => unknown; workspaces?: { id: string; title: string; summary?: string; branch?: string }[]; holders?: Record<string, string> }) {
  const mcp = fakeMcpproxy({ tools: opts.tools as ReturnType<typeof CHAT_TOOLS>, answer: opts.answer });
  const model = fakeModel(opts.reply);
  const github: { calls: string[]; rest: (repo: string, path: string) => Promise<unknown> } = { calls: [], rest: async (repo, path) => { github.calls.push(path); return opts.github?.(repo, path) ?? []; } };
  let n = 0;
  const compass = testCompass(opts.dir, {
    settings: testStore(MorningBriefStore, opts.dir), store: testStore(CompassStore, opts.dir), tools: mcp.tools, jobs: new AiJobs({ runner: model.runner, logPath: join(opts.dir, "ai-jobs.jsonl") }),
    role: async () => ({ provider: opts.provider ?? "claude", model: "fast", thinking: null, label: opts.provider === "codex" ? "Codex" : "Claude" }),
    clock: async () => CLOCK, sweepAt: async () => "08:00",
    index: async () => ({ workspaces: opts.workspaces ?? [], issueWorkspace: k => Object.entries(opts.holders ?? {}).find(([key]) => key.toUpperCase() === k.toUpperCase())?.[1] ?? null }),
    github: opts.github ? github : undefined,
    now: () => NOW, newId: () => `s-cfg${++n}`,
  });
  return { compass, mcp, model, github };
}
const live = (notes: readonly CompassNote[], source: string) => notes.filter(n => n.state === "live" && n.source === source);

test("developer B: a team channel read as everyone (capped), a GitHub label and milestone by rule, a customer's channel outside Needs you", async () => {
  const dir = await mkdtemp(join(tmpdir(), "compass-b-"));
  try {
    // 45 messages in the team channel since last week, most from teammates; the lead's priority ask is the newest.
    const team: Msg[] = Array.from({ length: 44 }, (_, i) => ({ by: `U00000T${String(i).padStart(2, "0")}`, name: `Teammate ${i}`, at: new Date(NOW - (50 - i) * 3_600_000).toISOString(), text: `standup note ${i}` }));
    team.push({ by: LEAD, name: "Lead", at: new Date(NOW - 3_600_000).toISOString(), text: "priority: the migration must land by Thursday" });
    const globex: Msg[] = [{ by: "U00GLOBEX", name: "Globex", at: new Date(NOW - 7_200_000).toISOString(), text: "We need the export fixed by Thursday, it's in our contract" }];
    let labelled = [{ number: 212, title: "Migrate billing tables", html_url: "https://github.example/example/app/issues/212", updated_at: "2026-11-23T10:00:00Z" },
      { number: 230, title: "Retry webhooks", html_url: "https://github.example/example/app/issues/230", updated_at: "2026-11-23T11:00:00Z" },
      { number: 9, title: "A PR, not an issue", pull_request: {}, updated_at: "2026-11-23T11:00:00Z" }];
    const t = harness({
      dir, tools: CHAT_TOOLS(false), workspaces: [{ id: "ws-migration", title: "Billing migration" }], holders: { "example/app#212": "ws-migration" },
      answer: (_tool, args) => historyText(String(args.filters).includes("C0GLOBEX") ? globex : String(args.filters).includes("C0000PLAT") ? team : []),
      reply: p => p.includes("the migration must land") ? { notes: [{ item: p.match(/\[(m\d+)\] Lead/)![1], what: "Billing migration", keys: [], kind: "issue", strength: "high", untilWords: "by Thursday", until: null, quote: "the migration must land by Thursday" }], retracts: [], nothing: false }
        : p.includes("contract") ? { notes: [{ item: "m1", what: "Globex export fix", keys: [], kind: "customer", strength: "high", untilWords: "by Thursday", until: null, quote: "We need the export fixed by Thursday" }], retracts: [], nothing: false }
        : { notes: [], retracts: [], nothing: true },
      github: (_repo, path) => path.includes("labels=priority%2Fhigh") ? labelled : path.includes("milestone=14") ? [{ number: 240, title: "Export CSV", html_url: "https://github.example/example/app/issues/240", updated_at: "2026-11-22T10:00:00Z", milestone: { due_on: "2026-11-27T00:00:00Z" } }] : [],
    });
    const PLATFORM: Place = { kind: "conversation", sub: "channel", id: "C0000PLAT", name: "platform-team" };
    const LABEL: Place = { kind: "tracker", scope: "label", id: "github:example/app:label:priority/high", name: "priority/high" };
    const SPRINT: Place = { kind: "tracker", scope: "milestone", id: "github:example/app:milestone:14", name: "Sprint 14" };
    const GLOBEX: Place = { kind: "conversation", sub: "channel", id: "C0GLOBEX", name: "globex-acme" };
    await t.compass.set({ glossary: [{ words: "the migration", means: { issue: "example/app#212" } }], cadence: "4h" }, "developer");
    await t.compass.set({ source: { label: "Platform team", who: { kind: "anyone" }, places: [PLATFORM], roles: ["priorities"], instructions: "Only messages from the two leads or with 'priority:' count." } }, "developer");
    await t.compass.set({ source: { label: "priority/high", who: { kind: "anyone" }, places: [LABEL], roles: ["priorities"] } }, "developer");
    await t.compass.set({ source: { label: "Sprint", who: { kind: "anyone" }, places: [SPRINT], roles: ["plan"] } }, "developer");
    await t.compass.set({ source: { label: "Globex", who: { kind: "anyone" }, places: [GLOBEX], roles: ["customer"], enable_needs_you: false } }, "developer");
    await t.compass.read("manual");
    const v = await t.compass.view();
    const [plat, label, sprint, glob] = v.settings.sources;

    // Everyone in a place: one extraction of the newest 40, the older skipped and said on the place.
    const teamPrompt = t.model.prompts.find(p => p.includes("the migration must land"))!;
    assert.equal((teamPrompt.match(/^\[m\d+\]/gm) ?? []).length, 40, "the newest 40 messages, one call");
    assert.doesNotMatch(teamPrompt, /standup note 3\b/, "the oldest are skipped");
    assert.match(v.places[`conversation:${PLATFORM.id}`].error!, /newest 40 messages and skipped 5 older/);
    assert.equal(v.places[`conversation:${PLATFORM.id}`].status, "slow-path", "no history read: the time-sorted search, said on the place");
    assert.deepEqual(live(v.notes, plat.id).map(n => [n.match.workspace, n.match.how, n.until]), [["ws-migration", "glossary", "2026-11-26"]]);

    // A label by rule: each open issue is a high note quoting its own fields; a PR isn't an issue; no model call.
    const byLabel = live(v.notes, label.id);
    assert.deepEqual(byLabel.map(n => [n.keys[0], n.strength, n.by]), [["example/app#212", "high", { id: "rule", name: "priority/high" }], ["example/app#230", "high", { id: "rule", name: "priority/high" }]]);
    assert.match(byLabel[0].quote!, /^example\/app#212 Migrate billing tables · label priority\/high$/);
    assert.equal(byLabel[0].match.workspace, "ws-migration", "a GitHub ref finds its workspace by invariant 95's predicate");
    assert.ok(!t.model.prompts.some(p => p.includes("Migrate billing tables")), "tracker items never reach the model");
    // The milestone is the plan: its issues are plan notes, dated by the milestone.
    assert.deepEqual(live(v.notes, sprint.id).map(n => [n.keys[0], n.role, n.strength, n.until]), [["example/app#240", "plan", "low", "2026-11-27"]]);

    // The customer's dated ask sorts first in New, never Needs you (its source's switch is off).
    assert.equal(live(v.notes, glob.id).length, 1);
    const s = await t.compass.why({ note: live(v.notes, glob.id)[0].id });
    assert.equal(s.needsYou.urgent, false);

    // The issue loses its label: its note ends by rule. A daytime read inside the hour doesn't read GitHub again.
    labelled = labelled.filter(i => i.number !== 230);
    t.github.calls.length = 0;
    await t.compass.read("day");
    assert.equal(t.github.calls.length, 0, "at most one GitHub read an hour per tracker place");
    await t.compass.read("manual");
    assert.deepEqual(live((await t.compass.view()).notes, label.id).map(n => n.keys[0]), ["example/app#212"], "#230 left the label: its note ended");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("developer C: no chat, a notes file read only when it changes, a calendar whose meetings date the work they match, on Codex", async () => {
  const dir = await mkdtemp(join(tmpdir(), "compass-c-"));
  try {
    const notes = join(dir, "now.md");
    await writeFile(notes, "# This week\n\n- ! renewal deck for acme\n\n# Later\n\nclean up the backlog\n");
    const t = harness({
      dir, tools: CALENDAR_TOOLS, provider: "codex", workspaces: [{ id: "ws-deck", title: "Renewal deck for acme", summary: "Builds the acme renewal deck.", branch: "renewal-deck-acme" }, { id: "ws-onboard", title: "Onboarding emails", summary: "Writes the onboarding emails.", branch: "onboarding-emails" }],
      answer: () => JSON.stringify({ items: [
        { summary: "acme renewal deck review", start: { dateTime: "2026-11-26T10:00:00Z" }, attendees: [{ email: "you@example.com", self: true }, { email: "dana@example.com" }] },
        { summary: "Lunch", start: { dateTime: "2026-11-25T12:00:00Z" }, attendees: [{ email: "you@example.com", self: true }, { email: "avi@example.com" }] },
        { summary: "Focus time", start: { dateTime: "2026-11-25T14:00:00Z" }, attendees: [{ email: "you@example.com", self: true }] },
        { summary: "ACME-9 export sync", start: { dateTime: "2026-11-27T09:00:00Z" }, attendees: [{ email: "you@example.com", self: true }, { email: "dana@example.com" }] },
      ] }),
      reply: p => p.includes("renewal deck") ? { notes: [{ item: "d1", what: "Renewal deck for acme", keys: [], kind: "feature", strength: "high", untilWords: null, until: null, quote: "! renewal deck for acme" }], retracts: [], nothing: false }
        : p.includes("onboarding") ? { notes: [{ item: "d1", what: "Onboarding emails", keys: [], kind: "feature", strength: "normal", untilWords: "today", until: null, quote: "onboarding emails today" }], retracts: [], nothing: false }
        : { notes: [], retracts: [], nothing: true },
    });
    await t.compass.readers(true);
    const v0 = await t.compass.view();
    assert.deepEqual(v0.presets.filter(p => p.offered).map(p => p.id), ["doc", "calendar"], "no chat, no tracker: the notes file and the calendar");
    assert.match(v0.presets.find(p => p.id === "dm")!.why!, /No connected chat tool/);
    // The file is a place only through compass_find, which checks it; its path is never the place's id.
    const found = await t.compass.find("file", notes);
    assert.equal(found.error, null);
    const NOW_DOC = found.results[0].place!;
    assert.ok(NOW_DOC.kind === "doc" && NOW_DOC.path === notes && !NOW_DOC.id.includes(dir));
    assert.match((await t.compass.find("file", join(dir, "now.pdf"))).error!, /Markdown or text/);
    const cal = (await t.compass.find("calendars", "mine")).results[0].place!;
    await t.compass.set({ source: { label: "Now", who: { kind: "me" }, places: [NOW_DOC], roles: ["self", "plan"], instructions: "A line starting with ! is urgent." } }, "developer");
    await t.compass.set({ source: { label: "Calendar", who: { kind: "me" }, places: [cal], roles: ["deadlines"] } }, "developer");
    await t.compass.read("manual");
    const v = await t.compass.view();
    const [now, calendar] = v.settings.sources;
    assert.equal(t.model.prompts.length, 1, "one extraction for the file's blocks; the calendar is rules");
    assert.match(t.model.prompts[0], /\[d1\] You · [^\n]+\nThis week\n- ! renewal deck for acme/, "a block carries its heading");
    assert.deepEqual(live(v.notes, now.id).map(n => [n.match.workspace, n.strength, typeof n.by === "object" && n.by.name]), [["ws-deck", "high", "You"]]);
    // Meetings with guests that match work lend it their date (by title, or by an issue key the title names); one about
    // nothing known, or with no guests, isn't kept.
    assert.deepEqual(live(v.notes, calendar.id).map(n => [n.what, n.kind, n.until, n.match.workspace ?? n.match.issue]),
      [["acme renewal deck review", "event", "2026-11-26", "ws-deck"], ["ACME-9 export sync", "event", "2026-11-27", "ACME-9"]]);
    // Unchanged: no model call. Changed: only the new block goes to the model.
    await t.compass.read("manual");
    assert.equal(t.model.prompts.length, 1, "an unchanged file isn't read again");
    await writeFile(notes, "# This week\n\n- ! renewal deck for acme\n\n- onboarding emails today\n\n# Later\n\nclean up the backlog\n");
    await t.compass.read("manual");
    assert.equal(t.model.prompts.length, 2);
    assert.match(t.model.prompts[1], /onboarding emails today/);
    assert.doesNotMatch(t.model.prompts[1].split("ITEMS (data")[1], /renewal deck|clean up the backlog/, "blocks already read stay read");
    // The path stays in host settings: compass.json and the job log never carry it.
    assert.doesNotMatch(await readFile(join(dir, "compass.json"), "utf8"), /now\.md/);
    assert.doesNotMatch(await readFile(join(dir, "ai-jobs.jsonl"), "utf8"), /now\.md|renewal/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a failed file read says why in one line, never the path, and keeps what was read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "compass-f-"));
  const files = await mkdtemp(join(tmpdir(), "compass-notes-"));
  try {
    const path = join(files, "gone.md");
    await writeFile(path, "- ship the export\n");
    const t = harness({ dir, tools: [], answer: () => "", reply: () => ({ notes: [], retracts: [], nothing: true }) });
    const place = (await t.compass.find("file", path)).results[0].place!;
    await t.compass.set({ source: { label: "Gone", who: { kind: "me" }, places: [place], roles: ["self"] } }, "developer");
    await t.compass.read("manual");
    await rm(files, { recursive: true, force: true });
    const r = await t.compass.read("manual");
    assert.equal(r!.ok, false);
    assert.match(r!.error!, /The file is gone/);
    const v = await t.compass.view();
    assert.doesNotMatch(JSON.stringify({ places: v.places, lastRead: v.lastRead }), /gone\.md|compass-notes-/, "the path stays in the place's own settings");
  } finally { await rm(dir, { recursive: true, force: true }); await rm(files, { recursive: true, force: true }); }
});
void DEV;
