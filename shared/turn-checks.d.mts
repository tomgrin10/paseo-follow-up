// Types for shared/turn-checks.mjs (plain JS: scripts/build.mjs inlines it into the agent hook).
export type DueLine = { id: string; key: string; revision: number; dueAt: string; line: string };
export type NudgeReceipt = Record<string, { key: string; revision: number; count: number; at: string }>;
export function isAskInput(input: unknown): boolean;
export function pickNudges<E extends DueLine>(entries: readonly E[], receipt: NudgeReceipt, now: number): { lines: string[]; receipt: NudgeReceipt };
export type TurnEndFacts = {
  /** Who decides: the Stop hook (in the turn) or Paseo's turn-end event (a queued message). */
  trigger: "hook" | "event";
  /** The agent's role in a tracked workspace, or null outside one. */
  role: "main" | "contributor" | "recovery" | null;
  /** A root agent (launched with FOLLOW_UP_BRIEF; every tracked main is one). */
  root: boolean;
  /** The inbox and its nudge are on, and no permission prompt is showing. */
  nudgeOn: boolean;
  /** The turn changed something worth syncing. */
  changed: boolean;
  /** It called sync_workspace after the change. */
  synced: boolean;
  needsYouCalled: boolean;
  askedElsewhere: boolean;
  /** The event trigger only: the developer started this turn. */
  developerTurn?: boolean | null;
  due?: readonly DueLine[];
  receipt?: NudgeReceipt;
  now: number;
};
export type TurnEndDecision = { sync: boolean; nudge: boolean; due: string[]; receipt: NudgeReceipt | null; any: boolean };
export function turnEndDecision(f: TurnEndFacts): TurnEndDecision;
export function dueBlock(lines: readonly string[], native: boolean): string;
export function turnEndMessage(d: TurnEndDecision, native?: boolean): string;
