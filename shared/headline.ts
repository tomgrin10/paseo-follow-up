import type { NeedItem } from "./attention";
import { FINISH_ASK, FINISH_WORD } from "./status";
import type { BriefKind } from "./brief";
import { age, displayReason, reasonRank, type InboxRow, type Reason, type ReasonEntry } from "./inbox";

/**
 * One precedence for "what does this agent need from you", shared by the composer pill, the brief card's
 * header and the Needs-you rows, so the three never disagree.
 *
 * The agent's own flag (the Needs-you inbox entry and its open brief) always decides the headline. Workspace
 * items (PRs to merge, repairs to send, questions) only headline when the agent isn't flagged; otherwise they
 * sit inside the popover. A failed CI check is never the headline on its own: Paseo's own checks chip already
 * shows it, so it only surfaces as "Send N fixes" when Follow-up has repairs ready.
 */
export const HEADLINE_KEYS = ["permission", "error", "paused", "blocked", "decision", "question", "action", "repairs", "finish", "merge", "reviewers", "review", "finished", "flagged", "pr_closed"] as const;
export type HeadlineKey = typeof HEADLINE_KEYS[number];
export type HeadlineTone = "danger" | "warning" | "accent" | "merged" | "muted";

/** The decisive word each key leads with. The pill, the card header and the row all read it from here. */
export const HEADLINE_WORD: Record<HeadlineKey, string> = {
  permission: "Permission", error: "Error", paused: "Paused", blocked: "Blocked", decision: "Decision", question: "Question", action: "Action",
  repairs: "Fixes", finish: FINISH_WORD, merge: "Merge", reviewers: "Add reviewers", review: "Review", finished: "Finished", flagged: "Flagged", pr_closed: "PR closed",
};
export const HEADLINE_ICON: Record<HeadlineKey, string> = {
  permission: "ShieldQuestion", error: "CircleX", paused: "CirclePause", blocked: "OctagonAlert", decision: "MessageCircleQuestion", question: "MessageCircleQuestion",
  action: "Hand", repairs: "Wrench", finish: "ListChecks", merge: "GitMerge", reviewers: "UserPlus", review: "GitPullRequest", finished: "Flag", flagged: "Flag", pr_closed: "GitMerge",
};
export const HEADLINE_TONE: Record<HeadlineKey, HeadlineTone> = {
  permission: "warning", error: "danger", paused: "warning", blocked: "danger", decision: "warning", question: "warning", action: "warning",
  repairs: "warning", finish: "warning", merge: "merged", reviewers: "warning", review: "warning", finished: "accent", flagged: "warning", pr_closed: "merged",
};
export const headlineRank = (key: HeadlineKey) => HEADLINE_KEYS.indexOf(key);

/** The brief card's kind, as a headline key. */
export function briefKey(kind: BriefKind): HeadlineKey {
  switch (kind) {
    case "decision": return "decision";
    case "action": return "action";
    case "review": return "review";
    case "permission": return "permission";
    case "paused": return "paused";
    case "error": return "error";
    case "reviewers": return "reviewers";
    case "done": case "unknown": return "finished";
  }
}

const REASON_KEY: Record<Reason, HeadlineKey> = { permission: "permission", error: "error", paused: "paused", ci: "flagged", review: "review", reviewers: "reviewers", finished: "finished", pr_closed: "pr_closed" };

export type Headline = {
  key: HeadlineKey;
  /** The pill label: the decisive word first, then a short detail ("Decision 4m", "Merge #812", "2 questions"). */
  label: string;
  /** One line for the popover and tooltips: what is asked, or why the agent is flagged. */
  line: string;
  /** Where the headline came from: the agent's own flag or its workspace's items. */
  source: "flag" | "workspace";
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The reason that headlines a flag: the first by urgency, skipping a CI failure while anything else is flagged. */
function headReason(needs: InboxRow["needs"]): ReasonEntry | null {
  const top = displayReason(needs);
  if (!top || top.reason !== "ci") return top;
  const rest = [...needs!.reasons].filter(r => r.reason !== "ci").sort((a, b) => reasonRank(a.reason) - reasonRank(b.reason) || a.at.localeCompare(b.at));
  return rest[0] ?? top;
}

/**
 * The flag's headline, for the pill, the row and the card. With an open brief, its kind replaces "finished"
 * (and agrees with permission, pause and error, which the brief mirrors).
 */
export function flagHeadline(row: Pick<InboxRow, "needs" | "snooze" | "brief">, now: number, items: NeedItem[] = []): Headline | null {
  if (!row.needs || row.snooze) return null;
  const top = headReason(row.needs);
  if (!top) return null;
  const brief = row.brief?.state === "open" ? row.brief : null;
  let key = REASON_KEY[top.reason];
  if (brief && (top.reason === "finished" || briefKey(brief.kind) === key)) key = briefKey(brief.kind);
  const since = age(row.needs.since, now);
  // "Finished · No ask stated" while the workspace has an open question tells Tom to skip it; the question is the ask.
  if (key === "finished" && (!brief || brief.source === "none")) {
    const asked = workspaceHeadline(items.filter(i => i.kind === "question"));
    if (asked) return { ...asked, source: "flag" };
  }
  // A failed check or review thread headlines as the developer's action: repairs ready to send.
  const send = items.find((i): i is Extract<NeedItem, { kind: "send" }> => i.kind === "send" && !i.finish);
  if ((key === "flagged" || key === "review") && send) return { key: "repairs", label: `Send ${plural(send.tasks.length, "fix", "fixes")}`, line: send.title, source: "flag" };
  // "Add reviewers #1499": the PR number is the detail, so the pill names which PR.
  if (key === "reviewers") return { key, label: `${HEADLINE_WORD.reviewers} ${top.detail}`.trim(), line: brief?.ask ?? `Add reviewers to ${top.detail}`, source: "flag" };
  const line = brief ? (brief.source === "none" ? "No ask stated" : brief.ask) : top.detail || HEADLINE_WORD[key];
  return { key, label: since ? `${HEADLINE_WORD[key]} ${since}` : HEADLINE_WORD[key], line, source: "flag" };
}

/** The workspace's top item, used only when the agent itself isn't flagged. */
export function workspaceHeadline(items: NeedItem[]): Headline | null {
  if (!items.length) return null;
  const questions = items.filter((i): i is Extract<NeedItem, { kind: "question" }> => i.kind === "question");
  const top = items[0];
  // needsYou() already orders by urgency; questions read as a count when there are several.
  if (top.kind === "question") {
    const stopped = top.state === "stopped";
    if (questions.length > 1) return { key: "question", label: plural(questions.length, "question"), line: stopped ? `The main agent stopped until you answer ${top.questionId}` : top.title, source: "workspace" };
    return { key: "question", label: `Question ${top.questionId}`, line: top.detail || top.title, source: "workspace" };
  }
  switch (top.kind) {
    case "hold": return { key: "blocked", label: "On hold", line: top.detail || top.title, source: "workspace" };
    case "retry": return { key: "blocked", label: "Fixes stuck", line: top.title, source: "workspace" };
    case "capped": return { key: "blocked", label: "Task unchanged", line: top.title, source: "workspace" };
    case "check": return { key: "blocked", label: "Check PR", line: top.title, source: "workspace" };
    case "answer": return { key: "blocked", label: "Check answer", line: top.title, source: "workspace" };
    case "decision": return { key: "decision", label: "Decision", line: top.title, source: "workspace" };
    case "send": return top.finish ? { key: "finish", label: FINISH_WORD, line: FINISH_ASK[0].toUpperCase() + FINISH_ASK.slice(1), source: "workspace" } : { key: "repairs", label: `Send ${plural(top.tasks.length, "task")}`, line: top.title, source: "workspace" };
    case "merge": return { key: "merge", label: `Merge #${top.number}`, line: top.title, source: "workspace" };
    case "reviewers": return { key: "reviewers", label: `Add reviewers #${top.number}`, line: top.title, source: "workspace" };
  }
}

/** Question ids the agent's open brief already asks. The popover shows that decision once, as the brief's ask. */
export function briefQuestionIds(row: Pick<InboxRow, "brief"> | null): Set<string> {
  return new Set(row?.brief?.state === "open" ? row.brief.questionIds ?? [] : []);
}
/** The workspace's items minus the questions the open brief already asks (decision 3: no repeat in the popover). */
export function withoutBriefQuestions(items: NeedItem[], row: Pick<InboxRow, "brief"> | null): NeedItem[] {
  const asked = briefQuestionIds(row);
  return asked.size ? items.filter(i => !(i.kind === "question" && asked.has(i.questionId))) : items;
}

/** "3 to do": the workspace count shown inside the popover. Never on the pill, where it read like a count of agents. */
export const todoLabel = (items: NeedItem[]) => items.length ? `${items.length} to do` : "";

export type PillState =
  | { mode: "flag"; headline: Headline; todo: number }
  | { mode: "workspace"; headline: Headline; todo: number }
  | { mode: "undo"; label: string }
  | null;

export const UNDO_MS = 6_000;

/**
 * The single Follow-up pill for one agent. Flagged → its flag; just signed off → "Signed off" (Undo inside its popover) for 6 s;
 * otherwise the workspace's items when this is the workspace's main agent; else nothing.
 */
export function pillState(input: {
  row: Pick<InboxRow, "agentId" | "needs" | "snooze" | "brief"> | null;
  /** needsYou() for the workspace, only when this agent is its main agent. */
  items: NeedItem[];
  /** The store's last sign-off or Later ("later"); no kind is a sign-off. */
  recent: { agentIds: string[]; at: number; kind?: "sign_off" | "later" | "later_ws" } | null;
  /** This agent has a Done waiting on its Undo toast (client/done-windows.ts). */
  done?: boolean;
  now: number;
}): PillState {
  const { row, recent, now } = input;
  const items = withoutBriefQuestions(input.items, row);
  // Done waits on its toast, so the Action brief is still open on the daemon: the developer's move owns the pill for
  // as long as the toast does (the store clears it when the toast ends), not a fixed 6 s.
  if (row && input.done) return { mode: "undo", label: "Done" };
  const flag = row ? flagHeadline(row, now, items) : null;
  if (flag) return { mode: "flag", headline: flag, todo: items.length };
  if (row && recent && recent.agentIds.includes(row.agentId) && now - recent.at < UNDO_MS) return { mode: "undo", label: recent.kind === "later" ? "Later" : "Signed off" };
  const work = workspaceHeadline(items);
  return work ? { mode: "workspace", headline: work, todo: items.length } : null;
}
