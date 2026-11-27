// compass-reaches-an-agent-only-by-a-click (AGENTS.md invariant 107). A Compass note reaches an agent only when someone
// asks for it: Tell the agent (one click in the panel, or compass_note tell, planned and confirmed). Reads, the
// morning read, Home lines and why_suggested never queue a message. Also the hand notes' life: pin, edit, unpin.
// Fake mcpproxy and model; fictional people only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiJobs } from "../server/ai-jobs";
import { CompassStore } from "../server/compass";
import { MorningBriefStore } from "../server/morning-brief";
import { RPC_TOOLS } from "../server/agent-parity";
import { rm, testStore } from "./support/store-temp-dir";
import { CHAT_TOOLS, DANA, fakeMcpproxy, fakeModel, testCompass, historyText } from "./support/compass-fakes";
import { applyNoteAction, noteActionSchema, noteLines, settleNotes, type CompassChange, type CompassNote } from "../shared/compass";

const NOW = Date.parse("2026-11-24T09:00:00Z"); // a Tuesday
const DAY = 86_400_000;
const DANA_SOURCE: CompassChange = { source: { label: "Dana · product", who: { kind: "person", person: { id: DANA, name: "Dana" } }, places: [{ kind: "conversation", sub: "dm", id: DANA, name: "Dana" }], roles: ["priorities"] } };
const EXPIRY = { undatedDays: 7, graceDays: 1, decayWorkdays: 3 };

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "compass-agent-"));
  const mcp = fakeMcpproxy({ tools: CHAT_TOOLS(true), answer: () => historyText([{ by: DANA, name: "Dana", at: "2026-11-23T14:00:00Z", text: "ACME-12 invoice export is really important for the client call" }]) });
  const model = fakeModel(() => ({ notes: [{ item: "m1", what: "ACME-12 invoice export", keys: ["ACME-12"], kind: "issue", strength: "high", untilWords: null, until: null, quote: "ACME-12 invoice export is really important" }], retracts: [], nothing: false }));
  const told: { workspace: string; text: string; by: string }[] = [];
  let clock = NOW; let n = 0;
  const compass = testCompass(dir, {
    settings: testStore(MorningBriefStore, dir), store: testStore(CompassStore, dir), tools: mcp.tools,
    jobs: new AiJobs({ runner: model.runner, logPath: join(dir, "ai-jobs.jsonl") }),
    role: async () => ({ provider: "claude", model: "haiku", thinking: null, label: "Claude" }),
    clock: async () => ({ timeZone: "UTC", workdays: ["Mon", "Tue", "Wed", "Thu", "Fri"] }), sweepAt: async () => "08:00",
    index: async () => ({ workspaces: [{ id: "ws-invoice", title: "Invoice export for acme", branch: "acme-12-invoice-export" }, { id: "ws-app", title: "APP-142 retry", branch: "app-142" }], issueWorkspace: k => k === "ACME-12" ? "ws-invoice" : null }),
    tell: async (workspace, text, by) => { told.push({ workspace, text, by }); return workspace === "ws-invoice" ? { agentId: "agent-main" } : null; },
    now: () => clock, newId: () => `s-test${++n}`,
  });
  return { dir, compass, told, setNow: (t: number) => { clock = t; } };
}

test("reads, the morning read, Home lines and why_suggested never reach an agent; only tell does, once, with the quote as someone else's words", async () => {
  const t = await setup();
  try {
    await t.compass.set(DANA_SOURCE, "developer");
    await t.compass.read("manual");
    await t.compass.tick();
    const v = await t.compass.view({ workspace: "ws-invoice" });
    assert.equal(v.notes.length, 1, "the read made one note on the workspace");
    await t.compass.lines();
    await t.compass.why({ workspace: "ws-invoice" });
    await t.compass.note({ action: "pin", workspace: "ws-invoice", what: "client call Tue" }, "developer");
    await t.compass.note({ action: "edit", id: v.notes[0].id, strength: "low" }, "developer");
    assert.equal(t.told.length, 0, "nothing but tell queues a message");

    const r = await t.compass.note({ action: "tell", id: v.notes[0].id }, "agent:agent-overseer");
    assert.deepEqual(r.told, { agentId: "agent-main" });
    assert.equal(t.told.length, 1, "one message");
    assert.equal(t.told[0].workspace, "ws-invoice");
    assert.equal(t.told[0].by, "agent:agent-overseer", "audited as the agent that confirmed it");
    assert.match(t.told[0].text, /someone else's words, for context/);
    assert.match(t.told[0].text, /"ACME-12 invoice export is really important"/, "the quote travels as a quote");
    assert.match(t.told[0].text, /Dana \(Dana · product\) in a DM/);
  } finally { await rm(t.dir, { recursive: true, force: true }); }
});

test("tell refuses a note off any workspace, an ended note, and a workspace with no main agent; nothing is queued", async () => {
  const t = await setup();
  try {
    const { view } = await t.compass.note({ action: "pin", workspace: "ws-app", what: "APP-142 retry first" }, "developer");
    const id = view.notes[0].id;
    await assert.rejects(t.compass.note({ action: "tell", id }, "developer"), /no main agent/);
    await t.compass.note({ action: "unpin", id }, "developer");
    await assert.rejects(t.compass.note({ action: "tell", id }, "developer"), /ended/);
    await assert.rejects(t.compass.note({ action: "tell", id: "n-missing" }, "developer"), /No Compass note/);
    assert.equal(t.told.length, 1, "only the first try reached the tell dep, which found no agent");
  } finally { await rm(t.dir, { recursive: true, force: true }); }
});

test("compass_note is planned (confirm first) and why_suggested is a read; Tell's queue message is the only one Compass writes", async () => {
  const note = RPC_TOOLS.find(x => x.name === "compass_note")!;
  assert.equal(note.kind, "planned");
  assert.equal(note.rpc, "follow.compass-note");
  assert.equal(RPC_TOOLS.find(x => x.name === "why_suggested")?.kind, "read");
  const server = await readFile(new URL("../index.server.ts", import.meta.url), "utf8");
  assert.equal(server.match(/enqueueMessage\([^)]*`compass-/g)?.length, 1, "one compass queue path, the tell dep");
  const compass = await readFile(new URL("../server/compass.ts", import.meta.url), "utf8");
  assert.equal(compass.match(/this\.d\.tell\(/g)?.length, 1, "Compass calls tell in one place");
  assert.match(compass.slice(compass.indexOf("async note("), compass.indexOf("async lines(")), /this\.d\.tell\(/, "and that place is note()");
});

test("hand notes: pin, edit, unpin; a dated one ends on its day, an undated one stays until unpinned", () => {
  const ctx = { now: NOW, by: "developer" as const, newId: () => "n-1", workspaceExists: (id: string) => id === "ws-invoice" || id === "ws-app" };
  assert.equal(noteActionSchema.safeParse({ action: "pin", what: "x" }).success, false, "pin needs a workspace");
  assert.equal(noteActionSchema.safeParse({ action: "edit", id: "n-1" }).success, false, "edit needs a change");
  const missing = applyNoteAction([], { action: "pin", workspace: "ws-gone", what: "x" }, ctx);
  assert.equal(missing.ok, false);
  const far = applyNoteAction([], { action: "pin", workspace: "ws-invoice", what: "x", until: "2027-06-01" }, ctx);
  assert.equal(far.ok, false, "until stays in range");

  const pinned = applyNoteAction([], { action: "pin", workspace: "ws-invoice", what: "client call Tue" }, ctx);
  assert.ok(pinned.ok);
  const note = pinned.note;
  assert.deepEqual([note.source, note.state, note.match.how, note.by], ["hand", "live", "hand", "developer"]);
  assert.deepEqual(noteLines(pinned.notes, NOW, EXPIRY), { "ws-invoice": "You: client call Tue" });

  const later = settleNotes(pinned.notes, { now: NOW + 60 * DAY, expiry: EXPIRY });
  assert.equal(later[0].state, "live", "an undated hand note lasts until unpinned");

  const moved = applyNoteAction(pinned.notes, { action: "edit", id: note.id, workspace: "ws-app", until: "2026-11-26" }, ctx);
  assert.ok(moved.ok);
  assert.deepEqual([moved.note.match.workspace, moved.note.until], ["ws-app", "2026-11-26"]);
  const after = settleNotes(moved.notes, { now: Date.parse("2026-11-28T09:00:00Z"), expiry: EXPIRY });
  assert.notEqual(after[0].state, "live", "a dated hand note ends after its day");

  const gone = applyNoteAction(pinned.notes, { action: "unpin", id: note.id }, ctx);
  assert.ok(gone.ok);
  assert.equal(gone.note.state, "unpinned");
  assert.deepEqual(noteLines(gone.notes as CompassNote[], NOW, EXPIRY), {}, "an unpinned note leaves Home");
});
