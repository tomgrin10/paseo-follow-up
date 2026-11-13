import type { Store } from "./store";
import type { State, Workspace } from "../shared/model";
import { holdOnTurnEnd, holdSuperseded, liftHold } from "../shared/status";
import { applyHistory, extractHistory } from "./discovery";
import { turnPrompt } from "./inbox-classifier";
import { conversationGone } from "./agent-load";
import { answerMarker, awaitingSend, deliveredInChat } from "../shared/questions";

/**
 * The writes an agent's turn makes, each to the one workspace the turn is about (a-send-never-clones-the-whole-state).
 * The workspaces are found on the frozen snapshot and written with Store.mutateWorkspace, so a turn copies one
 * workspace and the next save validates only it. 2026-11-13: these handlers copied the whole 2 MB state on every turn
 * start and end, and the start handler walked every workspace for a superseded hold.
 */
type TurnOutcome = { kind: "completed" } | { kind: "failed"; error: { message: string } } | { kind: "canceled"; reason: string };

const tracksAgent = (w: Workspace, agentId: string) => w.enable_tracking && (w.mainAgentId === agentId || !!w.contributorAgentIds?.includes(agentId));

/** The tracked workspace an agent works in (main or contributor), if any. */
export function agentTrackedWorkspace(state: State, agentId: string): Workspace | undefined {
  return state.workspaces.find(w => tracksAgent(w, agentId));
}

/**
 * A turn started: a newer main-agent turn lifts the stopped turn's automatic hold (holdSuperseded), a turn in an owned
 * workspace ends its Done, and a turn in a dormant workspace makes it active again. Returns the workspaces to nudge.
 */
export async function turnStarted(store: Store, agent: { id: string; workspaceId: string | null }, turnId: string | null): Promise<{ lifted: string[]; owned: string | null; woken: string | null }> {
  const saved = await store.snapshot();
  const turn = { agentId: agent.id, turnId };
  const owned = agentTrackedWorkspace(saved, agent.id);
  const waking = saved.workspaces.find(w => w.dormant && w.id === agent.workspaceId);
  // A main agent leads one workspace; its own is the only one whose hold its turn can supersede.
  const held = saved.workspaces.filter(w => w.enable_tracking && w.mainAgentId === agent.id && holdSuperseded(w, turn));
  const lifted: string[] = [];
  for (const w of held) await store.mutateWorkspace(w.id, current => { if (current.enable_tracking && holdSuperseded(current, turn)) { liftHold(current); lifted.push(current.id); } });
  if (owned && (owned.completion || owned.declaration)) await store.mutateWorkspace(owned.id, w => { w.completion = null; w.declaration = null; });
  if (waking) await store.mutateWorkspace(waking.id, w => { delete w.dormant; });
  return { lifted, owned: owned?.id ?? null, woken: waking?.id ?? null };
}

/**
 * A turn ended: record the history its tail shows, and a developer's Stop or a failed turn on the main agent holds (or
 * marks the conversation gone). `items` is the bounded tail read outside the state lock; null when it couldn't be read.
 */
export async function turnEnded(store: Store, agentId: string, outcome: TurnOutcome, turnId: string | null, items: unknown[] | null, o: { interruption: { turnId: string | null; at: string; kind: string } | null; guarded: boolean; newerTurn?: boolean; compaction?: boolean }): Promise<string | null> {
  const w = agentTrackedWorkspace(await store.snapshot(), agentId);
  if (!w) return null;
  if (items) await store.mutateWorkspace(w.id, current => {
    if (tracksAgent(current, agentId)) applyHistory(current, extractHistory(items, current.inventory?.historyComplete ?? false, current.inventory?.historyError ?? null), null);
  });
  // An answer the developer copied or put in this agent's chat is delivered once their message carrying it is in the
  // tail just read (an-answer-leaves-needs-you-only-when-delivered). No read of its own.
  const sent = items ? userTexts(items) : [];
  if (sent.length && w.questions.some(q => awaitingSend(q) && sent.some(t => t.includes(answerMarker(q.id)))))
    await store.mutateWorkspace(w.id, current => { if (tracksAgent(current, agentId)) deliveredInChat(current.questions, agentId, sent, new Date().toISOString()); });
  const interruption = o.interruption;
  if ((outcome.kind === "canceled" || outcome.kind === "failed") && !o.guarded && interruption && w.mainAgentId === agentId) {
    const prompt = items ? turnPrompt(items).message?.text ?? null : null;
    await store.mutateWorkspace(w.id, current => {
      if (!tracksAgent(current, agentId) || current.mainAgentId !== agentId) return;
      // The provider lost the conversation: every later send fails the same way, so stop sending instead of holding.
      if (outcome.kind === "failed" && conversationGone(outcome.error.message)) { current.goneAgent = { agentId, at: interruption.at, reason: outcome.error.message }; current.completion = null; current.declaration = null; return; }
      holdOnTurnEnd(current, { agentId, turnId: interruption.turnId, at: interruption.at, outcome, prompt, newerTurn: !!o.newerTurn, compaction: !!o.compaction });
    });
  }
  return w.id;
}

/** The text of every user message in a timeline tail: the developer's own words (an agent's message is a tool call). */
export function userTexts(items: unknown[]): string[] {
  const texts: string[] = [];
  for (const item of items) {
    const i = item as { type?: string; text?: unknown } | null;
    if (i && i.type === "user_message" && typeof i.text === "string") texts.push(i.text);
  }
  return texts;
}
