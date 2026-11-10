import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { briefStep, collapsedLine, nothingNeededLine, extrasFit, isTight, FALLBACK_ASK, matchOption, NEEDS_YOU_INSTRUCTION, NEEDS_YOU_NUDGE, pickBrief, prState, validateNeedsYou, type Brief, type BriefContent, type NeedsYouCall, type NeedsYouRecord, type PrState } from "../shared/brief";
import { classify, type Sources } from "../server/inbox-classifier";
import { briefShare, finishIsQuiet, Inbox, type AgentInfo, type Directory, type GuardPause } from "../server/inbox";
import { pr, snapshot, workspace } from "./fixtures";

const T0 = "2026-11-08T10:00:00.000Z";
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();
const decision: NeedsYouCall = { ask: "Pick how the export API is rate-limited", kind: "decision", context: "Tenant 7 made 81% of export calls.",
  decisions: [{ question: "Per-tenant buckets or one global bucket?", options: [{ label: "Per-tenant buckets", consequence: "60 req/min each" }, { label: "One global bucket" }, { label: "Per-tenant, behind a flag" }], recommend: 0 }] };
const prFacts: PrState = { key: "acme/app#813", number: 813, url: "https://example.invalid/pr/813", title: "CSV export", facts: [{ icon: "CircleCheck", label: "Required checks pass", tone: "ok" }, { icon: "UserCheck", label: "Approved · no conflicts", tone: "ok" }], mergeable: true, event: null };

// ---------- §5.2 precedence, one test per row ----------

test("§5.2 row 1: a permission takes the headline over a pause, an error and the agent's statement, which stays below", () => {
  const b = pickBrief({ permission: { title: "run the vendor-merge migration on staging", subagent: null }, paused: { note: null, resetsAt: null }, error: { message: "boom" }, agent: decision });
  assert.equal(b.source, "permission"); assert.equal(b.kind, "permission"); assert.equal(b.slim, true);
  assert.equal(b.ask, "Accept or deny: run the vendor-merge migration on staging");
  assert.deepEqual(b.moves, [], "Paseo's own prompt is the control (F9)");
  assert.equal(b.also?.ask, decision.ask);
  const sub = pickBrief({ permission: { title: "edit config.ts", subagent: { id: "sub1", title: "Reviewer" } } });
  assert.equal(sub.ask, "Subagent Reviewer asks: edit config.ts");
  assert.deepEqual(sub.moves.map(m => [m.kind, m.agentId]), [["open_subagent", "sub1"]]);
});
test("§5.2 row 1: a pause outranks an error, and an error outranks the agent's statement", () => {
  const paused = pickBrief({ paused: { note: "Stopped on step 4 of 6", resetsAt: "14:00" }, error: { message: "boom" }, agent: decision });
  assert.equal(paused.source, "paused"); assert.equal(paused.context, "Stopped on step 4 of 6"); assert.equal(paused.also?.ask, decision.ask);
  const error = pickBrief({ error: { message: "API error 529 · overloaded_error" }, agent: decision });
  assert.equal(error.source, "error"); assert.equal(error.mono, "API error 529 · overloaded_error");
  assert.deepEqual(error.moves.map(m => m.kind), ["retry", "copy_error"]);
  assert.equal(error.also?.ask, decision.ask);
});
test("§5.2 row 2: otherwise the agent's needs_you is the brief, with lettered options and its recommendation", () => {
  const b = pickBrief({ agent: decision });
  assert.equal(b.source, "agent"); assert.equal(b.kind, "decision"); assert.equal(b.slim, false); assert.equal(b.also, null);
  assert.deepEqual(b.decisions[0].options.map(o => o.letter), ["A", "B", "C"]);
  assert.equal(b.decisions[0].recommend, "A");
  assert.match(b.sourceLine, /Stated by the agent/);
});
test("§5.2 row 3: PR facts merge into the winning brief; a merge-ready review gets Squash & merge; alone, a PR event headlines", () => {
  const review = pickBrief({ agent: { ask: "Review and merge #813", kind: "review" }, pr: prFacts });
  assert.equal(review.source, "agent"); assert.equal(review.facts.length, 2);
  assert.deepEqual(review.moves.map(m => m.label), ["Squash & merge #813", "Open PR"]);
  assert.deepEqual(pickBrief({ agent: { ask: "Review #813", kind: "review" }, pr: { ...prFacts, mergeable: false } }).moves.map(m => m.kind), ["open_pr"], "no merge move when it can't merge");
  const error = pickBrief({ error: { message: "x" }, pr: prFacts });
  assert.equal(error.facts.length, 2, "facts merge into a blocking brief too");
  const followup = pickBrief({ pr: { ...prFacts, event: "Checks failed on #812 lint, unit-api" } });
  assert.equal(followup.source, "followup"); assert.equal(followup.ask, "Checks failed on #812 lint, unit-api");
  assert.equal(pickBrief({ pr: prFacts }).source, "none", "PR facts without an event never invent an ask");
  // Q: a merge-ready PR is still a "Needs you" brief, kind review.
  assert.equal(review.kind, "review");
});
test("§5.2 rows 4–5: with no extraction (out of scope) and nothing stated, the honest fallback, slim and quote-free", () => {
  const b = pickBrief({ extracted: null });
  assert.equal(b.source, "none"); assert.equal(b.kind, "unknown"); assert.equal(b.slim, true);
  assert.equal(b.ask, FALLBACK_ASK); assert.deepEqual(b.decisions, []); assert.deepEqual(b.moves, []);
  assert.match(b.sourceLine, /nothing is guessed/);
});
test("F7: a finish the agent states as done has no moves: nothing to sign off, one muted line", () => {
  const b = pickBrief({ agent: { ask: "Nothing needed. Daily plugin updates are scheduled for 09:30.", kind: "done" }, pr: prFacts });
  assert.deepEqual(b.moves, []); assert.deepEqual(b.facts, []);
  assert.equal(nothingNeededLine(b.ask), "Nothing needed · Daily plugin updates are scheduled for 09:30.");
  assert.equal(nothingNeededLine("Nothing needed."), "Nothing needed");
});

// ---------- §6 lifecycle, one test per row (pure steps) ----------

const content = (c: Partial<BriefContent> = {}) => ({ ...pickBrief({ agent: decision }), ...c });
const open = (id = "brief:t1", c?: Partial<BriefContent>) => briefStep(null, { type: "create", id, turnId: "t1", content: content(c), flagged: true, seq: 1 }, at(0)).brief!;
test("§6 create: a new brief is open and appended; one still open is collapsed first", () => {
  const first = briefStep(null, { type: "create", id: "brief:t1", turnId: "t1", content: content(), flagged: true, seq: 1 }, at(0));
  assert.equal(first.brief!.state, "open"); assert.deepEqual(first.appends.map(b => b.id), ["brief:t1"]);
  const second = briefStep(first.brief, { type: "create", id: "brief:t2", turnId: "t2", content: content(), flagged: true, seq: 2 }, at(5));
  assert.deepEqual(second.appends.map(b => [b.id, b.state]), [["brief:t1", "superseded"], ["brief:t2", "open"]]);
  const unflagged = briefStep(null, { type: "create", id: "brief:t3", turnId: "t3", content: content(), flagged: false, seq: 1 }, at(0)).brief!;
  assert.equal(unflagged.flagged, false);
  const linked = briefStep(null, { type: "create", id: "brief:t4", turnId: "t4", content: content(), flagged: true, seq: 1, questionIds: ["Q7"] }, at(0)).brief!;
  assert.equal(linked.decisions[0].id, "Q7", "decisions stored as questions carry the question id");
});
test("§6 option clicked: answered, the choice recorded, the row replaced in place", () => {
  const b = open();
  const r = briefStep(b, { type: "option", decisionId: "D1", choice: "B" }, at(3));
  assert.equal(r.brief!.state, "answered"); assert.equal(r.brief!.outcome, "You picked B · One global bucket");
  assert.equal(r.brief!.decisions[0].chosen, "B"); assert.equal(r.appends[0].id, b.id);
  assert.equal(briefStep(b, { type: "option", decisionId: "D1", choice: "Z" }, at(3)).brief, b, "an unknown option changes nothing");
});
test("§6 the developer's message from anywhere answers it: a bare letter or a label picks, other words reply", () => {
  const b = open();
  assert.equal(briefStep(b, { type: "message", text: "c" }, at(1)).brief!.outcome, "You picked C · Per-tenant, behind a flag");
  assert.equal(briefStep(b, { type: "message", text: "One global bucket." }, at(1)).brief!.outcome, "You picked B · One global bucket");
  assert.equal(briefStep(b, { type: "message", text: "Let's talk about this first" }, at(1)).brief!.outcome, "You replied");
  assert.equal(matchOption(b, "Absolutely"), null);
});
test("§6 sign off collapses to 'Signed off'; undo reopens it", () => {
  const signed = briefStep(open(), { type: "sign_off" }, at(1)).brief!;
  assert.equal(signed.state, "signed"); assert.equal(signed.outcome, "Signed off");
  const back = briefStep(signed, { type: "undo" }, at(2)).brief!;
  assert.equal(back.state, "open"); assert.equal(back.outcome, null);
  assert.equal(briefStep(open(), { type: "undo" }, at(2)).appends.length, 0, "undo only reopens a signed-off brief");
});
test("§6 a turn the developer didn't start leaves the open brief open; only a newer brief supersedes it", () => {
  const b = open();
  const r = briefStep(b, { type: "turn_start" }, at(1));
  assert.equal(r.brief!.state, "open"); assert.equal(r.appends.length, 0);
  const next = briefStep(b, { type: "create", id: "brief:t2", turnId: "t2", content: pickBrief({ agent: { ask: "Newer ask", kind: "action" } }), flagged: true, seq: 2 }, at(2));
  assert.equal(next.appends[0].state, "superseded"); assert.equal(next.appends[0].outcome, "The agent kept going");
});
test("§6 permission answered retires the slim permission brief, and no other", () => {
  const perm = open("brief:t1:permission:p1", pickBrief({ permission: { title: "x", subagent: null } }));
  assert.equal(briefStep(perm, { type: "permission_resolved" }, at(1)).brief!.state, "superseded");
  assert.equal(briefStep(open(), { type: "permission_resolved" }, at(1)).appends.length, 0);
});
test("§6 CI red or review threads on an idle agent refresh the open brief's facts in place", () => {
  const b = open();
  const r = briefStep(b, { type: "facts", facts: [{ icon: "CircleX", label: "Checks failed · lint", tone: "bad" }] }, at(4));
  assert.equal(r.brief!.id, b.id); assert.equal(r.brief!.at, b.at, "the age doesn't reset"); assert.equal(r.brief!.facts[0].label, "Checks failed · lint");
});

// ---------- needs_you validation (§7.1) ----------

test("needs_you validation mirrors ask_question: lengths, 2–5 options, a recommendation, kinds, links and PRs", () => {
  const resolvePr = (ref: string) => { if (ref === "813") return "acme/app#813"; throw new Error(`No registered PR matches ${ref}.`); };
  assert.deepEqual(validateNeedsYou({ ask: "  Merge #813  ", kind: "review", links: [{ label: "PR", pr: "813" }] }, resolvePr), { ask: "Merge #813", kind: "review", links: [{ label: "PR", pr: "acme/app#813" }] });
  const bad: [Partial<NeedsYouCall>, RegExp][] = [
    [{ ask: "" }, /ask is required/], [{ ask: "x".repeat(121) }, /120/], [{ kind: "maybe" as never }, /kind must be/],
    [{ kind: "action", decisions: decision.decisions }, /only for kind/],
    [{ decisions: [{ question: "q", options: [{ label: "only" }], recommend: 0 }] }, /2–5 options/],
    [{ decisions: [{ question: "q", options: [{ label: "a" }, { label: "b" }] }] }, /Recommend one option/],
    [{ decisions: [{ question: "q", options: [{ label: "a" }, { label: "b" }], recommend: 2 }] }, /index from 0 to 1/],
    [{ decisions: Array(4).fill({ question: "q" }) }, /at most 3/],
    [{ decisions: [{ question: "q", options: [{ label: "x".repeat(61) }, { label: "b" }], recommend: 0 }] }, /1–60/],
    [{ context: "x".repeat(401) }, /400/],
    [{ links: [{ label: "both", url: "https://a.example", path: "a.ts" }] }, /exactly one/],
    [{ links: [{ label: "ftp", url: "ftp://a.example" }] }, /http/],
    [{ links: [{ label: "PR", pr: "999" }] }, /No registered PR/],
  ];
  for (const [patch, error] of bad) assert.throws(() => validateNeedsYou({ ...decision, ...patch } as NeedsYouCall, resolvePr), error);
  assert.doesNotThrow(() => validateNeedsYou({ ask: "Name the new table", kind: "decision", decisions: [{ question: "What should the table be called?" }] }, resolvePr), "a free-text decision has no options");
});

// ---------- the Inbox service: briefs at the real hook points ----------

const agent = (patch: Partial<AgentInfo> & { id: string }): AgentInfo => ({ workspaceId: "w1", parentAgentId: null, title: "Main", status: "idle", archivedAt: null, updatedAt: T0, lastUserMessageAt: null, requiresAttention: false, attentionReason: null, ...patch });
async function service(agents: AgentInfo[], o: { tails?: Record<string, unknown[]>; calls?: Record<string, NeedsYouRecord>; pr?: PrState | null; pauses?: GuardPause[]; now?: () => number; ledger?: Sources["ledger"]; callDelay?: number; settleMs?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "brief-"));
  const appended: { agentId: string; brief: Brief }[] = [];
  const directory: Directory = {
    async agents() { return agents; }, async workspaces() { return [{ id: "w1", name: "Synthetic workspace" }]; },
    async agent(id) { return agents.find(a => a.id === id) ?? null; }, async tail(id) { return o.tails?.[id] ?? []; }, async clearAttention() {},
  };
  let now = o.now ?? (() => Date.parse(at(1)));
  const inbox: Inbox = new Inbox(dir, {
    enabled: async () => ({ enable_inbox: true, enable_inbox_pr_closed: true }), directory,
    sources: { ledger: o.ledger ?? (async () => (await inbox.store.snapshot()).ledger), defer: async () => false, session: async () => false, schedule: async () => false },
    guard: async () => o.pauses ?? null, graceMs: 5, permissionSettleMs: o.settleMs ?? 30_000, settleMs: 40, settleStepMs: 5, now: () => now(),
    briefs: { async sink(agentId, brief) { appended.push({ agentId, brief }); }, async call(id) { if (o.callDelay) await new Promise(r => setTimeout(r, o.callDelay)); return o.calls?.[id] ?? null; }, async pr(_id, event) { return o.pr ? { ...o.pr, event: event ?? null } : null; } },
  });
  await inbox.store.mutate(s => { s.importedAt = T0; s.lastSeen = at(0); s.primedAt = T0; });
  return { inbox, appended, setNow: (f: () => number) => { now = f; }, entry: async (id = "main") => (await inbox.store.snapshot()).entries[id], done: () => rm(dir, { recursive: true, force: true }) };
}
const main = { id: "main", workspaceId: "w1", parentAgentId: null };

test("§6 turn completed and flagged: a brief from needs_you, and the inbox detail becomes the ask", async () => {
  const s = await service([agent({ id: "main" })], { calls: { main: { at: Date.parse(at(1)) - 1000, turnId: "t1", call: decision } } });
  await s.inbox.turnStarted(main, "t1");
  await s.inbox.turnEnded(main, { kind: "completed" }, "t1");
  const e = await s.entry();
  assert.equal(e.brief?.source, "agent"); assert.equal(e.brief?.id, "brief:t1"); assert.equal(e.brief?.flagged, true);
  assert.deepEqual(s.appended.map(a => [a.agentId, a.brief.state]), [["main", "open"]]);
  const rows = (await s.inbox.list()).rows;
  assert.equal(rows[0].brief?.ask, decision.ask);
  assert.deepEqual((await s.inbox.store.snapshot()).briefOrigins.map(o => o.origin), ["tool"]);
  await s.done();
});
test("§6 turn completed without needs_you: the honest fallback, recorded as fallback; a call from an earlier turn is ignored", async () => {
  const s = await service([agent({ id: "main" })], { calls: { main: { at: Date.parse(T0) - 3_600_000, turnId: "t0", call: decision } } });
  await s.inbox.turnStarted(main, "t1");
  await s.inbox.turnEnded(main, { kind: "completed" }, "t1");
  assert.equal((await s.entry()).brief?.source, "none");
  assert.deepEqual(briefShare(await s.inbox.store.snapshot(), Date.parse(at(1))), { days: 7, total: 1, tool: 0, structured: 0, extraction: 0, fallback: 1 });
  await s.done();
});
test("§6 plugin reloaded mid-turn: the turn start is lost, but a needs_you made after the previous brief still counts", async () => {
  const s = await service([agent({ id: "main" })], { calls: { main: { at: Date.parse(at(1)) - 1000, turnId: null, call: decision } } });
  await s.inbox.store.mutate(st => { st.entries.main = { needs: null, snooze: null, signedOffAt: null, lastTomMessageAt: null, seq: 1, undo: null, enable_finish_flags: true, goneAt: null, seenKeys: [], lastEventAt: at(0), brief: { ...open("brief:t0"), at: at(0), state: "answered" }, agentId: "main", muteTurn: false }; });
  await s.inbox.turnEnded(main, { kind: "completed" }, "t1");
  const e = await s.entry();
  assert.equal(e.brief?.source, "agent"); assert.equal(e.brief?.ask, decision.ask);
  await s.done();
});
test("§6 turn completed but not flagged (muted turn): an unflagged brief only if the agent stated one", async () => {
  for (const stated of [true, false]) {
    const s = await service([agent({ id: "main" })], { calls: stated ? { main: { at: Date.parse(at(1)), turnId: "t1", call: decision } } : {} });
    await s.inbox.store.mutate(st => { st.entries.main = { needs: null, snooze: null, signedOffAt: null, lastTomMessageAt: null, seq: 0, undo: null, enable_finish_flags: true, goneAt: null, seenKeys: [], lastEventAt: null, brief: null, agentId: "main", muteTurn: true }; });
    await s.inbox.turnEnded(main, { kind: "completed" }, "t1");
    const e = await s.entry();
    assert.equal(e.needs, null);
    assert.equal(e.brief?.flagged ?? null, stated ? false : null);
    assert.equal((await s.inbox.store.snapshot()).briefOrigins.length, 0, "only flagged turns count toward adoption");
    await s.done();
  }
});
test("§6 turn failed: an error brief, with needs_you kept below it", async () => {
  const s = await service([agent({ id: "main" })], { calls: { main: { at: Date.parse(at(1)), turnId: "t1", call: decision } } });
  await s.inbox.turnEnded(main, { kind: "failed", error: { message: "API error 529 · overloaded_error" } }, "t1");
  const b = (await s.entry()).brief!;
  assert.equal(b.source, "error"); assert.equal(b.ask, "The turn failed: API error 529 · overloaded_error"); assert.equal(b.also?.ask, decision.ask);
  await s.done();
});
test("§6 paused at attention: a paused brief from Session Guard; a waiting pause makes none", async () => {
  const pause = (phase: string): GuardPause => ({ id: "g1", agentId: "main", phase, turnId: "t1", note: "Stopped on step 4 of 6", anchorResetsAt: "not a date" });
  for (const [phase, expected] of [["attention", "paused"], ["waiting", null]] as const) {
    const s = await service([agent({ id: "main" })], { pauses: [pause(phase)] });
    await s.inbox.turnEnded(main, { kind: "canceled", reason: "guard" }, "t1");
    const b = (await s.entry())?.brief ?? null;
    assert.equal(b?.source ?? null, expected);
    if (b) assert.deepEqual(b.facts, [], "an unreadable reset time shows no fact rather than a wrong one");
    await s.done();
  }
});
test("§6 permission pending: a slim brief after the grace; answered → superseded; a subagent's lands on the root", async () => {
  const s = await service([agent({ id: "main" }), agent({ id: "sub", parentAgentId: "main", title: "Reviewer" })]);
  await s.inbox.permissionRequested(main, { id: "p1", title: "Run migration 0042 on staging?" });
  let b = (await s.entry()).brief!;
  assert.equal(b.source, "permission"); assert.equal(b.slim, true);
  assert.deepEqual(s.inbox.pendingPermissions(), ["main"]);
  await s.inbox.permissionResolved(main, "p1");
  b = (await s.entry()).brief!;
  assert.equal(b.state, "superseded"); assert.deepEqual(s.inbox.pendingPermissions(), []);
  await s.inbox.permissionRequested({ id: "sub", workspaceId: "w1", parentAgentId: "main" }, { id: "p2", title: "Edit config.ts" });
  b = (await s.entry()).brief!;
  assert.equal(b.ask, "Subagent Reviewer asks: Edit config.ts"); assert.equal(b.moves[0].agentId, "sub");
  assert.equal((await s.entry("sub"))?.brief ?? null, null, "subagents never get their own brief");
  await s.done();
});
test("a permission answered while its brief is being built never leaves a stale row", async () => {
  const s = await service([agent({ id: "main" }), agent({ id: "sub", parentAgentId: "main", title: "Follow-up: Summary" })], { callDelay: 40 });
  const sub = { id: "sub", workspaceId: "w1", parentAgentId: "main" };
  const pending = s.inbox.permissionRequested(sub, { id: "p1", title: "Bash" });
  // The grace (5 ms) has passed and the brief is still reading its sources (40 ms) when the answer lands.
  await new Promise(r => setTimeout(r, 15));
  await s.inbox.permissionResolved(sub, "p1");
  await pending;
  const e = await s.entry();
  assert.equal(e?.needs ?? null, null, "no Needs-you row for an answered prompt");
  assert.notEqual(e?.brief?.state, "open", "no open 'asks: Bash' card");
  assert.deepEqual(s.inbox.pendingPermissions(), []);
  await s.done();
});
test("a permission row whose prompt Paseo no longer shows clears; one still showing, or unknown, stays", async () => {
  const agents = [agent({ id: "main", pendingPermissionIds: [] }), agent({ id: "sub", parentAgentId: "main", pendingPermissionIds: [] }),
    agent({ id: "other", pendingPermissionIds: ["q1"] }), agent({ id: "legacy" })];
  let clock = Date.parse(at(1));
  const s = await service(agents, { now: () => clock, settleMs: 30_000 });
  for (const [who, id] of [[{ id: "sub", workspaceId: "w1", parentAgentId: "main" }, "p1"], [{ id: "other", workspaceId: "w1", parentAgentId: null }, "q1"], [{ id: "legacy", workspaceId: "w1", parentAgentId: null }, "r1"]] as const)
    await s.inbox.permissionRequested(who, { id, title: "Bash" });
  await s.inbox.reconcilePermissions();
  assert.equal((await s.entry())?.brief?.state, "open", "inside the settle time nothing is checked");
  clock += 31_000;
  await s.inbox.reconcilePermissions();
  const main = await s.entry();
  assert.equal(main.needs, null); assert.equal(main.brief?.state, "superseded"); assert.equal(main.brief?.outcome, "Permission answered");
  assert.equal((await s.entry("other")).brief?.state, "open", "a prompt Paseo still shows keeps its row");
  assert.equal((await s.entry("legacy")).brief?.state, "open", "unknown pending prompts never clear a row");
  assert.deepEqual(s.inbox.pendingPermissions().sort(), ["legacy", "other"]);
  await s.done();
});
test("§6 new turn: only the developer's own message answers; anything else leaves the card open", async () => {
  const s = await service([agent({ id: "main" })], { calls: { main: { at: Date.parse(at(1)), turnId: "t1", call: decision } }, tails: { main: [{ type: "user_message", text: "B" }] } });
  await s.inbox.turnEnded(main, { kind: "completed" }, "t1");
  await s.inbox.turnStarted(main, "t2");
  assert.equal((await s.entry()).brief?.outcome, "You picked B · One global bucket", "a developer option pick");
  await s.done();
  const reply = await service([agent({ id: "main" })], { calls: { main: { at: Date.parse(at(1)), turnId: "t1", call: decision } }, tails: { main: [{ type: "assistant_message", text: "Which one?" }, { type: "user_message", text: "Let me think, ask me after lunch" }] } });
  await reply.inbox.turnEnded(main, { kind: "completed" }, "t1");
  await reply.inbox.turnStarted(main, "t2");
  assert.equal((await reply.entry()).brief?.outcome, "You replied", "a developer reply");
  await reply.done();
  // Tom, 2026-11-10: another agent's message collapsed the card as "You replied". Paseo 0.15 stores it as an
  // agent_message tool call after the developer's previous message, which was mistaken for the reply.
  const cases: [string, unknown[]][] = [
    ["an agent message (Paseo 0.15 projection)", [{ type: "user_message", text: "B" }, { type: "assistant_message", text: "Done." }, { type: "tool_call", callId: "paseo-agent-message:m1", name: "agent_message", status: "completed", agentMessage: { event: "message", sender: { id: "other" }, text: "PR is up" } }]],
    ["an agent message (envelope text)", [{ type: "user_message", text: "<paseo-system version=\"1\" kind=\"agent-message\" source-agent-id=\"other\" message-id=\"m\">\nPR is up\n</paseo-system>" }]],
    ["a schedule or heartbeat", [{ type: "user_message", text: "B" }, { type: "tool_call", callId: "paseo-system:abc", name: "heartbeat", status: "completed" }]],
    ["a compaction continuation (no prompt in the tail yet)", [{ type: "user_message", text: "B" }, { type: "assistant_message", text: "Summary of the work so far" }]],
  ];
  cases.push(["a Follow-up batch prompt", [{ type: "user_message", text: "Workspace follow-through batch fix-1: 2 repairs", messageId: "batch-1" }]]);
  for (const [label, tail] of cases) {
    const other = await service([agent({ id: "main" })], { calls: { main: { at: Date.parse(at(1)), turnId: "t1", call: decision } }, tails: { main: tail },
      ledger: async () => [{ agentId: "main", messageId: "batch-1", at: at(1) }] });
    await other.inbox.turnEnded(main, { kind: "completed" }, "t1");
    await other.inbox.turnStarted(main, "t2");
    assert.equal((await other.entry()).brief?.state, "open", label);
    await other.done();
  }
});
test("repair: a card wrongly collapsed while its questions are open comes back open, in the inbox and the chat", async () => {
  const s = await service([agent({ id: "main" })], { calls: { main: { at: Date.parse(at(1)), turnId: "t1", call: decision, questionIds: ["Q20"] } }, tails: { main: [{ type: "user_message", text: "Looks good" }] } });
  await s.inbox.turnEnded(main, { kind: "completed" }, "t1");
  await s.inbox.turnStarted(main, "t2");
  assert.equal((await s.entry()).brief?.outcome, "You replied");
  assert.deepEqual(await s.inbox.reopenCollapsed(async () => new Set<string>()), [], "its questions are closed: stays answered");
  assert.deepEqual(await s.inbox.reopenCollapsed(async () => new Set(["Q20"])), ["main"]);
  assert.equal((await s.entry()).brief?.state, "open");
  assert.equal(s.appended.at(-1)?.brief.state, "open", "the chat card is re-appended open");
  assert.deepEqual(await s.inbox.reopenCollapsed(async () => new Set(["Q20"])), [], "idempotent");
  await s.done();
});
test("§6 sign off and undo (single and batch) update the brief and re-append it", async () => {
  const s = await service([agent({ id: "main" })], { calls: { main: { at: Date.parse(at(1)), turnId: "t1", call: decision } } });
  await s.inbox.turnEnded(main, { kind: "completed" }, "t1");
  await s.inbox.act({ action: "sign_off", agentIds: ["main"] });
  assert.equal((await s.entry()).brief?.state, "signed");
  await s.inbox.act({ action: "undo", agentIds: ["main"] });
  assert.equal((await s.entry()).brief?.state, "open");
  assert.deepEqual(s.appended.map(a => a.brief.state), ["open", "signed", "open"]);
  await s.done();
});
test("§6 CI red on an idle agent: facts refresh an open brief, or an S5 brief is made", async () => {
  const w = workspace({ prs: [pr({ snapshot: snapshot({ failedChecks: ["lint"] }) })] });
  const red: PrState = { ...prFacts, facts: [{ icon: "CircleX", label: "Checks failed · lint", tone: "bad" }], event: null };
  const s = await service([agent({ id: w.mainAgentId })], { pr: red });
  await s.inbox.observeFollowUp({ workspaces: [w] } as never);
  const b = (await s.entry(w.mainAgentId)).brief!;
  assert.equal(b.source, "followup"); assert.match(b.ask, /^Checks failed on #\d+/);
  await s.done();
});
test("§6 an option click is the developer's message: ledger by developer, the classifier says tom, the flag clears", async () => {
  const s = await service([agent({ id: "main" })], { calls: { main: { at: Date.parse(at(1)), turnId: "t1", call: decision } } });
  await s.inbox.turnEnded(main, { kind: "completed" }, "t1");
  const id = (await s.entry()).brief!.id;
  const sent: { text: string; messageId: string }[] = [];
  const after = await s.inbox.briefAction("main", { briefId: id, decisionId: "D1", choice: "A" }, async (text, messageId) => { sent.push({ text, messageId }); });
  assert.equal(after.state, "answered"); assert.match(sent[0].text, /^Follow-up answer D1 \(Per-tenant buckets or one global bucket\?\): A — Per-tenant buckets/);
  const ledger = (await s.inbox.store.snapshot()).ledger;
  assert.deepEqual(ledger.map(l => [l.messageId, l.by]), [[sent[0].messageId, "developer"]]);
  const sources: Sources = { ledger: async () => ledger, defer: async () => false, session: async () => false, schedule: async () => false };
  assert.equal(await classify({ text: sent[0].text, messageId: sent[0].messageId }, "main", Date.parse(at(1)), sources), "tom");
  assert.equal(await classify({ text: "repair batch", messageId: "m2" }, "main", Date.parse(at(1)), { ...sources, ledger: async () => [{ agentId: "main", messageId: "m2", at: at(1) }] }), "follow-up", "Follow-up's own sends stay automation");
  s.inbox["o"].directory.tail = async () => [{ type: "user_message", text: sent[0].text, messageId: sent[0].messageId }];
  await s.inbox.turnStarted(main, "t2");
  assert.equal((await s.entry()).needs, null, "the flag clears as the developer's message (#11)");
  await assert.rejects(s.inbox.briefAction("main", { briefId: id, decisionId: "D1", choice: "B" }, async () => {}), /already answered/);
  await assert.rejects(s.inbox.briefAction("main", { briefId: "brief:old", decisionId: "D1", choice: "B" }, async () => {}), /replaced by a newer one/);
  await s.done();
});
test("restart: Follow-up's own brief append bumps updatedAt, and the restart check doesn't re-flag because of it", async () => {
  // Regression guard: 1.1.0-beta.1 already reads Paseo's unread time, not updatedAt; this keeps the brief's append from ever counting.
  const s = await service([agent({ id: "main", updatedAt: at(30), status: "idle", requiresAttention: false })], { calls: { main: { at: Date.parse(at(1)), turnId: "t1", call: decision } } });
  await s.inbox.turnEnded(main, { kind: "completed" }, "t1");
  await s.inbox.act({ action: "sign_off", agentIds: ["main"] });
  await s.inbox.store.mutate(st => { st.lastSeen = at(2); });
  s.setNow(() => Date.parse(at(40)));
  await s.inbox.start();
  const e = await s.entry();
  assert.equal(e.needs, null); assert.equal(e.brief?.state, "signed");
  await s.done();
});

// ---------- R1: the card fits above the composer ----------

test("R1: phones and short windows use the tight layout; a roomy desktop window shows everything", () => {
  const b = pickBrief({ agent: decision });
  const full = { ...b, facts: prFacts.facts };
  assert.equal(isTight(full, true, 844), true);
  assert.equal(isTight(full, false, 1200), false);
  assert.equal(isTight(full, false, 700), true, "a desktop window shorter than the card");
});

test("R1: on a 390×844 phone, context and facts stay inline when the card fits; Details only when they'd overflow", () => {
  const b = pickBrief({ agent: decision });
  assert.equal(extrasFit({ ...b, facts: prFacts.facts }, 844), true);
  const crowded = { ...b, decisions: [...b.decisions, ...b.decisions], facts: prFacts.facts };
  assert.equal(extrasFit(crowded, 844), false);
});

test("a superseded fallback reads as 'no ask was stated', not as an earlier ask", () => {
  const fb = { ...pickBrief({}), state: "superseded" as const, outcome: "The agent kept going" };
  assert.equal(collapsedLine(fb), "No ask was stated · the agent kept going");
  const d = { ...pickBrief({ agent: decision }), state: "superseded" as const, outcome: "The agent kept going" };
  assert.match(collapsedLine(d), /^Earlier ask, the agent kept going: /);
});

// ---------- R2: the Stop-hook nudge ----------

test("R2: the nudge decision covers called, not called, already nudged, permission pending, subagent, setting off and inbox off", async () => {
  process.env.FOLLOW_THROUGH_HOOK_IMPORT = "1";
  // @ts-expect-error plain JS hook, generated into hook-source.ts
  const { shouldNudge } = await import("../server/agent-hook.mjs");
  const base = { provider: "claude", brief: { enable_inbox: true, enable_brief_nudge: true, pending: [] }, agentId: "a1", contributor: false, recovery: false, subagent: false, stopHookActive: false, turn: { startedAt: 1000, stopped: false }, called: null };
  assert.equal(shouldNudge(base), true, "not called");
  assert.equal(shouldNudge({ ...base, called: { at: 2000 } }), false, "called this turn");
  assert.equal(shouldNudge({ ...base, called: { at: 500 } }), true, "a call from an earlier turn doesn't count");
  assert.equal(shouldNudge({ ...base, turn: { startedAt: 1000, stopped: true } }), false, "already nudged this turn");
  assert.equal(shouldNudge({ ...base, stopHookActive: true }), false, "stop_hook_active: never loops");
  assert.equal(shouldNudge({ ...base, brief: { ...base.brief, pending: ["a1"] } }), false, "permission pending");
  assert.equal(shouldNudge({ ...base, subagent: true }), false, "subagent");
  assert.equal(shouldNudge({ ...base, contributor: true }), false, "contributor");
  assert.equal(shouldNudge({ ...base, recovery: true }), false, "recovery");
  assert.equal(shouldNudge({ ...base, brief: { ...base.brief, enable_brief_nudge: false } }), false, "setting off");
  assert.equal(shouldNudge({ ...base, brief: { ...base.brief, enable_inbox: false } }), false, "inbox off");
  assert.equal(shouldNudge({ ...base, brief: null }), false, "unknown state never nudges");
  assert.equal(shouldNudge({ ...base, provider: "codex" }), false, "Codex gets the instruction only");
  assert.equal(shouldNudge({ ...base, turn: null }), false, "no turn marker, no nudge");
});

async function hookHome(t: { after: (f: () => Promise<void>) => void }, brief: object) {
  const root = await mkdtemp(join(tmpdir(), "brief-hook-")); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "plugin-data/follow-through"); await mkdir(join(directory, "hook-state"), { recursive: true });
  await writeFile(join(directory, "agent-hook.mjs"), await readFile(resolve("server/agent-hook.mjs"), "utf8"));
  await writeFile(join(directory, "hooks-enabled.json"), JSON.stringify({ expiresAt: Date.now() + 60_000, clientEntry: "/fixture/client.js" }));
  await writeFile(join(directory, "state.json"), JSON.stringify({ workspaces: [] }));
  await writeFile(join(directory, "brief.json"), JSON.stringify(brief));
  const fire = (event: object, env: Record<string, string> = {}) => new Promise<string>((ok, bad) => {
    const child = spawn(process.execPath, [join(directory, "agent-hook.mjs")], { env: { ...process.env, FOLLOW_THROUGH_HOOK_IMPORT: "", PASEO_AGENT_ID: "a1", FOLLOW_THROUGH_BRIEF: "claude", FOLLOW_THROUGH_RECOVERY: "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = ""; child.stdout.on("data", c => out += c); child.once("error", bad); child.once("exit", () => ok(out.trim()));
    child.stdin.end(JSON.stringify({ session_id: "s1", ...event }));
  });
  return { directory, fire };
}
test("R2: the installed hook nudges an untracked Claude Code root agent once per turn and never loops", async t => {
  const h = await hookHome(t, { enable_inbox: true, enable_brief_nudge: true, pending: [] });
  assert.equal(await h.fire({ hook_event_name: "UserPromptSubmit", prompt: "do it" }), "", "untracked agents get no sidebar instructions");
  const first = JSON.parse(await h.fire({ hook_event_name: "Stop" }));
  assert.equal(first.decision, "block"); assert.equal(first.reason, NEEDS_YOU_NUDGE);
  assert.equal(await h.fire({ hook_event_name: "Stop", stop_hook_active: true }), "", "the continuation stops");
  assert.equal(await h.fire({ hook_event_name: "Stop" }), "", "at most one nudge per turn");
  await h.fire({ hook_event_name: "UserPromptSubmit", prompt: "next" });
  await new Promise(r => setTimeout(r, 5));
  await writeFile(join(h.directory, "hook-state", "needs-you-a1.json"), JSON.stringify({ at: Date.now() + 1, turnId: null, call: {} }));
  assert.equal(await h.fire({ hook_event_name: "Stop" }), "", "called this turn: no nudge");
  assert.equal(await h.fire({ hook_event_name: "UserPromptSubmit", prompt: "x" }, { FOLLOW_THROUGH_BRIEF: "" }), "");
  assert.equal(await h.fire({ hook_event_name: "Stop" }, { FOLLOW_THROUGH_BRIEF: "" }), "", "not launched as a brief root (subagent or contributor): nothing");
  assert.equal(await h.fire({ hook_event_name: "Stop", agent_id: "task-1" }), "", "Claude Code subagents never");
});
test("R2: setting off or inbox off means the hook stays silent for untracked agents", async t => {
  for (const brief of [{ enable_inbox: true, enable_brief_nudge: false }, { enable_inbox: false, enable_brief_nudge: true }]) {
    const h = await hookHome(t, brief);
    await h.fire({ hook_event_name: "UserPromptSubmit", prompt: "go" });
    assert.equal(await h.fire({ hook_event_name: "Stop" }), "");
  }
});

// ---------- the instruction and the bridge ----------

test("the bridge's instruction and the hook's nudge match the shared wording exactly (§7.2)", async () => {
  const bridge = await readFile(resolve("server/mcp.mjs"), "utf8");
  const hook = await readFile(resolve("server/agent-hook.mjs"), "utf8");
  assert.ok(bridge.includes(JSON.stringify(NEEDS_YOU_INSTRUCTION)), "mcp.mjs instruction");
  assert.ok(hook.includes(JSON.stringify(NEEDS_YOU_NUDGE)), "agent-hook.mjs nudge");
});
test("needs_you reaches an untracked root agent while the inbox is on, never otherwise, with the instruction", async t => {
  const root = await mkdtemp(join(tmpdir(), "brief-mcp-")); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "plugin-data/follow-through"); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "hooks-enabled.json"), JSON.stringify({ expiresAt: Date.now() + 60_000 }));
  await writeFile(join(directory, "state.json"), JSON.stringify({ workspaces: [] }));
  const ask = (env: Record<string, string>) => new Promise<any[]>((ok, bad) => {
    const child = spawn(process.execPath, [resolve("server/mcp.mjs")], { env: { ...process.env, PASEO_HOME: root, PASEO_AGENT_ID: "a1", FOLLOW_THROUGH_RECOVERY: "", FOLLOW_THROUGH_BRIEF: "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = ""; child.stdout.on("data", c => out += c); child.once("error", bad); child.once("exit", () => ok(out.trim().split("\n").map(l => JSON.parse(l))));
    child.stdin.end([{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { jsonrpc: "2.0", id: 2, method: "tools/list" }].map(r => JSON.stringify(r)).join("\n") + "\n");
  });
  await writeFile(join(directory, "brief.json"), JSON.stringify({ enable_inbox: true, enable_brief_nudge: true }));
  const on = await ask({ FOLLOW_THROUGH_BRIEF: "claude" });
  assert.deepEqual(on[1].result.tools.map((x: { name: string }) => x.name), ["needs_you"]);
  assert.equal(on[0].result.instructions, NEEDS_YOU_INSTRUCTION);
  assert.deepEqual((await ask({}))[1].result.tools, [], "not launched as a root agent");
  assert.deepEqual((await ask({ FOLLOW_THROUGH_BRIEF: "claude", FOLLOW_THROUGH_RECOVERY: "1" }))[1].result.tools, [], "recovery");
  await writeFile(join(directory, "brief.json"), JSON.stringify({ enable_inbox: false, enable_brief_nudge: true }));
  assert.deepEqual((await ask({ FOLLOW_THROUGH_BRIEF: "claude" }))[1].result.tools, [], "inbox off");
});
test("prState reads the agent's newest open PR and only says merge-ready when it is", () => {
  const ready = workspace({ prs: [pr({ snapshot: snapshot({ reviewDecision: "APPROVED" }) })] });
  const s = prState(ready, ready.mainAgentId)!;
  assert.equal(s.mergeable, true); assert.deepEqual(s.facts.map(f => f.label), ["Required checks pass", "Approved · no conflicts"]);
  assert.equal(prState(workspace({ prs: [pr({ snapshot: snapshot({ reviewDecision: "APPROVED", conflict: true }) })] }), ready.mainAgentId)!.mergeable, false);
  assert.equal(prState(null, "x"), null);
});

// ---------- F7: "Nothing needed" and still-running turns don't flag ----------

const doneCall: NeedsYouCall = { ask: "Nothing needed. Background verification is still running.", kind: "done" };
test("F7 (1): a turn ending with needs_you kind=done doesn't flag: no inbox flag, an unflagged muted brief", async () => {
  const s = await service([agent({ id: "main" })], { calls: { main: { at: Date.parse(at(1)), turnId: "t1", call: doneCall } } });
  await s.inbox.turnStarted(main, "t1");
  await s.inbox.turnEnded(main, { kind: "completed" }, "t1");
  const e = await s.entry();
  assert.equal(e.needs, null, "no Needs-you flag");
  assert.equal(e.brief?.kind, "done"); assert.equal(e.brief?.flagged, false); assert.deepEqual(e.brief?.moves, []);
  assert.equal((await s.inbox.list()).rows.find(r => r.agentId === "main")?.needs ?? null, null);
  await s.done();
});
test("F7 (1): an older open flag and its card stay when a later turn says nothing is needed", async () => {
  const s = await service([agent({ id: "main" })], { calls: { main: { at: Date.parse(at(1)), turnId: "t1", call: decision } } });
  await s.inbox.turnStarted(main, "t1");
  await s.inbox.turnEnded(main, { kind: "completed" }, "t1");
  const before = await s.entry();
  assert.ok(before.needs); assert.equal(before.brief?.kind, "decision");
  // The developer didn't answer; an automated continuation ends with kind=done.
  const later = await service([agent({ id: "main" })], { calls: { main: { at: Date.parse(at(1)), turnId: "t2", call: doneCall } } });
  await later.inbox.store.mutate(st => { st.entries.main = before; });
  await later.inbox.turnEnded(main, { kind: "completed" }, "t2");
  const after = await later.entry();
  assert.deepEqual(after.needs, before.needs, "the decision flag stays");
  assert.equal(after.brief?.id, before.brief?.id, "the decision card isn't replaced");
  await s.done(); await later.done();
});
test("F7 (2): while Paseo shows the agent running, a plain finish adds nothing", async () => {
  const s = await service([agent({ id: "main", status: "running" })]);
  await s.inbox.turnStarted(main, "t1");
  await s.inbox.turnEnded(main, { kind: "completed" }, "t1");
  const e = await s.entry();
  assert.equal(e.needs, null); assert.equal(e.brief ?? null, null);
  await s.done();
});
test("F7 (2b): Paseo still says running at the turn-end instant, then goes idle: the finish flags", async () => {
  const agents = [agent({ id: "main", status: "running" })];
  const s = await service(agents);
  await s.inbox.turnStarted(main, "t1");
  setTimeout(() => { agents[0] = { ...agents[0], status: "idle" }; }, 10);
  await s.inbox.turnEnded(main, { kind: "completed" }, "t1");
  const e = await s.entry();
  assert.deepEqual(e.needs?.reasons.map(r => r.reason), ["finished"]);
  await s.done();
});
test("F7 (3): a turn without needs_you on an idle agent still flags as finished", async () => {
  const s = await service([agent({ id: "main", status: "idle" })]);
  await s.inbox.turnStarted(main, "t1");
  await s.inbox.turnEnded(main, { kind: "completed" }, "t1");
  const e = await s.entry();
  assert.deepEqual(e.needs?.reasons.map(r => r.reason), ["finished"]);
  assert.equal(e.brief?.source, "none");
  await s.done();
});
test("F7: finishIsQuiet covers done, running and the unknown case", () => {
  assert.equal(finishIsQuiet("done", "idle"), true);
  assert.equal(finishIsQuiet("done", "running"), true);
  assert.equal(finishIsQuiet(null, "running"), true);
  assert.equal(finishIsQuiet(null, "idle"), false, "nothing stated: we don't know, so it flags");
  assert.equal(finishIsQuiet("decision", "running"), false, "an ask still flags while background work runs");
  assert.equal(finishIsQuiet(null, null), false);
});
test("F7 (4): the nudge and the tool say kind=done won't flag", () => {
  assert.match(NEEDS_YOU_NUDGE, /won't flag/); assert.match(NEEDS_YOU_INSTRUCTION, /won't flag/);
});
