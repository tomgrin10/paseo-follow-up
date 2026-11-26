import { View } from "react-native";
import { Pressable, Text } from "./text";
import type { InboxStore } from "./inbox-store";
import { useInbox } from "./inbox";
import { focusRing, text, type Theme } from "./kit";
import type { Workspace } from "../shared/model";
import { positionText, workspaceNow, type Now } from "../shared/now";
import type { InboxRow } from "../shared/inbox";

const NO_INBOX = { subscribe: () => () => undefined, version: () => 0, rows: () => [] } as unknown as InboxStore;
const NO_ROWS: readonly InboxRow[] = [];

/**
 * What each agent in the workspace is working on now (shared/now.ts), one row per agent, main agent first: the work
 * ("Capping the retry gap", its place "2 of 4" when the agent listed its steps), then who and its state ("Main agent ·
 * working 6m"). Nothing known: the state is the row's line. No label, no placeholder, no live stream: it reads the
 * record and the inbox rows the panel already has. A row opens that agent's chat.
 */
export function AgentLines({ workspace: w, inbox, theme, compact, now, openAgent }: { workspace: Workspace; inbox?: InboxStore; theme: Theme; compact: boolean; now: number; openAgent?: (agentId: string) => void }) {
  const c = theme.colors;
  const rows = useInbox(inbox ?? NO_INBOX, () => inbox?.rows() ?? NO_ROWS);
  // A contributor that has closed has nothing to say here; the main agent always has its row.
  // Nothing known about an agent (no work, an unknown state): no row, never a placeholder.
  const lines = workspaceNow(w, rows, now).filter(n => (n.role === "main" || n.state.kind !== "closed") && (n.work || n.state.text));
  const names = new Map(rows.map(r => [r.agentId, r.title]));
  if (!lines.length) return null;
  return <View style={{ marginHorizontal: compact ? 16 : 12, marginTop: 12, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, overflow: "hidden" }}>
    {lines.map((n, i) => <AgentLine key={n.agentId} n={n} who={n.role === "main" ? "Main agent" : names.get(n.agentId)?.trim() || w.taskAgents?.[n.agentId]?.title?.trim() || "Another agent"} first={i === 0} theme={theme} compact={compact} openAgent={openAgent} />)}
  </View>;
}

function AgentLine({ n, who, first, theme, compact, openAgent }: { n: Now; who: string; first: boolean; theme: Theme; compact: boolean; openAgent?: (agentId: string) => void }) {
  const c = theme.colors; const t = text(c, compact);
  const tone = n.state.kind === "permission" || n.state.kind === "asking" ? c.statusWarning : n.state.kind === "working" || n.state.kind === "compacting" ? c.statusSuccess : c.foregroundMuted;
  const position = positionText(n.work);
  // The work leads; without one the state is the headline and the second line only says whose it is.
  const head = n.work?.text ?? n.state.text;
  const state = n.work && n.state.text ? n.state.text.charAt(0).toLowerCase() + n.state.text.slice(1) : null;
  const meta = [who, state].filter(Boolean).join(" · ");
  const label = [who, n.work?.text, position, n.state.text].filter(Boolean).join(". ");
  return <Pressable accessibilityRole={openAgent ? "button" : undefined} accessibilityLabel={label} accessibilityHint={openAgent ? "Opens this agent's chat" : undefined} disabled={!openAgent}
    onPress={() => openAgent?.(n.agentId)}
    style={state => ({ ...focusRing((state as { focused?: boolean }).focused, c, true), flexDirection: "row", gap: 10, paddingHorizontal: compact ? 14 : 12, paddingVertical: compact ? 12 : 9, minHeight: compact ? 56 : 0,
      borderTopWidth: first ? 0 : 1, borderTopColor: c.border, backgroundColor: (state as { hovered?: boolean }).hovered || state.pressed ? c.surface2 : "transparent" })}>
    <View style={{ width: 8, height: 8, borderRadius: 4, marginTop: compact ? 6 : 5, backgroundColor: tone }} />
    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
        <Text numberOfLines={2} style={[t.body, { flex: 1, minWidth: 0 }]}>{head}</Text>
        {position && <Text style={[t.meta, { paddingTop: compact ? 2 : 1 }]}>{position}</Text>}
      </View>
      <Text numberOfLines={2} style={t.meta}>{meta}</Text>
    </View>
  </Pressable>;
}
