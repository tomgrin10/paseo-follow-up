import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Obligation, Workspace } from "../shared/model";
import { followUpObligations } from "../shared/follow-up";
import { taskSchedule, type TaskTrigger } from "../shared/task-trigger";
import { taskTriggerRpc } from "../shared/contracts";
import { Button, Card, Chip, FoldRow, errorText, text, type Theme } from "./kit";
import { Spinner } from "./motion";
import type { Colors } from "./theme";

const finished = (o: Obligation) => ["done", "waived"].includes(o.status);

function TriggerEditor({ obligation: o, workspace, theme, compact }: { obligation: Obligation; workspace: Workspace; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c);
  const [event, setEvent] = useState<TaskTrigger["event"] | "manual">(o.enable_follow_up && o.trigger ? o.trigger.event : "manual");
  const [days, setDays] = useState(String(o.trigger?.delayDays ?? 0));
  const [prs, setPrs] = useState(o.afterPrs);
  const rpc = useRpc(taskTriggerRpc); const cache = useQueryClient(); const toast = useToast();
  const gated = event === "merge" || event === "deploy";
  const valid = !gated || prs.length > 0 && /^\d+$/.test(days) && Number(days) <= 3650;
  const save = useMutation({ mutationFn: () => rpc({ workspaceId: workspace.id, obligationId: o.id, expectedRevision: o.revision, afterPrs: event === "now" ? [] : prs, trigger: event === "manual" ? null : { event, delayDays: gated ? Number(days) : 0 } }), onSuccess: async () => { toast.show("Schedule saved", { variant: "success" }); await cache.invalidateQueries(); } });
  const busy = save.isPending;
  const options = [["manual", "Manual"], ["now", "Now"], ["merge", "After merge"], ["deploy", "After deploy"]] as const;
  return <View style={{ gap: 10 }}>
    <View style={{ gap: 4 }}>
      <Text style={t.label}>Send to the agent</Text>
      <Text style={t.meta}>Manual tasks wait for you. Scheduled tasks join the next repair batch when they come due, and still follow your Auto-send choice.</Text>
    </View>
    <View accessibilityRole="radiogroup" accessibilityLabel={`Send trigger for ${o.title}`} style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {options.map(([value, label]) => <Pressable key={value} accessibilityRole="radio" accessibilityLabel={label} aria-checked={event === value} accessibilityState={{ checked: event === value, disabled: busy }} disabled={busy} onPress={() => { setEvent(value); save.reset(); }}
        style={{ minHeight: compact ? 44 : 30, justifyContent: "center", paddingHorizontal: 11, borderRadius: 999, borderWidth: 1, borderColor: event === value ? c.accent : c.border, backgroundColor: event === value ? c.accent : "transparent" }}>
        <Text style={{ fontSize: 12, fontWeight: "600", color: event === value ? c.accentForeground : c.foreground }}>{label}</Text>
      </Pressable>)}
    </View>
    {gated && <>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={t.meta}>Wait</Text>
        <TextInput accessibilityLabel="Delay in days" inputMode="numeric" value={days} editable={!busy} onChangeText={setDays} style={{ width: 64, minHeight: compact ? 44 : 32, paddingHorizontal: 10, borderRadius: 6, borderWidth: 1, borderColor: valid ? c.border : c.statusDanger, color: c.foreground, backgroundColor: c.surface1, fontSize: 13, fontVariant: ["tabular-nums"] }} />
        <Text style={t.meta}>days after every selected PR {event === "merge" ? "merges" : "deploys"}</Text>
      </View>
      {!workspace.prs.length && <Text style={[t.meta, { color: c.statusWarning }]}>Register a PR before scheduling this task.</Text>}
      <View>
        {workspace.prs.map(p => <Pressable key={p.key} accessibilityRole="checkbox" accessibilityLabel={`Use PR ${p.number} for task trigger`} aria-checked={prs.includes(p.key)} accessibilityState={{ checked: prs.includes(p.key), disabled: busy }} disabled={busy} onPress={() => setPrs(prs.includes(p.key) ? prs.filter(k => k !== p.key) : [...prs, p.key])}
          style={{ minHeight: compact ? 44 : 32, flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Icon name={prs.includes(p.key) ? "SquareCheck" : "Square"} size={15} color={prs.includes(p.key) ? c.accent : c.foregroundMuted} />
          <Text numberOfLines={2} style={[t.body, { flex: 1, fontSize: 12, lineHeight: 17 }]}><Text style={{ fontVariant: ["tabular-nums"], color: c.foregroundMuted }}>#{p.number} </Text>{p.snapshot?.title ?? p.stack}</Text>
        </Pressable>)}
      </View>
    </>}
    {save.error && <Text accessibilityRole="alert" style={[t.meta, { color: c.statusDanger }]}>{errorText(save.error)}</Text>}
    <Button title="Save schedule" kind="primary" accessibilityLabel={`Save trigger for ${o.title}`} disabled={busy || !valid} loading={busy} onPress={() => save.mutate()} theme={theme} compact={compact} />
  </View>;
}

function statusOf(o: Obligation, w: Workspace) {
  const schedule = taskSchedule(o, w);
  if (finished(o)) return o.status === "done" ? "Done" : "Waived";
  if (o.status === "blocked") return "Needs a decision";
  if (o.status === "working") return "Agent working";
  return schedule.ready ? "Ready to send" : schedule.label;
}
function TaskGlyph({ o, w, colors }: { o: Obligation; w: Workspace; colors: Colors }) {
  if (finished(o)) return <Icon name={o.status === "done" ? "Check" : "CircleSlash"} size={14} color={o.status === "done" ? colors.statusSuccess : colors.foregroundMuted} />;
  if (o.status === "blocked") return <Icon name="MessageCircleQuestion" size={14} color={colors.statusWarning} />;
  if (o.status === "working") return <Spinner color={colors.accent} size={13} />;
  if (o.enable_follow_up && o.trigger && !taskSchedule(o, w).ready) return <Icon name="Clock" size={14} color={colors.foregroundMuted} />;
  return <View style={{ width: 14, height: 14, alignItems: "center", justifyContent: "center" }}><View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colors.foregroundMuted, opacity: 0.6 }} /></View>;
}

function TaskRow({ o, w, theme, onOpen, compact }: { o: Obligation; w: Workspace; theme: Theme; onOpen: () => void; compact: boolean }) {
  const c = theme.colors; const t = text(c);
  const status = statusOf(o, w);
  const scheduled = o.enable_follow_up && !!o.trigger;
  const prs = o.afterPrs.map(p => `#${p.split("#")[1]}`).join(", ");
  return <Pressable accessibilityRole="button" accessibilityLabel={`Task: ${o.title}. ${status}. Open details`} onPress={onOpen}
    style={state => ({ flexDirection: "row", gap: 10, paddingHorizontal: 12, paddingVertical: 9, minHeight: compact ? 52 : 44, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: state.pressed ? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
    <View style={{ width: 16, paddingTop: 2, alignItems: "center" }}><TaskGlyph o={o} w={w} colors={c} /></View>
    <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
      <Text numberOfLines={3} style={[t.body, finished(o) ? { color: c.foregroundMuted } : null]}>{o.title}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        {scheduled && !finished(o) ? <Chip theme={theme} label={`${status}${prs ? ` · ${prs}` : ""}`} color={c.foregroundMuted} />
          : <Text style={[t.meta, o.status === "blocked" ? { color: c.statusWarning } : null, { fontVariant: ["tabular-nums"] }]}>{status}{prs && !finished(o) ? ` · waits for ${prs}` : ""}</Text>}
      </View>
    </View>
    <View style={{ paddingTop: 2 }}><Icon name="ChevronRight" size={14} color={c.foregroundMuted} /></View>
  </Pressable>;
}

function TaskSheet({ o, w, theme, compact, onClose }: { o: Obligation | null; w: Workspace; theme: Theme; compact: boolean; onClose: () => void }) {
  const c = theme.colors; const t = text(c);
  const schedule = o ? taskSchedule(o, w) : null;
  return <Modal title="Task" icon={<Icon name="ListTodo" size={18} color={c.foreground} />} open={!!o} onOpenChange={next => { if (!next) onClose(); }}>
    <Modal.Content contentContainerStyle={{ padding: compact ? 16 : 20, gap: 14 }}>
      {o && <>
        <View style={{ gap: 6 }}>
          <Text selectable style={[t.title, { fontSize: 16, lineHeight: 22 }]}>{o.title}</Text>
          <Text style={t.meta}>{statusOf(o, w)}{o.afterPrs.length ? ` · after ${o.afterPrs.map(p => `#${p.split("#")[1]}`).join(", ")}` : ""}{schedule?.dueAt ? ` · due ${new Date(schedule.dueAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}</Text>
        </View>
        <View style={{ gap: 4 }}>
          <Text style={t.label}>Evidence</Text>
          <Text selectable style={t.meta}>{o.evidence || "Nothing recorded yet. The agent adds evidence when it checks or finishes the task."}</Text>
        </View>
        {!finished(o) && o.status !== "working" && <View style={{ paddingTop: 12, borderTopWidth: 1, borderTopColor: c.border }}>
          <TriggerEditor key={`${o.id}:${o.revision}`} obligation={o} workspace={w} theme={theme} compact={compact} />
        </View>}
      </>}
    </Modal.Content>
  </Modal>;
}

export function TasksCard({ workspace: w, theme, compact, open, toggle }: { workspace: Workspace; theme: Theme; compact: boolean; open: (key: string) => boolean; toggle: (key: string) => void }) {
  const c = theme.colors; const t = text(c);
  const [selected, setSelected] = useState<string | null>(null);
  const all = followUpObligations(w);
  const outstanding = all.filter(o => !finished(o));
  const completed = all.filter(finished);
  const showDone = open("tasks-done");
  return <Card theme={theme} compact={compact} icon="ListTodo" title="Tasks" count={outstanding.length ? `${outstanding.length} left` : undefined}>
    {!all.length && <View style={{ paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: c.border }}>
      <Text style={t.meta}>No follow-up tasks. The agent records work that outlives a merge here, like a migration to run or a production check.</Text>
    </View>}
    {outstanding.map(o => <TaskRow key={o.id} o={o} w={w} theme={theme} compact={compact} onOpen={() => setSelected(o.id)} />)}
    {completed.length > 0 && <FoldRow theme={theme} open={showDone} onPress={() => toggle("tasks-done")} icon="Check" iconColor={c.statusSuccess} label={`${completed.length} done`} />}
    {showDone && completed.map(o => <TaskRow key={o.id} o={o} w={w} theme={theme} compact={compact} onOpen={() => setSelected(o.id)} />)}
    <TaskSheet o={all.find(o => o.id === selected) ?? null} w={w} theme={theme} compact={compact} onClose={() => setSelected(null)} />
  </Card>;
}
