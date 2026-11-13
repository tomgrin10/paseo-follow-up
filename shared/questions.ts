import { agentActor, onBehalfLine } from "./actor";
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
  /** An agent answered another agent's question on the developer's behalf (answer_question): which one (shared/actor.ts). */
  agentId: z.string().optional(),
  agentTitle: z.string().nullable().optional(),
  delivery: z.object({
    state: z.enum(["sending", "sent", "queued", "unconfirmed", "copied", "in-chat", "signed-off", "recorded"]),
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
  /** Which path created it (1.4.0-beta.25): ask_question, a needs_you decision, or a blocked task. Older records: null. */
  via: z.enum(["ask", "needs_you", "task"]).nullable().optional(),
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

/**
 * "Something else" (1.4.0-beta.32): the built-in last choice on every question with options, after the agent's own.
 * Recorded as `choice: "other"` with the developer's words as the answer; agents never add it themselves.
 */
export const OTHER = "other";
export const OTHER_LABEL = "Something else";
export const isOther = (choice: string | null | undefined) => choice === OTHER;
const quoted = (words: string | undefined | null) => `"${(words ?? "").trim()}"`;

/**
 * The one way every surface names an answer: "B · Retry for a day", `Something else · "use a cron"`, or the free
 * answer itself. The dialog, Activity, Needs-you and the brief's past card all read it from here.
 */
export function answerLabel(q: { options: readonly { letter: string; label: string }[] }, choice: string, words?: string | null): string {
  // One line: a row clamps it, and a newline inside the words would cut the label off at the first line break.
  if (isOther(choice)) return `${OTHER_LABEL} · ${quoted((words ?? "").replace(/\s+/g, " "))}`;
  const option = q.options.find(o => o.letter === choice);
  return option ? `${choice} · ${option.label}` : choice;
}

/** The head of an answer line: "B — Retry for a day", `Something else — "use a cron"`, or the free answer. */
function answerHead(q: { options: readonly { letter: string; label: string }[] }, choice: string, words?: string): string {
  if (isOther(choice)) return `${OTHER_LABEL} — ${quoted(words)}`;
  const option = q.options.find(o => o.letter === choice);
  return `${choice}${option ? ` — ${option.label}` : ""}`;
}

/** What Copy puts on the clipboard, ready to paste into the agent's chat. */
export function replyText(q: Pick<Question, "id" | "title" | "options">, choice: string, words?: string): string {
  return `${q.id} (${q.title}): ${answerHead(q, choice, words)}${!isOther(choice) && words?.trim() ? `\n${words.trim()}` : ""}`;
}

export const ANSWER_PREFIX = "Follow-up answer";
/**
 * A title or question inside an answer's "(…): " head: no parentheses or line breaks, so the chat card and the
 * Overseer parse it back exactly. Every answer producer (answerMessage, server/inbox.ts briefAnswer/briefAnswers) uses it.
 */
export const answerTitle = (text: string) => text.replace(/\)/g, "").replace(/[(\n]/g, " ").replace(/\s+/g, " ").trim();
/** The lines Follow-up adds after an answer: the answer and the developer's note run until one of these. */
const ANSWER_TRAILER = /^(?:The developer added: |None of your options|You were building |Continue|Answered by .+ for the developer\.$)/;
/** The message sent to the asking agent. It starts with ANSWER_PREFIX so chat rows and history scans recognise it. */
export function answerMessage(q: Question, choice: string, words?: string): string {
  const lines = [`${ANSWER_PREFIX} ${q.id} (${answerTitle(q.title)}): ${answerHead(q, choice, words)}`];
  if (isOther(choice)) lines.push("None of your options: the developer's own answer is in the quotes.");
  else if (words?.trim()) lines.push(`The developer added: ${words.trim()}`);
  if (q.mode === "keep-building" && !q.big && q.recommend && choice !== q.recommend) lines.push(isOther(choice)
    ? `You were building ${q.recommend}. Undo the work built on it and do what the developer described first.`
    : `You were building ${q.recommend}. Undo the work built on it and build ${choice} first.`);
  else if (q.taskId) lines.push("Continue the blocked task with this decision and update the task when it moves.");
  else lines.push("Continue with this choice. The answer is already recorded, so you don't need to record it.");
  // answer_question by another agent: the receiving agent and every reader know it wasn't the developer's click.
  const byline = q.answer?.by === "agent" && q.answer.agentId ? onBehalfLine(agentActor(q.answer.agentId, q.answer.agentTitle)) : null;
  if (byline) lines.push(byline);
  return lines.join("\n");
}

/** Parses an answer message back into its parts, for the chat card. The answer and the note may run over several lines. */
export function parseAnswerMessage(text: string): { id: string; title: string; choice: string; label: string | null; words: string | null } | null {
  const lines = text.trim().split("\n");
  const head = /^Follow-up answer ([QD]\d+) \((.+?)\): (.*)$/.exec(lines[0] ?? "");
  if (!head) return null;
  // Each part runs to the next line Follow-up adds itself.
  let i = 1;
  const upToTrailer = (first: string) => { const part = [first]; while (i < lines.length && !ANSWER_TRAILER.test(lines[i])) part.push(lines[i++]); return part.join("\n").trim(); };
  const answer = upToTrailer(head[3]);
  const other = /^Something else — "([\s\S]*)"$/.exec(answer);
  if (other) return { id: head[1], title: head[2], choice: OTHER_LABEL, label: null, words: other[1].trim() || null };
  const added = lines[i]?.startsWith("The developer added: ") ? (i++, upToTrailer(lines[i - 1].slice("The developer added: ".length))) : "";
  const pick = /^([^—]+?)(?: — ([\s\S]+))?$/.exec(answer);
  return { id: head[1], title: head[2], choice: (pick?.[1] ?? answer).trim(), label: pick?.[2]?.trim() ?? null, words: added || null };
}

/**
 * A multi-decision answer (1.4.0) parsed back for the chat card and the agent: one entry per decision, in order, with
 * the picked letter and label, or `choice: null` for a decision the developer skipped.
 */
export function parseAnswersMessage(text: string): { title: string; answers: { id: string; question: string; choice: string | null; label: string | null; words: string | null }[] } | null {
  const lines = text.trim().split("\n");
  // A summary line ("1. A — … · 2. skipped") then one line per decision. A card with one decision has one id.
  const head = /^Follow-up answer ((?:[QD]\d+, )*[QD]\d+) \((.*?)\): (?=\d+\. )/.exec(lines[0] ?? "");
  if (!head) return null;
  const ids = head[1].split(", ");
  // One id: only with its decision line, so a free answer that reads "1. …" stays a single answer.
  if (ids.length === 1 && !lines.some((l, n) => n > 0 && l.startsWith(`${ids[0]} (`))) return null;
  const answers = ids.map(id => {
    const line = lines.find(l => l.startsWith(`${id} (`));
    const m = line ? /^[QD]\d+ \((.*?)\): (?:([A-Z]|Something else) — (.+)|skipped\b.*)$/.exec(line) : null;
    const note = lines.find(l => l.startsWith(`${id} note: `));
    return { id, question: m?.[1] ?? "", choice: m?.[2] ?? null, label: m?.[3]?.trim() ?? null, words: note ? note.slice(`${id} note: `.length).trim() || null : null };
  });
  return { title: head[2], answers };
}

/**
 * The answer is a known option letter, "other" with the developer's words (only when there are options to be other
 * than), or free words when the question has no options.
 */
export function validChoice(q: Pick<Question, "options">, choice: string, words?: string): boolean {
  if (isOther(choice)) return q.options.length > 0 && !!words?.trim();
  return q.options.length ? q.options.some(o => o.letter === choice) : choice.trim().length > 0;
}
/** Why an answer was refused, in the developer's (or agent's) terms. */
export function choiceError(q: Pick<Question, "options">, choice: string): string {
  if (isOther(choice)) return q.options.length ? `${OTHER_LABEL} needs your answer in words.` : "This question has no options; write the answer as the choice.";
  return q.options.length ? `Pick one of ${q.options.map(o => o.letter).join(", ")}, or ${OTHER_LABEL} (choice "other") with words.` : "Write an answer first.";
}

// ---------- one identity per open question (1.4.0-beta.25) ----------
//
// Questions came in two or more times: an agent asked with ask_question and then restated the decision in its
// end-of-turn needs_you, or restated an open decision at every turn's end. Every path that creates a question asks
// this matcher first. It is deterministic and cheap (token sets, no model call), and it only compares questions in
// one workspace.

const STOP = new Set(["a", "an", "the", "and", "or", "of", "to", "for", "in", "on", "at", "by", "with", "it", "its", "is", "are", "be", "do", "does", "should", "we", "i", "you", "this", "that", "what", "which", "how", "now", "as"]);
const stem = (t: string) => t.length > 4 ? t.replace(/(ations|ation|ings|ing|ed|es|s)$/, "").replace(/e$/, "") : t;
/** Lower-cased word stems. `keepStop` keeps short words, for option labels like "as is". */
export function questionTokens(text: string, keepStop = false): Set<string> {
  return tokensOf(wordsOf(text), keepStop);
}
const wordsOf = (text: string) => text.toLowerCase().replace(/^[a-z][:.)]\s+/, "").replace(/['’]s\b/g, "").split(/[^a-z0-9]+/).filter(Boolean);
const tokensOf = (words: string[], keepStop: boolean) => new Set(words.filter(w => keepStop || !STOP.has(w)).map(stem));
const jaccard = (a: Set<string>, b: Set<string>) => { if (!a.size && !b.size) return 1; let n = 0; for (const t of a) if (b.has(t)) n++; return n / (a.size + b.size - n); };
const contained = (a: Set<string>, b: Set<string>) => { const [small, big] = a.size <= b.size ? [a, b] : [b, a]; if (!small.size) return 0; let n = 0; for (const t of small) if (big.has(t)) n++; return n / small.size; };

export type QuestionShape = { title: string; question: string; options: { label: string }[] };
type Features = { title: string; question: string; labels: string[]; t: Set<string>; q: Set<string>; both: Set<string>; options: Set<string>[]; specific: number };
/**
 * Each question's token sets, built once (invariant a-check-costs-linear-in-its-workspace). 2026-11-13: the status
 * check's duplicate scan tokenized both sides of every pair, O(Q²) tokenizations, 1.6 MB of a 4 MB check on a
 * 52-question workspace. Keyed by the question object and checked against its text on every hit, so an edited
 * question is never compared on stale tokens.
 */
const features = new WeakMap<QuestionShape, Features>();
function featuresOf(x: QuestionShape): Features {
  const hit = features.get(x);
  if (hit && hit.title === x.title && hit.question === x.question && hit.labels.length === x.options.length && hit.labels.every((l, i) => l === x.options[i]!.label)) return hit;
  const t = questionTokens(x.title), q = questionTokens(x.question);
  const f: Features = { title: x.title, question: x.question, labels: x.options.map(o => o.label), t, q, both: new Set([...t, ...q]), options: [], specific: 0 };
  const plain = new Set<string>();
  for (const o of x.options) { const words = wordsOf(o.label); f.options.push(tokensOf(words, true)); for (const t of tokensOf(words, false)) plain.add(t); }
  f.specific = plain.size;
  features.set(x, f);
  return f;
}
/** How alike two questions read: 0–1 over the title, the question and both together. */
export function textSimilarity(a: QuestionShape, b: QuestionShape): number {
  const fa = featuresOf(a), fb = featuresOf(b);
  return Math.max(jaccard(fa.t, fb.t), jaccard(fa.q, fb.q), jaccard(fa.both, fb.both));
}
/** Share of options that have a counterpart ("Memoize the gate" ~ "A: memoize"). Both free-answer: 1; one only: 0. */
export function optionOverlap(a: QuestionShape, b: QuestionShape): number {
  if (!a.options.length && !b.options.length) return 1;
  if (!a.options.length || !b.options.length) return 0;
  const bs = featuresOf(b).options;
  let hits = 0;
  for (const t of featuresOf(a).options) if (bs.some(x => contained(t, x) >= 0.5)) hits++;
  return hits / Math.max(a.options.length, b.options.length);
}
/**
 * `same`: the same question again (return the open one). `changed`: the same decision with materially different options
 * (the new one supersedes it). null: a different question.
 */
export function compareQuestions(a: QuestionShape, b: QuestionShape): "same" | "changed" | null {
  const text = textSimilarity(a, b), options = optionOverlap(a, b);
  if (text >= 0.6) return options >= 0.67 ? "same" : "changed";
  // A reworded question with the same options ("How should the gate's added cost be handled?" / "How should PR 6's gate
  // handle the cost increase?", both memoize / as is / prefilter).
  // Generic options (Yes / No, Keep / Defer) say nothing about which question it is, so they never carry a match.
  const specific = featuresOf(a).specific >= 3;
  if (text >= 0.3 && specific && a.options.length >= 2 && options >= 0.99 && a.options.length === b.options.length) return "same";
  return null;
}
/** Near-identical: the only match allowed across two different askers in one workspace. */
const nearIdentical = (a: QuestionShape, b: QuestionShape) => textSimilarity(a, b) >= 0.85 && optionOverlap(a, b) >= 0.99;

/**
 * The open question in this workspace that `input` repeats, if any. Candidates are the asker's own open questions and
 * open needs_you decisions; another agent's question only when near-identical. Blocked-task questions keep their own
 * identity (the task and its revision) and never match.
 */
export function findOpenMatch(questions: readonly Question[], input: QuestionShape, askedBy: string | null): { question: Question; verdict: "same" | "changed" } | null {
  let best: { question: Question; verdict: "same" | "changed"; score: number } | null = null;
  for (const q of questions) {
    if (!isOpen(q) || q.taskRevision !== null) continue;
    const own = q.askedBy === askedBy || q.via === "needs_you";
    const verdict = own ? compareQuestions(input, q) : nearIdentical(input, q) ? "same" : null;
    if (!verdict) continue;
    const score = textSimilarity(input, q) + optionOverlap(input, q);
    if (!best || score > best.score) best = { question: q, verdict, score };
  }
  return best && { question: best.question, verdict: best.verdict };
}

/** Open questions that repeat an older open one in the same workspace: [duplicate, original] pairs. The invariant. */
export function duplicateOpenQuestions(questions: readonly Question[]): { duplicate: Question; of: Question }[] {
  const out: { duplicate: Question; of: Question }[] = [];
  const kept: Question[] = [];
  for (const q of questions) {
    if (!isOpen(q)) continue;
    const match = q.taskRevision === null ? findOpenMatch(kept, q, q.askedBy) : null;
    if (match?.verdict === "same") out.push({ duplicate: q, of: match.question }); else kept.push(q);
  }
  return out;
}

export const QUESTION_DEDUPE_MIGRATION = "dedupe-open-questions-1";
/**
 * One-time cleanup (1.4.0-beta.25): open questions that repeat an older open one close as "Duplicate of Qn.". The
 * oldest stays; answered and closed questions are never touched. Idempotent: a second run finds nothing to close.
 * Returns what it closed, so a dry run can report it.
 */
export function collapseDuplicateQuestions(questions: Question[], now: number): { closed: string; of: string }[] {
  const at = new Date(now).toISOString();
  return duplicateOpenQuestions(questions).map(({ duplicate, of }) => {
    duplicate.closed = { at, reason: `Duplicate of ${of.id}.`, by: null };
    return { closed: duplicate.id, of: of.id };
  });
}

/**
 * Invariant an-answer-leaves-needs-you-only-when-delivered. A copied answer, or one put in the agent's chat (Paseo
 * 0.16), is the developer's to send: until it is, it stays in Needs you as waiting to be sent. It counts as delivered
 * when a turn of an agent in its workspace ends with a message carrying its marker in the timeline tail the worker
 * already reads at turn end (`deliveredInChat`, server/turn-events.ts), or when the developer signs that agent's row
 * off (they edited the marker away, or answered another way). 2026-11-13: Copy recorded the answer and the question left
 * Needs you at once, though nothing had been sent.
 */
export const awaitingSend = (q: Pick<Question, "answer">) => !!answerStatus(q)?.waiting;

/**
 * One answer's delivery as every surface names it: the question dialog's answer block (`answerHeading`), the chat's
 * brief card (`briefAnswerStatus`), Needs you and the Home row's headline (`awaitingSend` in shared/attention.ts). An
 * answer copied or put in the agent's chat reads "not sent yet" everywhere until it is delivered; only then "Answered".
 * Part of an-answer-leaves-needs-you-only-when-delivered: 2026-11-13, the chat card said "Answered 12:00 PM" with a
 * check while the answer sat unsent in the message box and Needs you said it wasn't sent.
 */
export type AnswerStatus = {
  /** It reached the agent (sent, or the agent recorded it from chat). */
  delivered: boolean;
  /** The developer's to send: copied, or in the agent's message box. */
  waiting: "in-chat" | "copied" | null;
  /** The short state, for a card's corner: "Answered", "Copied · not sent yet"… */
  label: string;
};
export function answerStatus(q: Pick<Question, "answer">): AnswerStatus | null {
  const a = q.answer;
  if (!a) return null;
  const mine = a.by === "developer";
  switch (a.delivery.state) {
    case "in-chat": return { delivered: false, waiting: mine ? "in-chat" : null, label: "In your message box · not sent yet" };
    case "copied": return { delivered: false, waiting: mine ? "copied" : null, label: "Copied · not sent yet" };
    case "sending": return { delivered: false, waiting: null, label: "Sending…" };
    case "queued": return { delivered: false, waiting: null, label: "Waiting for the agent" };
    case "unconfirmed": return { delivered: false, waiting: null, label: "Not confirmed" };
    case "signed-off": return { delivered: false, waiting: null, label: "Signed off" };
    case "sent": case "recorded": return { delivered: true, waiting: null, label: "Answered" };
  }
}
/** The answer block's first line in the question dialog: "You answered B · …", or "Your answer, not sent yet: B · …". */
export function answerHeading(q: Pick<Question, "answer" | "options">): { text: string; waiting: boolean } | null {
  const a = q.answer, s = answerStatus(q);
  if (!a || !s) return null;
  const label = isOther(a.choice) ? OTHER_LABEL : answerLabel(q, a.choice);
  if (s.waiting) return { text: `Your answer, not sent yet: ${label}`, waiting: true };
  return { text: `${a.by === "agent" ? "Answered in chat: " : "You answered "}${label}`, waiting: false };
}
/** A brief card over questions (its decisions): the least delivered of their answers, so it never reads Answered early. */
export function briefAnswerStatus(questionIds: readonly string[], questions: readonly Pick<Question, "id" | "answer">[]): AnswerStatus | null {
  const all = questionIds.map(id => questions.find(q => q.id === id)).map(q => q ? answerStatus(q) : null).filter((s): s is AnswerStatus => !!s);
  return all.find(s => s.waiting) ?? all.find(s => !s.delivered) ?? all[0] ?? null;
}
/** What marks a pasted or composer-sent answer in the agent's chat: answerMessage's first words. */
export const answerMarker = (id: string) => `${ANSWER_PREFIX} ${id} (`;

/** Marks each answer waiting to be sent whose marker is in one of `texts` (the developer's messages to `agentId`) as sent to it. */
export function deliveredInChat(questions: Question[], agentId: string, texts: readonly string[], at: string): string[] {
  const done: string[] = [];
  for (const q of questions) {
    if (!awaitingSend(q) || !texts.some(t => t.includes(answerMarker(q.id)))) continue;
    q.answer!.delivery = { state: "sent", to: agentId, messageId: null, at, reason: null };
    done.push(q.id);
  }
  return done;
}

/** The developer signed `agentId`'s row off: answers waiting to be sent to it stop waiting. */
export function signedOffAnswers(questions: Question[], recipients: (q: Question) => readonly string[], agentId: string, at: string): string[] {
  const done: string[] = [];
  for (const q of questions) {
    if (!awaitingSend(q) || !recipients(q).includes(agentId)) continue;
    q.answer!.delivery = { state: "signed-off", to: agentId, messageId: null, at, reason: null };
    done.push(q.id);
  }
  return done;
}
