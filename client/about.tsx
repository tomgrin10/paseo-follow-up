import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { workspaceAboutRpc } from "../shared/contracts";
import { aboutDisplay, linkLine, SOURCE_LABEL, type AboutLink, type AboutView } from "../shared/about";
import { errorText } from "../shared/errors";
import { Button, text, type Theme } from "./kit";
import { Spinner } from "./motion";
import { useTick } from "./home-data";
import type { Colors } from "./theme";

const OPEN_KEY = "follow-up.about.open";
/** Open/closed is per device (web and desktop storage). Native or blocked storage: this session only. */
let memoryOpen: boolean | null = null;
const readOpen = (): boolean => {
  try { const v = (globalThis as { localStorage?: Storage }).localStorage?.getItem(OPEN_KEY); if (v === "1" || v === "0") return v === "1"; } catch { /* memory only */ }
  return memoryOpen ?? false;
};
const writeOpen = (open: boolean) => {
  memoryOpen = open;
  try { (globalThis as { localStorage?: Storage }).localStorage?.setItem(OPEN_KEY, open ? "1" : "0"); } catch { /* memory only */ }
};

export const aboutKey = (workspaceId: string) => ["follow-through", "about", workspaceId] as const;

/**
 * "What's this about?" at the top of Home's detail pane and the workspace panel. Collapsed: the label and, when one
 * is cached, the one-line gist. Open: the overview, what's linked, and when it was written with a Refresh.
 */
export function AboutSection({ workspaceId, theme, compact, flush = false }: { workspaceId: string; theme: Theme; compact: boolean; flush?: boolean }) {
  const c = theme.colors; const t = text(c);
  const [open, setOpenState] = useState(readOpen);
  const [refreshing, setRefreshing] = useState(false);
  const read = useRpc(workspaceAboutRpc);
  const client = useQueryClient();
  const query = useQuery({
    queryKey: [...aboutKey(workspaceId), open],
    queryFn: () => read({ workspaceId, open }),
    // Polls only while an overview is being written; otherwise one read per open (and per Refresh).
    refetchInterval: q => (q.state.data as AboutView | undefined)?.status === "pending" ? 3000 : false,
    staleTime: 60_000,
  });
  useTick(60_000);
  const view = query.data ?? null;
  const d = aboutDisplay(view, Date.now());
  const toggle = () => { const next = !open; writeOpen(next); setOpenState(next); };
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try { const next = await read({ workspaceId, open: true, refresh: true }); client.setQueryData([...aboutKey(workspaceId), true], next); }
    catch { /* the query's error shows */ } finally { setRefreshing(false); }
  };
  const busy = refreshing || view?.status === "pending";

  const failedKinds = new Set(view?.record?.failed ?? []);

  // Collapsed it's a plain disclosure row; open, a hairline frame with no fill so the ask stays the raised block.
  return <View style={{ borderRadius: 10, borderWidth: open ? 1 : 0, borderColor: c.border, marginHorizontal: flush ? 0 : compact ? 16 : 12, marginTop: flush ? 0 : 8 }}>
    <Pressable accessibilityRole="button" aria-expanded={open} accessibilityState={{ expanded: open }} accessibilityLabel={`${open ? "Hide" : "Show"} what this workspace is about`}
      accessibilityHint={d.gist && !open ? d.gist : undefined} onPress={toggle}
      style={state => ({ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: open ? 12 : 8, marginHorizontal: open ? 0 : -8, minHeight: compact ? 44 : 32, paddingVertical: 6, borderRadius: 8,
        backgroundColor: state.pressed ? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
      <Icon name={open ? "ChevronDown" : "ChevronRight"} size={14} color={c.foregroundMuted} />
      <Text style={[t.label, { flexShrink: 0 }]}>What's this about?</Text>
      {!open && d.gist ? <Text numberOfLines={1} style={[t.meta, { flex: 1, minWidth: 0 }]}>{d.gist}</Text> : <View style={{ flex: 1 }} />}
      {!open && view?.status === "pending" && !d.gist && <Spinner color={c.foregroundMuted} size={11} label="Summarizing" />}
    </Pressable>
    {open && <View style={{ paddingHorizontal: 12, paddingBottom: 10, gap: 12 }}>
      <Overview d={d} view={view} c={c} compact={compact} loading={query.isPending} error={query.error ? errorText(query.error) : null} />
      {/* Nothing is claimed about links until an overview exists: "none found" only after a finished write. */}
      {d.body === "overview" && <View style={{ gap: 4 }}>
        <Text accessibilityRole="header" style={[t.small, { fontWeight: "600", letterSpacing: 0.5, textTransform: "uppercase" }]}>Linked</Text>
        {d.links.length ? d.links.map(l => <LinkRow key={l.key} l={l} c={c} compact={compact} failed={failedKinds.has(SOURCE_LABEL[l.kind])} />)
          : <Text style={t.meta}>{d.empty}</Text>}
      </View>}
      {view?.record && <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={[t.small, { flex: 1, minWidth: 0 }]}>{d.footer}</Text>
        <Button theme={theme} compact={compact} kind="ghost" icon="RefreshCw" title={busy ? "Summarizing…" : "Refresh"} accessibilityLabel="Summarize again" disabled={busy} onPress={() => void refresh()} />
      </View>}
      {!view?.record && view?.status === "failed" && <View style={{ flexDirection: "row" }}>
        <Button theme={theme} compact={compact} kind="ghost" icon="RefreshCw" title={busy ? "Summarizing…" : "Try again"} disabled={busy} onPress={() => void refresh()} />
      </View>}
    </View>}
  </View>;
}

function Overview({ d, view, c, compact, loading, error }: { d: ReturnType<typeof aboutDisplay>; view: AboutView | null; c: Colors; compact: boolean; loading: boolean; error: string | null }) {
  const t = text(c);
  const [more, setMore] = useState(false);
  // onTextLayout doesn't fire on web; about 200 characters fill four lines at phone width.
  const long = compact && (d.overview?.length ?? 0) > 200;
  // Context, not the ask: body size, a step quieter than the ask's text. On a phone, four lines with More.
  if (d.body === "overview") return <View style={{ gap: 4 }}>
    <Text selectable numberOfLines={compact && !more ? 4 : undefined}
      style={[t.body, { lineHeight: 19, color: c.foreground, opacity: 0.88 }]}>{d.overview}</Text>
    {long && <Pressable accessibilityRole="button" onPress={() => setMore(m => !m)} hitSlop={12}><Text style={[t.small, { color: c.foreground }]}>{more ? "Less" : "More"}</Text></Pressable>}
    {d.refreshing && <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}><Spinner color={c.foregroundMuted} size={10} label="Summarizing" /><Text style={t.small}>Updating…</Text></View>}
  </View>;
  if (d.body === "summarizing" || loading) return <View style={{ gap: 6 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Spinner color={c.foregroundMuted} size={12} label="Summarizing" />
      <Text style={t.meta}>Summarizing…</Text>
    </View>
    {d.excerpt && <Text numberOfLines={3} style={[t.meta, { fontStyle: "italic" }]}>“{d.excerpt}”</Text>}
  </View>;
  if (error) return <Text accessibilityRole="alert" style={[t.meta, { color: c.statusDanger }]}>Couldn't load the overview: {error}</Text>;
  if (d.body === "failed") return <Text accessibilityRole="alert" style={t.meta}>Couldn't write an overview{view?.error ? `: ${view.error}` : "."}</Text>;
  return <Text style={t.meta}>No overview yet.</Text>;
}

function LinkRow({ l, c, compact, failed }: { l: AboutLink; c: Colors; compact: boolean; failed: boolean }) {
  const t = text(c);
  const line = linkLine(l);
  const bare = !l.title && !l.excerpt;
  // A source that couldn't be read says so on its own row, muted: it doesn't need the developer.
  const meta = bare && failed ? [...line.meta, `${SOURCE_LABEL[l.kind]} couldn't be read`] : line.meta;
  return <Pressable accessibilityRole="link" accessibilityLabel={[SOURCE_LABEL[l.kind], line.lead, line.title, ...meta].filter(Boolean).join(", ")} disabled={!l.url}
    onPress={() => { if (l.url) void openExternalUrl(l.url).catch(() => undefined); }}
    style={state => ({ flexDirection: "row", alignItems: "flex-start", gap: 10, minHeight: compact ? 44 : undefined, paddingVertical: compact ? 8 : 4, paddingHorizontal: 6, marginHorizontal: -6, borderRadius: 6, backgroundColor: (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
    <Text numberOfLines={1} style={[t.small, { width: 46, paddingTop: 2 }]}>{SOURCE_LABEL[l.kind]}</Text>
    <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
      <Text numberOfLines={2} style={t.body}>
        <Text style={{ fontWeight: "500", fontVariant: ["tabular-nums"], color: bare ? c.foregroundMuted : c.foreground }}>{line.lead}</Text>
        {line.title ? <Text>{`  ${line.title}`}</Text> : bare && l.url && l.kind !== "slack" ? <Text style={{ color: c.foregroundMuted }}>{"  link"}</Text> : null}
      </Text>
      {!!meta.length && <Text numberOfLines={1} style={t.small}>{meta.join(" · ")}</Text>}
    </View>
    {!!l.url && <View style={{ paddingTop: 3 }}><Icon name="ArrowUpRight" size={12} color={c.foregroundMuted} /></View>}
  </Pressable>;
}
