import type { NeedItem } from "./attention";
import type { Workstream } from "./home";
import type { ListWorkspace as Workspace } from "./list";

/**
 * Home's row menu (right-click, long-press, the menu key): the quick moves on one workspace row without opening it.
 * Pure, so the menu's contents are tested here and every surface that shows it builds the same list. Each action names
 * the agent tool that does the same thing (agent parity), or why it needs none; `tests/row-menu.test.ts` checks both.
 */

/** Today's Later choices, the same four the detail pane and the pill offer (`snoozeUntil`). */
export const LATER_CHOICES = [["hour", "In 1 hour"], ["tonight", "Tonight 18:00"], ["tomorrow", "Tomorrow 09:00"], ["next-event", "Next event"]] as const;
export type LaterChoice = typeof LATER_CHOICES[number][0];
/**
 * The Later choices that make sense right now: from 18:00 "Tonight 18:00" would mean tomorrow evening, after
 * "Tomorrow 09:00", so it's left out. The menu, the detail pane and the pill all list these.
 */
export function laterChoices(now: Date): typeof LATER_CHOICES[number][] {
  return LATER_CHOICES.filter(([id]) => id !== "tonight" || now.getHours() < 18);
}

export const ROW_ACTIONS = {
  later: { tool: "snooze" },
  bring_back: { tool: "inbox_act", note: "action: \"unsnooze\"." },
  sign_off: { tool: "sign_off" },
  later_ws: { tool: "snooze_workspace" },
  bring_back_ws: { tool: "snooze_workspace", note: "bring_back=true." },
  answer: { exempt: "Opens the question card; sending the answer is answer_question." },
  send_repairs: { tool: "send_repairs" },
  retry_batch: { tool: "retry_batch" },
  clear_hold: { tool: "clear_hold" },
  open_chat: { exempt: "Navigation: shows the agent's chat and changes nothing." },
  ask_overseer: { tool: "overseer_ask", note: "Pre-fills the omnibox; the developer's Enter sends it through follow.overseer-ask." },
  copy_branch: { exempt: "Copies text to the clipboard and changes nothing." },
  rewrite_summary: { tool: "workspace_about" },
  rename_ai: { tool: "ai_rename" },
  pin: { tool: "pin_workspace", note: "pinned=true." },
  unpin: { tool: "pin_workspace", note: "pinned=false." },
  make_main: { tool: "make_main_agent" },
  stop_following: { tool: "set_follow_settings" },
  archive: { exempt: "Paseo's own archive_workspace tool archives a workspace for an agent; this item sends Paseo that same request." },
} as const satisfies Record<string, { tool: string; note?: string } | { exempt: string }>;
export type RowActionId = keyof typeof ROW_ACTIONS;

export type RowMenuItem = {
  /** Unique within the menu: the action plus its argument ("later:tomorrow", "answer:Q3"). */
  key: string;
  action: RowActionId;
  label: string;
  icon: string;
  /** The action's argument: a Later choice, a question or batch id, a branch. */
  arg?: string;
  /** Supporting text under the label (a question's title). */
  hint?: string;
  /** A submenu that opens in place (Later). */
  children?: RowMenuItem[];
  /** Destructive: asks first with this line. Several lines (`\n`): the first is the step's question, set as its title. */
  confirm?: string;
  /** The confirm's one line about losing work, drawn in the danger colour (Archive's uncommitted changes). */
  confirmLoss?: string;
};
export type RowMenuSection = { key: string; items: RowMenuItem[] };

/**
 * What Paseo's workspace list already says about a workspace that archiving touches, read from the descriptor Paseo
 * streams (no git run, no poll). Paseo's archive stops every agent, closes the terminals and takes the workspace off
 * the list; for a worktree Paseo created it also runs the teardown and deletes the worktree folder (git worktree
 * remove --force), so uncommitted changes there are lost. The branch and its commits stay, and Paseo can restore it.
 */
export type ArchiveFacts = {
  kind: "directory" | "worktree" | "checkout" | "local_checkout" | null;
  /** gitRuntime.isPaseoOwnedWorktree: false means Paseo leaves the folder in place. */
  ownedWorktree: boolean | null;
  dirty: boolean | null;
  diff: { additions: number; deletions: number } | null;
  /** Commits not pushed to origin. */
  ahead: number | null;
  /** Paseo's workspace status is running: an agent is working right now. */
  running: boolean;
};

const lines = (n: number, word: string) => `${n} ${word} line${n === 1 ? "" : "s"}`;

/**
 * The confirm line for Archive: what Paseo's archive really does to this workspace, in plain words. It names what
 * Paseo's own archive warns about (uncommitted changes, unpushed commits; `worktree-archive-warning.ts` upstream) and
 * an agent working right now.
 */
export function archiveConfirm(title: string, f: ArchiveFacts): string {
  return archiveConfirmLines(title, f).lines.join("\n");
}

/** The confirm's lines (the question first, one consequence a line) and the one about losing work, if any. */
export function archiveConfirmLines(title: string, f: ArchiveFacts): { lines: string[]; loss: string | null } {
  const out = [`Archive ${title}?`];
  out.push(f.running ? "An agent is working in it now. Archiving stops it and the other agents, closes its terminals and takes it off your workspace list."
    : "Its agents stop, its terminals close and it leaves your workspace list.");
  let loss: string | null = null;
  if (f.kind === "worktree" && f.ownedWorktree !== false) {
    const changed = !!f.diff && (f.diff.additions > 0 || f.diff.deletions > 0);
    const dirty = f.dirty === true || (f.dirty == null && changed);
    const stat = changed ? [f.diff!.additions > 0 && lines(f.diff!.additions, "added"), f.diff!.deletions > 0 && lines(f.diff!.deletions, "deleted")].filter(Boolean).join(", ") : "";
    // Paseo's list streams isDirty only once the row has read its git status; until then (null, no diff) nothing says
    // the worktree is clean, so the line names the loss as possible rather than promising it's safe.
    if (dirty) { out.push("Paseo deletes its worktree folder."); loss = `Uncommitted changes${stat ? ` (${stat})` : ""} are lost.`; out.push(loss); }
    else if (f.dirty === false) out.push("Paseo deletes its worktree folder. The branch and its commits stay.");
    else out.push("Paseo deletes its worktree folder, with any uncommitted changes in it. The branch and its commits stay.");
    if ((f.ahead ?? 0) > 0) out.push(`${f.ahead} unpushed commit${f.ahead === 1 ? "" : "s"} stay on the local branch.`);
    out.push(dirty ? "Paseo can restore the workspace later, without those changes." : "Paseo can restore it later.");
  } else out.push("Its folder stays, and Paseo can restore it later.");
  return { lines: out, loss };
}

function archiveConfirmItem(title: string, f: ArchiveFacts): Pick<RowMenuItem, "confirm" | "confirmLoss"> {
  const { lines, loss } = archiveConfirmLines(title, f);
  return { confirm: lines.join("\n"), ...(loss ? { confirmLoss: loss } : {}) };
}

export type RowMenuInput = {
  s: Pick<Workstream, "key" | "agentId" | "workspaceId" | "title" | "agent"> & Partial<Pick<Workstream, "readyToArchive">>;
  /**
   * The agent's inbox flag (needs), snoozed or not: it gets Later and Sign off. A snoozed row's Later changes the time.
   * Needs-you rows raised only by the workspace (a hold, repairs to send) carry no inbox flag, so they have no Later:
   * the inbox can only snooze a flag. Their own fix (Resume follow-up, Send) leads their menu instead.
   */
  flagged: boolean;
  /** When the flag is snoozed, the wake label ("09:00", "Tue 09:00"), shown under Later. */
  snoozedUntil?: string | null;
  /** The clock, for the Later choices (default now). */
  now?: Date;
  /** The tracked workspace, when Follow-up follows it. */
  w?: Pick<Workspace, "id" | "mainAgentId" | "enable_tracking" | "prs"> | null;
  /** needsYou(w): what Answer, Send, Retry and Resume read. */
  needs?: readonly NeedItem[];
  /** Paseo's current branch for the workspace. */
  branch?: string | null;
  /**
   * A workspace-only Needs-you row (a hold, repairs to send; no agent flag): it gets the workspace's own Later, and
   * Bring back now while that's set (`snoozedUntil`, the wake label).
   */
  workspaceLater?: { snoozedUntil: string | null } | null;
  /** The surface can pre-fill an Overseer ask (Home's omnibox, while the Overseer is on). */
  canAsk?: boolean;
  /**
   * The surface can archive this workspace (the host's Paseo API has archive and Paseo lists the workspace), with what
   * the confirm line names. Absent: no Archive item.
   */
  archive?: ArchiveFacts | null;
  /**
   * Paseo's pin for the workspace (shared with Paseo's sidebar): an ISO time when pinned, null when not. Absent on a
   * host without pins: no Pin item.
   */
  pinnedAt?: string | null;
};

const MAX_ANSWERS = 2;

/** The row's menu, in sections: triage, answer, fix, go, copy and tidy. Only what applies to this row is listed. */
export function rowMenu(input: RowMenuInput): RowMenuSection[] {
  const { s, flagged, snoozedUntil, w, needs = [], branch, canAsk, workspaceLater, archive, pinnedAt, now = new Date() } = input;
  const sections: RowMenuSection[] = [];
  const add = (key: string, items: (RowMenuItem | null | false | undefined)[]) => {
    const kept = items.filter((x): x is RowMenuItem => !!x);
    if (kept.length) sections.push({ key, items: kept });
  };

  // Archive, only on the developer's click and after the confirm (invariant 6). A row Follow-up calls ready to archive
  // (the "N to archive" cue) leads with it, first in triage; any other row has it last in tidy.
  const archiveItem: RowMenuItem | null = s.workspaceId && archive ? { key: "archive", action: "archive", label: "Archive workspace…", icon: "Archive", ...archiveConfirmItem(s.title, archive) } : null;
  const archiveFirst = !!s.readyToArchive && !!archiveItem;

  // 1. Triage, the moves made many times a day. Later first: it's the one Tom named.
  const triage: (RowMenuItem | null | false)[] = s.agentId && flagged ? [
    { key: "later", action: "later", label: "Later", icon: "AlarmClock", ...(snoozedUntil ? { hint: `Later until ${snoozedUntil}` } : {}),
      children: laterChoices(now).map(([id, label]) => ({ key: `later:${id}`, action: "later" as const, label, icon: "Clock", arg: id })) },
    !!snoozedUntil && { key: "bring_back", action: "bring_back", label: "Bring back now", icon: "BellRing" },
    { key: "sign_off", action: "sign_off", label: "Sign off", icon: "Check" },
  ] : !flagged && workspaceLater && w ? [
    // No agent flag, so nothing to sign off: the workspace's needs themselves are put off.
    { key: "later_ws", action: "later_ws", label: "Later", icon: "AlarmClock", ...(workspaceLater.snoozedUntil ? { hint: `Later until ${workspaceLater.snoozedUntil}` } : {}),
      children: laterChoices(now).map(([id, label]) => ({ key: `later_ws:${id}`, action: "later_ws" as const, label, icon: "Clock", arg: id })) },
    !!workspaceLater.snoozedUntil && { key: "bring_back_ws", action: "bring_back_ws", label: "Bring back now", icon: "BellRing" },
  ] : [];
  add("triage", [archiveFirst && archiveItem, ...triage]);

  // 2. Answer the open questions, stopped ones first (needsYou's order).
  add("answer", needs.filter(i => i.kind === "question").slice(0, MAX_ANSWERS).map(i => i.kind === "question" && {
    key: `answer:${i.questionId}`, action: "answer" as const, label: `Answer ${i.questionId}`, icon: "MessageCircleReply", arg: i.questionId, hint: i.title.replace(/^Q\d+ · /, ""),
  }));

  // 3. What Follow-up itself is stuck on, only when it applies.
  const send = needs.find(i => i.kind === "send" && !i.blocker);
  const retry = needs.find(i => i.kind === "retry" && !i.exhausted);
  const hold = needs.some(i => i.kind === "hold");
  add("fix", w ? [
    hold && { key: "clear_hold", action: "clear_hold", label: "Resume follow-up", icon: "Play" },
    send?.kind === "send" && { key: `send_repairs:${send.batchId}`, action: "send_repairs", label: `Send ${send.what}`, icon: "Send", arg: send.batchId },
    retry?.kind === "retry" && { key: `retry_batch:${retry.batchId}`, action: "retry_batch", label: "Retry", icon: "RotateCcw", arg: retry.batchId },
  ] : []);

  // 4. Go somewhere.
  add("go", [
    !!(s.agentId || s.workspaceId) && { key: "open_chat", action: "open_chat", label: s.agentId ? "Open chat" : "Open workspace", icon: "PanelRightOpen" },
    canAsk && { key: "ask_overseer", action: "ask_overseer", label: "Ask the Overseer", icon: "MessagesSquare" },
    // Paseo's own words and pin: it shows in Paseo's sidebar and in Follow-up's Pinned alike.
    !!s.workspaceId && pinnedAt !== undefined && (pinnedAt ? { key: "unpin", action: "unpin", label: "Unpin", icon: "PinOff" } : { key: "pin", action: "pin", label: "Pin to top", icon: "Pin" }),
  ]);

  // 5. Copy and tidy.
  const multiRootOther = !!w && !!s.agent && !!s.agentId && s.agentId !== w.mainAgentId;
  add("tidy", [
    !!branch && { key: "copy_branch", action: "copy_branch", label: "Copy branch name", icon: "GitBranch", arg: branch },
    !!s.workspaceId && { key: "rename_ai", action: "rename_ai", label: "Rename title with AI…", icon: "Sparkles" },
    !!w && { key: "rewrite_summary", action: "rewrite_summary", label: "Rewrite summary", icon: "RefreshCw" },
    multiRootOther && { key: "make_main", action: "make_main", label: `Make ${s.agent} the main agent…`, icon: "Crown", arg: s.agentId!,
      confirm: `Make ${s.agent} the main agent of ${s.title}? It takes over the goal, tasks, questions and Done.` },
    !!w?.enable_tracking && { key: "stop_following", action: "stop_following", label: "Stop following…", icon: "EyeOff",
      confirm: `Stop following ${s.title}? Follow-up keeps its history, and you can follow it again in Settings → Following.` },
    !archiveFirst && archiveItem,
  ]);
  return sections;
}

/** Every item in reading order, a submenu's children right after their parent when it's open. */
export function flatItems(sections: readonly RowMenuSection[], openKey: string | null = null): RowMenuItem[] {
  return sections.flatMap(sec => sec.items.flatMap(i => i.children && i.key === openKey ? [i, ...i.children] : [i]));
}

/** Arrow-key movement in the menu: wraps at both ends; Home and End jump. */
export function moveFocus(index: number, count: number, key: string): number {
  if (!count) return -1;
  // Nothing active yet (opened with the pointer): Down starts at the top, Up at the bottom.
  if (index < 0) return key === "ArrowUp" || key === "End" ? count - 1 : key === "ArrowDown" || key === "Home" ? 0 : index;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowDown") return (index + 1 + count) % count;
  if (key === "ArrowUp") return (index - 1 + count) % count;
  return index;
}

/** Where a menu opened at a point sits so it stays inside the viewport (and a margin), flipping up or left when needed. */
export function placeMenu(at: { x: number; y: number }, size: { width: number; height: number }, viewport: { width: number; height: number }, margin = 8): { left: number; top: number } {
  const fitsRight = at.x + size.width + margin <= viewport.width;
  const fitsBelow = at.y + size.height + margin <= viewport.height;
  const left = fitsRight ? at.x : at.x - size.width;
  const top = fitsBelow ? at.y : at.y - size.height;
  const clamp = (v: number, span: number, max: number) => Math.max(margin, Math.min(v, max - span - margin));
  return { left: clamp(left, size.width, viewport.width), top: clamp(top, size.height, viewport.height) };
}

/** The menu key, or Shift+F10, on a focused row. */
export const isMenuKey = (e: { key: string; shiftKey?: boolean }) => e.key === "ContextMenu" || (e.key === "F10" && !!e.shiftKey);

/** How long after the opening touch lifts a pick still counts as that same touch (the browser's synthesized click). */
export const RELEASE_TAIL_MS = 350;
/**
 * Whether the sheet takes a pick yet. The long-press that opens the sheet ends with the finger lifting over whatever
 * item slid up under it, and the browser turns that lift into a click. So the sheet takes no pick until the opening
 * touch has been released, plus a short tail. Without this guard, long-pressing a held row ran "Resume follow-up".
 */
export const sheetArmed = (releasedAt: number | null, now: number): boolean => releasedAt !== null && now - releasedAt >= RELEASE_TAIL_MS;
