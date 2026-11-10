import { randomUUID } from "node:crypto";
import type { Workspace } from "../shared/model";
import { followUpObligations } from "../shared/follow-up";
import { QUESTION_MODE_RULES, findOpenMatch, isOpen, nextQuestionId, validChoice, type Question, type QuestionMode } from "../shared/questions";

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
   * changed version of an open question; the old one closed as "Superseded by Qn". */
  outcome: "asked" | "duplicate" | "superseded";
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
    if (!isOpen(replace)) throw new Error(`${replace.id} is already ${replace.answer ? "answered" : "closed"}; ask without supersedes.`);
  } else {
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
  if (replace) replace.closed = { at: question.askedAt, reason: `Superseded by ${question.id}.`, by: agentId };
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
  const at = new Date(now).toISOString();
  q.answer = { choice: choice.trim(), ...(words?.trim() ? { words: words.trim() } : {}), at, by: "agent", delivery: { state: "recorded", to: agentId, messageId: null, at, reason: null } };
  return q;
}

export function withdrawQuestion(w: Workspace, agentId: string, id: string, reason: string, now: number): Question {
  const q = owned(w, agentId, id);
  if (!isOpen(q)) throw new Error(`${id} is already ${q.answer ? "answered" : "withdrawn"}.`);
  q.closed = { at: new Date(now).toISOString(), reason: reason.trim(), by: agentId };
  return q;
}

/** The developer's answer from the UI. Sending happens outside the state lock; this only records it. */
export function developerAnswer(w: Workspace, id: string, choice: string, words: string | undefined, action: "send" | "copy" | "resend", now: number): Question {
  const q = w.questions.find(q => q.id === id);
  if (!q) throw new Error(`No question ${id} in this workspace.`);
  if (q.closed) throw new Error(`${id} was withdrawn: ${q.closed.reason}`);
  const at = new Date(now).toISOString();
  if (action === "resend") {
    if (!q.answer || !["queued", "unconfirmed"].includes(q.answer.delivery.state)) throw new Error(`${id} has nothing waiting to be resent.`);
    q.answer.delivery = { ...q.answer.delivery, state: "sending", at, reason: null };
    return q;
  }
  if (q.answer && !(q.answer.by === "developer" && q.answer.delivery.state === "copied" && action === "send")) throw new Error(`${id} is already answered.`);
  if (!validChoice(q, choice)) throw new Error(q.options.length ? `Pick one of ${q.options.map(o => o.letter).join(", ")}.` : "Write an answer first.");
  q.answer = { choice: choice.trim(), ...(words?.trim() ? { words: words.trim() } : {}), at, by: "developer",
    delivery: action === "copy" ? { state: "copied", to: null, messageId: null, at, reason: null } : { state: "sending", to: null, messageId: randomUUID(), at, reason: null } };
  return q;
}

/** Who should hear the answer: the asking agent first, then the main agent. */
export const answerRecipients = (w: Workspace, q: Question): string[] => [...new Set([q.askedBy, w.mainAgentId].filter((id): id is string => !!id))];

/**
 * Blocked tasks are decisions waiting on the developer, so each gets a question (without options) that
 * links back to it. The task itself is untouched; when it stops being blocked, its open question closes.
 */
export function syncTaskQuestions(w: Workspace, now: number): boolean {
  let changed = false;
  const at = new Date(now).toISOString();
  for (const o of followUpObligations(w)) {
    const linked = w.questions.filter(q => q.taskId === o.id && q.taskRevision !== null);
    const open = linked.find(isOpen);
    if (o.status === "blocked" && !open && !linked.some(q => q.taskRevision === o.revision)) {
      w.questions.push({ id: nextQuestionId(w.questions), title: o.title.slice(0, 120), question: o.evidence?.trim() || o.title, options: [], recommend: null, big: null,
        background: null, links: [], prKey: null, taskId: o.id, taskRevision: o.revision, askedBy: w.mainAgentId, askedAt: at, mode: "work-around", answer: null, closed: null, via: "task" });
      changed = true;
    } else if (o.status !== "blocked" && open) {
      open.closed = { at, reason: o.status === "done" || o.status === "waived" ? `The task was ${o.status === "done" ? "completed" : "waived"}.` : "The task is no longer blocked.", by: null };
      changed = true;
    }
  }
  return changed;
}

type NeedsYouDecision = { question: string; options?: { label: string; consequence?: string }[]; recommend?: number };
/** A stored question as a needs_you decision, so the brief shows it with its own id, options and recommendation. */
export function decisionOf(q: Question): NeedsYouDecision {
  const recommend = q.recommend ? q.options.findIndex(o => o.letter === q.recommend) : -1;
  return { question: q.question.slice(0, 200), ...(q.options.length ? { options: q.options.map(o => ({ label: o.label.slice(0, 60), ...(o.consequence ? { consequence: o.consequence.slice(0, 160) } : {}) })) } : {}), ...(recommend >= 0 ? { recommend } : {}) };
}

/**
 * The questions behind one needs_you call (1.4.0-beta.25). `questions` point at open questions; each decision goes
 * through askQuestion, so one already open (asked with ask_question, or restated from an earlier turn) is linked, not
 * asked again. `decisions` comes back aligned with `questionIds`, which is how the brief maps its decisions to
 * questions. A second call in the same turn replaces only the questions the first call created, never one it linked.
 */
export function needsYouQuestions(w: Workspace, agentId: string, call: { decisions?: NeedsYouDecision[]; questions?: string[] }, mode: QuestionMode, now: number,
  previous: { createdIds?: string[]; questionIds?: string[] } | null): { questionIds: string[]; createdIds: string[]; decisions: NeedsYouDecision[] } {
  const questionIds: string[] = [], createdIds: string[] = [], decisions: NeedsYouDecision[] = [];
  for (const id of call.questions ?? []) {
    const q = w.questions.find(q => q.id === id);
    if (!q) throw new Error(`No question ${id} in this workspace.`);
    if (!isOpen(q)) throw new Error(`${id} is already ${q.answer ? "answered" : "closed"}, so it isn't open any more. Leave it out.`);
    if (questionIds.includes(id)) continue;
    questionIds.push(id); decisions.push(decisionOf(q));
  }
  for (const d of call.decisions ?? []) {
    const options = (d.options ?? []).map((o, i) => ({ letter: String.fromCharCode(65 + i), label: o.label, ...(o.consequence ? { consequence: o.consequence } : {}) }));
    const r = askQuestion(w, agentId, { title: d.question.slice(0, 120), question: d.question, options, ...(d.options?.length ? { recommend: String.fromCharCode(65 + d.recommend!) } : {}) }, mode, now, { via: "needs_you" });
    if (questionIds.includes(r.question.id)) continue;
    questionIds.push(r.question.id);
    decisions.push(r.outcome === "duplicate" ? decisionOf(r.question) : d);
    if (r.outcome !== "duplicate") createdIds.push(r.question.id);
  }
  // Called twice in one turn: the last call wins, so what the first call created and this one doesn't keep closes.
  // Records from before 1.4.0-beta.25 have no createdIds; their questionIds were all created by the call.
  if (previous) for (const id of previous.createdIds ?? previous.questionIds ?? []) {
    const q = w.questions.find(q => q.id === id);
    if (q && isOpen(q) && !questionIds.includes(id) && q.via !== "ask") q.closed = { at: new Date(now).toISOString(), reason: "Replaced by a newer needs_you call.", by: agentId };
  }
  return { questionIds, createdIds, decisions };
}
