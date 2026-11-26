import { randomUUID } from "node:crypto";
import type { Obligation, Workspace } from "../shared/model";
import { lifecycleOnly } from "../shared/follow-up";
import { communicationKey, communicationSchema, replyRecorded, type Communication } from "../shared/communication";
import { storedTrigger, type TaskTrigger, type TaskTriggerInput } from "../shared/task-trigger";
import { currentQuestion } from "../shared/questions";
import { RECHECK_DAYS } from "../shared/task-due";
import { sameTask, similarLines, similarOpen } from "../shared/task-dup";

type Update = {
  id?: string; title: string; status: Obligation["status"]; afterPrs?: string[]; evidence?: string;
  /** While blocked: the developer's question. Kept across blocked updates that omit it; dropped when the task leaves blocked. */
  ask?: string;
  /** While blocked: the question (Q7) the task waits on, instead of an ask. Its words become the ask, and it covers the task. */
  question?: string;
  /** While blocked: what the ask wants of the developer, a decision or an action they take and report back. */
  need?: "decision" | "action";
  /** Background for whoever works it (Make a task: the question and its answer). Kept when an update leaves it out. */
  note?: string;
  dependencyStage?: "merged" | "deployed"; enable_follow_up?: boolean; communication?: Pick<Communication, "threadUrl" | "recipient"> & Partial<Communication>;
  trigger?: TaskTriggerInput | TaskTrigger | null;
  /** due-by-fact: when to look at it again, "YYYY-MM-DD" or an ISO time. An open task with no PRs gets RECHECK_DAYS out by default. */
  recheck?: string;
  /** The clock (tests); defaults to Date.now(). */
  now?: number;
  /** The calling agent (from the daemon, never an argument). */
  caller?: string;
  /** The agent actually doing it, when the caller names another (an orchestrator's subagent). */
  workingAgentId?: string;
  /** Add it even when a similar open task exists (a-new-task-is-checked-once). */
  new?: boolean;
};
/**
 * a-new-task-is-checked-once: a write without an id is checked against this workspace's open tasks, once, here. The
 * caller's own exact title updates that task (a repeated write); a similar title is refused with up to DUP_MAX lines
 * naming each by id, unless the agent passes new=true. Clean: nothing. Only agent writes (a caller) are checked.
 */
function newTaskCheck(w: Workspace, input: Update): Obligation | undefined {
  if (!input.caller || input.new) return undefined;
  const same = sameTask(w, input.title, input.caller);
  if (same) return same;
  const similar = similarOpen(w, input.title);
  if (similar.length) throw new Error(similarLines(similar));
  return undefined;
}

export function updateObligation(w: Workspace, input: Update): Obligation {
  const { id, title, status, dependencyStage, enable_follow_up, communication } = input;
  const existing = id ? w.obligations.find(o => o.id === id) : (communication ? w.obligations.find(o => o.communication && !["done", "waived"].includes(o.status) && communicationKey(o.communication) === communicationKey(communicationSchema.parse(communication))) : undefined) ?? newTaskCheck(w, input);
  if (id && !existing) throw new Error("Obligation does not exist. Omit id to add one.");
  const afterPrs = input.afterPrs ?? existing?.afterPrs ?? [];
  const evidence = input.evidence ?? existing?.evidence ?? "";
  // question="Q7": blocked on an open (or answered) question; its words become the ask and it covers the task, so the
  // task makes no second card (one-decision-one-card).
  const pointed = input.question ? currentQuestion(w.questions, input.question) : null;
  if (input.question) {
    if (status !== "blocked") throw new Error("question goes with status=blocked: the task waits on that question.");
    if (input.ask) throw new Error("Pass question or ask, not both: question points at a question you already asked.");
    if (!pointed) throw new Error(`No question ${input.question} in this workspace that still asks something. Ask it with ask_question (task set to this task) first.`);
    if (pointed.taskRevision !== null) throw new Error(`${pointed.id} is a blocked task's own card. Point at a question you asked with ask_question.`);
  }
  const asked = pointed ? `${pointed.id}: ${pointed.question}`.slice(0, 1000) : input.ask;
  const ask = status === "blocked" ? (asked ?? (existing?.status === "blocked" ? existing.ask : undefined))?.trim() || undefined : undefined;
  // Kept like the ask across blocked updates that leave it out; a new ask without need is read afresh.
  const need = ask ? input.need ?? (existing?.status === "blocked" && !input.ask && !input.question ? existing.need : undefined) : undefined;
  if (input.need && !ask) throw new Error("need goes with a blocked task's ask (or question).");
  if (["done", "waived"].includes(status) && !(existing?.status === status ? evidence.trim() : input.evidence?.trim())) throw new Error("Completed or waived work requires result evidence.");
  if (afterPrs.some(key => !w.prs.some(p => p.key === key))) throw new Error("Register dependency PRs before referencing them.");
  if (lifecycleOnly({ title, afterPrs })) throw new Error("PR approval, merging and deployment belong in Pull requests. Record a concrete follow-up action such as verifying behavior after deployment, with afterPrs and dependencyStage=deployed.");
  const destination = communication ? communicationSchema.parse({ ...existing?.communication, ...communication }) : existing?.communication;
  if (destination?.replyUrl && !replyRecorded(destination)) throw new Error("The reply receipt must be a different message in the original Slack workspace/channel/thread.");
  if (destination && status === "done" && !replyRecorded(destination)) throw new Error("A draft is not a sent reply. Record communication.replyUrl before completing this task; use blocked when posting is unavailable or uncertain.");
  const now = input.now ?? Date.now();
  // An at trigger's time is resolved and checked here (inMinutes from now, an ISO time with its offset); the same time
  // again keeps whether it already went out (a-scheduled-task-arrives-once-at-its-time).
  const trigger = input.trigger === undefined ? existing?.trigger : storedTrigger(input.trigger, existing?.trigger, now);
  if (trigger?.event === "now" && (afterPrs.length || trigger.delayDays)) throw new Error("Now requires no PR dependencies or delay. Choose a merge/deploy trigger for delayed work.");
  if (trigger && (trigger.event === "merge" || trigger.event === "deploy") && !afterPrs.length) throw new Error("Select at least one owned PR for a merge/deploy trigger.");
  const stage = trigger?.event === "merge" ? "merged" : trigger?.event === "deploy" ? "deployed" : dependencyStage ?? existing?.dependencyStage ?? "deployed";
  const followUp = enable_follow_up ?? (input.trigger !== undefined ? !!trigger : existing?.enable_follow_up ?? false);
  // due-by-fact: every open task knows what moves it. With no PRs that is a re-check date: the agent's, else
  // RECHECK_DAYS from this update (an update is the agent looking at it). A finished task records when.
  const recheck = input.recheck === undefined ? undefined : /^\d{4}-\d{2}-\d{2}$/.test(input.recheck) ? Date.parse(`${input.recheck}T00:00:00Z`) : Date.parse(input.recheck);
  if (recheck !== undefined && !Number.isFinite(recheck)) throw new Error("recheck is a date: \"YYYY-MM-DD\" or an ISO time.");
  const finished = ["done", "waived"].includes(status);
  const kept = existing?.recheckAt && Date.parse(existing.recheckAt) > now ? existing.recheckAt : undefined;
  // A task blocked on the developer gets none by default: the answer (or the question closing) is what moves it, and a
  // default date would hold that (shared/task-due.ts taskDue). Only a recheck the agent passes holds it.
  const recheckAt = finished ? undefined : recheck !== undefined ? new Date(recheck).toISOString() : ask ? undefined : kept ?? (afterPrs.length ? undefined : new Date(now + RECHECK_DAYS * 86_400_000).toISOString());
  const finishedAt = finished ? (existing && ["done", "waived"].includes(existing.status) ? existing.finishedAt : undefined) ?? new Date(now).toISOString() : undefined;
  const record = { title, status, afterPrs, evidence: evidence || (destination ? `Reply to ${destination.recipient}: ${destination.threadUrl}` : ""), enable_follow_up: followUp, dependencyStage: stage, category: "follow_up" as const, ...(destination ? { communication: destination } : {}), ...(trigger !== undefined ? { trigger } : {}) };
  // Who is working on it: set whenever status is working (the named agent, else the caller); kept as history otherwise.
  const worker = status === "working" ? input.workingAgentId ?? input.caller ?? existing?.workingAgentId : input.workingAgentId ?? existing?.workingAgentId;
  if (worker) Object.assign(record, { workingAgentId: worker });
  if (existing) {
    const reopened = ["done", "waived", "blocked"].includes(existing.status) && ["pending", "waiting"].includes(status);
    if (reopened || existing.title !== title || JSON.stringify(existing.afterPrs) !== JSON.stringify(afterPrs) || existing.dependencyStage !== stage || JSON.stringify(existing.communication) !== JSON.stringify(destination) || JSON.stringify(existing.trigger) !== JSON.stringify(trigger) || existing.enable_follow_up !== followUp || (existing.ask ?? "") !== (ask ?? "") || existing.need !== need || existing.recheckAt !== recheckAt) existing.revision++;
    // A changed ask is a new decision: what covered the old one doesn't cover it (syncTaskQuestions looks again).
    if ((existing.ask ?? "") !== (ask ?? "")) delete existing.coveredBy;
    Object.assign(existing, record);
    if (ask) existing.ask = ask; else delete existing.ask;
    if (need) existing.need = need; else delete existing.need;
    if (recheckAt) existing.recheckAt = recheckAt; else delete existing.recheckAt;
    if (finishedAt) existing.finishedAt = finishedAt; else delete existing.finishedAt;
    if (pointed && ask) existing.coveredBy = pointed.id;
    if (input.note) existing.note = input.note;
    return existing;
  }
  const added = { ...record, ...(recheckAt ? { recheckAt } : {}), ...(finishedAt ? { finishedAt } : {}), ...(ask ? { ask } : {}), ...(need ? { need } : {}), ...(pointed && ask ? { coveredBy: pointed.id } : {}), ...(input.caller ? { createdBy: input.caller } : {}), ...(input.note ? { note: input.note } : {}), id: randomUUID(), revision: 0 };
  w.obligations.push(added); return added;
}
