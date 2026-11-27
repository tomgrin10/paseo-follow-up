import { finishedTask } from "../shared/finished";
import { DEVELOPER, actorBy, type Actor } from "../shared/actor";
import { randomUUID } from "node:crypto";
import { blockedOnDeveloper, type Workspace } from "../shared/model";
import { followUpObligations } from "../shared/follow-up";
import { DISMISS_REASON, OTHER, TASK_DONE, currentQuestion, findTaskCover, taskCardsFor, taskNeed, OTHER_LABEL, QUESTION_MODE_RULES, choiceError, findDismissedMatch, findOpenMatch, isDismissed, isOpen, isOther, nextQuestionId, validChoice, type Question, type QuestionMode } from "../shared/questions";

/** "other" and its label both mean Something else, so an agent recording "Something else" lands on the same answer. */
const normalChoice = (choice: string) => [OTHER, OTHER_LABEL.toLowerCase()].includes(choice.trim().toLowerCase()) ? OTHER : choice.trim();

export type AskInput = {
  title: string; question: string; options?: { letter: string; label: string; consequence?: string }[]; recommend?: string;
  big?: string; background?: string; links?: { url?: string; path?: string; label?: string }[]; pr?: string; task?: string;
};

function resolvePr(w: Workspace, ref: string): string {
  const trimmed = ref.trim().replace(/^#/, "");
  const exact = w.prs.find(p => p.key.toLowerCase() === trimmed.toLowerCase());
  if (exact) return exact.key;
  const byNumber = w.prs.filter(p => String(p.number) === trimmed);
  if (byNumber.length === 1) return byNumber[0].key;
  throw new Error(`No registered PR matches ${ref}. Use owner/repo#number or a number registered in this workspace.`);
}

export type AskOutcome = {
  question: Question; instruction: string;
  /** asked: a new question. duplicate: the same question was already open, so it wasn't asked again. superseded: a
   * changed version of an open question; the old one closed as "Superseded by Qn". dismissed: the developer dismissed
   * this question, so it wasn't asked again. */
  outcome: "asked" | "duplicate" | "superseded" | "dismissed";
  /** The question that was already open (duplicate) or that this one replaced (superseded). */
  of: string | null;
};

/**
 * Validates and records a question. Returns it with the rule the agent must follow until it is answered.
 *
 * One identity per open question: asking something already open in this workspace returns the open question instead
 * of a second card, and a changed version (other options) supersedes it, so two versions are never open at once.
 * `supersedes` names the question to replace explicitly. See findOpenMatch for which questions can match.
 */
export function askQuestion(w: Workspace, agentId: string, input: AskInput, mode: QuestionMode, now: number, opts: { via?: "ask" | "needs_you"; supersedes?: string } = {}): AskOutcome {
  // Decisions belong to the main agent, like goal, tasks and completion. Contributors keep PR tools only.
  if (w.mainAgentId !== agentId) throw new Error("Only this workspace's main agent can ask the developer questions. Ask the main agent to raise it.");
  const options = input.options ?? [];
  const letters = options.map(o => o.letter);
  if (new Set(letters).size !== letters.length) throw new Error("Option letters must be unique.");
  if (letters.some((letter, i) => letter !== String.fromCharCode(65 + i))) throw new Error("Letter options A, B, C… in order.");
  const recommend = input.recommend?.trim() || null;
  if (options.length && !recommend) throw new Error("Recommend one option with recommend=<letter>.");
  if (options.length && recommend && !letters.includes(recommend)) throw new Error(`recommend must be one of ${letters.join(", ")}.`);
  if (input.task && !w.obligations.some(o => o.id === input.task)) throw new Error("No task with that id in this workspace. Read workspace_status for task ids.");
  for (const link of input.links ?? []) if (!!link.url === !!link.path) throw new Error("Each link needs a url or a path, not both.");
  const shape = { title: input.title.trim(), question: input.question.trim(), options };
  let replace: Question | null = null;
  if (opts.supersedes) {
    replace = w.questions.find(q => q.id === opts.supersedes) ?? null;
    if (!replace) throw new Error(`No question ${opts.supersedes} in this workspace.`);
    // A dismissed question may be asked again on purpose, when something really changed: it stays dismissed.
    if (!isOpen(replace) && !isDismissed(replace)) throw new Error(`${replace.id} is already ${replace.answer ? "answered" : "closed"}; ask without supersedes.`);
  } else {
    // dismissing-a-question-sends-the-agent-nothing: what the developer dismissed doesn't come back as a new card.
    const dismissed = findDismissedMatch(w.questions, shape, agentId);
    if (dismissed && !findOpenMatch(w.questions, shape, agentId)) return { question: dismissed, outcome: "dismissed", of: dismissed.id, instruction: dismissedInstruction(dismissed) };
    const match = findOpenMatch(w.questions, shape, agentId);
    if (match?.verdict === "same") {
      const open = match.question;
      const rule = QUESTION_MODE_RULES[open.mode].rule({ recommend: open.recommend, big: open.big });
      return { question: open, outcome: "duplicate", of: open.id,
        instruction: `Already open as ${open.id} (${open.title}), not asked again. Its answer arrives in this chat as "Follow-up answer ${open.id} …". To point at it at the end of a turn, call needs_you with questions=["${open.id}"] instead of restating it. To change its options, ask again with supersedes="${open.id}". Until then: ${rule}` };
    }
    if (match?.verdict === "changed") replace = match.question;
  }
  const question: Question = {
    id: nextQuestionId(w.questions), title: input.title.trim(), question: input.question.trim(), options, recommend,
    big: input.big?.trim() || null, background: input.background?.trim() || null, links: input.links ?? [],
    prKey: input.pr ? resolvePr(w, input.pr) : null, taskId: input.task ?? null, taskRevision: null,
    askedBy: agentId, askedAt: new Date(now).toISOString(), mode, answer: null, closed: null, via: opts.via ?? "ask",
  };
  w.questions.push(question);
  if (replace && isOpen(replace)) replace.closed = { at: question.askedAt, reason: `Superseded by ${question.id}.`, by: agentId };
  const rule = QUESTION_MODE_RULES[mode].rule({ recommend, big: question.big });
  const instruction = [
    `Asked ${question.id}${replace ? ` (it replaces ${replace.id}, now closed as superseded)` : ""}. Question mode: ${QUESTION_MODE_RULES[mode].label}. ${rule}`,
    `The developer answers in Follow-up and the answer arrives in this chat as "Follow-up answer ${question.id} …"; it is already recorded. When one card asks several decisions, they are answered together in one message: a summary line, then one line per decision ("Q<n> (<question>): <letter> — <label>"), and any decision the developer skipped says "skipped" and stays open. If they answer in chat instead, call record_answer. Call withdraw_question if it stops mattering.`,
  ].join("\n");
  return { question, instruction, outcome: replace ? "superseded" : "asked", of: replace?.id ?? null };
}

function owned(w: Workspace, agentId: string, id: string): Question {
  const q = w.questions.find(q => q.id === id);
  if (!q) throw new Error(`No question ${id} in this workspace.`);
  if (w.mainAgentId !== agentId) throw new Error(`Only the main agent can change ${id}.`);
  return q;
}

/** The developer answered in chat; the agent records what they said. */
export function recordAnswer(w: Workspace, agentId: string, id: string, choice: string, words: string | undefined, now: number): Question {
  const q = owned(w, agentId, id);
  if (!isOpen(q)) throw new Error(`${id} is already ${q.answer ? "answered" : "withdrawn"}.`);
  choice = normalChoice(choice);
  if (isOther(choice) && !validChoice(q, choice, words)) throw new Error(`${choiceError(q, choice)} Pass what the developer said as words.`);
  const at = new Date(now).toISOString();
  q.answer = { choice, ...(words?.trim() ? { words: words.trim() } : {}), at, by: "agent", delivery: { state: "recorded", to: agentId, messageId: null, at, reason: null } };
  return q;
}

export function withdrawQuestion(w: Workspace, agentId: string, id: string, reason: string, now: number): Question {
  const q = owned(w, agentId, id);
  if (!isOpen(q)) throw new Error(`${id} is already ${q.answer ? "answered" : "withdrawn"}.`);
  q.closed = { at: new Date(now).toISOString(), reason: reason.trim(), by: agentId };
  return q;
}

/** What an agent hears when it asks, or points at, a question the developer dismissed. */
export const dismissedInstruction = (q: Pick<Question, "id" | "title">) =>
  `The developer dismissed ${q.id} (${q.title}): it no longer matters, so it isn't asked again and nothing was sent to you. Carry on without it and don't raise it again, at a turn's end either. If something really changed, ask again with supersedes="${q.id}".`;

/**
 * The developer dismisses a question that no longer matters (dismissing-a-question-sends-the-agent-nothing). It closes
 * as dismissed and leaves Needs you; nothing is queued or sent, so the agent spends no turn and no tokens on it. It
 * learns only when it looks: workspace_status, or asking or pointing at it again. An agent may dismiss another agent's
 * question for the developer (dismiss_question), never one it asked or owns: that is withdraw_question.
 */
export function dismissQuestion(w: Workspace, id: string, actor: Actor, now: number): Question {
  const q = w.questions.find(q => q.id === id);
  if (!q) throw new Error(`No question ${id} in this workspace.`);
  if (!isOpen(q)) throw new Error(`${id} is already ${q.answer ? "answered" : isDismissed(q) ? "dismissed" : "closed"}.`);
  if (actor.kind === "agent" && (actor.agentId === q.askedBy || actor.agentId === w.mainAgentId))
    throw new Error(`${id} is your own question: use withdraw_question with a reason. dismiss_question dismisses another agent's question for the developer.`);
  q.closed = { at: new Date(now).toISOString(), reason: DISMISS_REASON, by: actorBy(actor), dismissed: true };
  return q;
}

/** Undo: a dismissed question opens again as it was. Only a dismissal can be undone this way. */
export function undoDismiss(w: Workspace, id: string): Question {
  const q = w.questions.find(q => q.id === id);
  if (!q) throw new Error(`No question ${id} in this workspace.`);
  if (!isDismissed(q)) throw new Error(`${id} isn't dismissed, so there is nothing to undo.`);
  q.closed = null;
  return q;
}

/** Delivery states a Resend (Retry, Try now) applies to. */
export const RESENDABLE: readonly string[] = ["queued", "retrying", "failed", "unconfirmed"];
/** How the developer's answer leaves the card: sent by Follow-up, copied, or put in the agent's chat (Paseo 0.16), or sent again. */
export type AnswerAction = "send" | "copy" | "chat" | "resend";

/** The developer's answer from the UI. Sending happens outside the state lock; this only records it. */
export function developerAnswer(w: Workspace, id: string, choice: string, words: string | undefined, action: AnswerAction, now: number, actor: Actor = DEVELOPER): Question {
  const q = w.questions.find(q => q.id === id);
  if (!q) throw new Error(`No question ${id} in this workspace.`);
  if (isDismissed(q)) throw new Error(`${id} was dismissed, so nothing was sent.`);
  if (q.closed) throw new Error(`${id} was withdrawn: ${q.closed.reason}`);
  const at = new Date(now).toISOString();
  if (action === "resend") {
    if (!q.answer?.delivery.messageId || !RESENDABLE.includes(q.answer.delivery.state)) throw new Error(`${id} has nothing waiting to be resent.`);
    // The queue item keeps its own state; Retry on a failed one resends, Try now on a waiting one moves its time.
    return q;
  }
  if (q.answer && !(q.answer.by === "developer" && ["copied", "in-chat"].includes(q.answer.delivery.state) && action === "send")) throw new Error(`${id} is already answered.`);
  choice = normalChoice(choice);
  if (!validChoice(q, choice, words)) throw new Error(choiceError(q, choice));
  // An agent answering for the developer (answer_question) is recorded as that agent, never as the developer.
  q.answer = { choice, ...(words?.trim() ? { words: words.trim() } : {}), at, ...(actor.kind === "agent" ? { by: "agent" as const, agentId: actor.agentId, agentTitle: actor.title } : { by: "developer" as const }),
    delivery: action === "copy" ? { state: "copied", to: null, messageId: null, at, reason: null }
      : action === "chat" ? { state: "in-chat", to: q.askedBy ?? w.mainAgentId ?? null, messageId: null, at, reason: null }
      : { state: "sending", to: null, messageId: randomUUID(), at, reason: null } };
  return q;
}

/** Who should hear the answer: the asking agent first, then the main agent. */
export const answerRecipients = (w: Workspace, q: Question): string[] => [...new Set([q.askedBy, w.mainAgentId].filter((id): id is string => !!id))];

/**
 * A task blocked on the developer (blocked with an `ask`) gets a question without options that links back to it and
 * asks exactly that, unless a question already asks it (one-decision-one-card): one it names ("Q1: may I …?", or
 * update_obligation question="Q1"), one asked with `task` set to it, or an open one that reads the same
 * (`findTaskCover`). The task then records that question (`coveredBy`) and shows as waiting on it, and an open card it
 * made before closes as "Already asked as Q1." An answered question keeps covering it while the ask is unchanged: the
 * agent has the answer and moves the task. A task blocked on anything else (a PR, another agent) asks nothing: it shows
 * as Blocked in Tasks. When the task leaves blocked, stops asking, or asks something else, its open question closes (a
 * new ask gets a new question). Invariant a-question-always-asks-the-developer-something.
 */
export function syncTaskQuestions(w: Workspace, now: number): boolean {
  let changed = false;
  const at = new Date(now).toISOString();
  for (const o of followUpObligations(w)) {
    const ask = blockedOnDeveloper(o) ? o.ask!.trim() : null;
    const cover = ask ? taskCover(w, o) : null;
    if ((cover?.id ?? undefined) !== o.coveredBy) {
      if (cover) o.coveredBy = cover.id; else delete o.coveredBy;
      changed = true;
    }
    const linked = w.questions.filter(q => q.taskId === o.id && q.taskRevision !== null);
    let open = linked.find(isOpen);
    // one-ask-one-item: an action ("… and tell me when it's done") is a Done card, never "write the decision".
    const need = ask ? taskNeed(ask, o.need) : null;
    // A card that asks the same thing in the wrong shape is reshaped in place (it keeps its id), never closed and made
    // again: a card from before 2.4 that framed an action as "write the decision" gets its Done.
    if (open && !cover && open.question === ask && (open.need ?? "decision") !== need) {
      if (need === "action") { open.options = [{ ...TASK_DONE }]; open.need = need; } else { open.options = []; delete open.need; }
      changed = true;
    }
    if (open && (cover || open.question !== ask)) {
      open.closed = { at, by: null, reason: cover ? `Already ${cover.answer ? "answered" : "asked"} as ${cover.id}.`
        : finishedTask(o) ? `The task was ${o.status === "done" ? "completed" : "waived"}.`
        : o.status !== "blocked" ? "The task is no longer blocked." : ask ? "The task asks something else now." : "The task waits on something other than you." };
      open = undefined; changed = true;
    }
    if (ask && !cover && !open && !linked.some(q => q.taskRevision === o.revision && q.question === ask)) {
      w.questions.push({ id: nextQuestionId(w.questions), title: o.title.slice(0, 120), question: ask, options: need === "action" ? [{ ...TASK_DONE }] : [], recommend: null, big: null,
        background: null, links: [], prKey: null, taskId: o.id, taskRevision: o.revision, askedBy: w.mainAgentId, askedAt: at, mode: "work-around", answer: null, closed: null, via: "task",
        ...(need === "action" ? { need } : {}) });
      changed = true;
    }
  }
  return changed;
}

/** The question covering a task blocked on the developer: the one it recorded while that still stands, else a fresh look. */
function taskCover(w: Workspace, o: Workspace["obligations"][number]): Question | null {
  const kept = o.coveredBy ? currentQuestion(w.questions, o.coveredBy) : null;
  if (kept && kept.taskRevision === null) return kept;
  return findTaskCover(o, w.questions, w.mainAgentId);
}

/** What update_obligation tells the agent about a task blocked on the developer: the card it waits on, so nothing restates it. */
export function coverNote(w: Workspace, taskId: string): string | null {
  const o = w.obligations.find(o => o.id === taskId);
  if (!o || !blockedOnDeveloper(o)) return null;
  const q = o.coveredBy ? w.questions.find(q => q.id === o.coveredBy) : null;
  // one-ask-one-item: the task's own card says nothing to the agent (zero words when clean). The turn-end needs_you
  // about it folds into the card on the server (taskCardsFor), so the agent never needs its id.
  if (!q) return null;
  if (isDismissed(q)) return dismissedInstruction(q);
  if (q.answer) return `Already answered as ${q.id}: the developer decided, and the answer is in this chat as "Follow-up answer ${q.id} …". No new card was made. Act on that answer and move this task (working, waiting or done) instead of keeping it blocked on it.`;
  return `Already asked as ${q.id}: the task shows as waiting on it and no second card was made. Its answer arrives as "Follow-up answer ${q.id} …". At the turn's end point at it with needs_you questions=["${q.id}"], don't restate it.`;
}

type NeedsYouDecision = { question: string; options?: { label: string; consequence?: string }[]; recommend?: number };
/** A stored question as a needs_you decision, so the brief shows it with its own id, options and recommendation. */
export function decisionOf(q: Question): NeedsYouDecision {
  const recommend = q.recommend ? q.options.findIndex(o => o.letter === q.recommend) : -1;
  // Whole text: needs_you's 200/60/160 limits are for decisions an agent writes, not for a stored question it points at.
  // The card clamps long text itself, at a word, with an ellipsis and a way to read it all.
  return { question: q.question, ...(q.options.length ? { options: q.options.map(o => ({ label: o.label, ...(o.consequence ? { consequence: o.consequence } : {}) })) } : {}), ...(recommend >= 0 ? { recommend } : {}) };
}

/**
 * The questions behind one needs_you call (1.4.0-beta.25). `questions` point at open questions; each decision goes
 * through askQuestion, so one already open (asked with ask_question, or restated from an earlier turn) is linked, not
 * asked again. `decisions` comes back aligned with `questionIds`, which is how the brief maps its decisions to
 * questions. A second call in the same turn replaces only the questions the first call created, never one it linked.
 */
export function needsYouQuestions(w: Workspace, agentId: string, call: { kind?: string; ask?: string; context?: string; decisions?: NeedsYouDecision[]; questions?: string[] }, mode: QuestionMode, now: number,
  previous: { createdIds?: string[]; questionIds?: string[] } | null, turnStartedAt: number | null = null): { questionIds: string[]; createdIds: string[]; decisions: NeedsYouDecision[]; dismissed: string[] } {
  const questionIds: string[] = [], createdIds: string[] = [], decisions: NeedsYouDecision[] = [], dismissed: string[] = [];
  for (const id of call.questions ?? []) {
    const q = w.questions.find(q => q.id === id);
    if (!q) throw new Error(`No question ${id} in this workspace.`);
    if (isDismissed(q)) throw new Error(dismissedInstruction(q));
    if (!isOpen(q)) throw new Error(`${id} is already ${q.answer ? "answered" : "closed"}, so it isn't open any more. Leave it out.`);
    if (questionIds.includes(id)) continue;
    questionIds.push(id); decisions.push(decisionOf(q));
  }
  for (const d of call.decisions ?? []) {
    const options = (d.options ?? []).map((o, i) => ({ letter: String.fromCharCode(65 + i), label: o.label, ...(o.consequence ? { consequence: o.consequence } : {}) }));
    const r = askQuestion(w, agentId, { title: d.question.slice(0, 120), question: d.question, options, ...(d.options?.length ? { recommend: String.fromCharCode(65 + d.recommend!) } : {}) }, mode, now, { via: "needs_you" });
    // A decision the developer dismissed doesn't come back on the card.
    if (r.outcome === "dismissed") { dismissed.push(r.question.id); continue; }
    if (questionIds.includes(r.question.id)) continue;
    questionIds.push(r.question.id);
    decisions.push(r.outcome === "duplicate" ? decisionOf(r.question) : d);
    if (r.outcome !== "duplicate") createdIds.push(r.question.id);
  }
  // one-ask-one-item: an action or decision brief about a blocked task's card points at that card, as questions=["Q3"]
  // would, so the brief folds into it and the ask shows once (needsYouBlock). See taskCardsFor for which cards.
  if (call.kind && call.ask) for (const q of taskCardsFor({ kind: call.kind, ask: call.ask, context: call.context }, w.questions, turnStartedAt)) {
    if (questionIds.includes(q.id)) continue;
    questionIds.push(q.id); decisions.push(decisionOf(q));
  }
  // Called twice in one turn: the last call wins, so what the first call created and this one doesn't keep closes.
  // Records from before 1.4.0-beta.25 have no createdIds; their questionIds were all created by the call.
  if (previous) for (const id of previous.createdIds ?? previous.questionIds ?? []) {
    const q = w.questions.find(q => q.id === id);
    if (q && isOpen(q) && !questionIds.includes(id) && q.via !== "ask") q.closed = { at: new Date(now).toISOString(), reason: "Replaced by a newer needs_you call.", by: agentId };
  }
  return { questionIds, createdIds, decisions, dismissed };
}
