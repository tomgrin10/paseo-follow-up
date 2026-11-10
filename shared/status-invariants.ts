import type { Workspace } from "./model";
import { duplicateOpenQuestions } from "./questions";
import { shouldReopen, type Brief } from "./brief";
import { completionCheck, summary } from "./model";
import { liveLine, needsYou } from "./attention";
import { trackedGroup } from "./home";
import { agentCard, batchView } from "./status";
import { followUpObligations } from "./follow-up";

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
    id: "no-duplicate-open-question",
    why: "Needs-you never shows two cards for the same open question: every path that creates a question links to a matching open one instead (shared/questions.ts findOpenMatch).",
    check(w) {
      const dupes = duplicateOpenQuestions(w.questions ?? []);
      return dupes.length ? dupes.map(d => `${d.duplicate.id} repeats ${d.of.id}`).join(", ") : null;
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
      return inFlight(w) || w.runtimeBusy || followUpObligations(w).some(o => o.status === "working") ? null : live.text;
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
];

export function violations(w: Workspace, now: number): { id: string; detail: string }[] {
  const out: { id: string; detail: string }[] = [];
  for (const inv of INVARIANTS) {
    let detail: string | null;
    try { detail = inv.check(w, now); } catch (error) { detail = `check threw: ${error instanceof Error ? error.message : String(error)}`; }
    if (detail) out.push({ id: inv.id, detail });
  }
  return out;
}

/**
 * Needs-you cards (briefs live in the inbox store, not the workspace). An agent's current card follows its linked
 * questions: while one is open on the server, only the developer closes the card. `brief-follows-questions`.
 */
export function briefViolations(current: Pick<Brief, "id" | "state" | "outcome" | "questionIds">, openQuestionIds: ReadonlySet<string>): { id: string; detail: string }[] {
  return shouldReopen(current, openQuestionIds) ? [{ id: "brief-follows-questions", detail: `${current.id} is ${current.state} while ${current.questionIds.filter(id => openQuestionIds.has(id)).join(", ")} ${current.questionIds.filter(id => openQuestionIds.has(id)).length === 1 ? "is" : "are"} open` }] : [];
}
