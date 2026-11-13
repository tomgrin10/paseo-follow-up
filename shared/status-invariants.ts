import { recoveryBatch } from "./follow-up";
import { oneReading } from "./status";
import type { Actor } from "./actor";
import { ANY_HOOK_TEXT_PREFIXES } from "./message-sender";
import { BATCH_PREFIXES, RECOVERY_TITLES } from "./legacy";
import type { Workspace } from "./model";
import { answerMessage, duplicateOpenQuestions, isOther, parseAnswerMessage, parseAnswersMessage } from "./questions";
import { briefAnswer, briefAnswers, briefAsks, briefStep, reviewersBriefPr, shouldReopen, type Brief } from "./brief";
import { flagHeadline, HEADLINE_WORD } from "./headline";
import { newEntry, prEndEvent, REASONS, reduce, type InboxRow } from "./inbox";
import { blockedOnDeveloper, completionCheck, liveWorkingTask, summary } from "./model";
import { asksForReviewers, liveLine, needsYou, type NeedItem } from "./attention";
import { prChip, trackedGroup, type HomeModel } from "./home";
import { freshPriorities, type Priority } from "./priorities";
import { agentCard, automaticHold, batchView, holdSuperseded } from "./status";
import { conditionId, isCapped, NO_PROGRESS_CAP, sendDecision } from "./send-decision";
import { messageStrip, obligationDelivery, repairRows } from "./task-rows";
import { followUpObligations } from "./follow-up";
import { PRESENCE, claimsWorking, taskStatus } from "./task-status";
import { cadence, movingReason, OBSERVATION_FRESH_MS, POLL_IDLE_MS, RUNNING_POLL_MS, TICK_MS } from "./poll";
import { staleUpdatePhase, type UpdatePhase } from "./updates";
import { foldedAsk, needsYouBlock, onceViolation } from "./needs-block";
import { compactPrStatus, prPresentation } from "./presentation";
import { agentMerges } from "./pr-workflow";

/**
 * Status invariants: what must hold for any workspace, whatever path changed it. Pure, no IO, and never throwing:
 * `check` returns null when the invariant holds, else a short detail. Each id names the bug class it guards
 * (tests/status-invariants.test.ts runs every one over a grid of workspaces plus one fixture per reported bug).
 */
export type Invariant = { id: string; why: string; check(w: Workspace, now: number): string | null };

const idle = (w: Workspace) => !w.runtimeBusy && !w.backgroundBusy;
const inFlight = (w: Workspace) => w.batches.some(b => ["sending", "sent"].includes(b.state));
const lines = (w: Workspace, now: number) => [liveLine(w, now).text, agentCard(w, now)?.line ?? "", batchView(w, now)?.line ?? "", ...needsYou(w, now).flatMap(i => [i.title, "blocker" in i ? i.blocker ?? "" : ""])];

export const INVARIANTS: Invariant[] = [
  {
    id: "a-task-only-says-working-when-its-agent-is",
    why: "2026-11-12: tasks read \"Agent working\" for days because the label mirrored the stored status=working, not any agent's live state; the panel's live line kept a spinner on a task whose agent had closed. Every surface that derives \"working\" from a task (the task row and sheet, the live line, the summary's Agent handling, Home's Agent working group) reads the recorded agent's live state (Workspace.taskAgents, shared/task-status.ts); with no agent recorded it says In progress; a recorded agent the directory doesn't know (not read yet, or Paseo doesn't list it) reads \"Agent unavailable\": words only, no live state, no link, never In progress. A known agent's word and link follow PRESENCE, shared with the chat's created cards. Only a working agent spins; idle, closed (Paseo ended the session: the idle unload or a plugin reload; it keeps its Open chat link, the developer's tap being the only load) and archived (words only) never claim working.",
    check(w, now) {
      const agents = w.taskAgents ?? {};
      const running = (id: string | undefined) => !!id && agents[id]?.state === "working";
      // The task row and sheet, with the stored live states and with none.
      for (const o of followUpObligations(w)) for (const known of [agents, {}]) {
        const s = taskStatus(o, w, known, now);
        if ((claimsWorking(s.text) || s.tone === "working") && !(known === agents && running(o.workingAgentId))) return `task row "${s.text}" with no live working agent`;
        if (o.status !== "working" || !o.workingAgentId) continue;
        const live = known[o.workingAgentId];
        // An agent the directory doesn't know is words only: no live state, no link, and never "In progress".
        if (!live && (s.tone !== "unknown" || s.agentId || s.text === "In progress")) return `task row "${s.text}" (${s.tone}) for an agent the directory doesn't know`;
        // A known agent's link follows PRESENCE, the table the chat cards read too.
        if (live && (!!s.agentId !== PRESENCE[live.state].opens || (s.link ?? null) !== PRESENCE[live.state].link)) return `task row "${s.text}" links unlike PRESENCE.${live.state}`;
      }
      // Anything else that spins or says handling needs a running agent or Follow-up's own batch in flight.
      const working = followUpObligations(w).find(o => o.status === "working" && !running(o.workingAgentId));
      const live = liveLine(w, now);
      if (working && live.icon === "spinner" && live.text.startsWith(working.title)) return `live line spins on "${working.title}" with no live working agent`;
      if (summary(w, now).status === "handling" && !w.runtimeBusy && !inFlight(w) && !liveWorkingTask(w)) return `"${summary(w, now).label}: ${summary(w, now).reason}" with no live working agent`;
      if (trackedGroup(w, now) === "running" && !w.runtimeBusy) return "Home's running group with no live working agent";
      return null;
    },
  },
  {
    id: "poll-backoff-never-hides-a-moving-pr",
    why: "2026-11-11 cpu-load §5: PR polling backs off for settled repositories. A PR that can still change without bumping what the last read saw (merge queue, merge when ready, unknown mergeability, an error) is read every tick, one with running checks every 30 s, and a backed-off PR is never older than the completion gate allows (shared/poll.ts).",
    check(w, now) {
      if (POLL_IDLE_MS + TICK_MS >= OBSERVATION_FRESH_MS) return `idle poll ${POLL_IDLE_MS} ms + tick ${TICK_MS} ms reaches the ${OBSERVATION_FRESH_MS} ms freshness gate`;
      if (RUNNING_POLL_MS > POLL_IDLE_MS) return `running checks read every ${RUNNING_POLL_MS} ms, slower than settled PRs`;
      const backedOff = w.prs.find(p => movingReason(p.snapshot, p.error) && cadence(p.snapshot, p.error, null, now) === "idle");
      return backedOff ? `${backedOff.key} (${movingReason(backedOff.snapshot, backedOff.error)}) would back off` : null;
    },
  },
  {
    id: "no-duplicate-open-question",
    why: "Needs-you never shows two cards for the same open question: every path that creates a question links to a matching open one instead (shared/questions.ts findOpenMatch).",
    check(w) {
      const dupes = duplicateOpenQuestions(w.questions ?? []);
      return dupes.length ? dupes.map(d => `${d.duplicate.id} repeats ${d.of.id}`).join(", ") : null;
    },
  },
  {
    id: "the-send-line-matches-the-send-decision",
    why: "2026-11-12: the panel said \"4 repairs queued · sending now\" while the worker wouldn't send (a PR it couldn't read, a refused dispatch it swallowed): the line and the auto-send were two copies of one rule. A queued batch's line is the worker's own decision (shared/send-decision.ts), so it only says sending when the next refresh sends.",
    check(w, now) {
      const v = batchView(w, now);
      if (v?.phase !== "queued" || v.kind !== "repairs") return null;
      const d = sendDecision(w, now, { batch: v.batch });
      if (!v.line.endsWith(d.reason)) return `line "${v.line}" but the decision is "${d.reason}"`;
      if (v.waitingOn !== d.waitingOn) return `line waits on ${v.waitingOn}, the decision on ${d.waitingOn}`;
      if (/going out now|waits a minute so new changes/.test(v.line) && d.waitingOn !== null) return `"${v.line}" while the send waits on ${d.waitingOn}`;
      return null;
    },
  },
  {
    id: "message-rows-say-it-once",
    why: "2026-11-12 (Q49 mock review): every row in the next message repeated \"sends at 14:32\" or \"sends after the agent's current turn\", and the header said it a third time. The Tasks strip carries when and why, straight from the send decision; a row in the message, repair or Auto task, says only Queued or Sent.",
    check(w, now) {
      const strip = messageStrip(w, now);
      if (strip?.phase === "queued" && sendDecision(w, now).waitingOn !== "you" && strip.reason !== sendDecision(w, now).reason) return `strip says "${strip.reason}" but the decision is "${sendDecision(w, now).reason}"`;
      for (const r of repairRows(w).open) if ((r.state === "queued" && r.text !== "Queued") || (r.state === "sent" && r.text !== "Sent")) return `${r.task.key} row says "${r.text}"`;
      for (const o of w.obligations ?? []) {
        const d = obligationDelivery(w, o), s = taskStatus(o, w, w.taskAgents ?? {}, now);
        if (d && o.status !== "working" && !["done", "waived", "blocked"].includes(o.status) && s.text !== (d === "sent" ? "Sent" : "Queued")) return `task ${o.id} in the message says "${s.text}"`;
      }
      return null;
    },
  },
  {
    id: "a-capped-task-never-holds-the-queue",
    why: "2026-11-12 (Q49/Q50): a turn that ended without acknowledge_batch blocked the whole batch and asked for Retry, so every other task waited behind one stubborn condition; a second rule blocked a PR's next message after three acknowledged ones. Such a turn settles its batch (never blocked), and only a condition that went out NO_PROGRESS_CAP times unchanged (acknowledged or not) is held, as its own task, while the rest of the queue keeps moving.",
    check(w) {
      const blocked = w.batches.find(b => b.state === "blocked" && b.unacknowledged);
      if (blocked) return `${blocked.id} is blocked for a missing acknowledgment`;
      // One cap: only an agent's own blocked acknowledgment blocks a message, never a count of earlier messages.
      const unsent = w.batches.find(b => b.state === "blocked" && !b.sentAt && !recoveryBatch(b));
      if (unsent) return `${unsent.id} is blocked before it went out`;
      const pending = w.batches.find(b => b.state === "pending");
      for (const h of w.heldTasks ?? []) {
        if (h.held === "capped" && !isCapped(w, h.task)) return `${h.task.key} is held as capped below ${NO_PROGRESS_CAP} sends`;
        if (h.held === "manual" && !(w.manualTasks ?? []).includes(h.task.key)) return `${h.task.key} is held as manual without the developer's choice`;
        if (pending?.tasks.some(t => conditionId(t) === conditionId(h.task))) return `${h.task.key} is held and in the next message`;
      }
      return null;
    },
  },
  {
    id: "no-sends-when-idle-claim", why: "2026-11-10 wks_4b27f268: \"sends when the agent is idle\" while the agent was idle and nothing would send",
    check: (w, now) => lines(w, now).find(l => /sends when the agent is idle/i.test(l)) ?? null,
  },
  {
    id: "waiting-on-agent-means-busy", why: "a queued batch may only blame the agent's turn while the agent is in one",
    check: (w, now) => { const v = batchView(w, now); return v?.phase === "queued" && v.waitingOn === "agent" && idle(w) ? v.line : null; },
  },
  {
    id: "on-it-means-sent", why: "2026-11-10 wks_4b27f268: \"Main agent is on it\" while the agent was idle and nothing had been sent",
    check: (w, now) => { const card = agentCard(w, now); return card && /is on it$/.test(card.title) && !inFlight(w) ? card.title : null; },
  },
  {
    id: "fixing-means-acting", why: "2026-11-10 wks_4b27f268: Home said \"Follow-up is fixing\" while it only waited on its own check",
    check: (w, now) => {
      if (trackedGroup(w, now) !== "fixing") return null;
      const v = batchView(w, now);
      return v && (v.phase === "sent" || v.phase === "queued" && v.kind === "repairs" && (v.waitingOn === null || v.waitingOn === "agent")) ? null : `fixing with ${v ? `${v.kind}/${v.phase}/${v.waitingOn}` : "no batch"}`;
    },
  },
  {
    id: "done-check-waits-on-you", why: "the Done check never auto-sends, so it must show as yours to send, never as Follow-up fixing",
    check: (w, now) => {
      const check = w.batches.find(b => b.state === "pending" && completionCheck(b));
      if (!check || w.completion) return null;
      if (!needsYou(w, now).some(i => i.kind === "send" && i.batchId === check.id)) return "the Done check is not in Needs you";
      return trackedGroup(w, now) === "needs" ? null : `Done check shown in ${trackedGroup(w, now)}`;
    },
  },
  {
    id: "waits-on-you-means-needs-you", why: "2026-11-10 critique: repairs queued for an idle agent said they waited on you while Home filed them under Waiting on others with no Send",
    check: (w, now) => {
      const v = batchView(w, now);
      if (!v || v.phase !== "queued" || v.waitingOn !== "you" || w.hold || w.goneAgent || w.dormant || summary(w, now).status === "done") return null;
      if (!needsYou(w, now).some(i => i.kind === "send" && i.batchId === v.batch.id)) return `"${v.line}" has no Send in Needs you`;
      return trackedGroup(w, now) === "needs" ? null : `"${v.line}" shown in ${trackedGroup(w, now)}`;
    },
  },
  {
    id: "done-is-done-everywhere", why: "a Done workspace reads as Done on every surface and asks nothing more",
    check: (w, now) => {
      if (summary(w, now).status !== "done") return null;
      if (trackedGroup(w, now) !== "quiet") return `Done but grouped ${trackedGroup(w, now)}`;
      if (liveLine(w, now).icon !== "done") return `Done but the live line says "${liveLine(w, now).text}"`;
      if (agentCard(w, now)) return "Done but an agent card is showing";
      return needsYou(w, now).some(i => i.kind === "send" && i.finish) ? "Done but still asking to finish" : null;
    },
  },
  {
    id: "working-means-work", why: "the live line may say an agent is working only when it has a turn or Follow-up's batch",
    check: (w, now) => {
      const live = liveLine(w, now);
      if (live.icon !== "spinner" || !/working/i.test(live.text)) return null;
      return inFlight(w) || w.runtimeBusy || liveWorkingTask(w) ? null : live.text;
    },
  },
  {
    id: "agent-merges-asks-nothing",
    why: "2026-11-11 wks_5dfd3a65: a PR the agent merges itself (register_pr agentMerges) is its own work in flight, so Needs you never asks the developer to review or merge it.",
    check(w, now) {
      const mine = new Set(w.prs.filter(agentMerges).map(p => p.key));
      const asked = needsYou(w, now).filter(i => (i.kind === "merge" || i.kind === "reviewers") && mine.has(i.prKey));
      return asked.length ? asked.map(i => i.title).join(", ") : null;
    },
  },
  {
    id: "a-merge-the-agent-made-never-flags-the-developer",
    why: "2026-11-12 live sidebar: an agent that merged its own PR (register_pr agentMerges) flagged the developer with \"PR closed · #37 merged\". Its merge is its own work, reported in its own turn.",
    check(w, now) {
      const at = new Date(now).toISOString();
      const flagged = w.prs.filter(agentMerges).filter(p => { const ev = prEndEvent(p); return ev?.merged && reduce(newEntry("agent"), ev, at).needs; });
      return flagged.length ? flagged.map(p => `#${p.number} merged by its agent flags the developer`).join(", ") : null;
    },
  },
  {
    id: "pr-label-matches-state",
    why: "2026-11-12 live sidebar: rows read \"PR closed · #37 merged\". A merged PR reads Merged; only a PR closed without merging reads PR closed.",
    check(w, now) {
      const at = new Date(now).toISOString();
      for (const p of w.prs) {
        const ev = prEndEvent(p);
        const h = ev && flagHeadline({ needs: reduce(newEntry("agent"), { ...ev, quiet: false }, at).needs, snooze: null, brief: null }, now);
        const want = p.snapshot?.state === "MERGED" ? "pr_merged" : "pr_closed";
        if (h && h.key !== want) return `#${p.number} is ${p.snapshot!.state} but reads ${h.label}`;
      }
      return null;
    },
  },
  {
    id: "in-flight-reads-waiting",
    why: "2026-11-11 wks_5dfd3a65: work the main agent tracks (a working or waiting task) reads as waiting on that work, never Quiet or \"declare Done\".",
    check(w, now) {
      if (!followUpObligations(w).some(o => o.status === "working" || o.status === "waiting") || ["done", "needs-you"].includes(summary(w, now).status)) return null;
      // A Done check queued before a task reopened is cancelled on the engine's next refresh (server/tasks.ts only
      // queues it once every task is done), so it isn't a reading of in-flight work.
      if (batchView(w, now)?.kind === "finish") return null;
      const group = trackedGroup(w, now);
      const live = liveLine(w, now).text;
      return group === "quiet" ? `reads Quiet: ${live}` : /declare Done/.test(live) ? live : null;
    },
  },
  {
    id: "snooze-can-wake",
    why: "A workspace Later always wakes: it stores an ISO time or next-event, never a raw word like \"1h\" (shared/inbox.ts resolveUntil).",
    check(w) {
      const u = w.snooze?.until;
      return u && u !== "next-event" && !Number.isFinite(Date.parse(u)) ? `snooze until "${u}" never wakes` : null;
    },
  },
  {
    id: "answer-card-round-trip",
    why: "The answer the agent receives parses back, on the chat card, to what was picked: the whole note and free answer, not their first line, and a title with parentheses doesn't swallow the choice (shared/questions.ts answerTitle, parseAnswerMessage).",
    check(w) {
      for (const q of w.questions) {
        if (!q.answer) continue;
        const card = parseAnswerMessage(answerMessage(q, q.answer.choice, q.answer.words));
        if (!card) return `${q.id}'s answer doesn't parse as an answer card`;
        const other = isOther(q.answer.choice), option = q.options.some(o => o.letter === q.answer!.choice);
        // A free answer has no option to split on, so the card's two halves together are the answer.
        const shown = other ? card.words ?? "" : option ? card.choice : [card.choice, card.label].filter(Boolean).join(" — ");
        const want = other ? (q.answer.words ?? "").trim() : q.answer.choice;
        if (shown !== want) return `${q.id}'s card shows "${shown}", not "${want}"`;
        if (!other && option && (card.words ?? "") !== (q.answer.words ?? "").trim()) return `${q.id}'s card drops part of the note`;
      }
      return null;
    },
  },
  {
    id: "a-pick-note-reaches-the-agent",
    why: "Task 32deeb27, the developer's ask: \"A, but make sure to…\". A note on a lettered pick reaches the agent's message and the record, on a question here and on a brief card (pickNoteViolations).",
    check(w) {
      for (const q of w.questions) {
        const a = q.answer;
        if (!a?.words?.trim() || isOther(a.choice) || !q.options.some(o => o.letter === a.choice)) continue;
        if (parseAnswerMessage(answerMessage(q, a.choice, a.words))?.words !== a.words.trim()) return `${q.id}'s note on ${a.choice} doesn't reach the agent`;
      }
      return null;
    },
  },
  {
    id: "a-done-brief-is-never-an-ask",
    why: "2026-11-12, the developer's phone on 2.0.1-beta.3: the panel read \"Needs you 1\" with one item, \"Nothing needed\", the agent's turn-end needs_you kind=done on a row flagged by a merged PR. A done brief is never drawn or counted as an ask, and the flag's headline reads its real reason (doneBriefViolations).",
    check(w, now) {
      const items = needsYou(w, now);
      for (const reason of REASONS) for (const source of ["agent", "extracted", "followup"] as const) {
        const row = { agentId: w.mainAgentId ?? "main", needs: { reasons: [{ reason, at: new Date(now).toISOString(), detail: `${reason} detail`, dedupeKey: reason }], since: new Date(now).toISOString() }, snooze: null,
          brief: { kind: "done" as const, source, state: "open" as const, ask: "Nothing needed", questionIds: [] } };
        const v = doneBriefViolations(row, items, now)[0];
        if (v) return `${reason}/${source}: ${v.detail}`;
      }
      return null;
    },
  },
  {
    id: "say-it-once",
    why: "2026-11-12: Home's row read \"Merged · #240 merged\" beside a \"#240 merged\" PR chip, and a two-decision card was titled with its first question, which then repeated as item 1. A flag's headline line never repeats its word, its pill label or the PR chip (a merged or closed PR's flag names the PR by title), and a brief over several open questions keeps the agent's own ask (foldedAsk).",
    check(w, now) {
      const at = new Date(now).toISOString();
      for (const pr of w.prs) {
        const event = prEndEvent({ ...pr, agentMerges: false });
        if (!event) continue;
        const row = { agentId: "main", needs: reduce(newEntry("main"), event, at).needs, snooze: null, brief: null } as unknown as InboxRow;
        const h = flagHeadline(row, now);
        const chip = prChip({ ...w, prs: [pr] });
        const said = [h && HEADLINE_WORD[h.key], h?.label, chip && [chip.label, chip.checks?.text].filter(Boolean).join(" ")];
        if (h && h.line !== HEADLINE_WORD[h.key] && said.includes(h.line)) return `#${pr.number}'s ${h.label} headline repeats "${h.line}"`;
      }
      const open = w.questions.filter(q => !q.answer && !q.closed);
      if (open.length > 1 && foldedAsk("The agent's ask", open.map(q => q.id), w.questions) !== "The agent's ask") return `a brief over ${open.length} open questions is titled with one of them`;
      return null;
    },
  },
  {
    id: "an-open-question-renders-once-per-surface",
    why: "2026-11-12: the panel drew the agent's brief card and the Needs you list side by side, so one open question asked twice (the brief's decision and the Q row), with two answer paths. Each surface's Needs you block (shared/needs-block.ts) shows every open question once, inside the brief's card when the brief points at it.",
    check(w, now) {
      const items = needsYou(w, now);
      const open = items.flatMap(i => i.kind === "question" ? [i.questionId] : []);
      return onceViolation(items, [null, { questionIds: open.slice(0, 1) }, { questionIds: open }, { questionIds: [...open].reverse() }, { questionIds: ["Q0"] }]);
    },
  },
  {
    id: "a-question-always-asks-the-developer-something",
    why: "2026-11-12 Q48: a task the agent marked blocked on a PR became an open question whose text was the task's evidence, with no options, in the developer's Needs you; they answered \"what's the question to me?\". A task asks only when blocked on the developer, with its own ask (shared/model.ts blockedOnDeveloper, server/questions.ts syncTaskQuestions).",
    check(w, now) {
      for (const q of w.questions ?? []) {
        if (q.answer || q.closed) continue;
        if (!q.question.trim()) return `${q.id} is open but asks nothing`;
        if (q.taskId && q.taskRevision !== null) {
          const o = w.obligations.find(o => o.id === q.taskId);
          if (!o || !blockedOnDeveloper(o)) return `${q.id} is open for a task that isn't blocked on the developer`;
          if (q.question !== o.ask!.trim()) return `${q.id} asks "${q.question.slice(0, 60)}" instead of its task's question`;
        }
      }
      const stray = needsYou(w, now).find(i => i.kind === "decision" && !blockedOnDeveloper(w.obligations.find(o => o.id === i.obligationId) ?? { status: "" }));
      return stray ? `Needs you asks about task ${stray.title}, which isn't blocked on the developer` : null;
    },
  },
  {
    id: "a-github-limit-never-blanks-a-known-pr",
    why: "2026-11-12 live 2.0.1-beta.1: merged PRs with a complete snapshot kept an error from beta.0's RATE_LIMIT failures, the panel let the error win and merged-is-final never re-read them, so they read Unknown for good. A complete snapshot always shows its own status (shared/presentation.ts), and a merged one never stores an error (shared/model.ts prSchema, server/github.ts finalMerged).",
    check(w) {
      for (const p of w.prs) {
        if (!p.snapshot?.complete) continue;
        if (prPresentation(p).label === "Status unavailable" || compactPrStatus(p).label === "Unknown") return `${p.key} has a complete snapshot but reads unknown`;
        if (p.snapshot.state === "MERGED" && p.error) return `${p.key} is merged and complete but stores "${p.error}"`;
      }
      return null;
    },
  },
  {
    id: "only-a-stop-holds",
    why: "2026-11-11 wks_5dfd3a653ad3c305: a /compact replaced by an agent's message read as \"You stopped the main agent\" and paused auto-sends until Resume. Of every cancel cause (shared/status.ts CANCEL_CAUSES) only the developer's Stop holds.",
    check(w) {
      const stop = w.interruption;
      return stop?.kind === "canceled" && automaticHold(w) && stop.cause && stop.cause !== "stop" ? `holds for a ${stop.cause} turn ${stop.turnId ?? "?"}` : null;
    },
  },
];

export function violations(w: Workspace, now: number): { id: string; detail: string }[] {
  // One reading: every invariant asks needsYou and batchView of the same workspace and clock (shared/status.ts perSnapshot).
  return oneReading(() => checkAll(w, now));
}
function checkAll(w: Workspace, now: number): { id: string; detail: string }[] {
  const out: { id: string; detail: string }[] = [];
  for (const inv of INVARIANTS) {
    let detail: string | null;
    try { detail = inv.check(w, now); } catch (error) { detail = `check threw: ${error instanceof Error ? error.message : String(error)}`; }
    if (detail) out.push({ id: inv.id, detail });
  }
  return out;
}

/**
 * `brief-pr-facts-referenced`: a card shows PR state only for a PR it references: one it links, or, linking none, the
 * PR its review or reviewers ask is about. Session Guard's limit fact on a paused card isn't PR state.
 */
export function briefFactsViolations(b: Pick<Brief, "id" | "kind" | "source" | "facts" | "factsPr" | "links">): { id: string; detail: string }[] {
  if (!b.facts.length || b.source === "paused") return [];
  if (!b.factsPr) return [{ id: "brief-pr-facts-referenced", detail: `${b.id} shows PR state without naming the PR` }];
  const linked = b.links.flatMap(l => l.pr ? [l.pr] : []);
  const ok = linked.length ? linked.includes(b.factsPr) : b.kind === "review" || b.kind === "reviewers";
  return ok ? [] : [{ id: "brief-pr-facts-referenced", detail: `${b.id} shows ${b.factsPr}'s state but doesn't reference it` }];
}

/**
 * Needs-you cards (briefs live in the inbox store, not the workspace). An agent's current card follows its linked
 * questions: while one is open on the server, only the developer closes the card. `brief-follows-questions`.
 */
export function briefViolations(current: Pick<Brief, "id" | "state" | "outcome" | "questionIds">, openQuestionIds: ReadonlySet<string>): { id: string; detail: string }[] {
  return shouldReopen(current, openQuestionIds) ? [{ id: "brief-follows-questions", detail: `${current.id} is ${current.state} while ${current.questionIds.filter(id => openQuestionIds.has(id)).join(", ")} ${current.questionIds.filter(id => openQuestionIds.has(id)).length === 1 ? "is" : "are"} open` }] : [];
}

/**
 * Conversation surfaces (Recent steps, the Overseer's digest and handoff, Summary inputs): what Follow-up shows or
 * feeds a model from a conversation never carries Paseo's raw envelope. Its sender is classified first
 * (shared/message-sender.ts), so another agent's words read "From <agent>" and never as the developer's.
 * `no-raw-paseo-envelope`; the attribution half, `only-developer-is-developer`, is driven per call site in
 * tests/message-sender.test.ts.
 */
export function senderViolations(texts: readonly string[]): { id: string; detail: string }[] {
  return texts.filter(t => typeof t === "string" && t.includes("<paseo-system")).map(t => ({ id: "no-raw-paseo-envelope", detail: t.slice(0, 80) }));
}

/**
 * `no-follow-up-text-as-work`: Summary inputs, the Finished reason and Recent steps never carry Follow-up's own words as
 * the agent's or the developer's work: its hook feedback (the Stop-hook bookkeeping nudge and the other hook texts),
 * batch headers or recovery prompts. A Recent-steps row labelled as Follow-up's own is exempt (pass only unlabelled text).
 */
export function followUpTextViolations(texts: readonly (string | null | undefined)[]): { id: string; detail: string }[] {
  const headers = [...BATCH_PREFIXES, ...RECOVERY_TITLES].map(h => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const own = (t: string) => ANY_HOOK_TEXT_PREFIXES.some(p => t.includes(p)) || new RegExp(`(?:^|\\n|: )(?:${headers}) `).test(t);
  return texts.filter((t): t is string => typeof t === "string" && own(t)).map(t => ({ id: "no-follow-up-text-as-work", detail: t.slice(0, 80) }));
}

/**
 * Inbox rows (agents, not workspaces): a running agent never headlines a failure or pause from before its current
 * turn started, since a newer turn supersedes them (RUN_STATE_REASONS in shared/inbox.ts). A flag from the turn that
 * just failed is real news even while Paseo still reads "running". `running-is-not-stale`, 2026-11-10: Home said
 * "Error · The turn failed" on an agent that had been running for 15 minutes.
 */
export function rowViolations(row: Pick<InboxRow, "agentId" | "status" | "needs" | "snooze" | "brief" | "turnStartedAt" | "backgroundWork">, now: number): { id: string; detail: string }[] {
  const out: { id: string; detail: string }[] = [];
  // background-work-is-running (Paseo 0.16): a job the agent started and ended its turn on is still its work, so the
  // row is Running and never "finished" until the work ends.
  if (row.backgroundWork && (!["running", "initializing"].includes(row.status) || flagHeadline(row, now)?.key === "finished")) out.push({ id: "background-work-is-running", detail: `${row.agentId} has ${row.backgroundWork} background job(s) but reads ${row.status}${flagHeadline(row, now)?.key === "finished" ? " · finished" : ""}` });
  // newest-brief-decides (2026-11-13, beta.4 live): the agent's newest word is done, so a "finished" flag from an
  // earlier turn that asked nothing can't still stand beside it (only an unanswered ask outlives a done).
  const doneAt = row.brief?.kind === "done" && row.brief.source === "agent" ? row.brief.at ?? null : null;
  const stale = doneAt ? row.needs?.reasons.find(r => r.reason === "finished" && r.at < doneAt) : undefined;
  if (stale) out.push({ id: "newest-brief-decides", detail: `${row.agentId} said done at ${doneAt} but still flags the finish from ${stale.at}` });
  if (!["running", "initializing"].includes(row.status) || !row.turnStartedAt) return out;
  const h = flagHeadline(row, now);
  if (!h || (h.key !== "error" && h.key !== "paused")) return out;
  const flaggedAt = [...(row.needs?.reasons.filter(r => r.reason === h.key).map(r => r.at) ?? []), ...(row.brief?.kind === h.key && row.brief.at ? [row.brief.at] : [])].sort().at(-1);
  if (!flaggedAt || flaggedAt < row.turnStartedAt) out.push({ id: "running-is-not-stale", detail: `${row.agentId} is ${row.status} since ${row.turnStartedAt} but headlines ${h.label} from ${flaggedAt ?? "an older card"}` });
  return out;
}

/**
 * Inbox flags against the workspaces they come from: an "Add reviewers" flag lasts only while one of the agent's PRs
 * still asks for reviewers (FACT_REASONS in shared/inbox.ts). A PR Follow-up couldn't read is unknown, never a
 * violation. `outside-fact-is-live`, 2026-11-11 wks_5dfd3a65: "Add reviewers #107" stayed after #107 merged, in a
 * repository nobody reviews.
 */
export function factFlagViolations(rows: Pick<InboxRow, "agentId" | "needs">[], workspaces: Workspace[]): { id: string; detail: string }[] {
  const out: { id: string; detail: string }[] = [];
  for (const row of rows) {
    const flag = row.needs?.reasons.find(r => r.reason === "reviewers");
    if (!flag) continue;
    const prs = workspaces.filter(w => w.enable_tracking && !w.archived).flatMap(w => w.prs.filter(p => (p.registeredAgentId ?? w.mainAgentId) === row.agentId).map(p => ({ p, w })));
    if (prs.some(({ p }) => p.error || !p.snapshot?.complete)) continue;
    if (!prs.some(({ p, w }) => p.snapshot!.state === "OPEN" && asksForReviewers(p, w))) out.push({ id: "outside-fact-is-live", detail: `${row.agentId} still flags "Add reviewers ${flag.detail}" but none of its PRs asks for reviewers` });
  }
  return out;
}

/**
 * Home rows (Home's list and the sidebar view render the same model): every row's lines come from its own row. A
 * priority is stored per workspace but its reason was written about one row, so at most one row of a workspace shows
 * it, and when the ranker named the row it read, that row. `row-lines-own-row` (1.4.0-beta.34: a Finished agent
 * row showed its errored sibling's "Agent errored before follow-up started" in the sidebar view).
 */
export function homeViolations(model: Pick<HomeModel, "byKey">, priorities: readonly Priority[], now: number): { id: string; detail: string }[] {
  const fresh = freshPriorities(priorities, now).byWorkspace;
  const carriers = new Map<string, string[]>();
  for (const s of model.byKey.values()) if (s.priority && s.workspaceId) carriers.set(s.workspaceId, [...carriers.get(s.workspaceId) ?? [], s.key]);
  const out: { id: string; detail: string }[] = [];
  for (const [workspaceId, keys] of carriers) {
    const p = fresh.get(workspaceId);
    if (keys.length > 1) out.push({ id: "row-lines-own-row", detail: `${keys.join(", ")} all show ${workspaceId}'s priority` });
    else if (!p) out.push({ id: "row-lines-own-row", detail: `${keys[0]} shows a priority ${workspaceId} doesn't have` });
    else if (p.row && p.row !== keys[0]) out.push({ id: "row-lines-own-row", detail: `${keys[0]} shows the reason ranked for ${p.row}` });
    else if (model.byKey.get(keys[0])!.priority!.reason !== p.reason) out.push({ id: "row-lines-own-row", detail: `${keys[0]} shows another reason than ${workspaceId}'s` });
  }
  return out;
}

/**
 * Workspaces against their main agent's current turn: Follow-up's automatic hold (a failed turn, or the developer's
 * Stop) is that turn's run state, so it never outlives a newer turn (holdSuperseded in shared/status.ts). A hold the
 * developer set may. `automatic-hold-is-not-stale`, 2026-11-10: a running agent's pane said "Follow-up is paused · The
 * main agent's turn failed" under a Working row; 2026-11-11 wks_5dfd3a653ad3c305: "You stopped the main agent" stayed
 * for an hour of newer turns after a replaced /compact.
 */
export function holdViolations(w: Pick<Workspace, "id" | "hold" | "interruption" | "mainAgentId">, mainTurnId: string | null): { id: string; detail: string }[] {
  if (!w.hold || !holdSuperseded(w, { agentId: w.mainAgentId, turnId: mainTurnId })) return [];
  return [{ id: "automatic-hold-is-not-stale", detail: `${w.id} holds for ${w.interruption?.kind ?? "canceled"} turn ${w.interruption?.turnId ?? "?"} while the main agent is on turn ${mainTurnId}` }];
}

/**
 * `only-developer-acts-as-developer`, the action half of `only-developer-is-developer` (shared/actor.ts): an action an
 * agent took on the developer's behalf (brief_action, inbox_act, answer_question, the spec link, linked items) is never
 * recorded as the developer's. Pass each path's actor and the `by` it recorded.
 */
export function actorViolations(rows: readonly { path: string; actor: Actor; recorded: string | null | undefined }[]): { id: string; detail: string }[] {
  return rows.filter(r => r.actor.kind === "agent" && (!r.recorded || r.recorded === "developer")).map(r => ({ id: "only-developer-acts-as-developer", detail: `${r.path} by agent ${r.actor.kind === "agent" ? r.actor.agentId : ""} recorded as ${r.recorded ?? "nobody"}` }));
}

/**
 * `update-phase-never-outlives-its-version`: Settings → General, Home's marker and `updates_status` never show a phase
 * tied to a version (failed, rolled back, untrusted, waiting, installing, available) once that version is at or below
 * the one running, however it got installed (Follow-up's installer, `paseo plugin` from outside, the 2.0 move). Only a
 * live installer's own phases (installing, settling) may name the running version. The updater applies the same rule
 * (`staleUpdatePhase` in shared/updates.ts) on every view; this checks its output.
 */
export function updatePhaseViolations(phase: UpdatePhase, running: string, installerAlive: boolean): { id: string; detail: string }[] {
  return staleUpdatePhase(phase, running, installerAlive) ? [{ id: "update-phase-never-outlives-its-version", detail: `${phase.kind} for ${"version" in phase ? phase.version : "?"} while ${running} runs` }] : [];
}

/**
 * `a-pick-note-reaches-the-agent` on a brief card: letter picks with notes, sent alone (briefAnswer) or together
 * (briefAnswers), keep each note on the card's decision and parse back from the message the agent receives.
 */
export function pickNoteViolations(b: Brief, picks: { decisionId: string; choice: string; words?: string }[], now: string): { id: string; detail: string }[] {
  const id = "a-pick-note-reaches-the-agent";
  const noted = picks.filter(p => !isOther(p.choice) && p.words?.trim());
  if (!noted.length) return [];
  const out: { id: string; detail: string }[] = [];
  const fold = (t: string) => t.replace(/\s+/g, " ").trim();
  if (picks.length === 1) {
    const p = picks[0], d = b.decisions.find(d => d.id === p.decisionId);
    const kept = briefStep(b, { type: "option", decisionId: p.decisionId, choice: p.choice, words: p.words }, now).brief?.decisions.find(d => d.id === p.decisionId)?.words;
    if (kept !== p.words!.trim()) out.push({ id, detail: `${p.decisionId}'s card drops the note on ${p.choice}` });
    const label = d?.options.find(o => o.letter === p.choice)?.label ?? "";
    if (parseAnswerMessage(briefAnswer(p.decisionId, d?.question ?? "", p.choice, label, p.words))?.words !== p.words!.trim()) out.push({ id, detail: `${p.decisionId}'s message drops the note on ${p.choice}` });
    return out;
  }
  const after = briefStep(b, { type: "options", picks }, now).brief;
  const words = Object.fromEntries(picks.filter(p => p.words?.trim()).map(p => [p.decisionId, p.words!.trim()]));
  const parsed = parseAnswersMessage(briefAnswers(b.ask, b.decisions, Object.fromEntries(picks.map(p => [p.decisionId, p.choice])), words));
  for (const p of noted) {
    if (after?.decisions.find(d => d.id === p.decisionId)?.words !== p.words!.trim()) out.push({ id, detail: `${p.decisionId}'s card drops the note on ${p.choice}` });
    if (parsed?.answers.find(a => a.id === p.decisionId)?.words !== fold(p.words!)) out.push({ id, detail: `${p.decisionId}'s message drops the note on ${p.choice}` });
  }
  return out;
}

/**
 * `one-reviewers-ask-per-pr` (2026-11-12, #147 renders): before the fold, a PR without reviewers asked twice in Needs you:
 * Follow-up's brief "Add reviewers to #240: Ravi" and the row "#240 has no reviewers", counted 2 for one thing. Now
 * the row names the suggested reviewer and the brief folds into it (needsYouBlock): no brief card beside its PR's row,
 * the count is the rows', and the row says the same ask as the brief, so the Home row and the panel agree.
 */
export function reviewersBriefViolations(row: Pick<InboxRow, "agentId" | "needs" | "brief">, items: NeedItem[]): { id: string; detail: string }[] {
  const id = "one-reviewers-ask-per-pr";
  const b = row.brief;
  const pr = b && briefAsks(b, row) ? reviewersBriefPr(b) : null;
  const item = pr ? items.find((i): i is Extract<NeedItem, { kind: "reviewers" }> => i.kind === "reviewers" && i.prKey === pr) : undefined;
  if (!b || !item) return [];
  const out: { id: string; detail: string }[] = [];
  const block = needsYouBlock(items, { questionIds: b.questionIds ?? [], kind: b.kind, prKey: pr! });
  if (block.cards.some(c => c.kind === "brief")) out.push({ id, detail: `${row.agentId}'s Needs you draws the reviewers brief beside #${item.number}'s row` });
  if (block.count !== needsYouBlock(items, null).count) out.push({ id, detail: `${row.agentId}'s Needs you counts ${block.count} for ${needsYouBlock(items, null).count} asks` });
  if (item.suggested.length && item.title !== b.ask) out.push({ id, detail: `#${item.number}'s row reads "${item.title}", the brief "${b.ask}"` });
  return out;
}

/**
 * `a-done-brief-is-never-an-ask` (2026-11-12, the developer's phone on 2.0.1-beta.3): the agent's turn-end needs_you
 * kind=done ("Nothing needed") on a row flagged for something else (a merged PR) drew inside the panel's Needs you and
 * counted 1. Enumerated per surface: the Needs-you block (the panel and Home's detail pane pick their brief with
 * briefAsks) draws and counts only what it shows, and the flag's headline (pill, sidebar row, Home row) reads the
 * real reason, not the done brief's line.
 */
export function doneBriefViolations(row: Pick<InboxRow, "agentId" | "needs" | "snooze" | "brief">, items: NeedItem[], now: number): { id: string; detail: string }[] {
  const id = "a-done-brief-is-never-an-ask";
  const b = row.brief;
  if (b?.state !== "open" || b.kind !== "done") return [];
  const out: { id: string; detail: string }[] = [];
  const block = needsYouBlock(items, briefAsks(b, row) ? { questionIds: b.questionIds ?? [], kind: b.kind, prKey: b.prKey } : null);
  if (block.cards.some(c => c.kind === "brief")) out.push({ id, detail: `${row.agentId}'s Needs you draws its done brief as an ask` });
  if (block.count !== needsYouBlock(items, null).count) out.push({ id, detail: `${row.agentId}'s Needs you counts ${block.count} for ${needsYouBlock(items, null).count} real asks` });
  const h = flagHeadline(row, now, items);
  if (h && h.key !== "finished" && b.source !== "none" && h.line === b.ask) out.push({ id, detail: `${row.agentId}'s ${h.label} headline reads the done brief's "${b.ask.slice(0, 40)}"` });
  return out;
}
