import { useRef } from "react";
import { View } from "react-native";
import { Pressable, Text } from "./text";
import type { InboxStore } from "./inbox-store";
import { useInbox } from "./inbox";
import { focusRing, text, type Theme } from "./kit";
import { Spinner } from "./motion";
import { runningColor } from "./theme";
import { usePeekLine } from "./turn-view";
import type { Workspace } from "../shared/model";
import { positionText, workspaceNow, type Now } from "../shared/now";
import type { InboxRow } from "../shared/inbox";

const NO_INBOX = { subscribe: () => () => undefined, version: () => 0, rows: () => [] } as unknown as InboxStore;
const NO_ROWS: readonly InboxRow[] = [];

/**
 * What each agent in the workspace is working on now (shared/now.ts), one row per agent, main agent first: the work
 * ("Capping the retry gap", its place "2 of 4" when the agent listed its steps), then who and its state ("Main agent ·
 * working 6m"). Nothing stated: one line, who and the state ("Main agent · working 1h"). No label, no placeholder, no live stream: it reads the
 * record and the inbox rows the panel already has. A row opens that agent's chat.
 */
export function AgentLines({ workspace: w, inbox, theme, compact, now, openAgent, peek = false, bare = false, selected = null, onSelect }: { workspace: Workspace; inbox?: InboxStore; theme: Theme; compact: boolean; now: number; openAgent?: (agentId: string) => void;
  /** Lines peek at their agent's turn (client/turn-view.tsx), under a PeekHost. */
  peek?: boolean;
  /** Inside the workspace view's agent card (client/agent-card.tsx): no frame of its own. */
  bare?: boolean;
  /** The agent card's selected agent (its Recent steps and reply box); its row is marked. */
  selected?: string | null;
  /** A row's press in the agent card: switches the card to that agent; Cmd/Ctrl (`chat`) opens its chat. */
  onSelect?: (agentId: string, chat: boolean) => void }) {
  const c = theme.colors;
  const rows = useInbox(inbox ?? NO_INBOX, () => inbox?.rows() ?? NO_ROWS);
  // A contributor that has closed has nothing to say here; the main agent always has its row.
  // Nothing known about an agent (no work, an unknown state): no row, never a placeholder.
  const lines = workspaceNow(w, rows, now).filter(n => (n.role === "main" || n.state.kind !== "closed") && (n.work || n.state.text));
  const names = new Map(rows.map(r => [r.agentId, r.title]));
  if (!lines.length) return null;
  const many = lines.length > 1;
  const drawn = lines.map((n, i) => <AgentLine key={n.agentId} n={n} who={n.role === "main" ? "Main agent" : names.get(n.agentId)?.trim() || w.taskAgents?.[n.agentId]?.title?.trim() || "Another agent"} first={i === 0} theme={theme} compact={compact} openAgent={openAgent} peek={peek}
    selected={many && selected === n.agentId} onSelect={onSelect} />);
  if (bare) return <View>{drawn}</View>;
  return <View style={{ marginHorizontal: compact ? 16 : 12, marginTop: 12, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, overflow: "hidden" }}>{drawn}</View>;
}

function AgentLine({ n, who, first, theme, compact, openAgent, peek, selected = false, onSelect }: { n: Now; who: string; first: boolean; theme: Theme; compact: boolean; openAgent?: (agentId: string) => void; peek: boolean; selected?: boolean; onSelect?: (agentId: string, chat: boolean) => void }) {
  const c = theme.colors; const t = text(c, compact);
  const ref = useRef<View>(null);
  // Desktop: hover or focus shows the agent's turn; a phone's tap opens it in a sheet with Open chat. Click still opens the chat.
  const peeks = usePeekLine(peek ? n.agentId : null, () => ref.current);
  // Running is Home's running mark (the spinner in runningColor), never green: green is idle in Paseo's sidebar.
  const running = n.state.kind === "working" || n.state.kind === "compacting";
  const tone = n.state.kind === "permission" || n.state.kind === "asking" ? c.statusWarning : c.foregroundMuted;
  const position = positionText(n.work);
  const state = n.state.text ? n.state.text.charAt(0).toLowerCase() + n.state.text.slice(1) : null;
  // The work leads, with who and the state under it. Nothing stated: the state is the only line ("Main agent · working 1h").
  const head = n.work ? n.work.text : [who, state].filter(Boolean).join(" · ");
  const meta = n.work ? [who, state].filter(Boolean).join(" · ") : null;
  const label = [who, n.work?.text, position, n.state.text].filter(Boolean).join(". ");
  const tap = peeks?.onPress;
  // In the agent card a row selects its agent; Cmd/Ctrl-click (web) opens its chat instead.
  const select = onSelect ? (e: { nativeEvent?: unknown }) => { const k = (e?.nativeEvent ?? {}) as { metaKey?: boolean; ctrlKey?: boolean }; onSelect(n.agentId, !!(k.metaKey || k.ctrlKey)); } : null;
  return <Pressable ref={ref} accessibilityRole={openAgent || tap || select ? "button" : undefined} accessibilityLabel={label} accessibilityState={onSelect ? { selected } : undefined}
    accessibilityHint={select ? "Shows this agent's recent steps here. Cmd or Ctrl opens its chat" : tap ? "Shows what this agent is doing" : openAgent ? "Opens this agent's chat" : undefined} disabled={!openAgent && !tap && !select}
    {...peeks} onPress={select ?? tap ?? (() => openAgent?.(n.agentId))}
    style={state => ({ ...focusRing((state as { focused?: boolean }).focused, c, true), flexDirection: "row", alignItems: meta ? "flex-start" : "center", gap: 10, paddingHorizontal: compact ? 14 : 12, paddingVertical: compact ? 12 : 9, minHeight: compact ? 56 : 0,
      borderTopWidth: first ? 0 : 1, borderTopColor: c.border, borderLeftWidth: onSelect ? 2 : 0, borderLeftColor: selected ? c.foregroundMuted : "transparent",
      backgroundColor: (state as { hovered?: boolean }).hovered || state.pressed ? c.surface2 : selected ? c.surface1 : "transparent" })}>
    <View style={{ width: 12, height: compact ? 20 : 18, alignItems: "center", justifyContent: "center" }}>
      {running ? <Spinner color={runningColor(c)} size={12} label="Running" /> : <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tone }} />}
    </View>
    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
        <Text numberOfLines={2} style={[t.body, { flex: 1, minWidth: 0 }]}>{head}</Text>
        {position && <Text style={[t.meta, { paddingTop: compact ? 2 : 1 }]}>{position}</Text>}
      </View>
      {meta && <Text numberOfLines={2} style={t.meta}>{meta}</Text>}
    </View>
  </Pressable>;
}
