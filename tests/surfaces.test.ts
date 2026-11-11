import test from "node:test";
import assert from "node:assert/strict";
import { needsYou } from "../shared/attention";
import { BRIEF_KINDS, type BriefKind } from "../shared/brief";
import { displayPreferences } from "../shared/display";
import { briefKey, flagHeadline, HEADLINE_WORD, pillState, todoLabel, UNDO_MS, workspaceHeadline } from "../shared/headline";
import type { InboxRow, Reason } from "../shared/inbox";
import type { Batch } from "../shared/model";
import { pr, snapshot, workspace } from "./fixtures";

const NOW = Date.parse("2026-11-08T10:12:00.000Z");
const since = "2026-11-08T10:00:00.000Z";
const batch = (patch: Partial<Batch> = {}): Batch => ({ id: "b1", tasks: [{ key: "conflict:example/app#2", kind: "conflict", target: "example/app#2", title: "Resolve merge conflicts on example/app#2", fingerprint: "f" }], state: "pending", createdAt: new Date(NOW - 60_000).toISOString(), sentAt: null, settledAt: null, messageId: "m", attempts: 1, result: "", recipientAgentId: null, contextPath: null, activityAt: null, acknowledgmentError: null, recoveryHandoffs: [], ...patch });
const reason = (r: Reason, detail = "") => ({ reason: r, at: since, detail, dedupeKey: r });
const row = (patch: Partial<InboxRow> = {}): InboxRow => ({
  agentId: "a1", workspaceId: "w1", title: "Main", workspaceTitle: "Synthetic", multiRoot: false, status: "idle", delegatedFrom: null, resumesAt: null,
  lastActivityAt: since, needs: null, snooze: null, signedOffAt: null, undoable: false, seq: 1, muteTurn: false, enable_finish_flags: true, brief: null, ...patch,
});
const flagged = (reasons: Reason[], brief?: { kind: BriefKind; ask: string }) => row({
  needs: { reasons: reasons.map(r => reason(r, `${r} detail`)), since },
  brief: brief ? { kind: brief.kind, source: "agent", state: "open", ask: brief.ask } : null,
});
/** What the brief card's header reads for its kind (client/brief.tsx uses exactly this). */
const cardWord = (kind: BriefKind) => HEADLINE_WORD[briefKey(kind)];
/** What the Needs-you row reads (client/inbox.tsx rowHeadline). */
const rowWord = (r: InboxRow) => { const h = flagHeadline({ ...r, snooze: null }, NOW); return h ? HEADLINE_WORD[h.key] : null; };

test("one precedence: for every brief kind, the pill label, the card header and the row agree", () => {
  for (const kind of BRIEF_KINDS) {
    const r = flagged(["finished"], { kind, ask: "Pick how exports are rate-limited" });
    const pill = pillState({ row: r, items: [], recent: null, now: NOW });
    assert.equal(pill?.mode, "flag");
    if (pill?.mode !== "flag") continue;
    assert.ok(pill.headline.label.startsWith(cardWord(kind)), `${kind}: pill "${pill.headline.label}" leads with the card's "${cardWord(kind)}"`);
    assert.equal(rowWord(r), cardWord(kind), `${kind}: row agrees`);
    assert.equal(pill.headline.line, "Pick how exports are rate-limited", "the popover line is the card's ask");
  }
});

test("labels lead with the decisive word and stay short; no 'Needs you ·' prefix", () => {
  const cases: [InboxRow, string][] = [
    [flagged(["finished"], { kind: "decision", ask: "x" }), "Decision 12m"],
    [flagged(["finished"]), "Finished 12m"],
    [flagged(["permission", "finished"]), "Permission 12m"],
    [flagged(["error"]), "Error 12m"],
  ];
  for (const [r, label] of cases) {
    const h = flagHeadline(r, NOW)!;
    assert.equal(h.label, label);
    assert.ok(h.label.length <= 14, `${label} fits ~10 visible characters plus the age`);
    assert.doesNotMatch(h.label, /Needs you/);
  }
});

test("a failed CI check never headlines on its own: it falls to the next reason, or to Send N fixes when Follow-up can act", () => {
  assert.equal(flagHeadline(flagged(["ci", "finished"]), NOW)?.label, "Finished 12m", "Paseo's checks chip already shows the failure");
  assert.equal(flagHeadline(flagged(["ci"]), NOW)?.key, "flagged");
  const repairs = needsYou(workspace({ prs: [pr()], batches: [batch()] }), NOW).filter(i => i.kind === "send");
  assert.equal(repairs.length, 1);
  assert.equal(flagHeadline(flagged(["ci"]), NOW, repairs)?.label, "Send 1 fix");
});

test("the agent's flag wins over workspace items; those go in the popover as 'N to do', never 'N need you' on the pill", () => {
  const w = workspace({ prs: [pr({ snapshot: snapshot({ reviewDecision: "APPROVED", graphiteMergeStatus: "READY_TO_MERGE" }) })], batches: [batch()] });
  const items = needsYou(w, NOW);
  assert.ok(items.length >= 2);
  const state = pillState({ row: flagged(["finished"]), items, recent: null, now: NOW });
  assert.equal(state?.mode, "flag");
  if (state?.mode === "flag") {
    assert.equal(state.headline.label, "Finished 12m", "matches the Needs-you row");
    assert.equal(state.todo, items.length);
  }
  assert.equal(todoLabel(items), `${items.length} to do`);
});

test("pill state machine: flagged → popover; sign off → undo window → gone; PR-only attention; questions", () => {
  const r = flagged(["finished"]);
  assert.equal(pillState({ row: r, items: [], recent: null, now: NOW })?.mode, "flag");
  // Sign off: the row clears and the store records the recent sign-off.
  const signed = row({ signedOffAt: new Date(NOW).toISOString(), undoable: true });
  const recent = { agentIds: ["a1"], at: NOW };
  assert.deepEqual(pillState({ row: signed, items: [], recent, now: NOW + 1_000 }), { mode: "undo", label: "Signed off" });
  assert.equal(pillState({ row: signed, items: [], recent, now: NOW + UNDO_MS + 1 }), null, "gone after 6 s");
  // Later from the pill: the pill says Later, not Signed off (bug: every recent move read "Signed off").
  const later = row({ needs: { reasons: [], since: new Date(NOW).toISOString() }, snooze: { until: "next-event", at: new Date(NOW).toISOString() } });
  assert.deepEqual(pillState({ row: later, items: [], recent: { ...recent, kind: "later" }, now: NOW + 1_000 }), { mode: "undo", label: "Later" });
  // Another agent's sign-off doesn't put an undo pill here.
  assert.equal(pillState({ row: signed, items: [], recent: { agentIds: ["other"], at: NOW }, now: NOW + 1_000 }), null);
  // PR-only attention on the main agent: no flag, the workspace headlines.
  const merge = needsYou(workspace({ prs: [pr({ number: 812, key: "example/app#812", snapshot: snapshot({ reviewDecision: "APPROVED", graphiteMergeStatus: "READY_TO_MERGE" }) })] }), NOW);
  const prOnly = pillState({ row: null, items: merge, recent: null, now: NOW });
  assert.equal(prOnly?.mode, "workspace");
  if (prOnly?.mode === "workspace") assert.equal(prOnly.headline.label, "Merge #812");
  // After the undo window the workspace pill comes back on its own.
  assert.equal(pillState({ row: signed, items: merge, recent, now: NOW + UNDO_MS + 1 })?.mode, "workspace");
  // A snoozed flag shows nothing unless the workspace has items.
  assert.equal(pillState({ row: { ...r, snooze: { until: "next-event", at: since } }, items: [], recent: null, now: NOW }), null);
  // Nothing at all: no pill.
  assert.equal(pillState({ row: row(), items: [], recent: null, now: NOW }), null);
});

test("questions read as a count, a single one by its id", () => {
  const q = (id: string) => ({ kind: "question" as const, key: `question:${id}`, questionId: id, title: `${id} · Title`, detail: "Which?", state: "waiting" as const, big: null });
  assert.equal(workspaceHeadline([q("Q1"), q("Q2")])?.label, "2 questions");
  assert.equal(workspaceHeadline([q("Q3")])?.label, "Question Q3");
});

test("setting migration: a saved document with the removed 'sidebar item at zero' switch still parses, and the key is dropped", () => {
  const saved = { enable_header_button: false, showSidebar: true, enable_composer_pill: true, enable_inbox: true, enable_inbox_header_when_empty: true, enable_inbox_pr_closed: false, enable_brief_nudge: true };
  const parsed = displayPreferences.schema.safeParse(saved);
  assert.ok(parsed.success);
  assert.equal("enable_inbox_header_when_empty" in parsed.data, false);
  assert.equal(parsed.data.enable_header_button, false, "other saved choices are kept");
  assert.equal(parsed.data.enable_inbox_pr_closed, false);
  assert.equal(displayPreferences.version, 1, "the stored version doesn't change");
});

// ---------- Review threads and red CI are the agent's work; reviewers are the developer's ----------

import { followUpEvents, repairsGoToAgent } from "../server/inbox";
import { firstTracking } from "../server/discovery";
import { newEntry, reduce, type InboxEvent } from "../shared/inbox";
import { pickBrief } from "../shared/brief";
import type { State } from "../shared/model";

const noOne = { author: "dev", requested: [], teams: [], reviewed: [], complete: true };
const asked = { author: "dev", requested: ["reviewer-1"], teams: [], reviewed: [], complete: true };
const red = (w: Parameters<typeof workspace>[0] = {}) => workspace({ prs: [pr({ number: 1499, key: "example/app#1499", snapshot: snapshot({ failedChecks: ["unit"], threads: [{ id: "t1", updatedAt: since }], reviewers: asked }) })], ...w });
const flagsFrom = (w: ReturnType<typeof workspace>) => {
  const events = followUpEvents({ version: 1, workspaces: [w] } as unknown as State, true);
  const e = events.reduce((acc, { event }) => reduce(acc, event as InboxEvent, since), newEntry("main-agent"));
  return { events, reasons: e.needs?.reasons.map(r => r.reason).sort() ?? [] };
};

test("(1)/(2) with auto-send on, red CI and review threads go to the agent and don't flag", () => {
  assert.deepEqual(flagsFrom(red({ enable_auto_sends: true })).reasons, []);
  assert.equal(repairsGoToAgent(red({ enable_auto_sends: true })), true);
});
test("(2) they flag only when the developer has to act: auto-send off, a hold, or a stuck repair", () => {
  assert.deepEqual(flagsFrom(red({ enable_auto_sends: false })).reasons, ["ci", "review"]);
  assert.deepEqual(flagsFrom(red({ enable_auto_sends: true, hold: "You stopped the agent" })).reasons, ["ci", "review"]);
  const stuck = { id: "b1", tasks: [], state: "blocked" as const, createdAt: since, sentAt: since, settledAt: null, messageId: "m", attempts: 3, result: "Needs credentials", recipientAgentId: null, contextPath: null, activityAt: null, acknowledgmentError: null, recoveryHandoffs: [] };
  assert.deepEqual(flagsFrom(red({ enable_auto_sends: true, batches: [stuck] })).reasons, ["ci", "review"]);
});
test("(4) review wording names the work, never 'Review on 1 thread on #1499'", () => {
  const detail = flagsFrom(red()).events.find(e => e.event.type === "review")!.event as { detail: string };
  assert.equal(detail.detail, "1 review thread to fix on #1499");
  assert.doesNotMatch(detail.detail, /^Review on/);
});
test("(1) a workspace tracked for the first time sends repairs on its own; one tracked before keeps its choice", () => {
  assert.equal(firstTracking(workspace({ enable_tracking: false, prs: [] })), true);
  assert.equal(firstTracking(workspace({ enable_tracking: false })), false, "it held PRs before");
  assert.equal(firstTracking(workspace({ enable_tracking: true, prs: [] })), false);
});
test("(3) 'Add reviewers' is a Needs-you reason that doesn't wait for open threads or CI", () => {
  const w = workspace({ enable_auto_sends: true, prs: [pr({ number: 1499, key: "example/app#1499", snapshot: snapshot({ failedChecks: ["unit"], threads: [{ id: "t1", updatedAt: since }], reviewers: noOne }) })] });
  const { events, reasons } = flagsFrom(w);
  assert.deepEqual(reasons, ["reviewers"], "threads and CI go to the agent; reviewers flag the developer");
  const ev = events.find(e => e.event.type === "reviewers")!.event as Extract<InboxEvent, { type: "reviewers" }>;
  assert.equal(ev.detail, "#1499");
  const h = flagHeadline(row({ needs: { reasons: [reason("reviewers", "#1499")], since } }), NOW);
  assert.equal(h?.label, "Add reviewers #1499");
  assert.equal(cardWord("reviewers"), "Add reviewers", "the card agrees with the pill");
  // Not for drafts, PRs that already have reviewers, or while a reviewer request is in flight.
  assert.deepEqual(flagsFrom(workspace({ prs: [pr({ snapshot: snapshot({ draft: true, reviewers: noOne }) })] })).reasons, []);
  assert.deepEqual(flagsFrom(workspace({ prs: [pr({ snapshot: snapshot({ reviewers: asked }) })] })).reasons, []);
  const inFlight = workspace({ prs: [pr({ snapshot: snapshot({ reviewers: noOne }) })], prActions: [{ id: "a", kind: "request_reviewers", prs: ["example/app#1"], heads: {}, createdAt: since, state: "sending", result: "" }] });
  assert.deepEqual(flagsFrom(inFlight).reasons, []);
});
test("(3) the reviewers brief offers Add reviewers with saved reviewers, and without them says none are set and opens the picker", () => {
  const withDefaults = pickBrief({ reviewers: { prKey: "herosecurity/hero-poc#1499", number: 1499, url: "https://example.invalid/pr/1499", names: ["Reviewer A", "Reviewer B"] } });
  assert.equal(withDefaults.kind, "reviewers");
  assert.deepEqual(withDefaults.moves.map(m => m.kind), ["add_reviewers", "open_pr"]);
  assert.match(withDefaults.ask, /^Add reviewers to #1499/);
  const none = pickBrief({ reviewers: { prKey: "example/app#1499", repo: "example/app", number: 1499, url: "https://example.invalid/pr/1499", names: [] } });
  assert.deepEqual(none.moves.map(m => m.kind), ["add_reviewers", "open_pr"]);
  assert.equal(none.ask, "#1499 has no reviewers yet");
  assert.equal(none.sourceLine, "No reviewers set for example/app; Add reviewers lets you pick.");
});

test("a finished flag with no stated ask headlines the workspace's open question, not 'No ask stated'", () => {
  const q = { kind: "question" as const, key: "question:Q1", questionId: "Q1", title: "Q1 · Cyera answers", detail: "Get Cyera answers for the 10 pairs", state: "waiting" as const, big: null };
  const none = { ...flagged(["finished"]), brief: { kind: "done" as BriefKind, source: "none" as const, state: "open" as const, ask: "" } } as InboxRow;
  const h = flagHeadline(none, NOW, [q] as never)!;
  assert.equal(h.key, "question");
  assert.equal(h.line, "Get Cyera answers for the 10 pairs");
  assert.equal(h.source, "flag");
  assert.equal(flagHeadline(flagged(["finished"]), NOW, [])!.key, "finished", "no question: still Finished");
  assert.equal(flagHeadline(flagged(["finished"], { kind: "decision", ask: "Pick one" }), NOW, [q] as never)!.key, "decision", "a real ask wins");
});

// 1.4.0-beta.59: during Done's Undo window the pill still read "Action": Done waits on the toast, so the brief is still
// open on the daemon. The developer's own move owns the pill for its window, the same way Signed off and Later do.
test("Done owns the pill for its Undo window: 'Done', then back to the ask if undone", () => {
  const r = flagged(["finished"], { kind: "action", ask: "Rotate the staging API key" });
  assert.equal(pillState({ row: r, items: [], recent: null, now: NOW })?.mode, "flag");
  assert.deepEqual(pillState({ row: r, items: [], recent: null, done: true, now: NOW }), { mode: "undo", label: "Done" });
  // A sign-off elsewhere inside the window doesn't take Done's place (critique: one shared `recent` slot did).
  assert.deepEqual(pillState({ row: r, items: [], recent: { agentIds: ["other"], at: NOW }, done: true, now: NOW + 1_000 }), { mode: "undo", label: "Done" });
  assert.equal(pillState({ row: r, items: [], recent: null, done: false, now: NOW + 1_000 })?.mode, "flag", "undone: the ask is back");
});

test("Done windows are per agent: a second Done or a sign-off can't take one over, and Undo cancels only its own", async () => {
  const { createDoneWindows } = await import("../client/done-windows");
  let changes = 0; const cancelled: string[] = [];
  const w = createDoneWindows(() => { changes++; });
  w.note("a1", () => cancelled.push("a1")); w.note("a2", () => cancelled.push("a2"));
  assert.ok(w.has("a1") && w.has("a2"), "two windows at once");
  assert.equal(w.undo(["a3"]), false, "another agent's Undo isn't Done's");
  assert.equal(w.undo(["a1"]), true); assert.deepEqual(cancelled, ["a1"]); assert.equal(w.has("a1"), false); assert.equal(w.has("a2"), true);
  w.end("a2"); assert.equal(w.has("a2"), false); assert.deepEqual(cancelled, ["a1"], "the toast ending is not an undo");
  assert.equal(changes, 4);
});

// 1.4.0-beta.62: the collapsed Done card showed the success-green check during the Undo window, before anything was
// sent. A card is green only once its outcome has landed on the daemon; a Done still waiting on its toast is muted.
test("a past card's check is green only once its outcome landed; a pending Done stays muted", async () => {
  const { pastTone } = await import("../shared/brief");
  assert.equal(pastTone("answered", false), "success");
  assert.equal(pastTone("answered", true), "muted", "Done inside its Undo window (or still sending)");
  assert.equal(pastTone("superseded", false), "muted");
  const { readFile } = await import("node:fs/promises"); const { join } = await import("node:path");
  const view = await readFile(join(import.meta.dirname, "..", "client", "brief.tsx"), "utf8");
  assert.match(view, /if \(marked\) return <Past [^\n]*pending /, "the locally marked Done renders as pending");
  assert.doesNotMatch(view.slice(view.indexOf("function Past"), view.indexOf("function Past") + 4000), /color=\{c\.statusSuccess\}/, "Past takes its colour from pastTone only");
});
