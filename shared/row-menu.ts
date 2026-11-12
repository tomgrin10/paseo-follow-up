import type { NeedItem } from "./attention";
import type { Workstream } from "./home";
import type { Workspace } from "./model";

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
  copy_pr: { exempt: "Copies text to the clipboard and changes nothing." },
  rewrite_summary: { tool: "workspace_about" },
  rename_ai: { tool: "ai_rename" },
  make_main: { tool: "make_main_agent" },
  stop_following: { tool: "set_follow_settings" },
} as const satisfies Record<string, { tool: string; note?: string } | { exempt: string }>;
export type RowActionId = keyof typeof ROW_ACTIONS;

export type RowMenuItem = {
  /** Unique within the menu: the action plus its argument ("later:tomorrow", "answer:Q3"). */
  key: string;
  action: RowActionId;
  label: string;
  icon: string;
  /** The action's argument: a Later choice, a question or batch id, a branch, PR links. */
  arg?: string;
  /** Supporting text under the label (a question's title). */
  hint?: string;
  /** A submenu that opens in place (Later). */
  children?: RowMenuItem[];
  /** Destructive: asks first with this line. */
  confirm?: string;
};
export type RowMenuSection = { key: string; items: RowMenuItem[] };

export type RowMenuInput = {
  s: Pick<Workstream, "key" | "agentId" | "workspaceId" | "title" | "agent">;
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
};

const MAX_ANSWERS = 2;

/** The row's menu, in sections: triage, answer, fix, go, copy and tidy. Only what applies to this row is listed. */
export function rowMenu(input: RowMenuInput): RowMenuSection[] {
  const { s, flagged, snoozedUntil, w, needs = [], branch, canAsk, workspaceLater, now = new Date() } = input;
  const sections: RowMenuSection[] = [];
  const add = (key: string, items: (RowMenuItem | null | false | undefined)[]) => {
    const kept = items.filter((x): x is RowMenuItem => !!x);
    if (kept.length) sections.push({ key, items: kept });
  };

  // 1. Triage, the moves made many times a day. Later first: it's the one Tom named.
  add("triage", s.agentId && flagged ? [
    { key: "later", action: "later", label: "Later", icon: "AlarmClock", ...(snoozedUntil ? { hint: `Later until ${snoozedUntil}` } : {}),
      children: laterChoices(now).map(([id, label]) => ({ key: `later:${id}`, action: "later" as const, label, icon: "Clock", arg: id })) },
    !!snoozedUntil && { key: "bring_back", action: "bring_back", label: "Bring back now", icon: "BellRing" },
    { key: "sign_off", action: "sign_off", label: "Sign off", icon: "Check" },
  ] : !flagged && workspaceLater && w ? [
    // No agent flag, so nothing to sign off: the workspace's needs themselves are put off.
    { key: "later_ws", action: "later_ws", label: "Later", icon: "AlarmClock", ...(workspaceLater.snoozedUntil ? { hint: `Later until ${workspaceLater.snoozedUntil}` } : {}),
      children: laterChoices(now).map(([id, label]) => ({ key: `later_ws:${id}`, action: "later_ws" as const, label, icon: "Clock", arg: id })) },
    !!workspaceLater.snoozedUntil && { key: "bring_back_ws", action: "bring_back_ws", label: "Bring back now", icon: "BellRing" },
  ] : []);

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
    send?.kind === "send" && { key: `send_repairs:${send.batchId}`, action: "send_repairs", label: send.tasks.length === 1 ? "Send 1 repair" : `Send ${send.tasks.length} repairs`, icon: "Send", arg: send.batchId },
    retry?.kind === "retry" && { key: `retry_batch:${retry.batchId}`, action: "retry_batch", label: "Retry repairs", icon: "RotateCcw", arg: retry.batchId },
  ] : []);

  // 4. Go somewhere.
  add("go", [
    !!(s.agentId || s.workspaceId) && { key: "open_chat", action: "open_chat", label: s.agentId ? "Open chat" : "Open workspace", icon: "PanelRightOpen" },
    canAsk && { key: "ask_overseer", action: "ask_overseer", label: "Ask the Overseer", icon: "MessagesSquare" },
  ]);

  // 5. Copy and tidy.
  const open = (w?.prs ?? []).filter(p => p.snapshot?.url && p.snapshot.state === "OPEN");
  const links = (open.length ? open : (w?.prs ?? []).filter(p => p.snapshot?.url).slice(-1)).map(p => p.snapshot!.url);
  const multiRootOther = !!w && !!s.agent && !!s.agentId && s.agentId !== w.mainAgentId;
  add("tidy", [
    !!branch && { key: "copy_branch", action: "copy_branch", label: "Copy branch name", icon: "GitBranch", arg: branch },
    links.length > 0 && { key: "copy_pr", action: "copy_pr", label: links.length === 1 ? "Copy PR link" : `Copy ${links.length} PR links`, icon: "Link", arg: links.join("\n") },
    !!s.workspaceId && { key: "rename_ai", action: "rename_ai", label: "Rename with AI…", icon: "Sparkles" },
    !!w && { key: "rewrite_summary", action: "rewrite_summary", label: "Rewrite Summary", icon: "RefreshCw" },
    multiRootOther && { key: "make_main", action: "make_main", label: `Make ${s.agent} the main agent…`, icon: "Crown", arg: s.agentId!,
      confirm: `Make ${s.agent} the main agent of ${s.title}? It takes over the goal, tasks, questions and Done.` },
    !!w?.enable_tracking && { key: "stop_following", action: "stop_following", label: "Stop following…", icon: "EyeOff",
      confirm: `Stop following ${s.title}? Follow-up keeps its history, and you can follow it again in Settings → Following.` },
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
