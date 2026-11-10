import { z } from "zod";
import type { Pr, Workspace } from "./model";

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
  chosen: z.string().nullable().default(null),
});
export const briefFactSchema = z.object({ icon: z.string(), label: z.string(), tone: z.enum(["ok", "warn", "bad", "muted"]).default("muted") });
export const briefLinkSchema = z.object({ label: z.string(), url: z.string().nullable().default(null), path: z.string().nullable().default(null), pr: z.string().nullable().default(null) });
export const MOVES = ["merge", "open_pr", "sign_off_next", "retry", "copy_error", "open_subagent", "add_reviewers"] as const;
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
  links: z.array(briefLinkSchema).default([]),
  moves: z.array(briefMoveSchema).default([]),
  /** What the agent stated with needs_you when a blocking state took the headline (§5.2 rule 1). */
  also: z.object({ ask: z.string(), context: z.string().nullable().default(null) }).nullable().default(null),
  /** Where the content came from, said on the card so the developer knows how much to trust it. */
  sourceLine: z.string(),
  /** Collapsed states: "You picked A · Per-tenant buckets", "You replied", "Signed off", "The agent kept going". */
  outcome: z.string().nullable().default(null),
  outcomeAt: z.string().nullable().default(null),
  /** For the card's PR moves: the tracked workspace, when there is one. */
  workspaceId: z.string().nullable().default(null),
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
  pr?: PrState | null;
  /** A PR with nobody asked to review it. `names` are the developer's saved reviewers for `repo` (may be empty). */
  reviewers?: { prKey: string; repo?: string; number: number; url: string | null; names: string[] } | null;
  /** S6 extraction is out of scope (Phase 2); kept so the precedence reads like the design. */
  extracted?: null;
};
export type BriefContent = Pick<Brief, "source" | "kind" | "ask" | "slim" | "decisions" | "context" | "mono" | "facts" | "links" | "moves" | "also" | "sourceLine">;

const line = (text: string, max = 140) => { const t = text.replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
const letter = (i: number) => String.fromCharCode(65 + i);
const move = (kind: BriefMove["kind"], label: string, extra: Partial<BriefMove> = {}): BriefMove => ({ kind, label, prKey: null, url: null, agentId: null, ...extra });
export const FALLBACK_ASK = "No ask stated. Its last paragraph is right above; nothing is guessed.";
const AGENT_LINE = "Stated by the agent.";

function fromAgent(call: NeedsYouCall): Pick<BriefContent, "kind" | "ask" | "decisions" | "context" | "links"> {
  return {
    kind: call.kind, ask: line(call.ask), context: call.context ?? null,
    decisions: (call.decisions ?? []).map((d, i) => ({ id: `D${i + 1}`, question: d.question, options: (d.options ?? []).map((o, j) => ({ letter: letter(j), label: o.label, consequence: o.consequence ?? null })), recommend: d.recommend !== undefined && d.options?.length ? letter(d.recommend) : null, chosen: null })),
    links: (call.links ?? []).map(l => ({ label: l.label, url: l.url ?? null, path: l.path ?? null, pr: l.pr ?? null })),
  };
}

/**
 * §5.2: blocking states win the headline (permission > paused > error) and keep the agent's statement below a divider;
 * otherwise the agent's needs_you; PR facts merge into whichever wins, or headline on their own when nothing else exists;
 * otherwise the honest fallback. Never invents an ask.
 */
export function pickBrief(s: BriefSources): BriefContent {
  const base = { decisions: [], context: null, mono: null, facts: [], links: [], moves: [], also: null } satisfies Partial<BriefContent>;
  const also = s.agent ? { ask: line(s.agent.ask), context: s.agent.context ?? null } : null;
  const prFacts = (s.pr?.facts ?? []).slice(0, 3);
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
    return { ...base, also, source: "error", kind: "error", slim: false, ask: line(`The turn failed: ${message}`), mono: line(message, 400), facts: prFacts,
      moves: [move("retry", "Retry the turn"), move("copy_error", "Copy error")], sourceLine: "From the failed turn." };
  }
  if (s.agent) {
    const a = fromAgent(s.agent);
    const pr = s.pr;
    // F7: "Nothing needed" doesn't flag, so it has nothing to sign off.
    const moves: BriefMove[] = a.kind === "done" ? []
      : a.kind === "review" && pr ? [...(pr.mergeable ? [move("merge", `Squash & merge #${pr.number}`, { prKey: pr.key })] : []), ...(pr.url ? [move("open_pr", "Open PR", { url: pr.url, prKey: pr.key })] : [])]
      : [];
    return { ...base, ...a, source: "agent", slim: false, facts: a.kind === "done" ? [] : prFacts, moves,
      sourceLine: pr && prFacts.length && a.kind !== "done" ? "Stated by the agent. PR, CI and review state from Follow-up." : AGENT_LINE };
  }
  if (s.reviewers) {
    const r = s.reviewers;
    const named = r.names.length ? r.names.join(" and ") : null;
    return { ...base, source: "followup", kind: "reviewers", slim: false,
      ask: line(named ? `Add reviewers to #${r.number}: ${named}` : `#${r.number} has no reviewers yet`),
      facts: (s.pr?.key === r.prKey ? s.pr.facts : []).slice(0, 3),
      // With nobody set, Add reviewers opens the picker; it never asks anyone without a click.
      moves: [move("add_reviewers", "Add reviewers", { prKey: r.prKey }), ...(r.url ? [move("open_pr", "Open PR", { url: r.url, prKey: r.prKey })] : [])],
      sourceLine: named ? "From Follow-up's PR state. Open review threads go to the agent; reviewers are yours." : `No reviewers set for ${r.repo ?? "this repository"}; Add reviewers lets you pick.` };
  }
  if (s.pr?.event) {
    const pr = s.pr;
    return { ...base, source: "followup", kind: "review", slim: false, ask: line(pr.event!), facts: prFacts,
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
export function collapsedLine(b: Pick<Brief, "state" | "source" | "outcome" | "ask">): string {
  if (b.state === "superseded") return b.source === "none" ? "No ask was stated · the agent kept going" : `Earlier ask, the agent kept going: ${b.ask}`;
  return `${b.outcome} · ${b.ask}`;
}

// ---------- PR facts (S5) ----------

/** Facts for the agent's newest open PR in a tracked workspace. No PR, no facts. */
export function prState(w: Pick<Workspace, "prs" | "mainAgentId"> | null | undefined, agentId: string, event: string | null = null): PrState | null {
  if (!w) return null;
  const owned = w.prs.filter(p => (p.registeredAgentId ?? w.mainAgentId) === agentId && p.snapshot?.complete && !p.error);
  const pr: Pr | undefined = owned.filter(p => p.snapshot!.state === "OPEN").at(-1);
  if (!pr) return null;
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
  | { type: "option"; decisionId: string; choice: string }
  /** Several decisions answered together (1.4.0): every pick at once; the rest were skipped on purpose. */
  | { type: "options"; picks: { decisionId: string; choice: string }[] }
  | { type: "sign_off" }
  | { type: "undo" }
  | { type: "permission_resolved" }
  | { type: "facts"; facts: BriefFact[] };

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
      const o = d?.options.find(o => o.letter === event.choice);
      if (!d || !o) return keep;
      const b = { ...collapse(prev, "answered", `You picked ${o.letter} · ${o.label}`), decisions: prev.decisions.map(x => x.id === d.id ? { ...x, chosen: o.letter } : x) };
      return { brief: b, appends: [b] };
    }
    case "options": {
      if (prev?.state !== "open") return keep;
      const chosen = new Map(event.picks.map(p => [p.decisionId, p.choice]));
      const decisions = prev.decisions.map(d => { const c = chosen.get(d.id); return c && d.options.some(o => o.letter === c) ? { ...d, chosen: c } : d; });
      if (!decisions.some(d => d.chosen)) return keep;
      const b = { ...collapse(prev, "answered", answeredOutcome(decisions)), decisions };
      return { brief: b, appends: [b] };
    }
    case "sign_off":
      if (prev?.state !== "open") return keep;
      { const b = collapse(prev, "signed", "Signed off"); return { brief: b, appends: [b] }; }
    case "undo":
      if (prev?.state !== "signed") return keep;
      { const b: Brief = { ...prev, state: "open", outcome: null, outcomeAt: null }; return { brief: b, appends: [b] }; }
    case "permission_resolved":
      if (prev?.state !== "open" || prev.source !== "permission") return keep;
      { const b = collapse(prev, "superseded", "Permission answered"); return { brief: b, appends: [b] }; }
    case "facts":
      if (prev?.state !== "open" || JSON.stringify(prev.facts) === JSON.stringify(event.facts.slice(0, 3))) return keep;
      { const b = { ...prev, facts: event.facts.slice(0, 3) }; return { brief: b, appends: [b] }; }
  }
}

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
export function pastRows(b: Pick<Brief, "decisions" | "ask">): { id: string; question: string | null; answer: string | null }[] {
  const asked = askedDecisions(b); const numbered = asked.length > 1;
  return asked.map((d, i) => { const o = d.options.find(o => o.letter === d.chosen); return { id: d.id, question: numbered || d.question.trim() !== b.ask.trim() ? `${numbered ? `${i + 1}. ` : ""}${d.question}` : null, answer: o ? `${o.letter} · ${o.label}` : null }; });
}
/** Whether a past card has more than its one line to show behind "Show full question" / "Show original". */
export const hasOriginal = (b: Pick<Brief, "decisions" | "context" | "mono" | "facts" | "links">) => b.decisions.length > 0 || !!b.context || !!b.mono || b.facts.length > 0 || b.links.length > 0;

/** "You picked 1. A · 2. B · 3. skipped" for a multi-decision answer; one decision reads as before. */
export function answeredOutcome(decisions: BriefDecision[]): string {
  const asked = decisions.filter(d => d.options.length);
  if (asked.length <= 1) { const d = asked.find(d => d.chosen); const o = d?.options.find(o => o.letter === d.chosen); return o ? `You picked ${o.letter} · ${o.label}` : "You replied"; }
  return `You picked ${asked.map((d, i) => `${i + 1}. ${d.chosen ?? "skipped"}`).join(" · ")}`;
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
