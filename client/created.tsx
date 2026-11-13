import { View } from "react-native";
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc, type PluginClientContext, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { Pressable, Text } from "./text";
import { Spinner } from "./motion";
import { RichText } from "./rich-text";
import { BRAND_ICONS } from "./brand-icons";
import { mergedColor, tint } from "./theme";
import { appVisible } from "./visibility";
import { taskAgentStates } from "../shared/task-status";
import { createdItemsRpc } from "../shared/contracts";
import { CREATED_KIND, CREATED_VERSION, cardFollow, cardMeta, cardPresence, cardTitle, createdCardSchema, type CreatedCard, type CreatedLive } from "../shared/created";

/** Live facts refresh this often while a card shows an open agent and the app is visible. */
export const CREATED_POLL_MS = 20_000;

type Rpc = (input: { agentIds: string[]; workspaceIds: string[] }) => Promise<CreatedLive>;

/**
 * Cards in one chat share one request: ids asked for within a frame go out together, and each card reads its own
 * entry from the answer. The RPC itself reads the engine's cached directory rows, so this is never a daemon list call.
 */
function batcher() {
  let pending: { agents: Set<string>; workspaces: Set<string>; waiters: ((v: CreatedLive | null) => void)[]; rpc: Rpc } | null = null;
  return (rpc: Rpc, card: CreatedCard): Promise<CreatedLive | null> => new Promise(resolve => {
    if (!pending) {
      const batch = pending = { agents: new Set<string>(), workspaces: new Set<string>(), waiters: [] as ((v: CreatedLive | null) => void)[], rpc };
      setTimeout(() => {
        pending = null;
        batch.rpc({ agentIds: [...batch.agents].slice(0, 40), workspaceIds: [...batch.workspaces].slice(0, 40) })
          .then(v => batch.waiters.forEach(w => w(v)), () => batch.waiters.forEach(w => w(null)));
      }, 16);
    }
    if (card.id) (card.kind === "agent" ? pending.agents : pending.workspaces).add(card.id);
    if (card.workspaceId && card.kind === "agent") pending.workspaces.add(card.workspaceId);
    pending.waiters.push(resolve);
  });
}
const batch = batcher();

export type CreatedDeps = {
  openAgent(agentId: string): void; openWorkspace(workspaceId: string): void;
  /** Paseo 0.16: an agent card follows Paseo's own agent stream instead of polling (null on 0.15: it polls). */
  watchAgent: ((agentId: string, listener: (agent: unknown) => void) => () => void) | null;
};

function CreatedCardView({ item, theme, layout, deps }: PluginTimelineItemProps<CreatedCard> & { deps: CreatedDeps }) {
  const c = theme.colors;
  const card = item.data;
  const compact = layout.compact;
  const rpc = useRpc(createdItemsRpc) as unknown as Rpc;
  const query = useQuery({
    queryKey: ["follow-up", "created", card.kind, card.id],
    queryFn: async () => (await batch(rpc, card)) ?? { agents: {}, workspaces: {} },
    enabled: card.phase === "created" && !!card.id,
    staleTime: 10_000,
    // Only while the agent isn't archived (a closed session can resume) and the app is in the foreground. This reads the
    // engine's directory snapshot; nothing here reads, prefetches or previews the agent itself.
    refetchInterval: q => !deps.watchAgent && card.kind === "agent" && card.id && q.state.data?.agents[card.id]?.state !== "archived" && appVisible() ? CREATED_POLL_MS : false,
  });
  // 0.16: Paseo pushes the agent's status and title; the card patches its own entry (taskAgentStates, the mapping the
  // server's answer uses). No RPC at all after the first read.
  const cache = useQueryClient();
  useEffect(() => {
    if (!deps.watchAgent || card.kind !== "agent" || !card.id) return;
    const id = card.id; const key = ["follow-up", "created", card.kind, id];
    return deps.watchAgent(id, agent => cache.setQueryData<CreatedLive>(key, prior => {
      const entry = prior?.agents[id];
      if (!prior || !entry) return prior;
      const a = agent as { id: string; status: string; title?: string | null; archivedAt?: string | null; backgroundWork?: { count?: unknown } | null } | null;
      const live = a ? taskAgentStates([id], [a])[id] : null;
      return { ...prior, agents: { ...prior.agents, [id]: live ? { ...entry, title: live.title ?? entry.title, state: live.state } : { ...entry, state: "archived" } } };
    }));
  }, [deps.watchAgent, card.kind, card.id, cache]);
  const live = query.data;
  const presence = cardPresence(card, live);
  const title = cardTitle(card, live);
  const meta = cardMeta(card, live);
  const follow = cardFollow(card, live);
  const opens = presence.opens && !!card.id;
  const failed = card.phase === "failed";
  // Green while working; hollow (no fill) for a closed session or an archived agent.
  const dot = presence.tone === "working" ? c.statusSuccess : presence.tone === "closed" || presence.tone === "archived" ? "closed" : null;
  const wordColor = presence.tone === "working" ? c.statusSuccess : c.foregroundMuted;
  const tile = compact ? 32 : 28;
  const chipColor = (tone: "success" | "danger" | "warning" | "merged" | "muted") => tone === "success" ? c.statusSuccess : tone === "danger" ? c.statusDanger : tone === "warning" ? c.statusWarning : tone === "merged" ? mergedColor(c) : c.foregroundMuted;
  const glyph = card.phase === "starting" ? <Spinner color={c.foregroundMuted} size={13} label={card.kind === "agent" ? "Starting" : "Creating"} />
    : failed ? <Icon name="CircleAlert" size={15} color={c.statusDanger} />
    : card.kind === "workspace" ? <Icon name="GitBranch" size={15} color={c.foregroundMuted} />
    : card.provider === "claude" ? <Icon icon={BRAND_ICONS.claude} size={15} color={c.foregroundMuted} />
    : <Icon name={card.provider === "codex" ? "SquareTerminal" : "Bot"} size={15} color={c.foregroundMuted} />;
  const label = [title, presence.word, meta, follow?.question ? `${follow.question.id} · ${follow.question.title}` : "", ...(follow?.chips.map(x => x.text) ?? []), follow?.line ?? ""].filter(Boolean).join(". ");
  const open = () => { if (!opens || !card.id) return; if (card.kind === "agent") deps.openAgent(card.id); else deps.openWorkspace(card.id); };

  const body = <>
    <View style={{ width: tile, height: tile, borderRadius: 7, backgroundColor: c.surface2, alignItems: "center", justifyContent: "center", marginTop: 1 }}>
      {glyph}
      {dot && <View style={{ position: "absolute", right: -3, bottom: -3, width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderColor: c.surface1,
        backgroundColor: dot === "closed" ? c.surface1 : dot }}>{dot === "closed" && <View style={{ flex: 1, borderRadius: 3, borderWidth: 1.5, borderColor: c.foregroundMuted }} />}</View>}
    </View>
    <View style={{ flex: 1, minWidth: 0 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: c.foreground, fontSize: compact ? 14 : 13, lineHeight: compact ? 20 : 18, fontWeight: card.phase === "created" && opens ? "600" : "500" }}>{title}</Text>
        {!!presence.word && <Text style={{ color: wordColor, fontSize: 12, lineHeight: 17 }}>{presence.word}{presence.link ? <Text style={{ color: c.foregroundMuted }}> · </Text> : null}{presence.link ? <Text style={{ color: c.foreground, fontWeight: "500" }}>{presence.link}</Text> : null}</Text>}
        {opens && <Icon name="ChevronRight" size={14} color={c.foregroundMuted} />}
      </View>
      {!!meta && <Text numberOfLines={failed ? 2 : 1} style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17, marginTop: 1 }}>{meta}</Text>}
      {follow && <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 6 }}>
        {follow.question && <View style={{ flexDirection: "row", alignItems: "center", gap: 4, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 1, backgroundColor: tint(c.statusWarning, c) }}>
          <Icon name="CircleHelp" size={12} color={c.statusWarning} /><RichText plain style={{ color: c.statusWarning, fontSize: 12, lineHeight: 17, fontVariant: ["tabular-nums"] }}>{follow.question.id}</RichText>
        </View>}
        {follow.question && <RichText plain numberOfLines={1} style={{ flex: 1, minWidth: 0, color: c.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{follow.question.title}</RichText>}
        {follow.chips.map(x => <View key={x.text} style={{ borderRadius: 5, paddingHorizontal: 6, paddingVertical: 1, backgroundColor: x.tone === "muted" ? c.surface2 : tint(chipColor(x.tone), c) }}>
          <Text style={{ color: chipColor(x.tone), fontSize: 12, lineHeight: 17, fontVariant: ["tabular-nums"] }}>{x.text}</Text>
        </View>)}
        {!!follow.line && <Text numberOfLines={1} style={{ flexShrink: 1, color: c.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{follow.line}</Text>}
      </View>}
    </View>
  </>;
  const frame = { flexDirection: "row" as const, gap: 10, alignItems: "flex-start" as const, borderRadius: 10, borderWidth: 1, borderColor: c.border, paddingHorizontal: compact ? 14 : 12, paddingVertical: compact ? 12 : 10, minHeight: compact ? 56 : undefined };
  return <View style={{ width: "100%", maxWidth: compact ? undefined : 560 }}>
    {opens
      ? <Pressable accessibilityRole="link" accessibilityLabel={label} accessibilityHint={card.kind === "agent" ? presence.link === "Open chat" ? "Opens the agent's chat" : "Opens the agent" : "Opens the workspace"} onPress={open}
          style={state => ({ ...frame, backgroundColor: state.pressed || (state as { hovered?: boolean }).hovered ? c.surface2 : c.surface1 })}>{body}</Pressable>
      : <View accessible accessibilityLabel={label} style={{ ...frame, backgroundColor: c.surface1 }}>{body}</View>}
  </View>;
}

/**
 * Paseo's create_agent / create_workspace calls become a card that opens what they made (docs/client.md). The card
 * replaces the raw call, so Paseo's "N tool calls" group no longer counts it, like the Done card. The transform lives
 * in client/chat.tsx's one tool_call transformer (`createdCard`); this registers the renderer. Hosts whose client API
 * has no timeline transformers or renderers get nothing registered and keep the plain row.
 */
export const timelineSupported = (client: PluginClientContext) => {
  const api = client as Partial<Pick<PluginClientContext, "addTimelineTransformer" | "addTimelineRenderer">>;
  return typeof api.addTimelineTransformer === "function" && typeof api.addTimelineRenderer === "function";
};
export function contributeCreated(client: PluginClientContext, deps: CreatedDeps): () => void {
  if (!timelineSupported(client)) return () => {};
  const remove = client.addTimelineRenderer({ kind: CREATED_KIND, version: CREATED_VERSION, schema: createdCardSchema, Component: props => <CreatedCardView {...props} deps={deps} /> });
  return () => { void remove(); };
}
