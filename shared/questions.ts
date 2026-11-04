// Questions agents ask the developer. The question modes, their rules and the
// "big question" test are adapted from Progress (@stevecastaneda/paseo-progress,
// MIT, © 2026 Steve Castaneda); see THIRD_PARTY_NOTICES.md.
import { z } from "zod";
import { defineSettings } from "@getpaseo/plugin";

export const QUESTION_MODES = ["stop", "work-around", "keep-building"] as const;
export type QuestionMode = (typeof QUESTION_MODES)[number];
/** Also what an unreadable setting means, so an agent never builds ahead by accident. */
export const DEFAULT_QUESTION_MODE: QuestionMode = "work-around";

export const questionPreferences = defineSettings({
  id: "questions",
  scope: "host",
  version: 1,
  schema: z.object({ mode: z.enum(QUESTION_MODES).default(DEFAULT_QUESTION_MODE) }),
});

const HOLD = "Build no option before the answer, not even your recommendation. Keep working on everything the question doesn't affect. If nothing else is left, end your turn and say in chat which question you're waiting on.";

export const QUESTION_MODE_RULES: Record<QuestionMode, { label: string; hint: string; rule(q: { recommend: string | null; big: string | null }): string }> = {
  stop: {
    label: "Stop",
    hint: "Agents stop all work when they ask, until you answer.",
    rule: () => "Ask any other questions you already have, then stop all work until the answer arrives. End your turn now and say in chat which questions you're waiting on.",
  },
  "work-around": {
    label: "Work around",
    hint: "Agents hold what your answer affects and keep working on the rest.",
    rule: () => HOLD,
  },
  "keep-building": {
    label: "Keep building",
    hint: "Agents build their recommendation while you decide and change course if you pick another. Big questions still wait.",
    rule: ({ recommend, big }) => big || !recommend
      ? `This question waits like Work around. ${HOLD}`
      : `Build option ${recommend} now and keep working. If the developer picks another option, undo the work built on ${recommend} and build their choice first. If everything else is done while it's still open, leave it open and say so in chat; don't withdraw it.`,
  },
};

export type QuestionState = "stopped" | "waiting" | "building";
export function questionState(q: Pick<Question, "mode" | "big" | "recommend">): QuestionState {
  if (q.mode === "stop") return "stopped";
  return q.mode === "keep-building" && !q.big && q.recommend ? "building" : "waiting";
}

const text = z.string().trim().min(1);
const httpUrl = z.string().url().refine(v => /^https?:\/\//i.test(v), "Use an HTTP or HTTPS link");
export const questionOptionSchema = z.object({ letter: z.string().regex(/^[A-Z]$/), label: text.max(200), consequence: z.string().trim().max(600).optional() });
export const questionLinkSchema = z.object({ url: httpUrl.optional(), path: z.string().trim().min(1).max(1000).optional(), label: z.string().trim().max(200).optional() })
  .refine(link => !!link.url !== !!link.path, "Give a link or a file path");
export const answerSchema = z.object({
  choice: z.string().trim().max(200),
  words: z.string().trim().max(2000).optional(),
  at: z.string(),
  by: z.enum(["developer", "agent"]),
  delivery: z.object({
    state: z.enum(["sending", "sent", "queued", "unconfirmed", "copied", "recorded"]),
    to: z.string().nullable(),
    messageId: z.string().nullable(),
    at: z.string(),
    reason: z.string().nullable().default(null),
  }),
});
export const questionSchema = z.object({
  id: z.string().regex(/^Q\d+$/),
  title: text.max(120),
  question: text.max(2000),
  options: z.array(questionOptionSchema).max(26).default([]),
  recommend: z.string().trim().max(200).nullable().default(null),
  big: z.string().trim().max(300).nullable().default(null),
  background: z.string().trim().max(4000).nullable().default(null),
  links: z.array(questionLinkSchema).max(10).default([]),
  prKey: z.string().nullable().default(null),
  taskId: z.string().nullable().default(null),
  // The task revision a blocked-task question was raised for, so a re-blocked task asks again.
  taskRevision: z.number().int().nullable().default(null),
  askedBy: z.string().nullable(),
  askedAt: z.string(),
  mode: z.enum(QUESTION_MODES),
  answer: answerSchema.nullable().default(null),
  closed: z.object({ at: z.string(), reason: z.string(), by: z.string().nullable() }).nullable().default(null),
});
export type Question = z.infer<typeof questionSchema>;
export type QuestionOption = z.infer<typeof questionOptionSchema>;
export type Answer = z.infer<typeof answerSchema>;

export const isOpen = (q: Question) => !q.answer && !q.closed;

/** Q1, Q2…: unique for the life of the workspace, never reused after a question closes. */
export function nextQuestionId(questions: Pick<Question, "id">[]): string {
  const highest = questions.reduce((n, q) => Math.max(n, Number(q.id.slice(1)) || 0), 0);
  return `Q${highest + 1}`;
}

/** What Copy puts on the clipboard, ready to paste into the agent's chat. */
export function replyText(q: Pick<Question, "id" | "title" | "options">, choice: string, words?: string): string {
  const option = q.options.find(o => o.letter === choice);
  return `${q.id} (${q.title}): ${choice}${option ? ` — ${option.label}` : ""}${words?.trim() ? `\n${words.trim()}` : ""}`;
}

export const ANSWER_PREFIX = "Follow-up answer";
/** The message sent to the asking agent. It starts with ANSWER_PREFIX so chat rows and history scans recognise it. */
export function answerMessage(q: Question, choice: string, words?: string): string {
  const option = q.options.find(o => o.letter === choice);
  const lines = [`${ANSWER_PREFIX} ${q.id} (${q.title}): ${choice}${option ? ` — ${option.label}` : ""}`];
  if (words?.trim()) lines.push(`The developer added: ${words.trim()}`);
  if (q.mode === "keep-building" && !q.big && q.recommend && choice !== q.recommend) lines.push(`You were building ${q.recommend}. Undo the work built on it and build ${choice} first.`);
  else if (q.taskId) lines.push("Continue the blocked task with this decision and update the task when it moves.");
  else lines.push("Continue with this choice. The answer is already recorded, so you don't need to record it.");
  return lines.join("\n");
}

/** Parses an answer message back into its parts, for the chat card. */
export function parseAnswerMessage(text: string): { id: string; title: string; choice: string; label: string | null; words: string | null } | null {
  const match = /^Follow-up answer (Q\d+) \((.+?)\): ([^\n—]+?)(?: — ([^\n]+))?\n(?:The developer added: ([^\n]+))?/.exec(text.trim() + "\n");
  return match ? { id: match[1], title: match[2], choice: match[3].trim(), label: match[4]?.trim() ?? null, words: match[5]?.trim() ?? null } : null;
}

/** The answer is a known option letter, or free words when the question has no options. */
export function validChoice(q: Pick<Question, "options">, choice: string): boolean {
  return q.options.length ? q.options.some(o => o.letter === choice) : choice.trim().length > 0;
}
