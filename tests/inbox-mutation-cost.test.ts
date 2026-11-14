import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inbox, InboxStore, type Directory } from "../server/inbox";
import { copyOnAccess } from "../server/cow";
import { BRIEF_ORIGINS_MAX, inboxStateSchema, newEntry, type InboxState } from "../shared/inbox";
import { pickBrief } from "../shared/brief";

// Invariant a-mutation-costs-what-it-changes. 2026-11-14 (2.0.2-beta.0, live turn mix 20,8, inbox 86 entries): the inbox
// was the worker's top allocator, 160 of ~600 MB per 5 min. Per turn, a turn start and a turn end each drafted the
// inbox (122 and 791 KB): plain() built a throwaway shadow of every new entry, finish() rebuilt the 86-entry record
// twice even when nothing changed, and the turn end's append to briefOrigins (500 items) structuredCloned,
// shadow-walked and zod-parsed all 500. questionsChanged drafted the inbox on half the turns and never changed it.
// A mutation now allocates for what it changes: one copy of the record when an entry changed, briefOrigins handed out
// as the saved frozen array and only its new item validated, and questionsChanged drafts nothing when nothing is due.

const H = 3_600_000, D = 24 * H;
const T0 = Date.parse("2026-11-14T12:00:00.000Z");
const iso = (ago: number) => new Date(T0 - ago).toISOString();
const words = ["merge", "review", "deploy", "branch", "check", "table", "query", "panel", "status", "build", "schema", "cache"];
const sentence = (n: number, len: number) => Array.from({ length: len }, (_, k) => words[(n * 7 + k * 3) % words.length]).join(" ");

/** The live install's inbox shape (scripts/scale-seed.ts --live-sized): 86 entries, 81 unsorted, 500 origins. Synthetic text only. */
function liveSized(): InboxState {
  const entries = Object.fromEntries(Array.from({ length: 86 }, (_, n) => {
    const e = newEntry(`agent-${n}`);
    e.seenKeys = n === 0 ? Array.from({ length: 200 }, (_, k) => `example/app#${1000 + k}:MERGED`) : Array.from({ length: n % 9 }, (_, k) => `example/app#${2000 + n * 10 + k}:checks`);
    e.lastEventAt = iso((n % 48) * H);
    if (n % 2 === 0) e.needs = { reasons: [{ reason: (["finished", "ci", "review", "reviewers"] as const)[n % 4]!, at: iso((n % 24) * H), detail: sentence(n, 7), dedupeKey: `seed:${n}` }], since: iso((n % 24) * H) };
    if (n % 11 < 6) e.brief = { id: `brief:turn-${n}`, turnId: `turn-${n}`, source: "none", kind: "action", ask: sentence(n + 3, 12).slice(0, 120), state: "open", questionIds: [], at: iso((n % 24) * H), seq: 0, flagged: true, slim: false, decisions: [], context: n % 3 ? sentence(n + 5, 30) : null, mono: null, facts: [], factsPr: null, links: [], moves: [], also: null, sourceLine: `From the agent's last message: ${sentence(n + 1, 6)}`, outcome: null, outcomeAt: null } as never;
    return [e.agentId, e];
  }));
  return inboxStateSchema.parse({ version: 1, entries, importedAt: iso(9 * D), primedAt: iso(9 * D), notifiedAt: iso(9 * D), lastSeen: iso(60_000), revision: 99,
    unsorted: Array.from({ length: 81 }, (_, k) => `helper-${k}`),
    ledger: Array.from({ length: 20 }, (_, k) => ({ agentId: `agent-${k}`, messageId: `seed-m-${k}`, at: iso(k * 60_000), by: "follow-up" })),
    briefOrigins: Array.from({ length: BRIEF_ORIGINS_MAX }, (_, k) => ({ at: iso((BRIEF_ORIGINS_MAX - k) * 600_000), origin: (["tool", "structured", "extraction", "fallback"] as const)[k % 4]! })) });
}

async function setup(t: { after(fn: () => unknown): void }) {
  const dir = await mkdtemp(join(tmpdir(), "follow-mutation-cost-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const directory: Directory = { async agents() { return []; }, async workspaces() { return []; }, async agent() { return null; }, async tail() { return []; }, async clearAttention() {} };
  let now = T0;
  // The worker's write window: mutations land in memory, one write per window (none inside a measurement).
  const inbox: Inbox = new Inbox(dir, {
    enabled: async () => ({ enable_inbox: true, enable_inbox_pr_closed: true }), directory, now: () => now, writeMs: 3_600_000, guard: async () => null,
    briefs: { async sink() {}, async call() { return null; }, async pr() { return null; } },
    sources: { ledger: async () => (await inbox.store.snapshot()).ledger, defer: async () => false, session: async () => false, schedule: async () => false },
  });
  const seed = liveSized();
  await inbox.store.mutate(s => { Object.assign(s, seed); });
  return { inbox, tick: () => { now += 1000; } };
}

/** A turn as the worker records it: the start (a message), then a completed turn end that flags a brief (briefOrigins grows). */
async function turn(inbox: Inbox, n: number) {
  const agentId = `agent-${n % 86}`;
  await inbox.apply([{ agentId, event: { type: "message", from: "automation" } }]);
  const content = pickBrief({ agent: { ask: `Synthetic ask ${n}`, kind: "action" } });
  await inbox.apply([{ agentId, event: { type: "turn_end", outcome: "completed", quiet: false, done: false, detail: "Finished", delegated: false } as never, brief: (_prev, next) => ({ type: "create", id: `brief:cost-${n}`, turnId: `cost-${n}`, content, flagged: true, seq: next.seq }) }]);
}

/**
 * KB allocated per call of `work` (V8's sampling heap profiler, garbage included): the median of `rounds` rounds of `n`
 * calls, after a warm-up round. Measured 2026-11-14 (Node 24): a turn 94 KB (main 902), reading three briefs 19 KB
 * (main 66), storing an equal entry 31 KB (main 86). The budgets sit ≥ 1.6× above the branch and below main.
 */
async function kbPerCall(work: (i: number) => Promise<unknown>, n: number, rounds = 5): Promise<number> {
  const session = new Session(); session.connect();
  try {
    for (let i = 0; i < n; i++) await work(i);
    const results: number[] = [];
    for (let r = 0; r < rounds; r++) {
      await session.post("HeapProfiler.startSampling", { samplingInterval: 256, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
      for (let i = 0; i < n; i++) await work((r + 1) * n + i);
      const { profile } = await session.post("HeapProfiler.stopSampling");
      const { samples } = profile as unknown as { samples: { size: number }[] };
      results.push(samples.reduce((sum, s) => sum + s.size, 0) / n / 1024);
    }
    return results.sort((a, b) => a - b)[rounds >> 1]!;
  } finally { session.disconnect(); }
}

test("a-mutation-costs-what-it-changes: 100 turns on a live-sized inbox allocate ≤ 200 KB a turn (main: ~900)", async t => {
  const { inbox, tick } = await setup(t);
  const kb = await kbPerCall(async i => { tick(); await turn(inbox, i); }, 100);
  assert.ok(kb <= 200, `a turn allocated ${kb.toFixed(0)} KB in the inbox`);
  assert.equal((await inbox.store.snapshot()).briefOrigins.length, BRIEF_ORIGINS_MAX, "the turns flagged briefs, and the log stayed at its cap");
});

test("a-mutation-costs-what-it-changes: a mutation that changes nothing allocates ≤ 50 KB and keeps the saved inbox", async t => {
  const { inbox } = await setup(t);
  const store = inbox.store;
  const before = await store.snapshot();
  const reads = await kbPerCall(() => store.mutate(s => { for (const id of ["agent-0", "agent-3", "agent-5"]) void s.entries[id]?.brief?.state; }), 100);
  const reassign = await kbPerCall(i => store.mutate(s => { const id = `agent-${i % 86}`; s.entries[id] = JSON.parse(JSON.stringify(s.entries[id])); }), 100);
  assert.ok(reads <= 50, `reading three briefs allocated ${reads.toFixed(0)} KB (main: ~66)`);
  assert.ok(reassign <= 50, `storing an equal entry allocated ${reassign.toFixed(0)} KB (main: ~86)`);
  assert.equal(await store.snapshot(), before, "a no-op mutation keeps the saved inbox object");
  assert.equal(store.writes, 0, "and writes nothing");
});

test("a-mutation-costs-what-it-changes: a no-op draft finishes as the saved object itself, and a change copies the record once", () => {
  const saved = liveSized();
  const noop = copyOnAccess(saved, { entries: { kind: "record" } });
  for (const e of Object.values(noop.draft.entries)) void e.needs?.reasons.length;
  noop.draft.entries["agent-4"] = JSON.parse(JSON.stringify(saved.entries["agent-4"]));
  const a = noop.finish();
  assert.equal(a.changed, false); assert.equal(a.next.entries, saved.entries, "the same entries record");
  const one = copyOnAccess(saved, { entries: { kind: "record" } });
  one.draft.entries["agent-4"]!.lastEventAt = iso(0);
  delete one.draft.entries["agent-6"];
  const b = one.finish();
  assert.deepEqual([...b.changes.items.get("entries")!], ["agent-4"]); assert.deepEqual([...b.changes.removed.get("entries")!], ["agent-6"]);
  assert.equal(Object.keys(b.next.entries).length, 85);
  assert.equal(b.next.entries["agent-5"], saved.entries["agent-5"], "untouched entries are the saved objects");
});

test("a-mutation-costs-what-it-changes: briefOrigins is the saved frozen log in a draft, readonly, and only its new items are validated", async t => {
  const { inbox } = await setup(t);
  const store = inbox.store;
  const saved = (await store.snapshot()).briefOrigins;
  await store.mutate(s => {
    assert.equal(s.briefOrigins, saved, "the draft hands out the saved array, not a copy");
    assert.ok(Object.isFrozen(s.briefOrigins) && Object.isFrozen(s.briefOrigins[0]));
    // @ts-expect-error briefOrigins is readonly: a reader can't push to it
    assert.throws(() => s.briefOrigins.push({ at: iso(0), origin: "tool" }), TypeError);
    assert.throws(() => { (s.briefOrigins[0] as { origin: string }).origin = "fallback"; }, TypeError);
  });
  assert.equal((await store.snapshot()).briefOrigins, saved, "reading it changed nothing");
  // Replaced whole: the kept items are the saved objects; a bad new item is refused, an old one isn't re-validated.
  await store.mutate(s => { s.briefOrigins = [...s.briefOrigins, { at: iso(0), origin: "tool" as const }].slice(-BRIEF_ORIGINS_MAX); });
  const after = (await store.snapshot()).briefOrigins;
  assert.equal(after.length, BRIEF_ORIGINS_MAX); assert.equal(after[0], saved[1], "kept items are the saved objects");
  await assert.rejects(store.mutate(s => { s.briefOrigins = [...s.briefOrigins.slice(1), { at: iso(0), origin: "guess" as never }]; }), /origin/, "a new item is validated");
  const parse = inboxStateSchema.shape.briefOrigins.parse; let parsed = 0;
  (inboxStateSchema.shape.briefOrigins as { parse: unknown }).parse = (v: unknown) => { parsed++; return parse(v); };
  try { await store.mutate(s => { s.briefOrigins = [...s.briefOrigins.slice(1), { at: iso(0), origin: "structured" as const }]; }); }
  finally { (inboxStateSchema.shape.briefOrigins as { parse: unknown }).parse = parse; }
  assert.equal(parsed, 0, "the whole log isn't re-parsed on a replacement");
});

test("a-mutation-costs-what-it-changes: briefOrigins keeps its 500-item cap when it is replaced whole", async t => {
  const { inbox, tick } = await setup(t);
  for (let i = 0; i < 30; i++) { tick(); await turn(inbox, i); }
  const origins = (await inbox.store.snapshot()).briefOrigins;
  assert.equal(origins.length, BRIEF_ORIGINS_MAX, "30 flagged briefs on a full log keep it at the cap");
  assert.equal(origins.at(-1)!.at, new Date(T0 + 30_000).toISOString(), "the newest is last");
  await assert.rejects(inbox.store.mutate(s => { s.briefOrigins = [...s.briefOrigins, { at: iso(0), origin: "tool" as const }]; }), /cap is 500/, "a replacement over the cap is refused");
  assert.equal((await inbox.store.snapshot()).briefOrigins.length, BRIEF_ORIGINS_MAX);
});

test("a-mutation-costs-what-it-changes: questionsChanged with nothing due drafts nothing", async t => {
  const { inbox } = await setup(t);
  // An open brief waiting on a question that is still open: nothing is due.
  await inbox.store.mutate(s => { s.entries["agent-0"]!.brief = { ...s.entries["agent-0"]!.brief!, questionIds: ["q1"], workspaceId: "w1" } as never; });
  const store = inbox.store; const mutate = store.mutate.bind(store); let drafts = 0;
  store.mutate = (work => { drafts++; return mutate(work); }) as typeof store.mutate;
  await inbox.questionsChanged([{ id: "w1", questions: [{ id: "q1", answer: null, closed: false } as never] }]);
  assert.equal(drafts, 0, "no draft when no brief's questions moved");
  await inbox.questionsChanged([{ id: "w1", questions: [{ id: "q1", answer: { choice: "Yes", words: null }, closed: false } as never] }]);
  assert.equal(drafts, 1, "an answered question still steps the brief");
});
