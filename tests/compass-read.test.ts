// compass-reads-only-what-was-named, compass-text-is-data (AGENTS.md invariants 98, 102). Compass reads only the places
// a source names, by cursor in time order, only the words its `who` allows, and never on a provider Follow-up can't
// take every tool away from. Fake mcpproxy (a chat server found by shape) and a fake model; fictional people only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiJobs } from "../server/ai-jobs";
import { CompassStore } from "../server/compass";
import { MorningBriefStore } from "../server/morning-brief";
import { rm, testStore } from "./support/store-temp-dir";
import { AVI, CHAT_TOOLS, DANA, DEV, fakeMcpproxy, fakeModel, testCompass, historyText, type Msg } from "./support/compass-fakes";
import type { CompassChange } from "../shared/compass";

const NOW = Date.parse("2026-11-24T09:00:00Z"); // a Tuesday
const DM = { kind: "conversation" as const, sub: "dm" as const, id: DANA, name: "Dana" };
const DANA_SOURCE: CompassChange = { source: { label: "Dana · product", who: { kind: "person", person: { id: DANA, name: "Dana" } }, places: [DM], roles: ["priorities", "plan"] } };
const MSGS: Msg[] = [
  { by: DANA, name: "Dana", at: "2026-11-23T14:00:00Z", text: "ACME-12 invoice export is really important, the acme demo is tomorrow" },
  { by: DEV, name: "Me", at: "2026-11-23T14:05:00Z", text: "on it" },
  { by: AVI, name: "Avi", at: "2026-11-23T14:06:00Z", text: "lunch?" },
];

async function setup(opts: { provider?: string; history?: boolean; msgs?: Msg[]; reply?: (p: string) => unknown; beforeExtract?: () => Promise<void> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "compass-"));
  const mcp = fakeMcpproxy({ tools: CHAT_TOOLS(opts.history ?? true), answer: () => historyText(opts.msgs ?? MSGS) });
  const model = fakeModel(opts.reply ?? (() => ({ notes: [{ item: "m1", what: "ACME-12 invoice export", keys: ["ACME-12"], kind: "issue", strength: "high", untilWords: "tomorrow", until: null, quote: "ACME-12 invoice export is really important" }], retracts: [], nothing: false })));
  let n = 0;
  const settings = testStore(MorningBriefStore, dir);
  const store = testStore(CompassStore, dir);
  const changes: string[] = [];
  const compass = testCompass(dir, {
    settings, store, tools: mcp.tools, jobs: new AiJobs({ runner: async input => { await opts.beforeExtract?.(); return model.runner(input); }, logPath: join(dir, "ai-jobs.jsonl") }),
    role: async () => ({ provider: opts.provider ?? "claude", model: "haiku", thinking: null, label: opts.provider === "gemini" ? "Gemini" : "Claude" }),
    clock: async () => ({ timeZone: "UTC", workdays: ["Mon", "Tue", "Wed", "Thu", "Fri"] }), sweepAt: async () => "08:00",
    index: async () => ({ workspaces: [{ id: "ws-invoice", title: "Invoice export for acme", branch: "acme-12-invoice-export" }], issueWorkspace: k => k === "ACME-12" ? "ws-invoice" : null }),
    now: () => NOW, newId: () => `s-test${++n}`, onChange: () => changes.push("changed"),
  });
  return { dir, mcp, model, compass, store, changes };
}

test("a source's place is read through the history tool by cursor, only the source's words reach the model, and the note finds its workspace", async () => {
  const t = await setup();
  try {
    await t.compass.set(DANA_SOURCE, "developer");
    await t.compass.read("manual");
    const reads = t.mcp.calls.filter(c => c.sub === "tool-read");
    assert.ok(reads.length >= 1 && reads.every(c => c.tool === "talk:talk_read_channel" && c.args.channel_id === DANA), "only the named place, through tool-read");
    assert.equal(reads[0].args.oldest, ((NOW - 7 * 86_400_000) / 1000).toFixed(6), "a new place is read over the last week");
    const prompt = t.model.prompts[0];
    assert.match(prompt, /ACME-12 invoice export is really important/);
    assert.match(prompt, /\(developer's reply\) Me/, "the developer's reply comes along as context");
    assert.doesNotMatch(prompt, /lunch\?/, "someone else's words in the place never reach the model");
    const v = await t.compass.view();
    assert.equal(v.notes.length, 1);
    const note = v.notes[0];
    assert.deepEqual([note.until, note.match.workspace, note.match.how, typeof note.by === "object" && note.by.name], ["2026-11-24", "ws-invoice", "key", "Dana"]);
    assert.equal(v.places[`conversation:${DANA}`].at, "2026-11-23T14:06:00.000Z", "the cursor moves to the newest message read");
    assert.deepEqual(t.changes, ["changed"], "AI priority hears once");
    // A second read starts at the cursor and makes no model call when nothing is new.
    t.mcp.calls.length = 0;
    await t.compass.read("manual");
    assert.equal(t.mcp.calls.find(c => c.sub === "tool-read")!.args.oldest, (Date.parse("2026-11-23T14:06:00Z") / 1000).toFixed(6));
    assert.equal(t.model.prompts.length, 1, "nothing new: no model call");
  } finally { await rm(t.dir, { recursive: true, force: true }); }
});

test("on a provider with no guard Compass reads nothing at all and says why in one line", async () => {
  const t = await setup({ provider: "gemini" });
  try {
    await t.compass.set(DANA_SOURCE, "developer");
    const r = await t.compass.read("manual");
    assert.equal(t.mcp.calls.filter(c => c.sub === "tool-read").length, 0, "no conversation was read");
    assert.equal(t.model.prompts.length, 0, "no model call");
    assert.equal(r!.ok, false);
    assert.match(r!.error!, /^Compass doesn't read on Gemini: Follow-up can't take its tools away\./);
    assert.equal((await t.compass.view()).blocked, r!.error);
  } finally { await rm(t.dir, { recursive: true, force: true }); }
});

test("without a history tool the message search is read by time, one day at a time, and the place says it's the slower path", async () => {
  const t = await setup({ history: false });
  try {
    await t.compass.set(DANA_SOURCE, "developer");
    await t.compass.read("manual");
    const reads = t.mcp.calls.filter(c => c.sub === "tool-read");
    assert.ok(reads.length >= 7 && reads.every(c => c.tool === "talk:talk_search_messages" && c.args.sort === "timestamp"), "sorted by time, never by relevance");
    assert.equal((await t.compass.view()).places[`conversation:${DANA}`].status, "slow-path");
  } finally { await rm(t.dir, { recursive: true, force: true }); }
});

test("a failed read keeps the cursor; a place no reader here serves is refused with why", async () => {
  const t = await setup();
  try {
    await t.compass.set(DANA_SOURCE, "developer");
    await t.compass.read("manual");
    const before = (await t.compass.view()).places[`conversation:${DANA}`].at;
    const broken = fakeMcpproxy({ answer: () => { throw new Error("dial timeout"); } });
    (t.compass as unknown as { d: { tools: unknown } }).d.tools = broken.tools;
    await t.compass.read("manual");
    const p = (await t.compass.view()).places[`conversation:${DANA}`];
    assert.deepEqual([p.status, p.at], ["failed", before], "a missed read is never 'nothing said'");
    // A place no reader here can serve is refused with one line of why, never saved to sit unread (a chat-only host here).
    await t.compass.readers(true);
    await assert.rejects(t.compass.set({ source: { who: { kind: "me" }, places: [{ kind: "doc", id: "page-1", name: "notes" }], roles: ["self"] } }, "developer"), /No connected docs tool can read a page/);
    await assert.rejects(t.compass.set({ source: { who: { kind: "anyone" }, places: [{ kind: "tracker", scope: "label", id: "acme-label", name: "acme" }], roles: ["priorities"] } }, "developer"), /No tracker is connected/);
  } finally { await rm(t.dir, { recursive: true, force: true }); }
});

test("the morning read runs once a workday after the sweep time, from the worker's loop", async () => {
  const t = await setup();
  try {
    await t.compass.set(DANA_SOURCE, "developer");
    await t.compass.read("manual");
    const before = t.model.prompts.length;
    await t.compass.tick(); await t.compass.tick();
    assert.equal(t.model.prompts.length, before, "the added read already covered it: nothing new, no model call");
    assert.equal((await t.store.read()).readDay, "2026-11-24", "one morning read a day");
  } finally { await rm(t.dir, { recursive: true, force: true }); }
});

test("text is data: compass.json keeps quotes, never the text read, and the job log keeps no text", async () => {
  const t = await setup();
  try {
    await t.compass.set(DANA_SOURCE, "developer");
    await t.compass.read("manual");
    const file = await readFile(join(t.dir, "compass.json"), "utf8");
    assert.doesNotMatch(file, /the acme demo is tomorrow/, "only the quote, never the whole message");
    assert.doesNotMatch(file, /lunch|on it/);
    const log = await readFile(join(t.dir, "ai-jobs.jsonl"), "utf8");
    assert.doesNotMatch(log, /invoice|acme|Dana/i);
  } finally { await rm(t.dir, { recursive: true, force: true }); }
});

test("a source added while another's first read runs still gets its own first read", async () => {
  const t = await setup();
  try {
    // Two sources added back to back: before the fix the second's "added" read joined the first's, which read only the first.
    await t.compass.set(DANA_SOURCE, "developer");
    await t.compass.set({ source: { label: "Avi", who: { kind: "person", person: { id: AVI, name: "Avi" } }, places: [{ kind: "conversation", sub: "dm", id: AVI, name: "Avi" }], roles: ["priorities"] } }, "developer");
    await t.compass.idle();
    const v = await t.compass.view();
    assert.ok(v.places[`conversation:${DANA}`] && v.places[`conversation:${AVI}`], "both new places were read over the last week");
  } finally { await rm(t.dir, { recursive: true, force: true }); }
});

test("temp-dir cleanup waits for an active background read and its queued read", async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const t = await setup({ beforeExtract: async () => { entered(); await gate; } });
  let queued: Promise<unknown> | undefined;
  let cleanup: Promise<void> | undefined;
  try {
    await t.compass.set(DANA_SOURCE, "developer");
    await started;
    queued = t.compass.read("manual");
    let removed = false;
    cleanup = rm(t.dir, { recursive: true, force: true }).then(() => { removed = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(removed, false, "cleanup waits while the background read can still write");
    release();
    await Promise.all([cleanup, queued]);
    await assert.rejects(stat(t.dir), { code: "ENOENT" });
    await t.compass.idle(); // already idle is safe too
  } finally {
    release();
    await queued;
    if (cleanup) await cleanup;
    else await rm(t.dir, { recursive: true, force: true });
  }
});
