import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { followUpEvents, Inbox, type AgentInfo, type Directory } from "../server/inbox";
import { needsYou, liveLine } from "../shared/attention";
import { buildHome } from "../shared/home";
import { emptyReviewerConfig, setReviewerConfig } from "../shared/reviewers";
import type { InboxRow } from "../shared/inbox";
import type { Workspace } from "../shared/model";
import { clock, pr, snapshot, workspace } from "./fixtures";

/**
 * Tom, 2026-11-11: the Follow-up orchestrator's workspace read "Needs you" while its main agent was waiting on a
 * release it merges itself. The cause: the inbox flagged "Add reviewers #107" for a repository nobody is set up to
 * review (Needs you's own reviewers item checks that, the inbox flag didn't), and the flag outlived the PR's merge.
 *
 * The rule: in-flight work (a declared wait, a running agent or subagent, background work, working or waiting
 * obligations, PRs the agent merges itself, repairs the agent is on) never reads as Needs you, Finished or ready.
 */
const reviewers = () => ({ author: "agent-author", requested: [] as string[], teams: [] as string[], reviewed: [] as string[], complete: true });
/** Open, green, no reviewers, GitHub flow: what #107 looked like while the release chain was about to merge it. */
const greenUnreviewed = (patch: Partial<Parameters<typeof pr>[0]> = {}) => pr({ snapshot: snapshot({ reviewers: reviewers(), prWorkflow: "github", mergeStateStatus: "CLEAN" }), registeredAgentId: "main-agent", ...patch });
const withReviewers = (repo = "example/app") => setReviewerConfig({ ...emptyReviewerConfig(), repos: { [repo]: [{ login: "reviewer", name: "Reviewer" }] } });
const iso = (offsetMin = 0) => new Date(clock + offsetMin * 60_000).toISOString();

test("a repository nobody is configured to review never flags 'Add reviewers': the inbox and Needs you agree", () => {
  setReviewerConfig(emptyReviewerConfig());
  const w = workspace({ mainAgentId: "main-agent", prs: [greenUnreviewed()] });
  assert.deepEqual(followUpEvents({ version: 1, workspaces: [w] } as never, true).map(e => e.event.type), [], "no reviewers flag for an unconfigured repository");
  assert.ok(!needsYou(w, clock).some(i => i.kind === "reviewers"));
});

test("a PR the agent merges itself asks the developer for neither reviewers nor a merge", () => {
  withReviewers();
  const mine = workspace({ mainAgentId: "main-agent", prs: [greenUnreviewed({ agentMerges: true })] });
  assert.deepEqual(followUpEvents({ version: 1, workspaces: [mine] } as never, true).map(e => e.event.type), []);
  assert.deepEqual(needsYou(mine, clock).map(i => i.kind), []);
  // The same PR without the declaration still asks: the developer reviews and merges by default.
  const theirs = workspace({ mainAgentId: "main-agent", prs: [greenUnreviewed()] });
  assert.deepEqual(followUpEvents({ version: 1, workspaces: [theirs] } as never, true).map(e => e.event.type), ["reviewers"]);
  assert.deepEqual(needsYou(theirs, clock).map(i => i.kind), ["merge"]);
  setReviewerConfig(emptyReviewerConfig());
});

// ---------- the inbox: an outside fact's flag lasts only as long as the fact ----------

const agent = (id: string): AgentInfo => ({ id, workspaceId: "workspace", parentAgentId: null, title: "Main", status: "idle", archivedAt: null, updatedAt: iso(), lastUserMessageAt: null, requiresAttention: false, attentionReason: null });
async function inbox(agents: AgentInfo[]) {
  const dir = await mkdtemp(join(tmpdir(), "in-flight-"));
  const directory: Directory = { async agents() { return agents; }, async workspaces() { return [{ id: "workspace", name: "Migration rollout" }]; }, async agent(id) { return agents.find(a => a.id === id) ?? null; }, async tail() { return []; }, async clearAttention() {} };
  let now = clock + 60_000;
  const box: Inbox = new Inbox(dir, {
    enabled: async () => ({ enable_inbox: true, enable_inbox_pr_closed: false }), directory,
    sources: { ledger: async () => [], defer: async () => false, session: async () => false, schedule: async () => false },
    guard: async () => null, graceMs: 5, settleMs: 40, settleStepMs: 5, now: () => now,
    briefs: { async sink() {}, async call() { return null; }, async pr() { return null; }, async prs() { return []; } },
  });
  await box.store.mutate(s => { s.importedAt = iso(-10); s.lastSeen = iso(-5); s.primedAt = iso(-10); s.notifiedAt = iso(-10); });
  return { box, advance: (min: number) => { now += min * 60_000; }, entry: async (id = "main-agent") => (await box.store.snapshot()).entries[id], done: () => rm(dir, { recursive: true, force: true }) };
}

test("an outside fact's flag is withdrawn once the fact ends: 'Add reviewers' goes when the PR merges", async () => {
  withReviewers();
  const s = await inbox([agent("main-agent")]);
  const open = workspace({ mainAgentId: "main-agent", prs: [greenUnreviewed()] });
  await s.box.observeFollowUp({ version: 1, workspaces: [open] } as never);
  assert.deepEqual((await s.entry()).needs?.reasons.map(r => r.reason), ["reviewers"], "flagged while it asks");
  assert.equal((await s.entry()).brief?.kind, "reviewers");
  s.advance(5);
  const merged = workspace({ ...open, prs: [greenUnreviewed({ snapshot: snapshot({ reviewers: reviewers(), prWorkflow: "github", state: "MERGED" }) })] });
  await s.box.observeFollowUp({ version: 1, workspaces: [merged] } as never);
  const e = await s.entry();
  assert.equal(e.needs, null, "the merged PR no longer asks for reviewers");
  assert.notEqual(e.brief?.state, "open", "its card closes with it");
  await s.done();
  setReviewerConfig(emptyReviewerConfig());
});

test("an unknown fact keeps its flag: a PR whose status couldn't be read withdraws nothing", async () => {
  withReviewers();
  const s = await inbox([agent("main-agent")]);
  const open = workspace({ mainAgentId: "main-agent", prs: [greenUnreviewed()] });
  await s.box.observeFollowUp({ version: 1, workspaces: [open] } as never);
  const unread = workspace({ ...open, prs: [greenUnreviewed({ error: "gh timed out" })] });
  await s.box.observeFollowUp({ version: 1, workspaces: [unread] } as never);
  assert.deepEqual((await s.entry()).needs?.reasons.map(r => r.reason), ["reviewers"]);
  await s.done();
  setReviewerConfig(emptyReviewerConfig());
});

// ---------- the invariant ----------

const row = (w: Workspace, patch: Partial<InboxRow> = {}): InboxRow => ({ agentId: w.mainAgentId, workspaceId: w.id, title: "Main", workspaceTitle: w.title, multiRoot: false, status: "idle", delegatedFrom: null, resumesAt: null,
  lastActivityAt: iso(), needs: null, snooze: null, signedOffAt: null, undoable: false, seq: 1, muteTurn: false, enable_finish_flags: true, ...patch } as InboxRow);
const obligation = (status: "working" | "waiting", title: string) => ({ id: `o-${status}`, title, status, afterPrs: [], evidence: "", enable_follow_up: false, revision: 1, category: "follow_up" as const });
const sentBatch = { id: "b", tasks: [{ key: "ci:x", kind: "ci", target: "example/app#1", title: "Fix lint", fingerprint: "f" }], state: "sent", createdAt: iso(-2), sentAt: iso(-1), settledAt: null, messageId: "m", attempts: 1, result: "", recipientAgentId: null, contextPath: null, activityAt: null, acknowledgmentError: null, recoveryHandoffs: [] };

/** Every in-flight signal Follow-up knows about, each on its own, with the main agent's turn ended idle. */
const IN_FLIGHT: { signal: string; w: Workspace; row?: Partial<InboxRow> }[] = [
  { signal: "a declared detached wait (waiting obligation)", w: workspace({ prs: [], obligations: [obligation("waiting", "beta.68 install · reload window 11:21")] as never }) },
  { signal: "a working obligation", w: workspace({ prs: [], obligations: [obligation("working", "Release 2.0.0-rc.0")] as never }) },
  { signal: "the main agent running", w: workspace({ prs: [], runtimeBusy: true }), row: { status: "running" } },
  { signal: "background work (Paseo 0.16)", w: workspace({ prs: [], backgroundBusy: true }), row: { status: "running" } },
  { signal: "repairs the agent is on", w: workspace({ batches: [sentBatch] as never, prs: [pr({ snapshot: snapshot({ failedChecks: ["lint"] }) })] }) },
  { signal: "a PR the agent merges itself, mid-release", w: workspace({ prs: [greenUnreviewed({ agentMerges: true })] }) },
  { signal: "an open PR waiting on checks, reviewers asked", w: workspace({ prs: [pr({ snapshot: snapshot({ checksPending: true, reviewers: { ...reviewers(), requested: ["reviewer"] } }) })] }) },
];

test("invariant: no in-flight signal can make a workspace read Needs you, Finished or ready", async () => {
  withReviewers();
  for (const { signal, w, row: patch } of IN_FLIGHT) {
    // The flags the inbox would raise from the workspace's own PR facts.
    const flags = followUpEvents({ version: 1, workspaces: [w] } as never, true).filter(e => !("suppressed" in e.event && e.event.suppressed));
    assert.deepEqual(flags.map(f => f.event.type), [], `${signal}: no inbox flag`);
    assert.deepEqual(needsYou(w, clock).map(i => i.kind), [], `${signal}: no Needs-you item`);
    const home = buildHome({ rows: [row(w, patch)], tracked: [w], paseo: [{ id: w.id, name: w.title, project: null, activityAt: iso() }] as never, now: clock });
    const mine = home.groups.flatMap(g => g.items).filter(i => i.workspaceId === w.id);
    assert.equal(mine.length, 1, `${signal}: one row`);
    assert.ok(["running", "sending", "waiting"].includes(mine[0].group), `${signal}: reads ${mine[0].group}, not running/sending/waiting`);
    assert.doesNotMatch(`${mine[0].word ?? ""} ${mine[0].line}`, /Finished|ready|Ready|declare Done/, `${signal}: "${mine[0].line}"`);
  }
  setReviewerConfig(emptyReviewerConfig());
});

test("a declared wait reads as Waiting with what it waits on", () => {
  const w = IN_FLIGHT[0].w;
  assert.deepEqual(liveLine(w, clock), { icon: "waiting", text: "beta.68 install · reload window 11:21", since: null });
});

test("invariants: the bug's own fixture breaks each new invariant before the fix's state, and holds after", async () => {
  const { INVARIANTS, factFlagViolations } = await import("../shared/status-invariants");
  const by = (id: string) => INVARIANTS.find(i => i.id === id)!;
  for (const { w } of IN_FLIGHT) for (const id of ["agent-merges-asks-nothing", "in-flight-reads-waiting"]) assert.equal(by(id).check(w, clock), null, id);
  // The reported state: "Add reviewers #107" on the main agent after #107 merged, in an unconfigured repository.
  setReviewerConfig(emptyReviewerConfig());
  const merged = workspace({ mainAgentId: "main-agent", prs: [greenUnreviewed({ snapshot: snapshot({ reviewers: reviewers(), state: "MERGED" }) })] });
  const flagged = { agentId: "main-agent", needs: { reasons: [{ reason: "reviewers" as const, at: iso(), detail: "#107", dedupeKey: "reviewers" }], since: iso() } };
  assert.deepEqual(factFlagViolations([flagged], [merged]).map(v => v.id), ["outside-fact-is-live"]);
  assert.deepEqual(factFlagViolations([flagged], [workspace({ ...merged, prs: [greenUnreviewed({ error: "gh timed out" })] })]), [], "unknown is not a violation");
});

test("a declared wait absorbs a finish that states no ask; the agent's own ask still flags", async () => {
  const s = await inbox([agent("main-agent")]);
  await s.box.store.mutate(st => { st.entries["main-agent"] = { agentId: "main-agent", needs: { reasons: [{ reason: "finished", at: iso(), detail: "Waiting on the release.", dedupeKey: "finished" }], since: iso() }, snooze: null, signedOffAt: null, lastTomMessageAt: iso(-3), seq: 1, undo: null, muteTurn: false, enable_finish_flags: true, goneAt: null, seenKeys: [], lastEventAt: iso(), brief: null }; });
  const rowOf = async () => (await s.box.list()).rows.find(r => r.agentId === "main-agent")!;
  assert.ok((await rowOf()).needs, "no declared wait: Finished shows");
  const waiting = workspace({ mainAgentId: "main-agent", prs: [], obligations: [obligation("waiting", "beta.68 install")] as never });
  await s.box.observeFollowUp({ version: 1, workspaces: [waiting] } as never);
  assert.equal((await rowOf()).needs, null, "a declared wait reads as waiting, not Finished");
  await s.box.observeFollowUp({ version: 1, workspaces: [workspace({ ...waiting, obligations: [] })] } as never);
  assert.ok((await rowOf()).needs, "the wait ended: the finish shows again");
  await s.done();
});
