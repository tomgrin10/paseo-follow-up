import { z } from "zod";
import type { Pr, Workspace } from "./model";
import { agentMergesKey } from "./pr-workflow";
import { ANSWER_PREFIX, OTHER_LABEL, answerLabel, answerTitle, isOther, type Question } from "./questions";

/**
 * The brief: "what you need to do", appended as one card at the end of an agent's timeline when it needs
 * the developer. Everything here is pure: the precedence function picks the content from the sources that
 * exist (design §5.2) and the lifecycle function moves a stored brief between states (design §6).
 * It never invents an ask: with no stated or structured source, the card says so.
 */

export const BRIEF_KINDS = ["decision", "action", "review", "reviewers", "permission", "paused", "error", "done", "unknown"] as const;
export type BriefKind = typeof BRIEF_KINDS[number];
export const BRIEF_SOURCES = ["permission", "paused", "error", "agent", "followup", "extracted", "none"] as const;
export type BriefSource = typeof BRIEF_SOURCES[number];
export const BRIEF_STATES = ["open", "answered", "signed", "superseded"] as const;

export const briefOptionSchema = z.object({ letter: z.string(), label: z.string(), consequence: z.string().nullable().default(null) });
export const briefDecisionSchema = z.object({
  /** The Follow-up question id (Q1…) when it was stored as one, else a local D1… */
  id: z.string(),
  question: z.string(),
  options: z.array(briefOptionSchema).default([]),
  recommend: z.string().nullable().default(null),
  /** A letter, or "other" (Something else) with the developer's own answer in `words`. */
  chosen: z.string().nullable().default(null),
  words: z.string().nullable().default(null),
});
export const briefFactSchema = z.object({ icon: z.string(), label: z.string(), tone: z.enum(["ok", "warn", "bad", "muted"]).default("muted") });
export const briefLinkSchema = z.object({ label: z.string(), url: z.string().nullable().default(null), path: z.string().nullable().default(null), pr: z.string().nullable().default(null) });
export const MOVES = ["merge", "open_pr", "sign_off_next", "retry", "copy_error", "open_subagent", "add_reviewers", "done"] as const;
export const briefMoveSchema = z.object({ kind: z.enum(MOVES), label: z.string(), prKey: z.string().nullable().default(null), url: z.string().nullable().default(null), agentId: z.string().nullable().default(null) });

/** Stored on the inbox entry (additive; the store's `version` stays 1) and appended as the timeline row's data. */
export const briefSchema = z.object({
  /** Timeline row id, "brief:<turnId>". Re-appending the same id replaces the row in place. */
  id: z.string(),
  turnId: z.string().nullable().default(null),
  source: z.enum(BRIEF_SOURCES),
  kind: z.enum(BRIEF_KINDS),
  /** ≤ 140 chars. The one-liner on the card, the inbox row and the composer tooltip. */
  ask: z.string(),
  state: z.enum(BRIEF_STATES).default("open"),
  /** Decisions stored as Follow-up questions (tracked workspaces only). */
  questionIds: z.array(z.string()).default([]),
  at: z.string(),
  /** The inbox entry's seq when this brief was made, so a stale click is refused. */
  seq: z.number().int().default(0),
  /** False for a brief shown without a flag (Don't flag finishes, a delegated agent, a muted turn). */
  flagged: z.boolean().default(true),
  /** One 40 px line: a permission (Paseo's prompt is right below) or the honest fallback. */
  slim: z.boolean().default(false),
  decisions: z.array(briefDecisionSchema).default([]),
  context: z.string().nullable().default(null),
  mono: z.string().nullable().default(null),
  facts: z.array(briefFactSchema).default([]),
  /** The PR whose state `facts` shows: one the brief references (its review's PR or a PR it links). Null: no PR facts. */
  factsPr: z.string().nullable().default(null),
  links: z.array(briefLinkSchema).default([]),
  moves: z.array(briefMoveSchema).default([]),
  /** What the agent stated with needs_you when a blocking state took the headline (§5.2 rule 1). */
  also: z.object({ ask: z.string(), context: z.string().nullable().default(null) }).nullable().default(null),
  /** Where the content came from, said on the card so the developer knows how much to trust it. */
  sourceLine: z.string(),
  /** Collapsed states: "You picked A · Per-tenant buckets", "You replied", "Signed off", "The agent kept going". */
  outcome: z.string().nullable().default(null),
  outcomeAt: z.string().nullable().default(null),
  /** Who answered the card (shared/actor.ts ledgerBy): "developer", or "agent:<id>" for an agent's brief_action. */
  answeredBy: z.string().optional(),
  /** The answering agent's title, for "Release captain's answer" on the collapsed card. */
  answeredByTitle: z.string().nullable().optional(),
  /** For the card's PR moves: the tracked workspace, when there is one. */
  workspaceId: z.string().nullable().default(null),
  /**
   * The answer's id: the client makes one per Send and reuses it on Retry, so a retried or double-clicked answer is
   * recognised and never sent twice. Absent on briefs answered before 1.4.0-beta.65.
   */
  answerId: z.string().nullable().optional(),
  /**
   * Getting the answer to the agent, after the card already recorded it (server/inbox.ts AnswerOutbox): "sending"
   * until Paseo confirms, "failed" with the reason once every retry failed. Absent once delivered, and on old briefs.
   */
  delivery: z.object({ state: z.enum(["sending", "failed"]), error: z.string().nullable().default(null) }).nullable().optional(),
});
export type Brief = z.infer<typeof briefSchema>;
export type BriefDecision = z.infer<typeof briefDecisionSchema>;
export type BriefFact = z.infer<typeof briefFactSchema>;
export type BriefMove = z.infer<typeof briefMoveSchema>;
export const BRIEF_KIND = "brief";
export const BRIEF_VERSION = 1;

// ---------- needs_you ----------

export const NEEDS_YOU_KINDS = ["decision", "action", "review", "done"] as const;
export type NeedsYouCall = {
  ask: string; kind: typeof NEEDS_YOU_KINDS[number];
  decisions?: { question: string; options?: { label: string; consequence?: string }[]; recommend?: number }[];
  /** Open questions (Q18) this ask is about, instead of restating them as decisions. */
  questions?: string[];
  context?: string;
  links?: { label: string; url?: string; path?: string; pr?: string }[];
};
/** What the bridge records after a valid call; the turn end reads the newest one for the turn. */
export type NeedsYouRecord = { at: number; turnId: string | null; call: NeedsYouCall; questionIds?: string[];
  /** The questions this call created (the rest it pointed at or matched). Only these are replaced by a later call in the same turn. */
  createdIds?: string[] };

/** The exact instruction appended to Follow-up's MCP instructions for root agents (design §7.2). */
export const NEEDS_YOU_INSTRUCTION = "When you end a turn, call `needs_you` once, just before your final reply, with what the developer has to do next: a decision (give 2–3 options, what each means for them, and the one you recommend), an action only they can take (merge, approve, log in, run or send something), or kind=done (\"Nothing needed\" plus what you finished, in one line), which means there is nothing for the developer and won't flag you in their inbox. A decision that is already an open question (you asked it with ask_question, or it is still open from an earlier turn) is never restated: point at it with questions=[\"Q18\"], or say \"Still open: Q18 …\" in ask. Keep `ask` to one line and `context` to what they need to decide. Don't repeat your report there; still write your normal reply. Don't call it while a permission prompt is waiting or while you're still working.";
/** The Stop-hook nudge's reason (R2). Short, because it lands in the agent's context. */
export const NEEDS_YOU_NUDGE = "Before you stop, call needs_you once with what the developer has to do next: a decision with options (or questions=[\"Q18\"] for one that is already an open question), an action only they can take, or kind=done (\"Nothing needed\" plus what you finished), which means nothing for the developer and won't flag you. Then stop; don't repeat your reply.";

/**
 * Validates a needs_you call the way ask_question is validated (§7.1). Throws with a message the agent can act on.
 * `resolvePr` maps a PR reference to a registered PR key, or throws.
 */
export function validateNeedsYou(input: NeedsYouCall, resolvePr: (ref: string) => string): NeedsYouCall {
  const ask = input.ask?.trim() ?? "";
  if (!ask) throw new Error("ask is required: one line with what the developer does next.");
  if (ask.length > 120) throw new Error("Keep ask to one line of at most 120 characters.");
  if (!NEEDS_YOU_KINDS.includes(input.kind)) throw new Error(`kind must be one of ${NEEDS_YOU_KINDS.join(", ")}.`);
  const decisions = input.decisions ?? [];
  if (decisions.length && input.kind !== "decision") throw new Error("decisions are only for kind \"decision\".");
  const questions = input.questions ?? [];
  if (questions.length && input.kind !== "decision") throw new Error("questions are only for kind \"decision\".");
  for (const id of questions) if (!/^Q\d+$/.test(id)) throw new Error(`questions lists open question ids like "Q18", not ${JSON.stringify(id)}.`);
  if (decisions.length + new Set(questions).size > 3) throw new Error("Give at most 3 decisions and questions together; anything bigger belongs in the chat.");
  for (const [i, d] of decisions.entries()) {
    if (!d.question?.trim() || d.question.length > 200) throw new Error(`decisions[${i}].question needs 1–200 characters.`);
    const options = d.options ?? [];
    if (options.length && (options.length < 2 || options.length > 5)) throw new Error(`decisions[${i}] needs 2–5 options, or none for a free answer.`);
    for (const [j, o] of options.entries()) {
      if (!o.label?.trim() || o.label.length > 60) throw new Error(`decisions[${i}].options[${j}].label needs 1–60 characters.`);
      if ((o.consequence?.length ?? 0) > 160) throw new Error(`decisions[${i}].options[${j}].consequence is over 160 characters.`);
    }
    if (options.length && d.recommend === undefined) throw new Error(`Recommend one option in decisions[${i}] with recommend=<index>.`);
    if (options.length && (!Number.isInteger(d.recommend) || d.recommend! < 0 || d.recommend! >= options.length)) throw new Error(`decisions[${i}].recommend must be an index from 0 to ${options.length - 1}.`);
    if (!options.length && d.recommend !== undefined) throw new Error(`decisions[${i}] has no options to recommend.`);
  }
  if ((input.context?.length ?? 0) > 400) throw new Error("Keep context to 400 characters: only what's needed to decide or act.");
  const links = input.links ?? [];
  if (links.length > 4) throw new Error("Give at most 4 links.");
  const checked = links.map((l, i) => {
    if (!l.label?.trim()) throw new Error(`links[${i}].label is required.`);
    const given = [l.url, l.path, l.pr].filter(v => v !== undefined).length;
    if (given !== 1) throw new Error(`links[${i}] needs exactly one of url, path or pr.`);
    if (l.url !== undefined && !/^https?:\/\//i.test(l.url)) throw new Error(`links[${i}].url must be an http(s) link.`);
    return l.pr !== undefined ? { ...l, pr: resolvePr(l.pr) } : l;
  });
  return { ask, kind: input.kind, ...(decisions.length ? { decisions } : {}), ...(questions.length ? { questions: [...new Set(questions)] } : {}), ...(input.context?.trim() ? { context: input.context.trim() } : {}), ...(checked.length ? { links: checked } : {}) };
}

// ---------- sources and precedence (§5) ----------

export type PrState = { key: string; number: number; url: string | null; title: string; facts: BriefFact[]; mergeable: boolean;
  /** Set when Follow-up just saw CI go red or review threads arrive (an S5 headline). */
  event: string | null };
export type BriefSources = {
  permission?: { title: string; subagent: { id: string; title: string | null } | null } | null;
  /** Only Session Guard's `attention` phase: a self-resuming pause isn't a flag. */
  paused?: { note: string | null; resetsAt: string | null } | null;
  error?: { message: string } | null;
  agent?: NeedsYouCall | null;
  /** The agent's newest open PR: a review brief that links no PR is about it, and S5 events are about it. */
  pr?: PrState | null;
  /** Every readable open PR in the agent's workspace, so a brief that links one shows that PR's own state. */
  prs?: PrState[] | null;
  /** A PR with nobody asked to review it. `names` are the developer's saved reviewers for `repo` (may be empty). */
  reviewers?: { prKey: string; repo?: string; number: number; url: string | null; names: string[] } | null;
  /** S6 extraction is out of scope (Phase 2); kept so the precedence reads like the design. */
  extracted?: null;
};
export type BriefContent = Pick<Brief, "source" | "kind" | "ask" | "slim" | "decisions" | "context" | "mono" | "facts" | "factsPr" | "links" | "moves" | "also" | "sourceLine">;

const line = (text: string, max = 140) => { const t = text.replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
const letter = (i: number) => String.fromCharCode(65 + i);
const move = (kind: BriefMove["kind"], label: string, extra: Partial<BriefMove> = {}): BriefMove => ({ kind, label, prKey: null, url: null, agentId: null, ...extra });
export const FALLBACK_ASK = "No ask stated. Its last paragraph is right above; nothing is guessed.";
const AGENT_LINE = "Stated by the agent.";

function fromAgent(call: NeedsYouCall): Pick<BriefContent, "kind" | "ask" | "decisions" | "context" | "links"> {
  return {
    kind: call.kind, ask: line(call.ask), context: call.context ?? null,
    decisions: (call.decisions ?? []).map((d, i) => ({ id: `D${i + 1}`, question: d.question, options: (d.options ?? []).map((o, j) => ({ letter: letter(j), label: o.label, consequence: o.consequence ?? null })), recommend: d.recommend !== undefined && d.options?.length ? letter(d.recommend) : null, chosen: null, words: null })),
    links: (call.links ?? []).map(l => ({ label: l.label, url: l.url ?? null, path: l.path ?? null, pr: l.pr ?? null })),
  };
}

/**
 * The PR a brief is about, or null. A brief that links PRs is about the first one Follow-up can read (never the lead PR
 * instead); a review that links none is about the agent's own PR. Anything else is about no PR: an Action to rotate a
 * key shows no CI state just because a PR is in flight (`brief-pr-facts-referenced`).
 */
function subjectPr(s: BriefSources, kind: BriefContent["kind"], links: { pr: string | null }[]): PrState | null {
  const linked = links.flatMap(l => l.pr ? [l.pr] : []);
  if (linked.length) {
    const known = [...(s.prs ?? []), ...(s.pr ? [s.pr] : [])];
    for (const key of linked) { const p = known.find(p => p.key === key); if (p) return p; }
    return null;
  }
  return kind === "review" ? s.pr ?? null : null;
}

/**
 * §5.2: blocking states win the headline (permission > paused > error) and keep the agent's statement below a divider;
 * otherwise the agent's needs_you, with the facts of the PR it references (subjectPr); a PR event headlines on its own
 * when nothing else exists; otherwise the honest fallback. Never invents an ask.
 */
export function pickBrief(s: BriefSources): BriefContent {
  const base = { decisions: [], context: null, mono: null, facts: [], factsPr: null, links: [], moves: [], also: null } satisfies Partial<BriefContent>;
  const also = s.agent ? { ask: line(s.agent.ask), context: s.agent.context ?? null } : null;
  if (s.permission) {
    const sub = s.permission.subagent;
    return { ...base, also, source: "permission", kind: "permission", slim: true,
      ask: line(sub ? `${sub.title ? `Subagent ${sub.title}` : "A subagent"} asks: ${s.permission.title}` : `Accept or deny: ${s.permission.title}`),
      sourceLine: sub ? "From the subagent's permission request. Answer it in the subagent's view." : "From the permission request. Answer it in Paseo's prompt just below.",
      moves: sub ? [move("open_subagent", "Open subagent", { agentId: sub.id })] : [] };
  }
  if (s.paused) {
    return { ...base, also, source: "paused", kind: "paused", slim: false, ask: "Hit the usage limit. Pick an account to continue on.",
      context: s.paused.note ? line(s.paused.note, 400) : null, facts: s.paused.resetsAt ? [{ icon: "Gauge", label: `At its limit until ${s.paused.resetsAt}`, tone: "warn" }] : [],
      sourceLine: "From Session Guard. Its automatic switch found no account it was allowed to use." };
  }
  if (s.error) {
    const message = s.error.message.trim() || "Turn failed";
    // No PR facts: a failed turn is about the turn. CI state beside an API error reads as its cause, even when the
    // agent has one PR in flight; the agent's own statement (`also`) still names what it was doing.
    return { ...base, also, source: "error", kind: "error", slim: false, ask: line(`The turn failed: ${message}`), mono: line(message, 400),
      moves: [move("retry", "Retry the turn"), move("copy_error", "Copy error")], sourceLine: "From the failed turn." };
  }
  if (s.agent) {
    const a = fromAgent(s.agent);
    // F7: "Nothing needed" doesn't flag, so it has nothing to sign off, and shows no PR state.
    const pr = a.kind === "done" ? null : subjectPr(s, a.kind, a.links);
    const facts = (pr?.facts ?? []).slice(0, 3);
    const moves: BriefMove[] = a.kind === "done" ? []
      : a.kind === "review" && pr ? [...(pr.mergeable ? [move("merge", `Squash & merge #${pr.number}`, { prKey: pr.key })] : []), ...(pr.url ? [move("open_pr", "Open PR", { url: pr.url, prKey: pr.key })] : [])]
      // An Action is something the developer does elsewhere; Done tells the agent in one tap ("Done: <ask>").
      : a.kind === "action" ? [move("done", "Done")]
      : [];
    return { ...base, ...a, source: "agent", slim: false, facts, factsPr: facts.length ? pr!.key : null, moves,
      sourceLine: facts.length ? "Stated by the agent. PR, CI and review state from Follow-up." : AGENT_LINE };
  }
  if (s.reviewers) {
    const r = s.reviewers;
    const named = r.names.length ? r.names.join(" and ") : null;
    return { ...base, source: "followup", kind: "reviewers", slim: false,
      ask: line(named ? `Add reviewers to #${r.number}: ${named}` : `#${r.number} has no reviewers yet`),
      ...(() => { const facts = (s.pr?.key === r.prKey ? s.pr.facts : []).slice(0, 3); return { facts, factsPr: facts.length ? r.prKey : null }; })(),
      // With nobody set, Add reviewers opens the picker; it never asks anyone without a click.
      moves: [move("add_reviewers", "Add reviewers", { prKey: r.prKey }), ...(r.url ? [move("open_pr", "Open PR", { url: r.url, prKey: r.prKey })] : [])],
      sourceLine: named ? "From Follow-up's PR state. Open review threads go to the agent; reviewers are yours." : `No reviewers set for ${r.repo ?? "this repository"}; Add reviewers lets you pick.` };
  }
  if (s.pr?.event) {
    const pr = s.pr;
    const facts = pr.facts.slice(0, 3);
    return { ...base, source: "followup", kind: "review", slim: false, ask: line(pr.event!), facts, factsPr: facts.length ? pr.key : null,
      moves: pr.url ? [move("open_pr", "Open PR", { url: pr.url, prKey: pr.key })] : [], sourceLine: "From Follow-up's PR state." };
  }
  return { ...base, source: "none", kind: "unknown", slim: true, ask: FALLBACK_ASK, sourceLine: "No brief stated by the agent; nothing is guessed." };
}

/** How each flagged brief's content was sourced, for the adoption share (R2). */
export type BriefOrigin = "tool" | "structured" | "extraction" | "fallback";
export function briefOrigin(source: BriefSource): BriefOrigin {
  if (source === "agent") return "tool";
  if (source === "extracted") return "extraction";
  if (source === "none") return "fallback";
  return "structured";
}

/** The inbox row's reason line for an open brief: "Decision · Pick how…". The fallback reads "No ask stated". */
export function briefLine(b: Pick<Brief, "source" | "ask" | "state">): string | null {
  if (b.state !== "open") return null;
  return b.source === "none" ? "No ask stated" : b.ask;
}

/**
 * R1: on a phone, or a window too short for the whole card, the card must still show the header, the ask, the options
 * and its move above the composer. Consequences then sit behind a tap on each option, and context and facts behind Details.
 * The estimate is deliberately simple (rows × typical heights) so the layout doesn't jump while it renders.
 */
export function isTight(b: Pick<Brief, "decisions" | "context" | "facts" | "mono" | "moves">, compact: boolean, windowHeight: number): boolean {
  if (compact) return true;
  const options = b.decisions.reduce((n, d) => n + d.options.length, 0);
  const estimate = 150 + b.decisions.length * 52 + options * 66 + (b.context ? 60 : 0) + (b.facts.length ? 36 : 0) + (b.mono ? 44 : 0) + (b.moves.length ? 44 : 0);
  // About 340 px of the window belong to the header, the composer and its controls.
  return estimate > windowHeight - 340;
}

/**
 * R1, second step: with consequences already behind a tap, context and facts still show inline when the card fits.
 * "Details" only appears when they would push the options or the move under the composer.
 */
export function extrasFit(b: Pick<Brief, "decisions" | "context" | "facts" | "mono" | "moves">, windowHeight: number): boolean {
  const options = b.decisions.reduce((n, d) => n + d.options.length, 0);
  const contextLines = b.context ? Math.min(4, Math.ceil(b.context.length / 45)) : 0;
  const estimate = 150 + b.decisions.length * 52 + options * 50 + contextLines * 19 + (b.facts.length ? 36 : 0) + (b.mono ? 64 : 0) + (b.moves.length ? 56 : 0);
  return estimate <= windowHeight - 340;
}

/** One muted line for a collapsed brief: what was asked and what happened to it. */
/** Why a card stopped being open without the developer answering it: Follow-up's words, shown as the card's line. */
export const RESOLVED = {
  replaced: "Replaced by a newer card",
  movedOn: "No longer needed · the agent moved on",
  withdrawn: "The agent withdrew this question",
  factEnded: "No longer needed · the PR moved on",
} as const;
const OWN_OUTCOMES: readonly string[] = Object.values(RESOLVED);

/**
 * The agent's ask as a resolved card's line. An agent sometimes writes the card's status into its ask ("Still open:
 * Q35, which plugin…"); once the card is resolved that contradicts it, so the status framing goes.
 */
export function pastAsk(ask: string): string {
  // Only a status word followed by punctuation or a question id: "Open the PR when CI is green" is an ask, not a status.
  const t = ask.replace(/^\s*(still open|open|pending|waiting on|needs you|blocked)(\s*[:,·-]\s*|\s+(?=Q\d+\b))(Q\d+\s*[:,·-]?\s*)?/i, "").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : ask;
}

export function collapsedLine(b: Pick<Brief, "state" | "source" | "outcome" | "ask">): string {
  if (b.state === "superseded" && b.outcome && OWN_OUTCOMES.includes(b.outcome)) return b.outcome;
  if (b.state === "superseded") return b.source === "none" ? "No ask was stated · the agent kept going" : `Earlier ask, the agent kept going: ${pastAsk(b.ask)}`;
  return `${b.outcome} · ${pastAsk(b.ask)}`;
}

// ---------- PR facts (S5) ----------

/** Facts for the agent's newest open PR in a tracked workspace. No PR, no facts. */
export function prState(w: Pick<Workspace, "prs" | "mainAgentId"> | null | undefined, agentId: string, event: string | null = null): PrState | null {
  if (!w) return null;
  const owned = w.prs.filter(p => (p.registeredAgentId ?? w.mainAgentId) === agentId && p.snapshot?.complete && !p.error);
  const pr: Pr | undefined = owned.filter(p => p.snapshot!.state === "OPEN").at(-1);
  return pr ? prFactsOf(pr, event) : null;
}

/** Every readable open PR in the workspace with its own facts, for briefs that link one (`BriefSources.prs`). */
export function prStates(w: Pick<Workspace, "prs"> | null | undefined): PrState[] {
  return (w?.prs ?? []).filter(p => p.snapshot?.complete && !p.error && p.snapshot.state === "OPEN").map(p => prFactsOf(p, null));
}

function prFactsOf(pr: Pr, event: string | null): PrState {
  const s = pr.snapshot!;
  const facts: BriefFact[] = [];
  if (s.failedChecks.length) facts.push({ icon: "CircleX", label: `Checks failed · ${s.failedChecks.slice(0, 2).join(", ")}`, tone: "bad" });
  else if (s.checksPending) facts.push({ icon: "Clock", label: "Checks running", tone: "muted" });
  else facts.push({ icon: "CircleCheck", label: "Required checks pass", tone: "ok" });
  const approved = s.reviewDecision === "APPROVED";
  facts.push(s.conflict ? { icon: "TriangleAlert", label: "Conflicts with its base", tone: "warn" }
    : s.threads.length ? { icon: "MessageSquare", label: `${s.threads.length} open thread${s.threads.length === 1 ? "" : "s"}`, tone: "warn" }
    : { icon: approved ? "UserCheck" : "User", label: approved ? "Approved · no conflicts" : "Review required", tone: approved ? "ok" : "muted" });
  if (s.draft) facts.push({ icon: "FilePen", label: "Draft", tone: "muted" });
  const mergeable = !s.draft && !s.conflict && !s.failedChecks.length && !s.checksPending && approved && !s.threads.length;
  return { key: pr.key, number: pr.number, url: s.url || null, title: s.title, facts, mergeable, event };
}

// ---------- lifecycle (§6) ----------

export type BriefEvent =
  | { type: "create"; id: string; turnId: string | null; content: BriefContent; flagged: boolean; seq: number; questionIds?: string[]; workspaceId?: string | null }
  | { type: "turn_start" }
  | { type: "message"; text: string | null }
  | { type: "option"; decisionId: string; choice: string; words?: string }
  /** Several decisions answered together (1.4.0): every pick at once; the rest were skipped on purpose. */
  | { type: "options"; picks: { decisionId: string; choice: string; words?: string }[] }
  | { type: "sign_off" }
  /** The developer did an Action brief's ask and said so with Done; the server already sent "Done: <ask>". */
  | { type: "done" }
  | { type: "undo" }
  | { type: "permission_resolved" }
  /** A PR's new state: lands only on the open brief whose facts are about that PR. */
  | { type: "facts"; prKey: string; facts: BriefFact[] }
  /** Every question the brief points at is settled, by any path (briefQuestionsEvent): an answer, or null if withdrawn. */
  | { type: "questions"; answers: Record<string, { choice: string; words: string | null } | null> }
  /** The PR facts a Follow-up card reported no longer hold (shared/inbox.ts FACT_REASONS): its card of these kinds closes. */
  | { type: "fact_ended"; kinds: BriefKind[] };

/** A bare letter, or an option's label, as the developer's message counts as picking it (§2 Keyboard). */
export function matchOption(b: Pick<Brief, "decisions">, text: string | null): { decision: BriefDecision; letter: string } | null {
  const t = (text ?? "").trim().replace(/[.!]$/, "");
  if (!t) return null;
  for (const d of b.decisions) {
    if (d.chosen) continue;
    const o = d.options.find(o => o.letter === t.toUpperCase() && t.length === 1 || o.label.toLowerCase() === t.toLowerCase());
    if (o) return { decision: d, letter: o.letter };
  }
  return null;
}

/**
 * One lifecycle step. Returns the brief to store and every version to (re-)append, oldest first.
 * A new brief supersedes an open one; the same id re-appended replaces the row in place.
 */
export function briefStep(prev: Brief | null, event: BriefEvent, now: string): { brief: Brief | null; appends: Brief[] } {
  const keep = { brief: prev, appends: [] as Brief[] };
  const collapse = (b: Brief, state: Brief["state"], outcome: string): Brief => ({ ...b, state, outcome, outcomeAt: now });
  switch (event.type) {
    case "create": {
      const appends: Brief[] = [];
      if (prev?.state === "open" && prev.id !== event.id) appends.push(collapse(prev, "superseded", "The agent kept going"));
      const brief: Brief = briefSchema.parse({ ...event.content, id: event.id, turnId: event.turnId, state: "open", at: now, seq: event.seq, flagged: event.flagged,
        questionIds: event.questionIds ?? [], workspaceId: event.workspaceId ?? null,
        decisions: event.content.decisions.map((d, i) => event.questionIds?.[i] ? { ...d, id: event.questionIds[i] } : d) });
      appends.push(brief);
      return { brief, appends };
    }
    // A turn the developer didn't start (another agent, Follow-up, a continuation, a schedule) leaves the card open:
    // only the developer answers it, and only a newer brief from the same agent supersedes it.
    case "turn_start":
      // A card that only reported the last turn's failure or pause is history once a new turn starts: the agent is
      // running again (RUN_STATE_REASONS in shared/inbox.ts). A card with open questions stays, as above.
      if (prev?.state === "open" && (prev.kind === "error" || prev.kind === "paused") && !prev.questionIds.length) {
        const b = collapse(prev, "superseded", "The agent started a new turn");
        return { brief: b, appends: [b] };
      }
      return keep;
    case "message": {
      if (prev?.state !== "open") return keep;
      const picked = matchOption(prev, event.text);
      const b = picked
        ? { ...collapse(prev, "answered", `You picked ${picked.letter} · ${picked.decision.options.find(o => o.letter === picked.letter)!.label}`), decisions: prev.decisions.map(d => d.id === picked.decision.id ? { ...d, chosen: picked.letter } : d) }
        : collapse(prev, "answered", "You replied");
      return { brief: b, appends: [b] };
    }
    case "option": {
      if (prev?.state !== "open") return keep;
      const d = prev.decisions.find(d => d.id === event.decisionId);
      if (!d || !validPick(d, event.choice, event.words)) return keep;
      const decisions = prev.decisions.map(x => x.id === d.id ? { ...x, chosen: event.choice, words: event.words?.trim() || null } : x);
      const b = { ...collapse(prev, "answered", answeredOutcome(decisions)), decisions };
      return { brief: b, appends: [b] };
    }
    case "options": {
      if (prev?.state !== "open") return keep;
      const chosen = new Map(event.picks.map(p => [p.decisionId, p]));
      const decisions = prev.decisions.map(d => { const p = chosen.get(d.id); return p && validPick(d, p.choice, p.words) ? { ...d, chosen: p.choice, words: p.words?.trim() || null } : d; });
      if (!decisions.some(d => d.chosen)) return keep;
      const b = { ...collapse(prev, "answered", answeredOutcome(decisions)), decisions };
      return { brief: b, appends: [b] };
    }
    case "done":
      if (prev?.state !== "open" || prev.kind !== "action") return keep;
      { const b = collapse(prev, "answered", "Done"); return { brief: b, appends: [b] }; }
    case "sign_off":
      if (prev?.state !== "open") return keep;
      { const b = collapse(prev, "signed", "Signed off"); return { brief: b, appends: [b] }; }
    case "undo":
      if (prev?.state !== "signed") return keep;
      { const b: Brief = { ...prev, state: "open", outcome: null, outcomeAt: null }; return { brief: b, appends: [b] }; }
    case "permission_resolved":
      if (prev?.state !== "open" || prev.source !== "permission") return keep;
      { const b = collapse(prev, "superseded", "Permission answered"); return { brief: b, appends: [b] }; }
    case "questions": {
      if (prev?.state !== "open" || !prev.questionIds.length || !prev.questionIds.every(id => id in event.answers)) return keep;
      const decisions = prev.decisions.map(d => { const a = event.answers[d.id]; return a && !d.chosen ? { ...d, chosen: a.choice, words: a.words?.trim() || null } : d; });
      const answered = prev.questionIds.some(id => event.answers[id]);
      const b = answered ? { ...collapse(prev, "answered", answeredOutcome(decisions)), decisions } : collapse(prev, "superseded", RESOLVED.withdrawn);
      return { brief: b, appends: [b] };
    }
    case "fact_ended":
      // Only Follow-up's own PR card: an agent's ask, or a card with questions, waits for the developer.
      if (prev?.state !== "open" || prev.source !== "followup" || prev.questionIds.length || !event.kinds.includes(prev.kind)) return keep;
      { const b = collapse(prev, "superseded", RESOLVED.factEnded); return { brief: b, appends: [b] }; }
    case "facts":
      if (prev?.state !== "open" || prev.factsPr !== event.prKey || JSON.stringify(prev.facts) === JSON.stringify(event.facts.slice(0, 3))) return keep;
      { const b = { ...prev, facts: event.facts.slice(0, 3) }; return { brief: b, appends: [b] }; }
  }
}

/** A pick on a decision: one of its letters, or Something else with words. The server and the lifecycle share it. */
export const validPick = (d: Pick<BriefDecision, "options">, choice: string, words?: string | null) => isOther(choice) ? d.options.length > 0 && !!words?.trim() : d.options.some(o => o.letter === choice);
/** What a decision's pick reads as: "B · label", or `Something else · "words"`. */
export const pickLabel = (d: Pick<BriefDecision, "options" | "chosen" | "words">) => d.chosen ? answerLabel(d, d.chosen, d.words) : null;

/** Decisions that have options to pick: the ones a multi-decision card sends together. */
export const askedDecisions = (b: Pick<Brief, "decisions">): BriefDecision[] => b.decisions.filter(d => d.options.length > 0);
/** Whether tapping an option only selects it (several decisions, sent together) instead of sending it (one decision). */
export const selectsFirst = (b: Pick<Brief, "decisions">) => askedDecisions(b).length > 1;
/** The send bar for a multi-decision card: all picked, some picked (names what's skipped), or nothing yet. */
export function sendBar(b: Pick<Brief, "decisions">, picks: Record<string, string>): { label: string; skipped: string | null; ready: boolean; partial: boolean } {
  const asked = askedDecisions(b);
  const numbered = asked.map((d, i) => ({ d, n: i + 1 }));
  const done = numbered.filter(x => picks[x.d.id]);
  const left = numbered.filter(x => !picks[x.d.id]);
  if (!done.length) return { label: "Send answers", skipped: null, ready: false, partial: false };
  if (!left.length) return { label: "Send answers", skipped: null, ready: true, partial: false };
  const names = left.map(x => String(x.n));
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  return { label: `Send ${done.length} of ${asked.length}`, skipped: `${left.length === 1 ? "Question" : "Questions"} ${list} ${left.length === 1 ? "stays" : "stay"} open; the agent is told so.`, ready: true, partial: true };
}

/** How many asked decisions have a pick, for the card's "1 of 3 picked". */
export const pickedCount = (b: Pick<Brief, "decisions">, picks: Record<string, string>) => askedDecisions(b).filter(d => picks[d.id]).length;
/** The answered card's summary (1.4.0): each asked decision's question (numbered when there are several) and the pick. */
/**
 * A past card's check: green once its outcome has landed on the daemon. A Done still waiting on its toast's Undo
 * window (or its send) is muted: nothing has happened yet, and green would claim it had.
 */
export function pastTone(state: Brief["state"], pending: boolean): "success" | "muted" {
  return state === "superseded" || pending ? "muted" : "success";
}

export function pastRows(b: Pick<Brief, "decisions" | "ask">): { id: string; question: string | null; answer: string | null }[] {
  const asked = askedDecisions(b); const numbered = asked.length > 1;
  return asked.map((d, i) => ({ id: d.id, question: numbered || d.question.trim() !== b.ask.trim() ? `${numbered ? `${i + 1}. ` : ""}${d.question}` : null, answer: pickLabel(d) }));
}
/** Whether a past card has more than its one line to show behind "Show full question" / "Show original". */
export const hasOriginal = (b: Pick<Brief, "decisions" | "context" | "mono" | "facts" | "links">) => b.decisions.length > 0 || !!b.context || !!b.mono || b.facts.length > 0 || b.links.length > 0;

/** "You picked 1. A · 2. B · 3. skipped" for a multi-decision answer; one decision reads as before. */
export function answeredOutcome(decisions: BriefDecision[]): string {
  const asked = decisions.filter(d => d.options.length);
  if (asked.length <= 1) { const d = asked.find(d => d.chosen); if (!d) return "You replied"; return isOther(d.chosen) ? `You answered ${pickLabel(d)}` : `You picked ${pickLabel(d)}`; }
  return `You picked ${asked.map((d, i) => `${i + 1}. ${isOther(d.chosen) ? OTHER_LABEL : d.chosen ?? "skipped"}`).join(" · ")}`;
}

/** F7: the one muted timeline line for a "Nothing needed" turn: "Nothing needed · <what was finished>". */
export function nothingNeededLine(ask: string): string {
  const rest = ask.replace(/^\s*nothing(?: is)? needed(?: from you)?\s*[.:·—–-]?\s*/i, "").trim();
  return rest ? `Nothing needed · ${rest}` : "Nothing needed";
}

// ---------- one source of truth: the card follows its questions (1.4.0-beta.25) ----------

/** Outcomes only the developer produces: a reply, an option pick, sign-off. Anything else never closes a card. */
export const developerClosed = (b: Pick<Brief, "state" | "outcome">) => b.state === "signed" || b.state === "answered" && /^You (replied|picked)\b/.test(b.outcome ?? "");
/**
 * Whether an agent's current brief (the newest) must be shown open: it links questions that are still open on the
 * server, and nothing the developer did closed it. Before 1.4.0-beta.25 a turn started by another agent (or Follow-up,
 * a continuation, a schedule) superseded it, or answered it with the developer's previous message.
 * `trustReplies: false` (the one-time repair) also reopens "You replied" cards, since those can't be told apart.
 */
export function shouldReopen(b: Pick<Brief, "state" | "outcome" | "questionIds">, openQuestionIds: ReadonlySet<string>, trustReplies = true): boolean {
  if (b.state === "open" || !b.questionIds.some(id => openQuestionIds.has(id))) return false;
  if (b.state === "superseded") return true;
  return !trustReplies && b.state === "answered" && b.outcome === "You replied";
}

/** An answer's id, made once per Send (no crypto needed: phones run Hermes). */
export const newAnswerId = (): string => `a${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12).padEnd(10, "0")}`;
/** The delivery failure as one sentence, or a plain fallback. */
export const undeliveredReason = (error: string | null | undefined): string => { const e = (error ?? "").trim() || "Paseo didn't confirm it"; return /[.!?]$/.test(e) ? e : `${e}.`; };

/**
 * What a brief card shows, from the server's live brief rather than the timeline row it was rendered from. The row is a
 * snapshot that the server re-appends when the brief changes, but that write is best-effort, so the row's own `state`
 * is never trusted on its own. A card is actionable only when the live brief is this exact brief and open.
 *  - `live` undefined: not loaded yet. The card shows its row but isn't actionable.
 *  - the live brief is another one (or none): this card is history. If its questions were answered, it says so
 *    ("You picked B · …"); otherwise "Replaced by a newer update".
 *  - every question it points at is answered: answered, even if the stored brief hasn't caught up.
 * Decisions backed by a stored question show that question's live, full text and its recorded answer.
 */
export function shownBrief(row: Brief, live: { brief: Brief | null } | undefined, questions: readonly Question[] = []): { brief: Brief; actionable: boolean } {
  const mine = live?.brief?.id === row.id ? live.brief! : row;
  const byId = new Map(questions.map(q => [q.id, q]));
  const decisions = mine.decisions.map(d => {
    const q = byId.get(d.id);
    if (!q) return d;
    const options = q.options.length ? q.options.map(o => ({ letter: o.letter, label: o.label, consequence: o.consequence ?? null })) : d.options;
    const chosen = d.chosen ?? q.answer?.choice ?? null;
    return { ...d, question: q.question, options, chosen, words: d.words ?? (chosen ? q.answer?.words ?? null : null) };
  });
  let brief: Brief = { ...mine, decisions };
  if (brief.state === "open") {
    const linked = brief.questionIds.filter(id => byId.has(id));
    const allAnswered = linked.length > 0 && linked.length === brief.questionIds.length && linked.every(id => byId.get(id)!.answer);
    const elsewhere = !!live && live.brief?.id !== row.id;
    if (allAnswered) brief = { ...brief, state: "answered", outcome: answeredOutcome(decisions), outcomeAt: brief.outcomeAt ?? null };
    else if (elsewhere) brief = { ...brief, state: "superseded", outcome: live!.brief ? RESOLVED.replaced : RESOLVED.movedOn, outcomeAt: brief.outcomeAt ?? null };
  }
  return { brief, actionable: !!live && live.brief?.id === row.id && brief.state === "open" };
}

/**
 * The server-side rule: when every question an open brief points at is answered or withdrawn, by any path (the question
 * card, the brief card, follow_record_answer, follow_answer_question, follow_withdraw_question), the brief resolves and
 * keeps the recorded answers. Null while any is still open or unknown. Run on every state write (store.onChanged).
 */
export function briefQuestionsEvent(b: Brief, questions: readonly Question[]): Extract<BriefEvent, { type: "questions" }> | null {
  if (b.state !== "open" || !b.questionIds.length) return null;
  const answers: Record<string, { choice: string; words: string | null } | null> = {};
  for (const id of b.questionIds) {
    const q = questions.find(q => q.id === id);
    if (!q) return null;
    if (q.answer) answers[id] = { choice: q.answer.choice, words: q.answer.words ?? null };
    else if (q.closed) answers[id] = null;
    else return null;
  }
  return { type: "questions", answers };
}

/** The developer's option click, in the existing answer format so Follow-up's answer card renders it. */
export function briefAnswer(id: string, question: string, letter: string, label: string, words?: string): string {
  const title = answerTitle(question).slice(0, 80);
  if (isOther(letter)) return `${ANSWER_PREFIX} ${id} (${title}): ${OTHER_LABEL} — "${(words ?? "").trim()}"\nNone of your options: the developer's own answer is in the quotes.`;
  const note = words?.trim() ? `\nThe developer added: ${words.trim()}` : "";
  return `${ANSWER_PREFIX} ${id} (${title}): ${letter} — ${label}${note}\nContinue with this choice.`;
}
/**
 * Several decisions answered together (1.4.0): one message, a summary line the developer reads at a glance, then one
 * line per decision the agent can act on. Skipped decisions are named, so the agent knows they're still open.
 */
export function briefAnswers(ask: string, decisions: { id: string; question: string; options: { letter: string; label: string }[] }[], picks: Record<string, string>, words: Record<string, string> = {}): string {
  const clean = (t: string) => answerTitle(t).slice(0, 80);
  const asked = decisions.filter(d => d.options.length);
  // Something else stays on its decision's one line: the developer's words with line breaks folded to spaces.
  const other = (d: typeof asked[number]) => isOther(picks[d.id]) && words[d.id]?.trim() ? `${OTHER_LABEL} — "${words[d.id].replace(/\s+/g, " ").trim()}"` : null;
  const picked = (d: typeof asked[number]) => { const o = d.options.find(o => o.letter === picks[d.id]); return other(d) ?? (o ? `${o.letter} — ${o.label}` : null); };
  const summary = asked.map((d, i) => { const p = picked(d); return `${i + 1}. ${other(d) ? OTHER_LABEL : p ?? "skipped"}`; }).join(" · ");
  const lines = [`${ANSWER_PREFIX} ${asked.map(d => d.id).join(", ")} (${clean(ask)}): ${summary}`];
  for (const d of asked) {
    const p = picked(d);
    lines.push(p ? `${d.id} (${clean(d.question)}): ${p}` : `${d.id} (${clean(d.question)}): skipped — not answered yet; ask again if it still matters.`);
    // A note on a letter pick: its own line under the decision, folded to one line like Something else's words.
    if (p && !isOther(picks[d.id]) && words[d.id]?.trim()) lines.push(`${d.id} note: ${words[d.id].replace(/\s+/g, " ").trim()}`);
  }
  const skipped = asked.filter(d => !picked(d));
  lines.push(skipped.length ? `Continue with the answered ones; ${skipped.map(d => d.id).join(" and ")} ${skipped.length === 1 ? "is" : "are"} still open. The answers are already recorded.` : "Continue with these choices. The answers are already recorded.");
  return lines.join("\n");
}

/**
 * The picks a card sends (a-pick-note-reaches-the-agent): Something else carries its words, a letter carries the
 * developer's note when there is one. The client's Send and the tests share it.
 */
export function cardPicks(picks: Record<string, string>, words: Record<string, string>, notes: Record<string, string>): { decisionId: string; choice: string; words?: string }[] {
  return Object.entries(picks).map(([decisionId, choice]) => {
    const text = (isOther(choice) ? words[decisionId] : notes[decisionId])?.trim();
    return { decisionId, choice, ...(text ? { words: text } : {}) };
  });
}
/** How many of the picks go with a note: "1 with a note" beside a multi-decision card's Send. */
export const notedCount = (picks: Record<string, string>, notes: Record<string, string>) => Object.entries(picks).filter(([id, c]) => !isOther(c) && !!notes[id]?.trim()).length;
/**
 * a-done-brief-is-never-an-ask: whether the agent's open brief is an ask in Needs you (the panel's and Home's block,
 * counted there). The row must be flagged; "No ask stated" (source none) only repeats the chat; and kind "done" says
 * nothing is needed, so a row flagged for something else (a merged PR) shows that reason, never "Nothing needed" as 1.
 */
export function briefAsks<B extends Pick<Brief, "state" | "kind" | "source">>(brief: B | null | undefined, row: { needs?: unknown } | null | undefined): brief is B {
  return !!row?.needs && !!liveBrief(brief) && brief!.source !== "none" && brief!.kind !== "done";
}

/** The PR an add-reviewers brief asks about: its Add reviewers move's PR. Null for every other kind. */
export function reviewersBriefPr(b: { kind: string; moves?: readonly { kind: string; prKey?: string | null }[]; prKey?: string }): string | null {
  if (b.kind !== "reviewers") return null;
  return b.prKey ?? b.moves?.find(m => m.kind === "add_reviewers")?.prKey ?? null;
}
/**
 * An open add-reviewers brief whose PR the agent merges itself (`agentMergesKey`): not an ask, so no surface draws it.
 * Invariant a-no-review-repo-never-asks-for-review-or-merge.
 */
export const reviewersBriefWithdrawn = (b: { kind: string; state: string; moves?: readonly { kind: string; prKey?: string | null }[]; prKey?: string }): boolean => {
  const pr = b.state === "open" ? reviewersBriefPr(b) : null;
  return !!pr && agentMergesKey(pr);
};
/**
 * The agent's brief as the client may draw it: open, and not an add-reviewers ask the agent's own merge withdrew
 * (`reviewersBriefWithdrawn`). The one place that check composes; `briefAsks` builds on it, and every client read of
 * the daemon's brief goes through it (tests/review-mode.test.ts scans).
 */
export function liveBrief<B extends { kind: string; state: string }>(brief: B | null | undefined): B | null {
  return brief?.state === "open" && !reviewersBriefWithdrawn(brief as Parameters<typeof reviewersBriefWithdrawn>[0]) ? brief : null;
}
