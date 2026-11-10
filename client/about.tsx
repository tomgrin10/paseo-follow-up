import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Platform, Text, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { workspaceAboutRpc } from "../shared/contracts";
import { shortFooter, summaryDisplay, summaryLine, type AboutView } from "../shared/about";
import { errorText } from "../shared/errors";
import { Button, text, type Theme } from "./kit";
import { useReducedMotion } from "./motion";
import { useTick } from "./home-data";

export const aboutKey = (workspaceId: string) => ["follow-through", "about", workspaceId] as const;

/**
 * The Summary: one sentence under the workspace's title saying what it's for (Tom, 2026-11-10). One read shape for
 * every place that shows it (the panel header, Home's detail header, the panel's Summary row), so they share one cache
 * entry. Reading asks the server to write one when none is current; its TTL, back-off, budgets and the memory check
 * decide whether it actually does. Polls only while one is being written.
 */
export function useSummary(workspaceId: string) {
  const read = useRpc(workspaceAboutRpc);
  const client = useQueryClient();
  const query = useQuery({
    queryKey: aboutKey(workspaceId),
    queryFn: () => read({ workspaceId, open: true }),
    refetchInterval: q => (q.state.data as AboutView | undefined)?.status === "pending" ? 3000 : false,
    staleTime: 60_000,
  });
  const [rewriting, setRewriting] = useState(false);
  const rewrite = async () => {
    if (rewriting) return;
    setRewriting(true);
    try { client.setQueryData(aboutKey(workspaceId), await read({ workspaceId, open: true, refresh: true })); }
    catch { /* the query's error shows */ } finally { setRewriting(false); }
  };
  return { query, view: query.data ?? null, rewrite, rewriting };
}

/**
 * Under the title: the sentence, or the goal when there's no sentence yet, or "Writing a summary…" when there's
 * neither. Plain, selectable, muted, at most three lines. No label, no control, no spinner.
 */
export function SummaryLine({ workspace, theme, compact, lead = false }: { workspace: { id: string; title: string; goal: string }; theme: Theme; compact: boolean; lead?: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const { view } = useSummary(workspace.id);
  const line = summaryLine(summaryDisplay(view, Date.now()), workspace);
  const reduced = useReducedMotion();
  const fade = useRef(new Animated.Value(1)).current;
  const shown = line?.kind === "summary" ? line.text : null;
  const seen = useRef(shown);
  // A sentence arriving fades in once; no height animation, and nothing with reduced motion.
  useEffect(() => {
    if (!shown || shown === seen.current) return;
    seen.current = shown;
    if (reduced) return;
    fade.setValue(0);
    Animated.timing(fade, { toValue: 1, duration: 200, easing: Easing.out(Easing.quad), useNativeDriver: Platform.OS !== "web" }).start();
  }, [shown, reduced, fade]);
  if (!line) return null;
  if (line.kind === "writing") return <Text style={t.meta}>{line.text}</Text>;
  // `lead`: the large view, where this line stands in for the title, keeps the goal's foreground lead style.
  const style = [t.body, { color: lead ? c.foreground : c.foregroundMuted }];
  return <Animated.View style={{ opacity: fade }}>
    <Text selectable numberOfLines={3} style={style}
      accessibilityLabel={line.kind === "summary" ? `Summary: ${line.text}` : undefined}
      {...(Platform.OS === "web" ? { title: line.text } as object : {})}>{line.text}</Text>
  </Animated.View>;
}

/**
 * The panel's Summary row (inside "Spec, agent and recovery"): who wrote it and when, and Rewrite. The agent tool
 * `workspace_about` with refresh=true does the same.
 */
export function SummaryRow({ workspaceId, theme, compact }: { workspaceId: string; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const { query, view, rewrite, rewriting } = useSummary(workspaceId);
  useTick(60_000);
  const d = summaryDisplay(view, Date.now());
  const busy = rewriting || d.pending;
  const line = query.error ? `Couldn't load the summary: ${errorText(query.error)}`
    : d.footer ? (compact ? shortFooter(d.footer) : d.footer)
    : d.failed ? "Couldn't write a summary"
    : d.pending ? "Writing a summary…" : "No summary yet";
  const action = busy ? "Rewriting…" : d.failed ? "Try again" : d.sentence ? "Rewrite" : "Write summary";
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: compact ? 48 : 36 }}>
    <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
      <Text style={t.label}>Summary</Text>
      <Text numberOfLines={1} accessibilityRole={d.failed || query.error ? "alert" : undefined} style={t.meta}>{line}</Text>
    </View>
    <Button theme={theme} compact={compact} kind="ghost" icon="RefreshCw" title={action} accessibilityLabel="Write a new summary"
      accessibilityHint={d.footer ?? undefined} disabled={busy} onPress={() => void rewrite()} />
  </View>;
}
