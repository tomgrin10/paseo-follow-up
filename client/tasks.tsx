import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Obligation, Workspace } from "../shared/model";
import { taskSchedule, type TaskTrigger } from "../shared/task-trigger";
import { taskTriggerRpc } from "../shared/contracts";
import { Button, type Theme } from "./components";

function TriggerEditor({ obligation: o, workspace, theme, compact }: { obligation: Obligation; workspace: Workspace; theme: Theme; compact: boolean }) {
  const [event, setEvent] = useState<TaskTrigger["event"] | "manual">(o.enable_follow_up && o.trigger ? o.trigger.event : "manual");
  const [days, setDays] = useState(String(o.trigger?.delayDays ?? 0));
  const [prs, setPrs] = useState(o.afterPrs);
  const rpc = useRpc(taskTriggerRpc); const cache = useQueryClient();
  const gated = event === "merge" || event === "deploy";
  const valid = !gated || prs.length > 0 && /^\d+$/.test(days) && Number(days) <= 3650;
  const save = useMutation({ mutationFn: () => rpc({ workspaceId: workspace.id, obligationId: o.id, expectedRevision: o.revision, afterPrs: event === "now" ? [] : prs, trigger: event === "manual" ? null : { event, delayDays: gated ? Number(days) : 0 } }), onSuccess: async () => { await cache.invalidateQueries(); } });
  const busy = save.isPending;
  return <View style={{ gap: 8, marginTop: 8 }}>
    <Text style={{ fontSize: 12, color: theme.colors.foregroundMuted }}>Send task</Text>
    <View accessibilityRole="radiogroup" accessibilityLabel={`Send trigger for ${o.title}`} style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {([["manual", "Manual"], ["now", "Now"], ["merge", "After merge"], ["deploy", "After deploy"]] as const).map(([value, label]) => <Pressable key={value} accessibilityRole="radio" accessibilityLabel={label} aria-checked={event === value} accessibilityState={{ checked: event === value, disabled: busy }} disabled={busy} onPress={() => { setEvent(value); save.reset(); }} style={{ minHeight: compact ? 44 : 36, justifyContent: "center", paddingHorizontal: 10, borderRadius: 6, borderWidth: 1, borderColor: event === value ? theme.colors.accent : theme.colors.border, backgroundColor: event === value ? theme.colors.accent : theme.colors.surface1 }}><Text style={{ fontSize: 12, color: event === value ? theme.colors.accentForeground : theme.colors.foreground }}>{label}</Text></Pressable>)}
    </View>
    {gated && <>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Text style={{ fontSize: 12, color: theme.colors.foregroundMuted }}>Delay (days)</Text><TextInput accessibilityLabel="Delay in days" inputMode="numeric" value={days} editable={!busy} onChangeText={setDays} style={{ width: 70, minHeight: compact ? 44 : 36, paddingHorizontal: 10, borderRadius: 6, borderWidth: 1, borderColor: theme.colors.border, color: theme.colors.foreground, backgroundColor: theme.colors.surface1, fontSize: 13 }} /></View>
      <Text style={{ fontSize: 12, color: theme.colors.foregroundMuted }}>Wait for all selected PRs</Text>
      {!workspace.prs.length && <Text style={{ fontSize: 12, color: theme.colors.statusWarning }}>Register a PR before scheduling this task.</Text>}
      {workspace.prs.map(p => <Pressable key={p.key} accessibilityRole="checkbox" accessibilityLabel={`Use PR ${p.number} for task trigger`} aria-checked={prs.includes(p.key)} accessibilityState={{ checked: prs.includes(p.key), disabled: busy }} disabled={busy} onPress={() => setPrs(prs.includes(p.key) ? prs.filter(k => k !== p.key) : [...prs, p.key])} style={{ minHeight: compact ? 44 : 36, flexDirection: "row", alignItems: "center", gap: 8 }}><Icon name={prs.includes(p.key) ? "SquareCheck" : "Square"} size={15} color={prs.includes(p.key) ? theme.colors.accent : theme.colors.foregroundMuted} /><Text numberOfLines={2} style={{ flex: 1, fontSize: 12, lineHeight: 17, color: theme.colors.foreground }}>#{p.number} · {p.snapshot?.title ?? p.stack}</Text></Pressable>)}
    </>}
    {save.error && <Text accessibilityRole="alert" style={{ fontSize: 12, color: theme.colors.statusDanger }}>{save.error.message}</Text>}
    {save.isSuccess && <Text accessibilityLiveRegion="polite" style={{ fontSize: 12, color: theme.colors.foregroundMuted }}>Trigger saved</Text>}
    <Button title={busy ? "Saving…" : "Save trigger"} accessibilityLabel={`Save trigger for ${o.title}`} disabled={busy || !valid} onPress={() => save.mutate()} theme={theme} compact={compact} />
  </View>;
}

export function FollowTask({ obligation: o, workspace, theme, compact }: { obligation: Obligation; workspace: Workspace; theme: Theme; compact: boolean }) {
  const [details, setDetails] = useState(false);
  const finished = ["done", "waived"].includes(o.status);
  const schedule = taskSchedule(o, workspace);
  const waiting = o.enable_follow_up && !!o.trigger && !schedule.ready;
  const status = finished ? o.status === "done" ? "Done" : "Waived" : o.status === "blocked" ? "Blocked" : o.status === "working" ? "Working" : schedule.ready ? "Ready" : schedule.label;
  return <View style={{ paddingVertical: 3 }}><Pressable accessibilityRole="button" accessibilityLabel={`${details ? "Hide" : "Show"} task details: ${o.title}`} aria-expanded={details} accessibilityState={{ expanded: details }} onPress={() => setDetails(!details)} style={{ minHeight: compact ? 44 : 36, flexDirection: "row", alignItems: "flex-start", gap: 7 }}><Icon name={finished ? "Check" : o.status === "blocked" ? "CircleAlert" : o.status === "working" ? "Activity" : waiting ? "Clock" : "Circle"} size={13} color={o.status === "blocked" ? theme.colors.statusDanger : theme.colors.foregroundMuted} /><View style={{ flex: 1, gap: 2 }}><Text numberOfLines={details ? undefined : 3} style={{ fontSize: 13, lineHeight: 18, color: theme.colors.foreground }}>{o.title}</Text><Text style={{ fontSize: 11, lineHeight: 16, color: theme.colors.foregroundMuted }}>{status}{o.afterPrs.length ? ` · ${o.afterPrs.map(p => `#${p.split("#")[1]}`).join(", ")}` : ""}</Text></View><Icon name={details ? "ChevronUp" : "ChevronDown"} size={12} color={theme.colors.foregroundMuted} /></Pressable>{details && <View style={{ gap: 5, marginTop: 5 }}><Text style={{ fontSize: 12, lineHeight: 18, color: theme.colors.foregroundMuted }}>{o.evidence || "No evidence recorded."}</Text>{schedule.dueAt && <Text style={{ fontSize: 12, color: theme.colors.foregroundMuted }}>Due {new Date(schedule.dueAt).toLocaleString()}</Text>}{!finished && o.status !== "working" && <TriggerEditor key={`${o.id}:${o.revision}`} obligation={o} workspace={workspace} theme={theme} compact={compact} />}</View>}</View>;
}
