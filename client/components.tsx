import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { graphitePrUrl, compactPrStatus, settledForDisplay } from "../shared/presentation";
import { summary, type Workspace, type Pr, type Status } from "../shared/model";
import { PrControls } from "./pr-controls";
export type Theme = PluginHostProps["theme"];
export const colorFor = (theme: Theme, state: Status) => state === "done" ? theme.colors.statusSuccess : state === "needs-you" ? theme.colors.statusDanger : state === "waiting" ? theme.colors.statusWarning : theme.colors.accent;
export function mergedColor(theme: Theme): string {
  const provided = (theme.colors as Theme["colors"] & { statusMerged?: string }).statusMerged;
  if (provided) return provided;
  // The plugin SDK omits Paseo's merged token; use the host's light/dark tones.
  const raw = theme.colors.surface0.replace(/^#/, "");
  const hex = raw.length === 3 ? raw.split("").map(c => c + c).join("") : raw;
  const brightness = [0, 2, 4].reduce((sum, offset) => sum + parseInt(hex.slice(offset, offset + 2), 16), 0) / 3;
  return brightness < 128 ? "#a890d5" : "#7347af";
}
export function Button({ title, onPress, theme, primary = false, disabled = false, icon, compact = false, accessibilityLabel }: { title: string; onPress: () => void; theme: Theme; primary?: boolean; disabled?: boolean; icon?: string; compact?: boolean; accessibilityLabel?: string }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title} disabled={disabled} onPress={onPress} style={({ pressed }) => ({ minHeight: compact ? 44 : 36, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: primary ? theme.colors.accent : pressed ? theme.colors.surface2 : theme.colors.surface1, borderWidth: primary ? 0 : 1, borderColor: theme.colors.border, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 })}>
    {icon && <Icon name={icon} size={14} color={primary ? theme.colors.accentForeground : theme.colors.foreground} />}
    <Text style={{ fontSize: 12, fontWeight: "600", color: primary ? theme.colors.accentForeground : theme.colors.foreground }}>{title}</Text>
  </Pressable>;
}
export function Section({ title, count, theme, children, compact = false, initiallyExpanded = true }: { title: string; count?: number; theme: Theme; children: ReactNode; compact?: boolean; initiallyExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  return <View style={{ gap: expanded ? 8 : 0, marginTop: 16 }}><Pressable accessibilityRole="button" accessibilityLabel={`${expanded ? "Collapse" : "Expand"} ${title}`} accessibilityState={{ expanded }} aria-expanded={expanded} onPress={() => setExpanded(!expanded)} style={{ minHeight: compact ? 44 : 36, flexDirection: "row", gap: 6, alignItems: "center" }}><Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={14} color={theme.colors.foregroundMuted} /><Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.foreground, flex: 1 }}>{title}</Text>{count !== undefined && <Text style={{ fontSize: 12, color: theme.colors.foregroundMuted }}>{count}</Text>}</Pressable><View accessibilityElementsHidden={!expanded} importantForAccessibility={expanded ? "auto" : "no-hide-descendants"} style={{ display: expanded ? "flex" : "none", gap: 8 }}>{children}</View></View>;
}
export function StatusLabel({ workspace, theme }: { workspace: Workspace; theme: Theme }) {
  const state = summary(workspace);
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}><Icon name={state.status === "done" ? "CircleCheck" : state.status === "needs-you" ? "CircleAlert" : state.status === "waiting" ? "Clock" : "Activity"} size={14} color={colorFor(theme, state.status)} /><Text style={{ color: colorFor(theme, state.status), fontSize: 12, fontWeight: "600" }}>{state.label}</Text></View>;
}
export function PrRow({ pr, theme, onOpen, compact, workspace, browserReady }: { browserReady: boolean; pr: Pr; theme: Theme; onOpen: (url: string) => void; compact: boolean; workspace: Workspace }) {
  const s = pr.snapshot;
  const [details, setDetails] = useState(false);
  const { label: status, tone } = compactPrStatus(pr);
  const color = tone === "merged" ? mergedColor(theme) : tone === "approved" ? theme.colors.statusSuccess : tone === "warning" ? theme.colors.statusWarning : theme.colors.foregroundMuted;
  return <View style={{ paddingVertical: compact ? 6 : 5, gap: 3, borderTopWidth: 1, borderColor: theme.colors.border }}><View style={{ flexDirection: "row", alignItems: "center" }}><Pressable accessibilityRole="link" accessibilityLabel={`Open ${pr.repo} pull request ${pr.number} in Graphite: ${s?.title ?? pr.stack}, ${status}`} onPress={() => onOpen(graphitePrUrl(pr))} style={({ pressed }) => ({ flex: 1, backgroundColor: pressed ? theme.colors.surface1 : "transparent", minHeight: compact ? 44 : 36, justifyContent: "center" })}>
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}><View style={{ width: 88, gap: 2 }}><View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}><Icon name={s?.state === "MERGED" ? "GitMerge" : "GitPullRequest"} size={14} color={color} /><Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 16 }}>#{pr.number}</Text></View><Text style={{ fontSize: 11, lineHeight: 16, color }}>{status}</Text></View><Text numberOfLines={details ? undefined : 2} style={{ color: theme.colors.foreground, fontSize: 13, lineHeight: 18, flex: 1 }}>{s?.title ?? `${pr.repo} pull request`}</Text></View>
    </Pressable><Pressable accessibilityRole="button" accessibilityLabel={`${details ? "Hide" : "Show"} details for PR ${pr.number}`} aria-expanded={details} accessibilityState={{ expanded: details }} onPress={() => setDetails(!details)} style={{ minHeight: compact ? 44 : 36, width: compact ? 44 : 36, justifyContent: "center", alignItems: "center" }}><Icon name={details ? "ChevronUp" : "ChevronDown"} size={12} color={theme.colors.foregroundMuted} /></Pressable></View>
    {details && <View style={{ gap: 4 }}><Text style={{ fontSize: 12, color: theme.colors.foregroundMuted }}>{pr.repo} · {s?.state === "MERGED" ? "Merged" : status}</Text>{pr.error && <Text style={{ fontSize: 12, color: theme.colors.statusWarning }}>{pr.error}</Text>}{s?.reviewers?.complete && [...s.reviewers.requested, ...s.reviewers.teams, ...s.reviewers.reviewed].length > 0 && <Text style={{ fontSize: 12, lineHeight: 18, color: theme.colors.foregroundMuted }}>Reviewers: {[...new Set([...s.reviewers.requested, ...s.reviewers.teams.map(team => `team/${team}`), ...s.reviewers.reviewed])].join(", ")}</Text>}{s?.deployment && <Text style={{ fontSize: 12, lineHeight: 18, color: theme.colors.foregroundMuted }}>{s.deployment.evidence}</Text>}</View>}
    {s?.state === "OPEN" && <PrControls browserReady={browserReady} pr={pr} workspace={workspace} theme={theme} compact={compact} />}
  </View>;
}
export function StackGroup({ name, prs, theme, onOpen, compact, workspace, browserReady }: { browserReady: boolean; name: string; prs: Pr[]; theme: Theme; onOpen: (url: string) => void; compact: boolean; workspace: Workspace }) {
  const [expanded, setExpanded] = useState(true);
  const [history, setHistory] = useState(false);
  const open = prs.filter(p => !settledForDisplay(p));
  const past = prs.filter(settledForDisplay);
  const fullySettled = open.length === 0;
  const sort = (rows: Pr[]) => {
    const depth = (p: Pr, seen = new Set<string>()): number => { if (seen.has(p.key)) return 0; seen.add(p.key); const parent = prs.find(x => x.key === p.parent); return parent ? depth(parent, seen) + 1 : 0; };
    return [...rows].sort((a, b) => depth(a) - depth(b) || a.number - b.number);
  };
  return <View style={{ marginTop: 3 }}><Pressable accessibilityRole="button" accessibilityLabel={`${expanded ? "Collapse" : "Expand"} ${name} stack`} accessibilityState={{ expanded }} aria-expanded={expanded} onPress={() => setExpanded(!expanded)} style={{ minHeight: compact ? 44 : 36, flexDirection: "row", alignItems: "center", gap: 6 }}><Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={14} color={theme.colors.foregroundMuted} /><Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600", flex: 1 }}>{name}</Text><Text style={{ fontSize: 12, color: theme.colors.foregroundMuted }}>{fullySettled ? past.length : open.length}</Text></Pressable>
    {expanded && <View>{sort(open).map(pr => <PrRow browserReady={browserReady} key={pr.key} pr={pr} workspace={workspace} theme={theme} onOpen={onOpen} compact={compact} />)}{past.length > 0 && !fullySettled && <Pressable accessibilityRole="button" accessibilityState={{ expanded: history }} aria-expanded={history} accessibilityLabel={`${history ? "Hide" : "Show"} settled PRs in ${name}`} onPress={() => setHistory(!history)} style={{ paddingVertical: 10, minHeight: compact ? 44 : 36, flexDirection: "row", alignItems: "center", gap: 6 }}><Icon name={history ? "ChevronDown" : "ChevronRight"} size={12} color={theme.colors.foregroundMuted} /><Text style={{ fontSize: 12, color: theme.colors.foregroundMuted }}>{history ? "Hide" : "Show"} {past.length} settled PR{past.length === 1 ? "" : "s"}</Text></Pressable>}{(fullySettled || history) && sort(past).map(pr => <PrRow browserReady={browserReady} key={pr.key} pr={pr} workspace={workspace} theme={theme} onOpen={onOpen} compact={compact} />)}</View>}
  </View>;
}
