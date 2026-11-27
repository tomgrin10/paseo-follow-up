/**
 * The turn-end checks, decided once for every provider (one-turn-end-decision): the sync reminder after a turn that
 * changed something, the needs_you nudge, and the due tasks. Two triggers run this one function: Claude Code's and
 * Codex's Stop hook (server/agent-hook.mjs, in the turn, free), and Paseo's turn-end event for every other provider
 * (server/turn-end.ts, one queued message). They differ only in what each can see, passed in as facts.
 *
 * Plain JS that imports only ./agent-text.mjs, so scripts/build.mjs can inline it into the hook (types:
 * turn-checks.d.mts). Internal helpers carry a `tc` prefix so the inlined copy can't collide with the file it lands in.
 */
import { dueHeader, named, nudgeReason, stopReason, syncBookkeeping, turnEndPrefix } from "./agent-text.mjs";

const tcRecord = v => typeof v === "object" && v !== null && !Array.isArray(v);
const tcAsks = v => tcRecord(v) && typeof v.question === "string" && v.question.trim().length > 0 && Array.isArray(v.options) && v.options.length > 0;
/**
 * Another tool's ask to the developer (other-ask-tool-counts-as-asked): a question with choices, `{question, options[]}`
 * or `{questions: [{question, options[]}, …]}`, told by shape, never by tool name. A bare `question` with no choices is
 * a lookup (a docs or code search), not an ask.
 */
export function isAskInput(input) {
  if (tcAsks(input)) return true;
  return tcRecord(input) && Array.isArray(input.questions) && input.questions.length > 0 && input.questions.every(tcAsks);
}

/**
 * The due tasks to name at this turn end (due-by-fact): due entries whose time passed, not yet named twice for this
 * fact and revision and not within a day, oldest first, at most 3; and the receipt counting them.
 */
export function pickNudges(entries, receipt, now) {
  const next = { ...receipt };
  const lines = [];
  for (const e of [...entries].sort((x, y) => String(x.dueAt).localeCompare(String(y.dueAt)))) {
    if (lines.length >= 3 || Date.parse(e.dueAt) > now) continue;
    const r = receipt[e.id];
    const same = r && r.key === e.key && r.revision === e.revision;
    if (same && (r.count >= 2 || now - Date.parse(r.at) < 86_400_000)) continue;
    next[e.id] = { key: e.key, revision: e.revision, count: same ? r.count + 1 : 1, at: new Date(now).toISOString() };
    lines.push(e.line);
  }
  return { lines, receipt: next };
}

/**
 * What a turn end says, from facts either trigger can give. Pure.
 * - sync: a tracked agent (main or contributor) whose turn changed something it didn't sync_workspace after.
 * - nudge: a root agent that isn't a contributor (a tracked main, or a root agent outside any tracked workspace), with
 *   the inbox and its nudge on and no permission prompt showing, that didn't call needs_you this turn and didn't ask
 *   the developer through another tool. The same for every provider: the provider never decides it. The event trigger
 *   costs the agent a whole turn, so there it also needs a turn the developer started (`developerTurn`).
 * - due: the tracked agent's due tasks (pickNudges).
 */
export function turnEndDecision(f) {
  const tracked = f.role === "main" || f.role === "contributor";
  const sync = tracked && f.changed && !f.synced;
  const nudge = f.role !== "contributor" && f.role !== "recovery" && f.root && f.nudgeOn && !f.needsYouCalled && !f.askedElsewhere
    && (f.trigger === "hook" || f.developerTurn === true);
  const picked = tracked && f.due?.length ? pickNudges(f.due, f.receipt ?? {}, f.now) : { lines: [], receipt: null };
  return { sync, nudge, due: picked.lines, receipt: picked.lines.length ? picked.receipt : null, any: sync || nudge || picked.lines.length > 0 };
}

/** The due tasks' block, named for the agent's tools. */
export const dueBlock = (lines, native) => named(dueHeader, native) + "\n" + lines.map(l => `- ${l}`).join("\n");

/** The turn-end message a provider without the hook gets (server/turn-end.ts): one message, its first line the prefix. */
export function turnEndMessage(d, native = true) {
  const parts = [
    d.due.length ? dueBlock(d.due, native) : null,
    d.sync ? `${stopReason} ${syncBookkeeping} Call ${named("sync_workspace", native)} with a short summary; pass milestone when the milestone you're on changed.` : null,
    d.nudge ? named(nudgeReason, native) : null,
  ].filter(Boolean);
  return `${turnEndPrefix} your turn ended with this still open. Handle it, then stop without repeating your reply.\n\n${parts.join("\n\n")}`;
}
