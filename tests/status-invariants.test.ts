import test from "node:test";
import assert from "node:assert/strict";
import { INVARIANTS, violations } from "../shared/status-invariants";
import { askQuestion, needsYouQuestions } from "../server/questions";
import { questionSchema } from "../shared/questions";
import type { Batch, Obligation, Workspace } from "../shared/model";
import { liveLine, needsYou } from "../shared/attention";
import { buildHome, trackedGroup } from "../shared/home";
import { agentCard, FINISH_LINE } from "../shared/status";
import { clock, pr, snapshot, workspace } from "./fixtures";

// Every status invariant over a grid of workspaces, plus one named fixture per reported bug. Extend the grid's axes
// and add invariants to shared/status-invariants.ts; a fixture stays once its bug is fixed.

const opts = (...labels: string[]) => labels.map((label, i) => ({ letter: String.fromCharCode(65 + i), label }));
const archive = { title: "Archive the 26 dormant workspaces whose PRs are all merged or closed?", question: "Archive them?", options: opts("Show me the list first", "Archive all 26 now", "Don't archive"), recommend: "A" };

test("invariants: ids are unique kebab-case and each says why", () => {
  const ids = INVARIANTS.map(i => i.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const i of INVARIANTS) { assert.match(i.id, /^[a-z]+(-[a-z]+)*$/); assert.ok(i.why.length > 20, i.id); }
});

test("grid: questions asked through every path never leave two open cards for one question", () => {
  const paths = ["ask", "needs_you", "ask-then-needs_you", "needs_you-every-turn", "reworded", "changed-options"] as const;
  for (const path of paths) {
    const w = workspace();
    const d = { question: archive.title, options: archive.options.map(o => ({ label: o.label })), recommend: 0 };
    if (path === "ask") { askQuestion(w, "main-agent", archive, "work-around", clock); askQuestion(w, "main-agent", archive, "work-around", clock); }
    if (path === "needs_you") needsYouQuestions(w, "main-agent", { decisions: [d, d] }, "work-around", clock, null);
    if (path === "ask-then-needs_you") { askQuestion(w, "main-agent", archive, "work-around", clock, { via: "ask" }); needsYouQuestions(w, "main-agent", { decisions: [d] }, "work-around", clock, null); }
    if (path === "needs_you-every-turn") for (let t = 0; t < 5; t++) needsYouQuestions(w, "main-agent", { decisions: [d] }, "work-around", clock + t * 600_000, null);
    if (path === "reworded") { askQuestion(w, "main-agent", archive, "work-around", clock); askQuestion(w, "main-agent", { ...archive, title: "Archive the 26 dormant workspaces (all PRs merged or closed)?" }, "work-around", clock); }
    if (path === "changed-options") { askQuestion(w, "main-agent", archive, "work-around", clock); askQuestion(w, "main-agent", { ...archive, options: opts("Archive 8 clean ones", "Keep all") }, "work-around", clock); }
    assert.deepEqual(violations(w, clock), [], path);
  }
});

test("fixture (2026-11-10, Q18/Q19): the check catches two open versions of one question", () => {
  const q = (id: string, title: string, labels: string[]) => questionSchema.parse({ id, title, question: title, options: opts(...labels), recommend: "A", askedBy: "main-agent", askedAt: new Date(clock).toISOString(), mode: "work-around" });
  const w = workspace({ questions: [q("Q18", "Linked items: build it with the six recommendations?", ["Build it as recommended", "Build it, with changes", "Rethink the design"]), q("Q19", "Build Linked items with the six recommended choices?", ["Build as recommended", "Build with changes", "Rethink the design"])] });
  assert.deepEqual(violations(w, clock), [{ id: "no-duplicate-open-question", detail: "Q19 repeats Q18" }]);
});

test("answer-card-round-trip: every answer shape reads back on the chat card in full", () => {
  const answered = (id: string, title: string, labels: string[], choice: string, words?: string) => questionSchema.parse({ id, title, question: title, options: opts(...labels), recommend: "A", askedBy: "main-agent", askedAt: new Date(clock).toISOString(), mode: "work-around", answer: { choice, ...(words ? { words } : {}), at: new Date(clock).toISOString(), by: "developer", delivery: { state: "sent", to: "main-agent", messageId: null, at: new Date(clock).toISOString() } } });
  const grid = [
    answered("Q1", "Retry window", ["An hour", "A day"], "B"),
    answered("Q2", "Retry window", ["An hour", "A day"], "B", "Alert after that\nand page on-call"),
    answered("Q3", "Retry window", ["An hour", "A day"], "other", "Until the billing date\nthen stop"),
    answered("Q4", "Where should exports land?", [], "The staging bucket\nthen prod"),
    answered("Q5", "Ship (v2): now?", ["Now", "Later"], "A"),
  ];
  assert.deepEqual(violations(workspace({ questions: grid }), clock).filter(v => v.id === "answer-card-round-trip"), []);
});

test("brief-follows-questions: while a linked question is open, only the developer closes the card", async () => {
  const { briefViolations } = await import("../shared/status-invariants");
  const { shouldReopen } = await import("../shared/brief");
  const open = new Set(["Q20", "Q21"]);
  const card = (state: "open" | "answered" | "signed" | "superseded", outcome: string | null, questionIds = ["Q20", "Q21", "Q22"]) => ({ id: "brief:t9", state, outcome, questionIds });
  assert.deepEqual(briefViolations(card("open", null), open), []);
  assert.deepEqual(briefViolations(card("superseded", "The agent kept going"), open), [{ id: "brief-follows-questions", detail: "brief:t9 is superseded while Q20, Q21 are open" }]);
  assert.deepEqual(briefViolations(card("answered", "You replied"), open), [], "a developer reply closes it");
  assert.deepEqual(briefViolations(card("answered", "You picked B · Fix the network"), open), []);
  assert.deepEqual(briefViolations(card("signed", "Signed off"), open), []);
  assert.deepEqual(briefViolations(card("superseded", "The agent kept going"), new Set()), [], "its questions are closed");
  // Fixture (2026-11-10, Q20–Q22): collapsed to "You replied" by another agent's message. The repair can't tell it
  // from a real reply, so it reopens "You replied" cards whose questions are all still open.
  assert.equal(shouldReopen(card("answered", "You replied"), open, false), true);
  assert.equal(shouldReopen(card("answered", "You picked B · x"), open, false), false);
});

// Follow-up status surfaces (2026-11-10, wks_4b27f268): every surface reads shared/status.ts.
const at = (ms: number) => new Date(clock - ms).toISOString();
const batch = (kind: "repairs" | "finish" | "recovery", state: Batch["state"], patch: Partial<Batch> = {}): Batch => ({
  id: `${kind}-${state}`, messageId: "m", attempts: 1, result: "", recipientAgentId: kind === "recovery" ? "recovery-agent" : null, contextPath: null, activityAt: null, acknowledgmentError: null, recoveryHandoffs: [],
  tasks: [kind === "repairs" ? { key: "conflict:example/app#1", kind: "conflict", target: "example/app#1", title: "Resolve merge conflicts on example/app#1", fingerprint: "f" }
    : kind === "finish" ? { key: "completion:workspace", kind: "completion", target: "workspace", title: "Verify the workspace is finished and declare Done", fingerprint: "f" }
    : { key: "inventory:workspace", kind: "inventory", target: "workspace", title: "Recover workspace PR stacks and remaining work", fingerprint: "1" }],
  state, createdAt: at(10 * 60_000), sentAt: ["sending", "sent", "blocked", "uncertain"].includes(state) ? at(5 * 60_000) : null, settledAt: null, ...patch,
});
const obligation = (status: Obligation["status"]): Obligation => ({ id: "task", title: "Verify tenant data", status, afterPrs: [], evidence: "", enable_follow_up: true, revision: 0 });
const merged = (deployment: "latched" | "unconfirmed" | "none") => pr({
  snapshot: snapshot({ state: "MERGED", mergeCommit: "merge", deployment: deployment === "none" ? null : { state: deployment === "latched" ? "deployed" : "unknown", environment: "production", commits: [], evidence: "", observedAt: at(10 * 60_000) } }),
  ...(deployment === "latched" ? { deploymentAnchor: { mergeCommit: "merge", at: at(86_400_000) } } : {}),
});

const AGENTS: Record<string, Partial<Workspace>> = {
  idle: {}, running: { runtimeBusy: true }, background: { backgroundBusy: true }, unavailable: { runtimeReason: "Agent state unavailable; refresh will retry" },
  gone: { goneAgent: { agentId: "main-agent", at: at(0), reason: "No conversation found" } as Workspace["goneAgent"] }, unloaded: { sendWait: "unloaded" }, setup: { sendWait: "setup" }, dormant: { dormant: true } as Partial<Workspace>,
};
const BATCHES: Record<string, Batch[]> = {
  none: [], "repairs-queued": [batch("repairs", "pending")], "repairs-settling": [batch("repairs", "pending", { createdAt: at(5_000) })], "repairs-sent": [batch("repairs", "sent")],
  "repairs-stuck": [batch("repairs", "blocked")], "repairs-uncertain": [batch("repairs", "uncertain")], "finish-queued": [batch("finish", "pending")], "finish-sent": [batch("finish", "sent")],
  "recovery-sent": [batch("recovery", "sent")], "finish-and-repairs": [batch("repairs", "pending"), batch("finish", "pending")],
  "repairs-refused": [batch("repairs", "pending", { refusal: { reason: "Task dependencies changed", at: at(5_000) } })], "repairs-refused-long-ago": [batch("repairs", "pending", { refusal: { reason: "Task dependencies changed", at: at(5 * 60_000) } })],
};
const PRS: Record<string, Workspace["prs"]> = { open: [pr()], unreadable: [pr(), pr({ key: "example/app#2", number: 2, snapshot: null, error: "GitHub rate limit" })], latched: [merged("latched")], unconfirmed: [merged("unconfirmed")], none: [] };
const TASKS: Record<string, Obligation[]> = { none: [], open: [obligation("pending")], done: [obligation("done")], blocked: [obligation("blocked")], working: [obligation("working")],
  "working-live": [{ ...obligation("working"), workingAgentId: "sub-1" }], "working-idle": [{ ...obligation("working"), workingAgentId: "sub-1" }], "working-closed": [{ ...obligation("working"), workingAgentId: "sub-1" }] };
/** The live state of the task's agent (Workspace.taskAgents), as the engine stores it. */
const TASK_AGENTS: Record<string, Workspace["taskAgents"]> = { "working-live": { "sub-1": { title: "Reader fix", state: "working" } }, "working-idle": { "sub-1": { title: "Reader fix", state: "idle" } }, "working-closed": { "sub-1": { title: "Backfill pass", state: "closed" } } };

function* grid(): Generator<[string, Workspace]> {
  for (const [agent, a] of Object.entries(AGENTS)) for (const [b, batches] of Object.entries(BATCHES)) for (const auto of [true, false])
    for (const [p, prs] of Object.entries(PRS)) for (const [t, obligations] of Object.entries(TASKS)) for (const done of [false, true]) for (const hold of [null, "Paused: the agent stopped"]) {
      const w = workspace({ ...a, batches: batches.map(x => ({ ...x })), enable_auto_sends: auto, prs, obligations, hold, taskAgents: TASK_AGENTS[t],
        completion: done ? { summary: "Shipped", declaredAt: at(60_000) } : null });
      yield [`agent=${agent} batch=${b} auto=${auto} prs=${p} tasks=${t} done=${done} hold=${!!hold}`, w];
    }
}

test("no generated workspace state produces contradictory status labels", () => {
  const failures: string[] = [];
  let count = 0;
  for (const [name, w] of grid()) {
    count++;
    for (const v of violations(w, clock)) if (failures.length < 20) failures.push(`${v.id} · ${name} · ${v.detail}`);
  }
  assert.ok(count > 10_000, `the grid covers ${count} states`);
  assert.deepEqual(failures, []);
});

/** wks_4b27f268b5dc2fc6, 2026-11-10: merged and deployed, both tasks done, agent idle, a Done check queued. */
const screenshot = () => workspace({ enable_auto_sends: true, prs: [merged("latched"), { ...merged("latched"), key: "example/app#2", number: 2 }, { ...merged("latched"), key: "example/app#3", number: 3 }],
  obligations: [obligation("done"), { ...obligation("done"), id: "task-2" }], batches: [batch("finish", "pending", { createdAt: at(7 * 60_000) })] });

test("regression wks_4b27f268: an idle agent with a queued Done check is not 'on it', not 'sending', and never 'sends when idle'", () => {
  const w = screenshot();
  assert.deepEqual(violations(w, clock), []);
  assert.doesNotMatch(liveLine(w, clock).text, /sends when the agent is idle/);
  assert.equal(agentCard(w, clock), null, "no 'Main agent is on it' card");
  assert.notEqual(trackedGroup(w, clock), "sending");
  const home = buildHome({ rows: [], tracked: [w], paseo: [], now: clock });
  assert.ok(!home.groups.some(g => g.id === "sending" && g.items.length), "Home doesn't put it under Sending");
  const row = home.groups.find(g => g.id === "needs")?.items[0];
  assert.ok(row, "it waits on you: Ready to finish");
  assert.equal(row.word, "Ready to finish", "the Done check isn't labelled as a fix");
  assert.notEqual(row.icon, "Wrench");
  const finish = needsYou(w, clock).find(i => i.kind === "send");
  assert.equal(finish?.title, FINISH_LINE);
});

test("regression wks_4b27f268: the same workspace once Done reads Done everywhere", () => {
  const w = { ...screenshot(), batches: [], completion: { summary: "Shipped", declaredAt: at(0), unconfirmed: [] } };
  assert.deepEqual(violations(w, clock), []);
  assert.equal(trackedGroup(w, clock), "quiet"); assert.equal(liveLine(w, clock).text, "Ready to archive");
});

test("regression 2026-11-10 critique: repairs queued for an idle agent Follow-up won't wake are yours to send", () => {
  const w = workspace({ enable_auto_sends: true, sendWait: "unloaded", prs: [pr()], batches: [batch("repairs", "pending")] });
  assert.deepEqual(violations(w, clock), []);
  assert.equal(trackedGroup(w, clock), "needs");
  assert.ok(needsYou(w, clock).some(i => i.kind === "send" && !i.finish), "a Send for the queued repair");
  assert.equal(agentCard(w, clock), null, "no 'Queued for the main agent' card that can't act");
});

test("regression 2026-11-10 critique: a stuck Done check is never called a repair", () => {
  const w = workspace({ prs: [merged("latched")], batches: [batch("finish", "blocked")] });
  const retry = needsYou(w, clock).find(i => i.kind === "retry");
  assert.equal(retry?.title, "The Done check didn't go through");
  assert.doesNotMatch(liveLine(w, clock).text, /repairs/);
});

test("running-is-not-stale: over every agent status, turn history and card, a running agent never headlines Error or Paused", async () => {
  const { reduce, newEntry, liveFlag } = await import("../shared/inbox");
  const { rowViolations } = await import("../shared/status-invariants");
  const iso = (m: number) => new Date(clock + m * 60_000).toISOString();
  const histories: Record<string, import("../shared/inbox").InboxEvent[]> = {
    failed: [{ type: "turn_end", outcome: "failed", detail: "The turn failed: Subagent closed during a turn" }],
    "failed-then-auto-turn": [{ type: "turn_end", outcome: "failed", detail: "x" }, { type: "message", from: "automation" }],
    paused: [{ type: "turn_end", outcome: "canceled", guard: "attention", detail: "Paused" }],
    crash: [{ type: "crash", detail: "Errored" }],
    "failed-and-ci": [{ type: "turn_end", outcome: "failed", detail: "x" }, { type: "ci", dedupeKey: "ci:1", detail: "Checks failing" }],
    "finished-then-failed": [{ type: "turn_end", outcome: "completed", detail: "Done" }, { type: "turn_end", outcome: "failed", detail: "x" }],
  };
  const failures: string[] = [];
  // Turn start unknown, before the flags (Paseo still reads "running" after the failed turn), or after them (a newer turn).
  for (const status of ["running", "initializing", "idle", "error"]) for (const [name, events] of Object.entries(histories)) for (const kind of [null, "error", "paused", "decision"] as const) for (const start of [null, iso(-1), iso(10)]) {
    const e = events.reduce((acc, ev, i) => reduce(acc, ev, iso(i)), newEntry("a1"));
    const card = kind ? { kind, source: "agent" as const, state: "open" as const, ask: "x", questionIds: [] as string[], at: iso(0) } : null;
    const turnStartedAt = ["running", "initializing"].includes(status) ? start : null;
    const row = { agentId: "a1", status, snooze: e.snooze, turnStartedAt, ...liveFlag(status, e.needs, card, turnStartedAt) };
    for (const v of rowViolations(row, clock + 3_600_000)) failures.push(`${status} · ${name} · card=${kind} · start=${start} · ${v.detail}`);
  }
  assert.deepEqual(failures, []);
  // The turn that just failed is news even while Paseo still reads "running" (found by the Home render): no newer
  // turn start, so the Error stays.
  const failed = reduce(newEntry("a1"), histories.failed[0], iso(0));
  for (const start of [null, iso(-1)]) assert.equal(liveFlag("running", failed.needs, null, start).needs?.reasons[0]?.reason, "error", `start=${start}`);
  assert.equal(liveFlag("running", failed.needs, null, iso(10)).needs, null);
  // Fixture (2026-11-10, orchestrator 37bc4ab1): the raw entry, unfiltered, is exactly what Home showed.
  const stale = reduce(newEntry("37bc4ab1"), histories.failed[0], iso(0));
  assert.equal(rowViolations({ agentId: "37bc4ab1", status: "running", needs: stale.needs, snooze: null, brief: null, turnStartedAt: iso(15) }, clock)[0]?.id, "running-is-not-stale");
  assert.deepEqual(rowViolations({ agentId: "37bc4ab1", status: "running", needs: stale.needs, snooze: null, brief: null, turnStartedAt: iso(-1) }, clock), []);
  // newest-brief-decides (2026-11-13): a done brief beside an older "No ask stated" finish flag is a violation.
  const finish = { reason: "finished" as const, at: iso(-30), detail: "Nothing new", dedupeKey: "finished" };
  const done = { id: "brief:t63", kind: "done", source: "agent", state: "open", ask: "Nothing needed", at: iso(-5) } as unknown as Parameters<typeof rowViolations>[0]["brief"];
  assert.equal(rowViolations({ agentId: "37bc4ab1", status: "idle", needs: { reasons: [finish], since: iso(-30) }, snooze: null, brief: done, turnStartedAt: null }, clock)[0]?.id, "newest-brief-decides");
  assert.deepEqual(rowViolations({ agentId: "37bc4ab1", status: "idle", needs: { reasons: [{ ...finish, at: iso(-1) }], since: iso(-1) }, snooze: null, brief: done, turnStartedAt: null }, clock), []);
});

test("automatic-hold-is-not-stale: over every hold, turn and agent, a newer main-agent turn leaves no automatic hold", async () => {
  const { holdViolations } = await import("../shared/status-invariants");
  const { holdSuperseded, liftHold, interruptionHold } = await import("../shared/status");
  const at = new Date(clock).toISOString();
  const holds = {
    failed: { hold: interruptionHold("failed"), interruption: { turnId: "t1", at, kind: "failed" as const } },
    "failed-other-agent": { hold: interruptionHold("failed"), interruption: { turnId: "t1", at, kind: "failed" as const, agentId: "helper" } },
    stopped: { hold: interruptionHold("canceled"), interruption: { turnId: "t1", at, kind: "canceled" as const } },
    developer: { hold: "You explicitly stopped follow-up", interruption: { turnId: "t1", at, kind: "failed" as const } },
    "guard-lifted": { hold: null, interruption: { turnId: "t1", at, kind: "failed" as const, guardPauseId: "p" } },
    none: { hold: null, interruption: undefined },
  };
  const failures: string[] = [];
  for (const [name, h] of Object.entries(holds)) for (const mainTurnId of [null, "t1", "t2"]) {
    const w = { ...workspace({ id: "w1", mainAgentId: "main" }), ...h } as import("../shared/model").Workspace;
    // What the worker does on a turn start or a refresh (index.server.ts, server/engine.ts).
    if (holdSuperseded(w, { agentId: w.mainAgentId, turnId: mainTurnId })) liftHold(w);
    for (const v of holdViolations(w, mainTurnId)) failures.push(`${name} · turn=${mainTurnId} · ${v.detail}`);
    if (!["failed", "stopped"].includes(name) && h.hold) assert.equal(w.hold, h.hold, `${name} · turn=${mainTurnId}: not Follow-up's to lift`);
  }
  assert.deepEqual(failures, []);
  // Fixture (2026-11-10 render): the failed turn's hold, unrepaired, under a newer turn is the bug.
  const raw = { ...workspace({ id: "w1", mainAgentId: "main" }), ...holds.failed } as import("../shared/model").Workspace;
  assert.equal(holdViolations(raw, "t2")[0]?.id, "automatic-hold-is-not-stale");
});

test("regression 2026-11-12: queued repairs with an unreadable PR never say 'sending now'", () => {
  const w = workspace({ enable_auto_sends: true, prs: [pr(), pr({ key: "example/app#2", number: 2, snapshot: null, error: "GitHub rate limit" })], batches: [batch("repairs", "pending")] });
  assert.deepEqual(violations(w, clock), []);
  const line = agentCard(w, clock)?.line ?? "";
  assert.doesNotMatch(line, /going out now|waits a minute so new changes/);
  assert.match(line, /GitHub answers for #2 \(GitHub rate limit\)/);
  const refused = workspace({ enable_auto_sends: true, prs: [pr()], batches: [batch("repairs", "pending", { refusal: { reason: "Task dependencies changed", at: at(10_000) } })] });
  assert.match(agentCard(refused, clock)?.line ?? "", /didn't send: Task dependencies changed/);
  assert.deepEqual(violations(refused, clock), []);
});
