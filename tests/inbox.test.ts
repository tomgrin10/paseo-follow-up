import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareNeeds, displayReason, newEntry, nextAfter, reduce, replay, rowTitle, sectionRows, StaleSignOff, stateOf, type Entry, type InboxEvent, type InboxRow } from "../shared/inbox";
import { classify, fileSources, newestUserMessage, type Sources } from "../server/inbox-classifier";
import { followUpEvents, Inbox, REVISION, type AgentInfo, type Directory, type GuardPause } from "../server/inbox";
import { pr, snapshot, workspace } from "./fixtures";

const T0 = "2026-11-08T10:00:00.000Z";
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();
const run = (events: InboxEvent[], start: Entry = newEntry("a1")) => events.reduce((e, ev, i) => reduce(e, ev, at(i)), start);
const finished: InboxEvent = { type: "turn_end", outcome: "completed", detail: "Opened PR #815" };
const needs = (e: Entry) => e.needs?.reasons.map(r => r.reason).sort() ?? [];
const snoozed = (e: Entry) => reduce(reduce(e, finished, at(0)), { type: "snooze", until: at(600) }, at(1));

// Table 2.3, one test per row.
test("#1 a completed turn flags a quiet agent and adds to a flagged one", () => {
  const e = run([finished]);
  assert.equal(stateOf(e), "NEEDS"); assert.deepEqual(needs(e), ["finished"]);
  const more = run([{ type: "permission", requestId: "p1", detail: "Run migration?" }, finished]);
  assert.deepEqual(needs(more), ["finished", "permission"]);
  assert.equal(more.needs!.since, at(0), "since keeps the first unresolved event");
});
test("#1b a plain finish doesn't break a snooze", () => {
  const e = reduce(snoozed(newEntry("a1")), { ...finished, detail: "second" }, at(2));
  assert.equal(stateOf(e), "LATER");
  assert.equal(e.needs!.reasons[0].detail, "second", "the reason updates");
});
test("#2 a failed turn flags an error and breaks a snooze", () => {
  const e = reduce(snoozed(newEntry("a1")), { type: "turn_end", outcome: "failed", detail: "Provider overloaded (529)" }, at(2));
  assert.equal(stateOf(e), "NEEDS"); assert.deepEqual(needs(e), ["error", "finished"]);
  assert.equal(stateOf(reduce({ ...newEntry("a1"), goneAt: T0 }, { type: "turn_end", outcome: "failed", detail: "x" }, at(1))), "GONE");
});
test("#3 the developer's own interrupt changes nothing", () => {
  for (const start of [newEntry("a1"), run([finished])]) {
    const e = reduce(start, { type: "turn_end", outcome: "canceled", guard: null, detail: "" }, at(5));
    assert.deepEqual(e.needs, start.needs);
  }
});
test("#3b a cancel owned by Session Guard follows #7: attention flags, waiting doesn't", () => {
  assert.deepEqual(needs(run([{ type: "turn_end", outcome: "canceled", guard: "attention", detail: "Pick an account" }])), ["paused"]);
  assert.equal(stateOf(run([{ type: "turn_end", outcome: "canceled", guard: "waiting", detail: "" }])), "QUIET");
});
test("#4 a permission prompt flags and breaks a snooze", () => {
  const e = reduce(snoozed(newEntry("a1")), { type: "permission", requestId: "p1", detail: "Run migration 0042 on staging?" }, at(2));
  assert.equal(stateOf(e), "NEEDS");
  assert.equal(displayReason(e.needs)!.detail, "Run migration 0042 on staging?");
});
test("#5 answering the permission drops it; with nothing else left the agent is quiet (D1)", () => {
  const only = run([{ type: "permission", requestId: "p1", detail: "q" }, { type: "permission_resolved", requestId: "p1" }]);
  assert.equal(stateOf(only), "QUIET");
  const withFinish = run([finished, { type: "permission", requestId: "p1", detail: "q" }, { type: "permission_resolved", requestId: "p1" }]);
  assert.deepEqual(needs(withFinish), ["finished"]);
});
test("#6 a crash flags an error", () => assert.deepEqual(needs(run([{ type: "crash", detail: "Closed during a turn" }])), ["error"]));
test("#7 a Session Guard pause needing a decision flags once per pause", () => {
  const e = run([{ type: "paused", pauseId: "g1", detail: "Usage limit" }, { type: "sign_off" }, { type: "paused", pauseId: "g1", detail: "Usage limit" }]);
  assert.equal(stateOf(e), "QUIET", "the same pause never re-flags after sign-off");
  assert.deepEqual(needs(reduce(e, { type: "paused", pauseId: "g2", detail: "again" }, at(9))), ["paused"]);
});
test("#8 failed checks flag once per head SHA and stay quiet while a repair batch is out", () => {
  const ci = (sha: string, suppressed = false): InboxEvent => ({ type: "ci", dedupeKey: `r#1:${sha}:checks`, detail: "#1 lint", suppressed });
  const e = run([ci("a"), { type: "sign_off" }, ci("a")]);
  assert.equal(stateOf(e), "QUIET", "the same red CI never re-flags after sign-off");
  assert.deepEqual(needs(reduce(e, ci("b"), at(9))), ["ci"]);
  assert.equal(stateOf(run([ci("c", true)])), "QUIET");
});
test("#9 new review threads flag once per thread set", () => {
  const review: InboxEvent = { type: "review", dedupeKey: "r#1:threads:t1", detail: "1 thread on #1" };
  assert.equal(stateOf(run([review, { type: "sign_off" }, review])), "QUIET");
  assert.deepEqual(needs(run([review])), ["review"]);
});
test("#10 a merged PR flags at the lowest priority and wakes a 'until it merges' snooze", () => {
  const e = run([finished, { type: "pr_closed", dedupeKey: "r#1:MERGED", detail: "#1 merged", prKey: "r#1" }]);
  assert.equal(displayReason(e.needs)!.reason, "finished");
  const s = run([finished, { type: "snooze", until: "pr:r#1" }, { type: "pr_closed", dedupeKey: "r#1:MERGED", detail: "#1 merged", prKey: "r#1" }]);
  assert.equal(stateOf(s), "NEEDS");
});
test("#11 the developer's message clears flags and the snooze from any state", () => {
  for (const start of [run([finished]), snoozed(newEntry("a1"))]) {
    const e = reduce(start, { type: "message", from: "tom" }, at(30));
    assert.equal(stateOf(e), "QUIET"); assert.equal(e.lastTomMessageAt, at(30));
  }
});
test("#12 automation messages change nothing; their turn end flags as usual", () => {
  const e = run([finished, { type: "message", from: "automation" }]);
  assert.deepEqual(needs(e), ["finished"]);
  assert.equal(stateOf(run([{ type: "message", from: "automation" }, finished])), "NEEDS");
});
test("#13 sign-off clears what's flagged, records undo, and rejects a stale seq", () => {
  const flagged = run([finished]);
  const e = reduce(flagged, { type: "sign_off", seq: flagged.seq }, at(5));
  assert.equal(stateOf(e), "QUIET"); assert.ok(e.undo); assert.equal(e.signedOffAt, at(5));
  assert.throws(() => reduce(reduce(flagged, finished, at(6)), { type: "sign_off", seq: flagged.seq }, at(7)), StaleSignOff);
  assert.equal(stateOf(reduce(snoozed(newEntry("a1")), { type: "sign_off" }, at(5))), "QUIET", "from Later too");
});
test("#14 undo restores the exact record and its age; it expires after 24 h", () => {
  const flagged = run([finished, { type: "permission", requestId: "p", detail: "q" }]);
  const off = reduce(flagged, { type: "sign_off" }, at(10));
  const back = reduce(off, { type: "undo" }, at(11));
  assert.deepEqual(back.needs, flagged.needs);
  const late = reduce(off, { type: "undo" }, new Date(Date.parse(at(10)) + 25 * 3_600_000).toISOString());
  assert.equal(stateOf(late), "QUIET");
  const merged = reduce(reduce(off, { type: "crash", detail: "x" }, at(12)), { type: "undo" }, at(13));
  assert.deepEqual(needs(merged), ["error", "finished", "permission"], "undo after a newer flag keeps both");
  assert.equal(merged.needs!.since, flagged.needs!.since);
});
test("#15 snooze moves Needs you to Later; a quiet agent can't be snoozed", () => {
  assert.equal(stateOf(snoozed(newEntry("a1"))), "LATER");
  assert.equal(stateOf(reduce(newEntry("a1"), { type: "snooze", until: at(60) }, at(0))), "QUIET");
});
test("#16 an expired snooze comes back with its original age; 'next event' wakes on any flag", () => {
  const e = snoozed(newEntry("a1"));
  assert.equal(stateOf(reduce(e, { type: "tick" }, at(599))), "LATER");
  const woke = reduce(e, { type: "tick" }, at(600));
  assert.equal(stateOf(woke), "NEEDS"); assert.equal(woke.needs!.since, at(0));
  const next = run([finished, { type: "snooze", until: "next-event" }, finished]);
  assert.equal(stateOf(next), "NEEDS");
});
test("#17 opening, reading and Paseo marking it read change nothing", () => {
  const flagged = run([finished]);
  const e = reduce(flagged, { type: "open" }, at(9));
  assert.deepEqual(e, flagged); assert.equal(e.seq, flagged.seq);
});
test("#18 archive hides the agent; unarchive within 7 days restores it", () => {
  const gone = reduce(run([finished]), { type: "archive" }, at(5));
  assert.equal(stateOf(gone), "GONE");
  assert.equal(stateOf(reduce(gone, { type: "unarchive" }, at(60))), "NEEDS");
  assert.equal(stateOf(reduce(gone, { type: "unarchive" }, new Date(Date.parse(at(5)) + 8 * 86_400_000).toISOString())), "GONE");
});

// Stubbed daemon for the service-level rows (#19, #20, D3, D4).
function fake(agents: AgentInfo[], tails: Record<string, unknown[]> = {}, pauses: GuardPause[] | null = null) {
  const cleared: string[][] = [];
  const directory: Directory = {
    async agents() { return agents; },
    async workspaces() { return [{ id: "w1", name: "TKT-2056 Export to CSV" }, { id: "w2", name: "Cleanup orchestrator" }]; },
    async agent(id) { return agents.find(a => a.id === id) ?? null; },
    async tail(id) { return tails[id] ?? []; },
    async clearAttention(ids) { cleared.push(ids); },
  };
  const none: Sources = { ledger: async () => [], defer: async () => false, session: async () => false, schedule: async () => false };
  return { directory, none, cleared, pauses };
}
const agent = (patch: Partial<AgentInfo> & { id: string }): AgentInfo => ({ workspaceId: "w1", parentAgentId: null, title: "Main", status: "idle", archivedAt: null, updatedAt: T0, lastUserMessageAt: null, requiresAttention: false, attentionReason: null, ...patch });
async function service(agents: AgentInfo[], options: { tails?: Record<string, unknown[]>; sources?: Partial<Sources>; pauses?: GuardPause[]; now?: () => number; enable_inbox?: boolean; dir?: string } = {}) {
  const dir = options.dir ?? await mkdtemp(join(tmpdir(), "inbox-"));
  const f = fake(agents, options.tails, options.pauses ?? null);
  const inbox = new Inbox(dir, { enabled: async () => ({ enable_inbox: options.enable_inbox ?? true, enable_inbox_pr_closed: true }), directory: f.directory, sources: { ...f.none, ...options.sources }, guard: async () => options.pauses ?? null, graceMs: 5, now: options.now ?? (() => Date.parse(at(1))) });
  return { inbox, cleared: f.cleared, done: () => rm(dir, { recursive: true, force: true }) };
}
const mark = async (inbox: Inbox) => inbox.store.mutate(s => { s.importedAt = T0; s.lastSeen = at(1); s.primedAt = T0; });

test("#19 a subagent's permission and error flag its parent; its finish doesn't", async () => {
  const { inbox, done } = await service([agent({ id: "main" }), agent({ id: "sub", parentAgentId: "main", title: "Reviewer" })]);
  await mark(inbox);
  const sub = { id: "sub", workspaceId: "w1", parentAgentId: "main" };
  await inbox.turnEnded(sub, { kind: "completed" }, "t1");
  assert.equal((await inbox.store.snapshot()).entries.main, undefined);
  await inbox.permissionRequested(sub, { id: "p1", title: "Run migration?" });
  const s = await inbox.store.snapshot();
  assert.match(displayReason(s.entries.main.needs)!.detail, /^Subagent asks/);
  assert.equal(s.entries.sub, undefined, "a subagent never gets its own row");
  await done();
});
test("#20 a turn that ended while the worker was down flags on start", async () => {
  // Both agents' updatedAt moved when the daemon came back; only a1 finished (Paseo marked it unread) after lastSeen.
  const unread = { requiresAttention: true, attentionReason: "finished" };
  const { inbox, done } = await service([agent({ id: "a1", updatedAt: at(39), ...unread, attentionTimestamp: at(30) }), agent({ id: "a2", updatedAt: at(39), ...unread, attentionTimestamp: at(0) }), agent({ id: "a3", updatedAt: at(39) })], { now: () => Date.parse(at(40)) });
  await mark(inbox);
  await inbox.start();
  const s = await inbox.store.snapshot();
  assert.equal(stateOf(s.entries.a1), "NEEDS"); assert.match(displayReason(s.entries.a1.needs)!.detail, /offline/);
  assert.equal(s.entries.a1.needs!.since, at(30), "the flag dates from the finish, not the restart");
  assert.equal(s.entries.a2, undefined, "activity before the worker stopped isn't news");
  assert.equal(s.entries.a3, undefined, "a bumped updatedAt alone isn't a finish");
  await done();
});
test("D3: a delegated agent's finish doesn't flag until the developer writes to it", async () => {
  const agents = [agent({ id: "orch", workspaceId: "w2" }), agent({ id: "del", parentAgentId: "orch" })];
  const { inbox, done } = await service(agents, { tails: { del: [{ type: "user_message", text: "please also add tests" }] } });
  await mark(inbox);
  const del = { id: "del", workspaceId: "w1", parentAgentId: "orch" };
  await inbox.turnEnded(del, { kind: "completed" }, "t1");
  assert.equal(stateOf((await inbox.store.snapshot()).entries.del), "QUIET");
  await inbox.permissionRequested(del, { id: "p", title: "Push?" });
  assert.equal(stateOf((await inbox.store.snapshot()).entries.del), "NEEDS", "permissions still flag the developer");
  await inbox.turnStarted(del);
  await inbox.turnEnded(del, { kind: "completed" }, "t2");
  assert.deepEqual(needs((await inbox.store.snapshot()).entries.del), ["finished"], "once the developer writes, it's theirs");
  await done();
});
test("D4 first run imports Paseo's unread and recent unanswered agents; older ones go to Unsorted", async () => {
  const now = Date.parse("2026-11-08T12:00:00.000Z");
  const bumped = "2026-11-08T11:59:00.000Z"; // Paseo's updatedAt after a daemon restart: not activity.
  const agents = [
    agent({ id: "unread", requiresAttention: true, attentionReason: "finished", attentionTimestamp: "2026-11-07T08:00:00.000Z", updatedAt: bumped }),
    agent({ id: "perm", requiresAttention: true, attentionReason: "permission", attentionTimestamp: "2026-11-08T11:00:00.000Z", updatedAt: bumped }),
    agent({ id: "recent", updatedAt: bumped, lastUserMessageAt: "2026-11-06T09:00:00.000Z" }),
    agent({ id: "never-asked", updatedAt: bumped, createdAt: "2026-11-06T10:00:00.000Z" }), // nothing from the developer to answer
    agent({ id: "old", updatedAt: bumped, lastUserMessageAt: "2026-10-01T10:00:00.000Z" }),
    agent({ id: "busy", status: "running" }),
    agent({ id: "child", parentAgentId: "unread" }),
  ];
  const { inbox, done } = await service(agents, { now: () => now });
  await inbox.start();
  const s = await inbox.store.snapshot();
  assert.deepEqual(Object.keys(s.entries).filter(id => stateOf(s.entries[id]) === "NEEDS").sort(), ["perm", "recent", "unread"]);
  assert.deepEqual(s.unsorted?.sort(), ["never-asked", "old"]);
  assert.ok(s.importedAt);
  assert.equal(s.revision, REVISION, "a fresh import needs no migration");
  // A confirmed "Sign off all" empties Unsorted; one Undo restores the whole batch.
  await inbox.act({ action: "unsorted_sign_off" });
  assert.equal((await inbox.store.snapshot()).unsorted, null);
  await inbox.act({ action: "batch_undo" });
  assert.deepEqual((await inbox.store.snapshot()).unsorted?.sort(), ["never-asked", "old"]);
  await inbox.start();
  assert.deepEqual((await inbox.store.snapshot()).unsorted?.sort(), ["never-asked", "old"], "import runs once");
  await done();
});

test("first run: closed and archived agents are not imported, and a closed agent without a flag stays hidden (§2.5)", async () => {
  const now = Date.parse("2026-11-08T12:00:00.000Z");
  const recentAt = "2026-11-08T09:00:00.000Z";
  const agents = [
    agent({ id: "closed", status: "closed", lastUserMessageAt: recentAt }),
    agent({ id: "closed-unread", status: "closed", requiresAttention: true, attentionReason: "finished", attentionTimestamp: recentAt }),
    agent({ id: "archived", archivedAt: "2026-11-07T10:00:00.000Z", lastUserMessageAt: recentAt }),
    agent({ id: "open", lastUserMessageAt: recentAt }),
  ];
  const { inbox, done } = await service(agents, { now: () => now });
  await inbox.start();
  const s = await inbox.store.snapshot();
  assert.deepEqual(Object.keys(s.entries).filter(id => stateOf(s.entries[id]) === "NEEDS"), ["open"]);
  assert.equal(s.unsorted, null, "closed agents aren't parked in Unsorted either");
  const list = await inbox.list();
  assert.deepEqual(list.rows.map(r => r.agentId), ["open"]);
  await done();
});

test("first run: the 7-day rule reads the agent's real last activity, not Paseo's updatedAt", async () => {
  const now = Date.parse("2026-11-08T12:00:00.000Z");
  const bumped = "2026-11-08T11:58:00.000Z"; // every agent's updatedAt after a daemon restart
  const agents = [
    agent({ id: "stale", updatedAt: bumped, lastUserMessageAt: "2026-09-20T10:00:00.000Z" }),
    agent({ id: "stale-created", updatedAt: bumped, createdAt: "2026-09-20T10:00:00.000Z" }),
    agent({ id: "fresh", updatedAt: bumped, lastUserMessageAt: "2026-11-05T10:00:00.000Z" }),
  ];
  const { inbox, done } = await service(agents, { now: () => now });
  await inbox.start();
  const s = await inbox.store.snapshot();
  assert.equal(stateOf(s.entries.fresh), "NEEDS");
  assert.equal(s.entries.stale?.needs ?? null, null);
  assert.equal(s.entries["stale-created"]?.needs ?? null, null);
  assert.deepEqual(s.unsorted?.sort(), ["stale", "stale-created"]);
  await done();
});

test("first run: imported flags date from the agent's last activity, so D9 orders oldest first", async () => {
  const now = Date.parse("2026-11-08T12:00:00.000Z");
  const agents = [agent({ id: "newer", updatedAt: "2026-11-08T11:59:00.000Z", lastUserMessageAt: "2026-11-08T08:00:00.000Z" }), agent({ id: "older", updatedAt: "2026-11-08T11:59:00.000Z", lastUserMessageAt: "2026-11-04T08:00:00.000Z" })];
  const { inbox, done } = await service(agents, { now: () => now });
  await inbox.start();
  const s = await inbox.store.snapshot();
  assert.equal(s.entries.older.needs!.since, "2026-11-04T08:00:00.000Z");
  assert.equal(s.entries.newer.needs!.since, "2026-11-08T08:00:00.000Z");
  assert.deepEqual(sectionRows((await inbox.list()).rows, "needs", now).map(r => r.agentId), ["older", "newer"]);
  await done();
});

test("migration: a store imported by 1.1.0-beta.0 is repaired once, and only entries the import wrote change", async () => {
  const now = Date.parse("2026-11-08T12:00:00.000Z");
  const importAt = "2026-11-08T10:46:52.000Z";
  const dir = await mkdtemp(join(tmpdir(), "inbox-"));
  const imported = (id: string, detail = "You haven't replied") => ({ ...newEntry(id), seq: 1, lastEventAt: importAt, needs: { since: importAt, reasons: [{ reason: "finished" as const, at: importAt, detail, dedupeKey: "finished" }] } });
  // What beta.0 left on disk: no revision field, every imported flag dated at import time.
  const beta0 = {
    version: 1, importedAt: importAt, lastSeen: importAt, primedAt: importAt, signOffs: 0, unsorted: ["already-unsorted"],
    entries: {
      closed: imported("closed"), archived: imported("archived"), old: imported("old"), recent: imported("recent"), unread: imported("unread", "Unread in Paseo"),
      "signed-off": { ...imported("signed-off"), needs: null, signedOffAt: "2026-11-08T11:00:00.000Z", seq: 2 },
      snoozed: { ...imported("snoozed"), snooze: { until: "2026-11-09T09:00:00.000Z", at: "2026-11-08T11:00:00.000Z" }, seq: 2 },
      "real-finish": { ...imported("real-finish"), seq: 2, needs: { since: "2026-11-08T11:30:00.000Z", reasons: [{ reason: "finished" as const, at: "2026-11-08T11:30:00.000Z", detail: "Opened PR #815.", dedupeKey: "finished" }] } },
      "real-crash": { ...imported("real-crash", "Closed during a turn"), needs: { since: "2026-11-08T11:00:00.000Z", reasons: [{ reason: "error" as const, at: "2026-11-08T11:00:00.000Z", detail: "Closed during a turn", dedupeKey: "error" }] } },
    },
  };
  await writeFile(join(dir, "inbox.json"), JSON.stringify(beta0));
  const bumped = "2026-11-08T10:46:00.000Z";
  const agents = [
    agent({ id: "closed", status: "closed", updatedAt: bumped, lastUserMessageAt: "2026-11-08T09:00:00.000Z" }), agent({ id: "archived", archivedAt: "2026-11-07T10:00:00.000Z" }),
    agent({ id: "old", updatedAt: bumped, lastUserMessageAt: "2026-09-30T10:00:00.000Z" }), agent({ id: "recent", updatedAt: bumped, lastUserMessageAt: "2026-11-06T10:00:00.000Z" }),
    agent({ id: "unread", updatedAt: bumped, requiresAttention: true, attentionReason: "finished", attentionTimestamp: "2026-10-01T10:00:00.000Z" }),
    agent({ id: "signed-off", updatedAt: bumped, lastUserMessageAt: "2026-09-01T10:00:00.000Z" }), agent({ id: "snoozed", updatedAt: bumped, lastUserMessageAt: "2026-09-01T10:00:00.000Z" }), agent({ id: "real-finish" }),
    agent({ id: "real-crash", status: "closed" }), agent({ id: "already-unsorted", updatedAt: bumped }),
  ];
  const { inbox, done } = await service(agents, { now: () => now, dir });
  await inbox.start();
  const s = await inbox.store.snapshot();
  assert.equal(s.revision, REVISION);
  assert.equal(s.entries.closed.needs, null, "a closed agent's imported flag is dropped");
  assert.equal(s.entries.archived.needs, null, "an archived agent's imported flag is dropped");
  assert.equal(s.entries.old.needs, null, "really idle for 7+ days: moved to Unsorted");
  assert.deepEqual(s.unsorted?.sort(), ["already-unsorted", "old"]);
  assert.equal(s.entries.recent.needs!.since, "2026-11-06T10:00:00.000Z", "a kept flag dates from real activity");
  assert.equal(s.entries.unread.needs!.since, "2026-10-01T10:00:00.000Z", "Paseo's unread stays, re-dated");
  assert.equal(s.entries["signed-off"].needs, null); assert.equal(s.entries["signed-off"].seq, 2, "the developer's sign-off is untouched");
  assert.ok(s.entries.snoozed.snooze && s.entries.snoozed.needs?.since === importAt, "a snoozed entry is untouched");
  assert.equal(s.entries["real-finish"].needs!.reasons[0].detail, "Opened PR #815.", "a newer real event is untouched");
  assert.equal(s.entries["real-crash"].needs!.reasons[0].reason, "error", "a closed agent's real flag keeps (§2.5)");
  // Runs once: a later start with different activity changes nothing.
  const after = JSON.stringify(s.entries);
  await inbox.start();
  assert.equal(JSON.stringify((await inbox.store.snapshot()).entries), after);
  await done();
});

test("a permission answered within the grace period never flags", async () => {
  const { inbox, done } = await service([agent({ id: "a1" })]);
  await mark(inbox);
  const a = { id: "a1", workspaceId: "w1" };
  const pending = inbox.permissionRequested(a, { id: "p1", title: "Allow?" });
  await inbox.permissionResolved(a, "p1");
  await pending;
  assert.equal((await inbox.store.snapshot()).entries.a1, undefined);
  await done();
});
test("the grace period on a mock clock: answered at 2.999 s never flags, unanswered at 3 s flags, a late answer clears it", async t => {
  const dir = await mkdtemp(join(tmpdir(), "inbox-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const f = fake([agent({ id: "a1" }), agent({ id: "a2" })]);
  // The production default grace (no graceMs); only setTimeout is mocked, so store I/O stays real.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const inbox = new Inbox(dir, { enabled: async () => ({ enable_inbox: true, enable_inbox_pr_closed: true }), directory: f.directory, sources: f.none, guard: async () => null, now: () => Date.parse(at(1)) });
  await mark(inbox);
  const a1 = { id: "a1", workspaceId: "w1" }; const a2 = { id: "a2", workspaceId: "w1" };
  const answered = inbox.permissionRequested(a1, { id: "p1", title: "Allow?" });
  const unanswered = inbox.permissionRequested(a2, { id: "p2", title: "Allow?" });
  t.mock.timers.tick(2_999);
  await inbox.permissionResolved(a1, "p1");
  await answered;
  t.mock.timers.tick(1);
  await unanswered;
  const s = await inbox.store.snapshot();
  assert.equal(s.entries.a1, undefined, "answered inside the grace period: never flagged");
  assert.deepEqual(needs(s.entries.a2), ["permission"], "unanswered at the end of the grace period: flagged");
  await inbox.permissionResolved(a2, "p2");
  assert.deepEqual(needs((await inbox.store.snapshot()).entries.a2), [], "answered after flagging: cleared");
});
test("sign-off clears Paseo's unread dot too (D8), and a batch sign-off has one undo", async () => {
  const { inbox, cleared, done } = await service([agent({ id: "a1" }), agent({ id: "a2" })]);
  await mark(inbox);
  await inbox.apply([{ agentId: "a1", event: finished }, { agentId: "a2", event: finished }]);
  await inbox.act({ action: "sign_off", agentIds: ["a1", "a2"] });
  assert.deepEqual(cleared, [["a1", "a2"]]);
  await inbox.act({ action: "batch_undo" });
  const s = await inbox.store.snapshot();
  assert.equal(stateOf(s.entries.a1), "NEEDS"); assert.equal(stateOf(s.entries.a2), "NEEDS");
  await done();
});
test("the mute switch: 'Don't flag finishes' keeps permissions and errors, and 'mute this turn' absorbs one finish", () => {
  const off = run([{ type: "set_finish_flags", value: false }, finished]);
  assert.equal(stateOf(off), "QUIET");
  assert.deepEqual(needs(run([{ type: "permission", requestId: "p", detail: "q" }, { type: "turn_end", outcome: "failed", detail: "boom" }], off)), ["error", "permission"]);
  assert.equal(stateOf(run([{ type: "reconcile", detail: "offline" }], off)), "QUIET");
  const muted = run([finished, { type: "sign_off", muteTurn: true }, finished]);
  assert.equal(stateOf(muted), "QUIET");
  assert.equal(stateOf(reduce(muted, finished, at(9))), "NEEDS", "only the one turn");
});
test("the inbox switch off: nothing flags and the list is empty", async () => {
  const { inbox, done } = await service([agent({ id: "a1", status: "running" })], { enable_inbox: false });
  await mark(inbox);
  await inbox.turnEnded({ id: "a1", workspaceId: "w1" }, { kind: "completed" }, "t");
  assert.equal((await inbox.store.snapshot()).entries.a1, undefined);
  assert.deepEqual((await inbox.list()).rows, []);
  await done();
});
test("offline replay applies sign-offs whose entry didn't move and reports the ones that came back", () => {
  const a = run([finished]); const b = run([finished]);
  const moved = reduce(b, { type: "permission", requestId: "p", detail: "q" }, at(5));
  const result = replay([{ agentId: "a1", seq: a.seq, action: "sign_off" }, { agentId: "b1", seq: b.seq, action: "sign_off" }], { a1: a, b1: { ...moved, agentId: "b1" } }, at(9));
  assert.deepEqual(result.applied, ["a1"]); assert.deepEqual(result.cameBack, ["b1"]);
  assert.equal(stateOf(result.entries.a1), "QUIET"); assert.equal(stateOf(result.entries.b1), "NEEDS");
});

test("D9 ordering: urgency group first, then the longest wait", () => {
  const row = (agentId: string, reason: InboxEvent, start: number) => ({ agentId, needs: reduce(newEntry(agentId), reason, at(start)).needs });
  const rows = [row("fin-old", finished, 0), row("perm-new", { type: "permission", requestId: "p", detail: "q" }, 50), row("err", { type: "crash", detail: "x" }, 10), row("perm-old", { type: "permission", requestId: "p", detail: "q" }, 5)];
  assert.deepEqual(rows.sort(compareNeeds).map(r => r.agentId), ["perm-old", "perm-new", "err", "fin-old"]);
});
test("'Sign off & next' opens the top of Needs you, skipping the current agent", () => {
  const base = { workspaceId: "w1", workspaceTitle: null, multiRoot: false, status: "idle", delegatedFrom: null, resumesAt: null, lastActivityAt: null, snooze: null, signedOffAt: null, undoable: false, seq: 1, muteTurn: false, enable_finish_flags: true };
  const rows: InboxRow[] = [
    { ...base, agentId: "cur", title: "Current", needs: { reasons: [{ reason: "finished", at: at(0), detail: "", dedupeKey: "finished" }], since: at(0) } },
    { ...base, agentId: "perm", title: "Asks", needs: { reasons: [{ reason: "permission", at: at(9), detail: "", dedupeKey: "p" }], since: at(9) } },
    { ...base, agentId: "fin", title: "Other", needs: { reasons: [{ reason: "finished", at: at(1), detail: "", dedupeKey: "finished" }], since: at(1) } },
  ];
  assert.equal(nextAfter(rows, "cur", Date.parse(at(10)))?.agentId, "perm");
  assert.deepEqual(sectionRows(rows, "needs", Date.parse(at(10))).map(r => r.agentId), ["perm", "cur", "fin"]);
});
test("titles read 'Workspace › Agent' only with several root agents", () => {
  assert.deepEqual(rowTitle({ title: "Main", workspaceTitle: "TKT-1", multiRoot: false }), { primary: "TKT-1", agent: null });
  assert.deepEqual(rowTitle({ title: "Reviewer", workspaceTitle: "TKT-1", multiRoot: true }), { primary: "TKT-1", agent: "Reviewer" });
});

test("Follow-up events: red CI per head SHA, threads, conflicts and merges, suppressed while repairing", () => {
  const w = workspace({ mainAgentId: "main", prs: [
    pr({ key: "acme/app#1", number: 1, snapshot: snapshot({ head: "s1", failedChecks: ["lint"] }) }),
    pr({ key: "acme/app#2", number: 2, snapshot: snapshot({ threads: [{ id: "t2", updatedAt: T0 }, { id: "t1", updatedAt: T0 }] }) }),
    pr({ key: "acme/app#3", number: 3, snapshot: snapshot({ state: "MERGED" }) }),
  ] });
  const events = followUpEvents({ version: 1, workspaces: [w] } as never, true);
  assert.deepEqual(events.map(e => [e.event.type, "dedupeKey" in e.event ? e.event.dedupeKey : ""]), [["ci", "acme/app#1:s1:checks"], ["review", "acme/app#2:threads:t1,t2"], ["pr_closed", "acme/app#3:MERGED"]]);
  assert.equal(followUpEvents({ version: 1, workspaces: [w] } as never, false).length, 2, "D6 switch");
  const repairing = workspace({ ...w, batches: [{ id: "b", tasks: [], state: "sent", createdAt: T0, sentAt: T0, settledAt: null, messageId: "m", attempts: 1, result: "", recipientAgentId: null, contextPath: null, activityAt: null, acknowledgmentError: null, recoveryHandoffs: [] }] as never });
  assert.equal((followUpEvents({ version: 1, workspaces: [repairing] } as never, true)[0].event as { suppressed?: boolean }).suppressed, true);
});

// Sender classification (§2.4): one fixture per sender.
const NOW = Date.parse(T0);
const sources = (patch: Partial<Sources> = {}): Sources => ({ ledger: async () => [], defer: async () => false, session: async () => false, schedule: async () => false, ...patch });
test("classifier: the developer typing in the app is Tom", async () => {
  assert.equal(await classify({ text: "Looks good, also handle empty filters", messageId: "u1" }, "a1", NOW, sources()), "tom");
});
test("classifier: an agent envelope is the orchestrator, not Tom", async () => {
  assert.equal(await classify({ text: '<paseo-system version="1" kind="agent-message" source-agent-id="x" message-id="m">\nDo the thing\n</paseo-system>' }, "a1", NOW, sources()), "agent");
  assert.equal(await classify({ text: '<paseo-system version="1" kind="agent-notification" message-id="m">\nChild finished\n</paseo-system>' }, "a1", NOW, sources()), "agent");
});
test("classifier: Follow-up's own delivery is automation, by message id or time", async () => {
  assert.equal(await classify({ text: "Fix CI", messageId: "batch-1" }, "a1", NOW, sources({ ledger: async () => [{ agentId: "a1", messageId: "batch-1", at: "2026-01-01T00:00:00.000Z" }] })), "follow-up");
  assert.equal(await classify({ text: "Fix CI" }, "a1", NOW, sources({ ledger: async () => [{ agentId: "a1", messageId: null, at: new Date(NOW - 3_000).toISOString() }] })), "follow-up");
  assert.equal(await classify({ text: "Fix CI" }, "a1", NOW, sources({ ledger: async () => [{ agentId: "a2", messageId: null, at: T0 }] })), "tom", "another agent's delivery doesn't count");
});
test("classifier: reads Defer, Smart Session, Session Guard and schedule files", async () => {
  const home = await mkdtemp(join(tmpdir(), "inbox-home-"));
  const write = async (path: string, value: unknown) => { await mkdir(join(home, path, ".."), { recursive: true }); await writeFile(join(home, path), JSON.stringify(value)); };
  const near = new Date(NOW - 2_000).toISOString(); const far = new Date(NOW - 600_000).toISOString();
  const s = fileSources(home, async () => []);
  const who = (id: string) => classify({ text: "continue" }, id, NOW, s);
  assert.equal(await who("defer"), "tom", "no files: fail open");
  await write("plugin-data/defer/queue.json", { version: 1, items: [{ agentId: "defer", state: "sent", settledAt: near }, { agentId: "stale", state: "sent", settledAt: far }] });
  await write("plugin-data/smart-session/compactions.json", { version: 1, items: [{ agentId: "smart", state: "sent", settledAt: far, resumedAt: near }] });
  await write("plugin-data/session-guard/state.json", { version: 1, pauses: [{ agentId: "guard", phase: "resumed", settledAt: near }] });
  await write("schedules/abc.json", { id: "abc", target: { type: "agent", agentId: "sched" }, runs: [{ startedAt: near, agentId: null }] });
  assert.equal(await who("defer"), "defer");
  assert.equal(await who("smart"), "session");
  assert.equal(await who("guard"), "session");
  assert.equal(await who("sched"), "schedule");
  assert.equal(await who("stale"), "tom", "an old Defer send isn't this message");
  await write("plugin-data/defer/queue.json", { version: 2, rows: [{ agentId: "defer", at: near }] });
  assert.equal(await who("defer"), "tom", "an unknown Defer format fails open");
  await write("plugin-data/defer/queue.json", "{not json");
  assert.equal(await who("defer"), "tom", "a corrupt file fails open");
  await rm(home, { recursive: true, force: true });
});
test("classifier: the newest user message is read from the tail", () => {
  assert.deepEqual(newestUserMessage([{ type: "user_message", text: "old" }, { type: "assistant_message", text: "a" }, { type: "user_message", text: "new", messageId: "m2" }, { type: "assistant_message", text: "b" }]), { text: "new", messageId: "m2", clientMessageId: null });
  assert.equal(newestUserMessage([{ type: "assistant_message", text: "a" }]), null);
});
test("the developer's message clears the flag end to end; automation doesn't", async () => {
  const { inbox, done } = await service([agent({ id: "a1" })], { tails: { a1: [{ type: "user_message", text: "Thanks, ship it" }] } });
  await mark(inbox);
  const a = { id: "a1", workspaceId: "w1" };
  await inbox.turnEnded(a, { kind: "completed" }, "t1");
  assert.equal(stateOf((await inbox.store.snapshot()).entries.a1), "NEEDS");
  await inbox.turnStarted(a);
  assert.equal(stateOf((await inbox.store.snapshot()).entries.a1), "QUIET");
  const auto = await service([agent({ id: "a1" })], { tails: { a1: [{ type: "user_message", text: '<paseo-system version="1" kind="agent-message" message-id="m">\nx\n</paseo-system>' }] } });
  await mark(auto.inbox);
  await auto.inbox.turnEnded(a, { kind: "completed" }, "t1");
  await auto.inbox.turnStarted(a);
  assert.equal(stateOf((await auto.inbox.store.snapshot()).entries.a1), "NEEDS");
  await done(); await auto.done();
});

// Stale run state (2026-11-10, Tom): a failed turn's Error flag outlived every later turn of an agent that kept running.
test("a newer turn from anyone supersedes the last turn's failure or pause; outside facts stay", () => {
  const failed = run([{ type: "turn_end", outcome: "failed", detail: "The turn failed: Subagent closed during a turn" }, { type: "ci", dedupeKey: "ci:1", detail: "Checks failing" }]);
  const next = reduce(failed, { type: "message", from: "automation" }, at(5));
  assert.deepEqual(next.needs?.reasons.map(r => r.reason), ["ci"], "the error is history; CI still needs you");
  const paused = run([{ type: "turn_end", outcome: "canceled", guard: "attention", detail: "Paused" }]);
  assert.equal(stateOf(reduce(paused, { type: "message", from: "automation" }, at(5))), "QUIET");
  const again = reduce(next, { type: "turn_end", outcome: "failed", detail: "Failed again" }, at(6));
  assert.equal(displayReason(again.needs)?.reason, "error", "a new failure flags again");
  const perm = run([{ type: "permission", requestId: "r1", detail: "Allow?" }]);
  assert.equal(stateOf(reduce(perm, { type: "message", from: "automation" }, at(5))), "NEEDS", "a permission is by request, not by turn");
});

test("a running agent's row never headlines a stale error; on 0.15 a stopped agent keeps it", async () => {
  const running = await service([agent({ id: "a1", status: "running" })]);
  await mark(running.inbox);
  await running.inbox.turnEnded({ id: "a1", workspaceId: "w1" }, { kind: "failed", error: { message: "Subagent closed during a turn" } }, "t1");
  assert.equal((await running.inbox.list()).rows.find(r => r.agentId === "a1")?.needs, null, "running: no Error headline");
  const stopped = await service([agent({ id: "a1", status: "idle" })]);
  await mark(stopped.inbox);
  await stopped.inbox.turnEnded({ id: "a1", workspaceId: "w1" }, { kind: "failed", error: { message: "Subagent closed during a turn" } }, "t1");
  assert.equal(displayReason((await stopped.inbox.list()).rows.find(r => r.agentId === "a1")?.needs ?? null)?.reason, "error", "stopped: the failure still needs you");
  await running.done(); await stopped.done();
});

test("load repair: an error from before a restart clears for an agent that is running now (0.16 resumes it)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "inbox-"));
  const before = await service([agent({ id: "a1", status: "idle" })], { dir });
  await mark(before.inbox);
  await before.inbox.turnEnded({ id: "a1", workspaceId: "w1" }, { kind: "failed", error: { message: "Daemon restarted" } }, "t1");
  assert.equal(stateOf((await before.inbox.store.snapshot()).entries.a1), "NEEDS");
  const after = await service([agent({ id: "a1", status: "running" })], { dir });
  await after.inbox.start();
  assert.equal(stateOf((await after.inbox.store.snapshot()).entries.a1), "QUIET", "persisted, not only hidden");
  await after.done();
});
