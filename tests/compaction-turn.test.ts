import { testStore, rm } from "./support/store-temp-dir";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quiesce } from "./support/queue";
import type { Brief, NeedsYouCall, NeedsYouRecord } from "../shared/brief";
import { compactionOnly } from "../server/inbox-classifier";
import { Inbox, type AgentInfo, type Directory } from "../server/inbox";
import { TurnEnd } from "../server/turn-end";

/**
 * a-compaction-is-not-a-finish (AGENTS.md invariant 130), 2026-11-26, the developer: after an agent compacted (usually
 * Smart Session's request), its timeline got "Earlier ask, the agent kept going: Nothing needed. …" and a Finished
 * card "No ask stated". A turn that only compacted is not the agent finishing work: Follow-up adds nothing for it, on
 * every provider and whoever asked for it, and the ask from before stays open and current. Fictional text throughout.
 */
const T0 = "2026-11-26T09:00:00.000Z";
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();
const doneCall: NeedsYouCall = { ask: "Nothing needed. The nightly export is fixed and merged.", kind: "done" };
const decision: NeedsYouCall = { ask: "Pick how stale export rows are cleaned up", kind: "decision", decisions: [{ question: "Cleanup", options: [{ label: "Daily job" }, { label: "On read" }], recommend: 0 }] };

// The tail Paseo shows for each kind of compaction turn: the prompt (if any) and the compaction divider, nothing else.
const smartCompact = [{ type: "user_message", text: "/compact" }, { type: "plugin", id: "card-1", pluginId: "smart-session", kind: "compaction-request", version: 1, data: { title: "Compaction the agent asked for" } }, { type: "compaction", status: "completed", trigger: "manual", preTokens: 321_000 }];
const typedCompact = [{ type: "user_message", text: "/compact keep the export notes" }, { type: "compaction", status: "completed", trigger: "manual", preTokens: 180_000 }];
const autoCompact = [{ type: "compaction", status: "completed", trigger: "auto", preTokens: 400_000 }];
const earlier = [{ type: "user_message", text: "Fix the nightly export" }, { type: "assistant_message", text: "Fixed and merged." }];

const agent = (patch: Partial<AgentInfo> & { id: string }): AgentInfo => ({ workspaceId: "w1", parentAgentId: null, title: "Main", status: "idle", archivedAt: null, updatedAt: T0, lastUserMessageAt: null, requiresAttention: false, attentionReason: null, ...patch });
const main = { id: "main", workspaceId: "w1", parentAgentId: null };

async function service(o: { session?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "compaction-turn-"));
  const appended: Brief[] = [];
  let tail: unknown[] = [];
  let call: NeedsYouRecord | null = null;
  const agents = [agent({ id: "main" })];
  const directory: Directory = {
    async agents() { return agents; }, async workspaces() { return [{ id: "w1", name: "Synthetic workspace" }]; },
    async agent(id) { return agents.find(a => a.id === id) ?? null; }, async tail() { return tail; }, async clearAttention() {},
  };
  let minute = 1;
  const inbox: Inbox = testStore(Inbox, dir, {
    enabled: async () => ({ enable_inbox: true, enable_inbox_pr_closed: true }), directory,
    sources: { ledger: async () => [], defer: async () => false, session: async () => !!o.session, schedule: async () => false },
    guard: async () => null, graceMs: 5, settleMs: 20, settleStepMs: 5, now: () => Date.parse(at(minute)),
    briefs: { async sink(_id, brief) { appended.push(brief); }, async call() { return call; }, async pr() { return null; }, async prs() { return []; } },
  });
  await inbox.store.mutate(s => { s.importedAt = T0; s.lastSeen = at(0); s.primedAt = T0; s.notifiedAt = T0; });
  /** One whole turn: its timeline, the needs_you it made (if any), its end. */
  const turn = async (turnId: string, items: unknown[], said: NeedsYouCall | null, outcome: Parameters<Inbox["turnEnded"]>[1] = { kind: "completed" }) => {
    minute += 1;
    tail = items;
    await inbox.turnStarted(main, turnId);
    if (said) call = { at: Date.parse(at(minute)), turnId, call: said };
    await inbox.turnEnded(main, outcome, turnId);
  };
  const entry = async () => (await inbox.store.snapshot()).entries.main!;
  return { inbox, appended, turn, entry, done: async () => { await quiesce(inbox); await rm(dir, { recursive: true, force: true }); } };
}

test("the reported case: Smart Session's compaction after a done brief adds no superseded line and no Finished card", async () => {
  const s = await service({ session: true });
  await s.turn("t1", earlier, doneCall);
  const before = await s.entry();
  assert.equal(before.brief?.kind, "done"); assert.equal(before.brief?.state, "open");
  const appendedBefore = s.appended.length;
  await s.turn("t2", smartCompact, null);
  const after = await s.entry();
  assert.deepEqual(s.appended.slice(appendedBefore), [], "nothing appended to the timeline");
  assert.deepEqual(after.brief, before.brief, "the done brief is unchanged: open and current");
  assert.equal(after.needs, null, "no Finished flag");
  assert.deepEqual((await s.inbox.store.snapshot()).briefOrigins.length, 0, "no fallback counted");
  await s.done();
});

test("an open decision and its flag stay exactly as they were through every kind of compaction turn", async () => {
  for (const [name, items, session] of [["Smart Session", smartCompact, true], ["typed /compact", typedCompact, false], ["auto-compaction", autoCompact, false]] as const) {
    const s = await service({ session });
    await s.turn("t1", earlier, decision);
    const before = await s.entry();
    assert.equal(before.brief?.kind, "decision", name); assert.ok(before.needs, name);
    const appendedBefore = s.appended.length;
    await s.turn("t2", items, null);
    const after = await s.entry();
    assert.deepEqual(s.appended.slice(appendedBefore), [], `${name}: nothing appended`);
    assert.deepEqual(after.brief, before.brief, `${name}: the decision brief stays open, not answered or superseded`);
    assert.deepEqual(after.needs, before.needs, `${name}: the flag stays`);
    await s.done();
  }
});

test("after the compaction, the agent's next real ask is a normal new brief and supersedes the old one", async () => {
  const s = await service({ session: true });
  await s.turn("t1", earlier, doneCall);
  await s.turn("t2", smartCompact, null);
  await s.turn("t3", [{ type: "user_message", text: "Continue from the summary." }, { type: "assistant_message", text: "Two ways to clean up." }], decision);
  const e = await s.entry();
  assert.equal(e.brief?.id, "brief:t3"); assert.equal(e.brief?.kind, "decision"); assert.equal(e.brief?.state, "open");
  assert.deepEqual(s.appended.map(b => [b.id, b.state]), [["brief:t1", "open"], ["brief:t1", "superseded"], ["brief:t3", "open"]]);
  await s.done();
});

test("a turn that compacted and then worked is still a finish: no needs_you there gets the honest fallback as before", async () => {
  const s = await service();
  await s.turn("t1", [{ type: "user_message", text: "Port the export" }, { type: "compaction", status: "completed", trigger: "auto", preTokens: 390_000 }, { type: "tool_call", callId: "c1", name: "Bash", status: "completed", error: null, detail: { type: "unknown", input: null, output: null } }, { type: "assistant_message", text: "Ported." }], null);
  const e = await s.entry();
  assert.equal(e.brief?.source, "none"); assert.deepEqual(e.needs?.reasons.map(r => r.reason), ["finished"]);
  await s.done();
});

test("compactionOnly: a compaction and nothing the agent produced", () => {
  assert.equal(compactionOnly(smartCompact), true);
  assert.equal(compactionOnly(typedCompact), true);
  assert.equal(compactionOnly(autoCompact), true);
  assert.equal(compactionOnly([{ type: "compaction", status: "loading" }]), true);
  // Not proven to be only a compaction: no compaction item, or the agent did something.
  assert.equal(compactionOnly([]), false, "an empty read proves nothing (it may have failed)");
  assert.equal(compactionOnly([{ type: "user_message", text: "/compact" }]), false, "no compaction seen");
  for (const work of [{ type: "assistant_message", text: "Done." }, { type: "reasoning", text: "…" }, { type: "tool_call", name: "Bash" }, { type: "todo", items: [] }, { type: "error", message: "boom" }])
    assert.equal(compactionOnly([...autoCompact, work]), false, work.type);
  assert.equal(compactionOnly([...earlier, ...smartCompact]), false, "a tail reaching into an earlier turn isn't this turn alone");
});

test("a provider without hooks gets no turn-end check for a turn that only compacted; a real turn still gets one", async () => {
  const sent: string[] = [];
  const turnEnd = new TurnEnd({ input: async () => ({ entry: { role: "main", workspaceId: "w1" }, syncedAt: null, needsYouAt: null, nudge: true, receipt: {} }), saveReceipt: async () => undefined, send: async (_a, _w, text) => { sent.push(text); } });
  for (const provider of ["pi", "opencode", "copilot"]) {
    const a = { id: `a-${provider}`, provider, parentAgentId: null };
    for (const items of [typedCompact, autoCompact]) {
      turnEnd.turnStarted(a.id);
      assert.equal(await turnEnd.turnEnded(a, { kind: "completed" }, "t1", items), null, `${provider}: nothing sent for a compaction`);
    }
  }
  assert.deepEqual(sent, []);
  turnEnd.turnStarted("a-pi");
  assert.ok(await turnEnd.turnEnded({ id: "a-pi", provider: "pi", parentAgentId: null }, { kind: "completed" }, "t2", earlier), "a turn with a reply is still checked");
});
