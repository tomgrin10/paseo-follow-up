import { useEffect, useState } from "react";
import { View } from "react-native";
import { usePaseo } from "@getpaseo/plugin/client";
import { Text } from "./text";
import type { InboxStore } from "./inbox-store";
import { useInbox } from "./inbox";
import { AgentLines } from "./now-lines";
import { FoldButton, PANEL_FOLDS, useFold } from "./fold";
import { HintBubble, HintIcon, useHint } from "./hint";
import { ReplyBox } from "./home";
import { TurnView, useTurn } from "./turn-view";
import { useMarkTimelineOnScreen } from "./on-screen";
import { Spinner } from "./motion";
import { PrLinksProvider } from "./rich-text";
import { prLinksByNumber } from "../shared/presentation";
import { raised, runningColor } from "./theme";
import type { Theme } from "./kit";
import type { Workspace } from "../shared/model";
import type { InboxRow } from "../shared/inbox";
import { turnSource } from "../shared/turn";

/** Where the workspace view is mounted. Only two things differ by place: the head's own controls and the reply box. */
export type ViewPlace = "home" | "panel" | "tab";

const NO_INBOX = { subscribe: () => () => undefined, version: () => 0, rows: () => [] } as unknown as InboxStore;
const NO_ROWS: readonly InboxRow[] = [];

export const STEPS_HINT = "Live while shown. A resting agent's steps come from its saved transcript, so it is never woken.";
const HOME_REPLY_HINT = " Sending clears Needs you; Sign off & next moves on without a reply.";

/**
 * The agent card (docs/client.md#the-workspace-view): one row per agent (client/now-lines.tsx), then Recent steps (the
 * peek's rows, client/turn-view.tsx: the developer's messages, the agent's replies, steps grouped) and the reply box
 * right under them, so reading and replying are one place. A row switches the steps and the box to its agent; Cmd/Ctrl
 * opens its chat. Recent steps reads live while shown and an unloaded agent's saved transcript otherwise, never waking
 * it (invariant 1). Its fold (the arrow on the Recent steps line) folds the steps and the box; the rows stay.
 *
 * The side panel (`place` "panel") sits beside the workspace's chat, so it never draws the reply box and its Recent
 * steps start folded; the developer's own fold choice wins everywhere (invariant 132). Home's pane and the main tab mark
 * the selected agent's timeline as on screen while its steps show, so its status-line peek stays shut.
 */
export function AgentCard({ workspace: w, inbox, theme, compact, steps, now, place, openAgent, onSent, reply }: {
  workspace: Workspace; inbox?: InboxStore; theme: Theme; compact: boolean;
  /** How many rows of steps the layout tier shows (shared/workspace-layout.ts). */
  steps: number; now: number; place: ViewPlace;
  openAgent?: (agentId: string) => void;
  /** After a reply went out (Home refreshes its inbox rows). */
  onSent?: () => void;
  /** Draw the reply box under Recent steps: never in the side panel, and not on a phone's Home, whose dock has it. */
  reply: boolean;
}) {
  const c = theme.colors;
  const rows = useInbox(inbox ?? NO_INBOX, () => inbox?.rows() ?? NO_ROWS);
  const [selected, setSelected] = useState(w.mainAgentId);
  // A new main agent (Make main agent, a claim) moves the card to it.
  useEffect(() => { setSelected(w.mainAgentId); }, [w.mainAgentId]);
  const name = selected === w.mainAgentId ? "the main agent" : rows.find(r => r.agentId === selected)?.title?.trim() || w.taskAgents?.[selected]?.title?.trim() || "the agent";
  const pick = (agentId: string, chat: boolean) => { if (chat && openAgent) openAgent(agentId); else setSelected(agentId); };
  const [hintOpen, setHintOpen] = useState(false);
  return <View style={[{ marginHorizontal: compact ? 16 : 12, marginTop: 12, borderRadius: 8, overflow: hintOpen ? "visible" : "hidden", zIndex: hintOpen ? 30 : undefined, backgroundColor: c.surface0 }, raised(c)]}>
    <AgentLines workspace={w} inbox={inbox} theme={theme} compact={compact} now={now} openAgent={openAgent} peek={place === "panel"} bare selected={selected} onSelect={pick} />
    <View style={{ borderTopWidth: 1, borderTopColor: c.border }}>
      <RecentSteps agentId={selected} name={name} theme={theme} compact={compact} steps={steps} place={place} reply={reply} prs={w.prs} onSent={onSent} onHint={setHintOpen} />
    </View>
  </View>;
}

/**
 * Recent steps for one agent, with its fold, its ? hint and (when `reply`) the reply box under it: the agent card's
 * lower half, and on its own in Home's pane for a row with no workspace and for the Overseer. Never wakes the agent.
 */
export function RecentSteps({ agentId, name, theme, compact, steps, place, reply, prs = [], onSent, onHint, empty }: {
  agentId: string | null; name: string; theme: Theme; compact: boolean; steps: number; place: ViewPlace; reply: boolean;
  prs?: Workspace["prs"]; onSent?: () => void;
  /** The ? hint opened or closed (the card lets it draw past its edge). */
  onHint?: (open: boolean) => void;
  /** What an empty turn says; the default points at the reply box or the chat. */
  empty?: string;
}) {
  const c = theme.colors;
  const fold = useFold(PANEL_FOLDS.steps, place !== "panel");
  const open = fold.open;
  useMarkTimelineOnScreen(place !== "panel" && open ? agentId : null);
  const turn = useTurn(agentId, open);
  const paseo = usePaseo();
  const [hintOpen, setHintOpen] = useState(false);
  const help = useHint(next => { setHintOpen(next); onHint?.(next); });
  const caption = turn.running ? "live" : turnSource(turn);
  const hint = STEPS_HINT + (place === "home" && reply ? HOME_REPLY_HINT : "");
  return <View style={{ zIndex: hintOpen ? 30 : undefined }}>
    <View style={{ zIndex: hintOpen ? 30 : undefined, flexDirection: "row", alignItems: "center" }}>
      <FoldButton open={open} onToggle={fold.toggle} label={caption ? `Recent steps, ${caption}` : "Recent steps"} theme={theme} chevron="end"
        style={(hovered, pressed) => ({ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: compact ? 14 : 12, paddingVertical: 8, minHeight: compact ? 44 : undefined, backgroundColor: pressed ? c.surface2 : hovered ? c.surface1 : "transparent" })}>
        <Text numberOfLines={1} style={{ flexShrink: 0, color: c.foreground, fontSize: compact ? 13 : 12, fontWeight: "600" }}>Recent steps</Text>
        <HintIcon hint={help} text={hint} theme={theme} compact={compact} />
        <View style={{ flex: 1, minWidth: 0, flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 5 }}>
          {turn.running && <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: runningColor(c) }} />}
          {!!caption && <Text numberOfLines={1} style={{ flexShrink: 1, color: c.foregroundMuted, fontSize: 12 }}>{caption}</Text>}
        </View>
      </FoldButton>
      <HintBubble hint={help} text={hint} theme={theme} />
    </View>
    {open && <View style={{ paddingHorizontal: compact ? 14 : 12, paddingBottom: reply ? 0 : 12, gap: 8 }}>
      {turn.error ? <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{`Couldn't read the steps: ${turn.error}`}</Text>
        : !agentId ? null
        : !turn.turn ? <Spinner color={c.foregroundMuted} size={12} label="Reading the agent's steps" />
        : turn.turn.empty ? <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{empty ?? (reply ? "No messages yet. Write to the agent below, or open its chat." : "No messages yet. Open its chat to write to it.")}</Text>
        : <PrLinksProvider prs={prLinksByNumber(prs)}><TurnView turn={turn.turn} theme={theme} maxRows={steps} /></PrLinksProvider>}
    </View>}
    {open && reply && agentId && <ReplyBox theme={theme} compact={compact} agentName={name} hint={null} placeholder={`Reply to ${name}`} target={{ kind: "agent", agentId }}
      onSend={async (text, images) => { await paseo.agents.ref(agentId).send(text, images?.length ? { images } : undefined); onSent?.(); }} />}
  </View>;
}
