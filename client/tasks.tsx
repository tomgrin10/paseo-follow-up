import { useState } from "react";
import { View } from "react-native";
import { Pressable, Text } from "./text";
import { Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useRpc } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import { blockedOnDeveloper, type Obligation, type Workspace } from "../shared/model";
import { followUpObligations } from "../shared/follow-up";
import { taskSchedule, type TaskTrigger } from "../shared/task-trigger";
import { taskTriggerRpc } from "../shared/contracts";
import { linkedQuestion, taskStatus, type TaskAgents, type TaskStatus } from "../shared/task-status";
import { Button, Card, Chip, FoldRow, text, type Theme, SubmitScope } from "./kit";
import { Spinner } from "./motion";
import type { Colors } from "./theme";
import { RichText } from "./rich-text";
import { runAction } from "./toasts";

const finished = (o: Obligation) => ["done", "waived"].includes(o.status);

function TriggerEditor({ obligation: o, workspace, theme, compact }: { obligation: Obligation; workspace: Workspace; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c);
  const [event, setEvent] = useState<TaskTrigger["event"] | "manual">(o.enable_follow_up && o.trigger ? o.trigger.event : "manual");
  const [days, setDays] = useState(String(o.trigger?.delayDays ?? 0));
  const [prs, setPrs] = useState(o.afterPrs);
  const rpc = useRpc(taskTriggerRpc); const cache = useQueryClient(); const toast = useToast();
  const gated = event === "merge" || event === "deploy";
  const valid = !gated || prs.length > 0 && /^\d+$/.test(days) && Number(days) <= 3650;
  // Quick action: Save doesn't wait on the server; a toast confirms it, or says what failed with Retry.
  const save = { isPending: false, mutate: () => void runAction({
    label: "Schedule", toast, run: () => rpc({ workspaceId: workspace.id, obligationId: o.id, expectedRevision: o.revision, afterPrs: event === "now" ? [] : prs, trigger: event === "manual" ? null : { event, delayDays: gated ? Number(days) : 0 } }),
    success: () => ({ message: "Schedule saved" }), onSuccess: () => { void cache.invalidateQueries(); }, onError: () => { void cache.invalidateQueries(); },
    failure: `Schedule for ${o.title} not saved`,
  }) };
  const busy = save.isPending;
  const options = [["manual", "Manual"], ["now", "Now"], ["merge", "After merge"], ["deploy", "After deploy"]] as const;
  return <SubmitScope enabled={!busy && valid} onSubmit={() => save.mutate()} style={{ gap: 10 }}>
    <View style={{ gap: 4 }}>
      <Text style={t.label}>Send to the agent</Text>
      <Text style={t.meta}>Manual tasks wait for you. Scheduled tasks join the next repair batch when they come due, and still follow your Auto-send choice.</Text>
    </View>
    <View accessibilityRole="radiogroup" accessibilityLabel={`Send trigger for ${o.title}`} style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {options.map(([value, label]) => <Pressable key={value} accessibilityRole="radio" accessibilityLabel={label} aria-checked={event === value} accessibilityState={{ checked: event === value, disabled: busy }} disabled={busy} onPress={() => { setEvent(value); }}
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
    <Button shortcut title="Save schedule" kind="primary" accessibilityLabel={`Save trigger for ${o.title}`} disabled={busy || !valid} loading={busy} onPress={() => save.mutate()} theme={theme} compact={compact} />
  </SubmitScope>;
}

function TaskGlyph({ o, w, status, colors }: { o: Obligation; w: Workspace; status: TaskStatus; colors: Colors }) {
  if (finished(o)) return <Icon name={o.status === "done" ? "Check" : "CircleSlash"} size={14} color={o.status === "done" ? colors.statusSuccess : colors.foregroundMuted} />;
  // Blocked on the developer asks them (a question glyph, amber until its question is open); blocked on a PR or an
  // agent is the agent's to wait out, so it stays muted.
  if (o.status === "blocked") return blockedOnDeveloper(o) ? <Icon name="MessageCircleQuestion" size={14} color={linkedQuestion(o, w) ? colors.foregroundMuted : colors.statusWarning} /> : <Icon name="CirclePause" size={14} color={colors.foregroundMuted} />;
  // A spinner only while the task's agent is really mid-turn (shared/task-status.ts), never off the stored status.
  if (status.tone === "working") return <Spinner color={colors.accent} size={13} />;
  if (o.enable_follow_up && o.trigger && !taskSchedule(o, w).ready) return <Icon name="Clock" size={14} color={colors.foregroundMuted} />;
  return <View style={{ width: 14, height: 14, alignItems: "center", justifyContent: "center" }}><View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colors.foregroundMuted, opacity: 0.6 }} /></View>;
}

/** "Open agent" ("Open chat" for a closed one): goes to the task's agent's chat on the developer's tap. An archived one is just the words. */
function OpenAgentLink({ status, openAgent, theme, compact }: { status: TaskStatus; openAgent?: (agentId: string) => void; theme: Theme; compact: boolean }) {
  const c = theme.colors;
  if (!status.agentId || !openAgent) return null;
  const id = status.agentId;
  return <><Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17 }} accessibilityElementsHidden importantForAccessibility="no">·</Text><Pressable accessibilityRole="link" accessibilityLabel={`${status.link ?? "Open agent"}: ${status.text}`} hitSlop={compact ? 12 : 6} onPress={() => openAgent(id)}
    style={state => ({ flexDirection: "row", alignItems: "center", gap: 3, borderRadius: 4, opacity: state.pressed ? 0.6 : 1, ...((state as { hovered?: boolean }).hovered ? { textDecorationLine: "underline" } : {}) } as object)}>
    <Text style={{ color: c.foreground, fontSize: 12, lineHeight: 17, fontWeight: "500" }}>{status.link ?? "Open agent"}</Text>
    <Icon name="ArrowUpRight" size={12} color={c.foreground} />
  </Pressable></>;
}

function TaskRow({ o, w, agents, openAgent, theme, onOpen, compact }: { o: Obligation; w: Workspace; agents: TaskAgents; openAgent?: (agentId: string) => void; theme: Theme; onOpen: () => void; compact: boolean }) {
  const c = theme.colors; const t = text(c);
  const line = taskStatus(o, w, agents);
  const status = line.text;
  const scheduled = o.enable_follow_up && !!o.trigger;
  const prs = o.afterPrs.map(p => `#${p.split("#")[1]}`).join(", ");
  return <Pressable accessibilityRole="button" accessibilityLabel={`Task: ${o.title}. ${status}. Open details`} onPress={onOpen}
    style={state => ({ flexDirection: "row", gap: 10, paddingHorizontal: 12, paddingVertical: 9, minHeight: compact ? 52 : 44, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: state.pressed ? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
    <View style={{ width: 16, paddingTop: 2, alignItems: "center" }}><TaskGlyph o={o} w={w} status={line} colors={c} /></View>
    <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
      <RichText plain numberOfLines={3} style={[t.body, finished(o) ? { color: c.foregroundMuted } : null]}>{o.title}</RichText>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        {scheduled && !finished(o) ? <Chip theme={theme} label={`${status}${prs ? ` · ${prs}` : ""}`} color={c.foregroundMuted} />
          : <Text style={[t.meta, blockedOnDeveloper(o) && !linkedQuestion(o, w) ? { color: c.statusWarning } : null, { fontVariant: ["tabular-nums"] }]}>{status}{prs && !finished(o) && !linkedQuestion(o, w) ? ` · waits for ${prs}` : ""}</Text>}
        <OpenAgentLink status={line} openAgent={openAgent} theme={theme} compact={compact} />
      </View>
    </View>
    <View style={{ paddingTop: 2 }}><Icon name="ChevronRight" size={14} color={c.foregroundMuted} /></View>
  </Pressable>;
}

function TaskSheet({ o, w, agents, openAgent, theme, compact, onClose }: { o: Obligation | null; w: Workspace; agents: TaskAgents; openAgent?: (agentId: string) => void; theme: Theme; compact: boolean; onClose: () => void }) {
  const c = theme.colors; const t = text(c);
  const schedule = o ? taskSchedule(o, w) : null;
  const line = o ? taskStatus(o, w, agents) : null;
  return <Modal title="Task" icon={<Icon name="ListTodo" size={18} color={c.foreground} />} open={!!o} onOpenChange={next => { if (!next) onClose(); }}>
    <Modal.Content contentContainerStyle={{ padding: compact ? 16 : 20, gap: 14 }}>
      {o && <>
        <View style={{ gap: 6 }}>
          <RichText selectable style={[t.title, { fontSize: 16, lineHeight: 22 }]}>{o.title}</RichText>
          <Text style={t.meta}>{line!.text}{o.afterPrs.length ? ` · after ${o.afterPrs.map(p => `#${p.split("#")[1]}`).join(", ")}` : ""}{schedule?.dueAt ? ` · due ${new Date(schedule.dueAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}</Text>
        </View>
        {line?.agentId && openAgent && <Button title={line.link ?? "Open agent"} icon="MessageSquare" accessibilityLabel={`${line.link ?? "Open agent"}: ${line.text}`} theme={theme} compact={compact} onPress={() => { openAgent(line.agentId!); onClose(); }} />}
        <View style={{ gap: 4 }}>
          <Text style={t.label}>Evidence</Text>
          <RichText selectable linkColor={c.foreground} style={t.meta}>{o.evidence || "Nothing recorded yet. The agent adds evidence when it checks or finishes the task."}</RichText>
        </View>
        {!finished(o) && o.status !== "working" && <View style={{ paddingTop: 12, borderTopWidth: 1, borderTopColor: c.border }}>
          <TriggerEditor key={`${o.id}:${o.revision}`} obligation={o} workspace={w} theme={theme} compact={compact} />
        </View>}
      </>}
    </Modal.Content>
  </Modal>;
}

export function TasksCard({ workspace: w, theme, compact, open, toggle, onOpenQuestion, openAgent }: { workspace: Workspace; theme: Theme; compact: boolean; open: (key: string) => boolean; toggle: (key: string) => void; onOpenQuestion?: (id: string) => void; openAgent?: (agentId: string) => void }) {
  const c = theme.colors; const t = text(c);
  const [selected, setSelected] = useState<string | null>(null);
  const all = followUpObligations(w);
  // Live state of the agents working tasks name: the engine stores it with runtimeBusy (directory metadata, wakes
  // nothing), so the row, the sheet, the live line and Home all read the same states.
  const agents = w.taskAgents ?? {};
  const outstanding = all.filter(o => !finished(o));
  const completed = all.filter(finished);
  const showDone = open("tasks-done");
  return <Card theme={theme} compact={compact} icon="ListTodo" title="Tasks" count={outstanding.length ? `${outstanding.length} left` : undefined}>
    {!all.length && <View style={{ paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: c.border }}>
      <Text style={t.meta}>No follow-up tasks. The agent records work that outlives a merge here, like a migration to run or a production check.</Text>
    </View>}
    {outstanding.map(o => { const q = linkedQuestion(o, w); return <TaskRow key={o.id} o={o} w={w} agents={agents} openAgent={openAgent} theme={theme} compact={compact} onOpen={() => q && onOpenQuestion ? onOpenQuestion(q.id) : setSelected(o.id)} />; })}
    {completed.length > 0 && <FoldRow theme={theme} compact={compact} open={showDone} onPress={() => toggle("tasks-done")} icon="Check" iconColor={c.statusSuccess} label={`${completed.length} done`} />}
    {showDone && completed.map(o => <TaskRow key={o.id} o={o} w={w} agents={agents} openAgent={openAgent} theme={theme} compact={compact} onOpen={() => setSelected(o.id)} />)}
    <TaskSheet o={all.find(o => o.id === selected) ?? null} w={w} agents={agents} openAgent={openAgent} theme={theme} compact={compact} onClose={() => setSelected(null)} />
  </Card>;
}
