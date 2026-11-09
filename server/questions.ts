import { randomUUID } from "node:crypto";
import type { Workspace } from "../shared/model";
import { followUpObligations } from "../shared/follow-up";
import { QUESTION_MODE_RULES, isOpen, nextQuestionId, validChoice, type Question, type QuestionMode } from "../shared/questions";

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

/** Validates and records a new question. Returns it with the rule the agent must follow until it is answered. */
export function askQuestion(w: Workspace, agentId: string, input: AskInput, mode: QuestionMode, now: number): { question: Question; instruction: string } {
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
  const question: Question = {
    id: nextQuestionId(w.questions), title: input.title.trim(), question: input.question.trim(), options, recommend,
    big: input.big?.trim() || null, background: input.background?.trim() || null, links: input.links ?? [],
    prKey: input.pr ? resolvePr(w, input.pr) : null, taskId: input.task ?? null, taskRevision: null,
    askedBy: agentId, askedAt: new Date(now).toISOString(), mode, answer: null, closed: null,
  };
  w.questions.push(question);
  const rule = QUESTION_MODE_RULES[mode].rule({ recommend, big: question.big });
  const instruction = [
    `Asked ${question.id}. Question mode: ${QUESTION_MODE_RULES[mode].label}. ${rule}`,
    `The developer answers in Follow-up and the answer arrives in this chat as "Follow-up answer ${question.id} …"; it is already recorded. When one card asks several decisions, they are answered together in one message: a summary line, then one line per decision ("Q<n> (<question>): <letter> — <label>"), and any decision the developer skipped says "skipped" and stays open. If they answer in chat instead, call record_answer. Call withdraw_question if it stops mattering.`,
  ].join("\n");
  return { question, instruction };
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
        background: null, links: [], prKey: null, taskId: o.id, taskRevision: o.revision, askedBy: w.mainAgentId, askedAt: at, mode: "work-around", answer: null, closed: null });
      changed = true;
    } else if (o.status !== "blocked" && open) {
      open.closed = { at, reason: o.status === "done" || o.status === "waived" ? `The task was ${o.status === "done" ? "completed" : "waived"}.` : "The task is no longer blocked.", by: null };
      changed = true;
    }
  }
  return changed;
}
