import { useState } from "react";
import { View } from "react-native";
import { Pressable, Text } from "./text";
import { Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useRpc } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import { blockedOnDeveloper, type Obligation, type Workspace } from "../shared/model";
import { followUpObligations } from "../shared/follow-up";
import { taskSchedule, type TaskTrigger } from "../shared/task-trigger";
import { controlRpc, sendRpc, taskTriggerRpc } from "../shared/contracts";
import { messageStrip, repairRows, shortTitle, type MessageStrip, type RepairRow } from "../shared/task-rows";
import { SETTLE_REASON } from "../shared/send-decision";
import { linkedQuestion, taskStatus, type TaskAgents, type TaskStatus } from "../shared/task-status";
import { Button, Card, Chip, FoldRow, Switch, text, type Theme, SubmitScope } from "./kit";
import { tint } from "./theme";
import { Spinner } from "./motion";
import type { Colors } from "./theme";
import { RichText } from "./rich-text";
import { runAction } from "./toasts";

/** The one-line hint under a task's Auto-send switch (the approved mock). */
const AUTO_OFF_HINT = "Off: it stays here for you";

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
      <Text style={t.meta}>Manual tasks wait for you. Scheduled tasks join the next message to the agent when they come due, and still follow your Auto-send choice.</Text>
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
  if (status.tone === "queued" || status.tone === "sent") return <DeliveryGlyph state={status.tone} w={w} colors={colors} />;
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

/** "14:32": a time on this device's clock. */
const clock = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
const tasks = (n: number) => `${n} task${n === 1 ? "" : "s"}`;

/** The status column reads one way for every task: dashed ring = queued, send glyph = sent (accent while the agent works on it). Never Running's spinner (Q51). */
function DeliveryGlyph({ state, w, colors }: { state: "queued" | "sent"; w: Workspace; colors: Colors }) {
  if (state === "sent") return <Icon name="Send" size={13} color={w.runtimeBusy ? colors.accent : colors.foregroundMuted} />;
  return <Icon name="CircleDashed" size={14} color={colors.foregroundMuted} />;
}

/** The strip's one line: who, how many, and when and why (Queued), or when it went out and what Follow-up waits for (Sent). */
export function stripLine(s: MessageStrip): { lead: string; rest: string } {
  if (s.phase === "sent") return { lead: `Sent to ${s.to}`, rest: `${s.at ? ` at ${clock(s.at)}` : ""} · ${tasks(s.count)} · ${s.reason}` };
  return { lead: `Next message to ${s.to}`, rest: ` · ${tasks(s.count)} · ${s.reason === SETTLE_REASON && s.at ? `sends at ${clock(s.at)} · ` : ""}${s.reason}` };
}

/** Always the first row of Tasks while a message is queued or out. Preview and Send now are quiet; the normal case needs no click. */
function StripRow({ strip, w, theme, compact, onPreview, openAgent }: { strip: MessageStrip; w: Workspace; theme: Theme; compact: boolean; onPreview: () => void; openAgent?: (agentId: string) => void }) {
  const c = theme.colors; const t = text(c, compact);
  const send = useRpc(sendRpc); const cache = useQueryClient(); const toast = useToast();
  const [busy, setBusy] = useState(false);
  const line = stripLine(strip);
  const sendNow = async () => {
    setBusy(true);
    try {
      const result = await send({ workspaceId: w.id, batchId: strip.batchId });
      const b = result.batches.find(x => x.id === strip.batchId);
      toast.show(!b || ["sent", "sending", "completed"].includes(b.state) ? `Sent to ${strip.to}` : b.state === "pending" ? "Queued. It goes out when the agent is free." : b.result || "The message couldn't be sent.", { variant: !b || ["sent", "sending", "completed"].includes(b.state) ? "success" : "info" });
    } catch (error) { toast.error(error instanceof Error ? error.message : "The message couldn't be sent."); }
    finally { setBusy(false); void cache.invalidateQueries(); }
  };
  return <View accessibilityRole="summary" style={{ flexDirection: "row", flexWrap: compact ? "wrap" : "nowrap", alignItems: "center", gap: 8, rowGap: 8, paddingHorizontal: compact ? 14 : 12, paddingVertical: compact ? 12 : 8, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.surface1 }}>
    <Icon name="Send" size={13} color={c.foregroundMuted} />
    <Text style={[t.meta, { flex: 1, flexBasis: compact ? "80%" : undefined, minWidth: 0 }]}><Text style={{ color: c.foreground, fontWeight: "500" }}>{line.lead}</Text>{line.rest}</Text>
    <View style={{ flexDirection: "row", gap: 8, marginLeft: compact ? 21 : 0 }}>
      {strip.phase === "queued" && <Button theme={theme} compact={compact} title="Preview" accessibilityLabel={`Preview the next message to ${strip.to}`} onPress={onPreview} />}
      {strip.phase === "queued" && strip.sendNow && <Button theme={theme} compact={compact} title="Send now" accessibilityLabel={`Send ${tasks(strip.count)} to ${strip.to} now`} loading={busy} disabled={busy} onPress={() => void sendNow()} />}
      {strip.phase === "sent" && openAgent && <Button theme={theme} compact={compact} title="Open agent" accessibilityLabel={`Open ${strip.to}`} onPress={() => openAgent(strip.recipientId)} />}
    </View>
  </View>;
}

/** The message's exact text, with this task's line marked when there is one. */
function MessageText({ text: body, highlight, theme }: { text: string; highlight?: string; theme: Theme }) {
  const c = theme.colors;
  return <View style={{ borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, paddingHorizontal: 12, paddingVertical: 10, gap: 2 }}>
    {body.split("\n").map((line, i) => <Text key={i} selectable style={{ fontFamily: "monospace", fontSize: 12, lineHeight: 17, color: c.foreground, borderRadius: 3, ...(highlight && line.endsWith(highlight) ? { backgroundColor: tint(c.accent, c) } : {}) }}>{line}</Text>)}
  </View>;
}

function PreviewSheet({ open, w, strip, theme, compact, onClose }: { open: boolean; w: Workspace; strip: MessageStrip | null; theme: Theme; compact: boolean; onClose: () => void }) {
  const t = text(theme.colors, compact);
  return <Modal title="Next message" icon={<Icon name="Send" size={18} color={theme.colors.foreground} />} open={open} onOpenChange={next => { if (!next) onClose(); }}>
    <Modal.Content contentContainerStyle={{ padding: compact ? 16 : 20, gap: 12 }}>
      {strip && <Text style={t.meta}>{stripLine(strip).lead}{stripLine(strip).rest}</Text>}
      <MessageText text={w.nextMessage ?? ""} theme={theme} />
    </Modal.Content>
  </Modal>;
}

const chipColor = (r: RepairRow, c: Colors) => r.state === "done" ? c.foregroundMuted : r.task.kind === "review" ? c.statusWarning : r.task.kind === "restack" ? c.foregroundMuted : c.statusDanger;

function RepairGlyph({ row, w, colors }: { row: RepairRow; w: Workspace; colors: Colors }) {
  if (row.state === "done") return <Icon name="Check" size={14} color={colors.statusSuccess} />;
  if (row.state === "capped") return <Icon name="CircleAlert" size={14} color={colors.statusWarning} />;
  if (row.state === "manual") return <View style={{ width: 14, height: 14, alignItems: "center", justifyContent: "center" }}><View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colors.foregroundMuted, opacity: 0.6 }} /></View>;
  return <DeliveryGlyph state={row.state} w={w} colors={colors} />;
}

/** A task Follow-up found on a PR, in the same row as every other task: status glyph, title, PR chip and one state. */
function RepairTaskRow({ row, w, theme, compact, onOpen }: { row: RepairRow; w: Workspace; theme: Theme; compact: boolean; onOpen: () => void }) {
  const c = theme.colors; const t = text(c);
  const label = row.state === "done" && row.at ? `${row.text} ${clock(row.at)}` : row.text;
  return <Pressable accessibilityRole="button" accessibilityLabel={`Task: ${row.task.title}. ${label}. Open details`} onPress={onOpen}
    style={state => ({ flexDirection: "row", gap: 10, paddingHorizontal: 12, paddingVertical: 9, minHeight: compact ? 52 : 44, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: state.pressed ? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
    <View style={{ width: 16, paddingTop: 2, alignItems: "center" }}><RepairGlyph row={row} w={w} colors={c} /></View>
    <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
      <RichText plain numberOfLines={3} style={[t.body, row.state === "done" ? { color: c.foregroundMuted } : null]}>{repairTitle(row)}</RichText>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        <Chip theme={theme} label={row.pr} color={chipColor(row, c)} />
        <Text style={[t.meta, row.state === "capped" ? { color: c.statusWarning } : null, { fontVariant: ["tabular-nums"] }]}>{label}</Text>
      </View>
    </View>
    <View style={{ paddingTop: 2 }}><Icon name="ChevronRight" size={14} color={c.foregroundMuted} /></View>
  </Pressable>;
}

/** The task's title without the PR it names: the chip carries the PR. */
const repairTitle = (row: RepairRow) => shortTitle(row.task);

function RepairSheet({ row, w, strip, theme, compact, onClose }: { row: RepairRow | null; w: Workspace; strip: MessageStrip | null; theme: Theme; compact: boolean; onClose: () => void }) {
  const c = theme.colors; const t = text(c, compact);
  const control = useRpc(controlRpc); const cache = useQueryClient(); const toast = useToast();
  const [saving, setSaving] = useState(false);
  const manual = !!row && (w.manualTasks ?? []).includes(row.task.key);
  const setAuto = async (auto: boolean) => {
    if (!row) return;
    setSaving(true);
    try { await control({ workspaceId: w.id, taskAuto: { key: row.task.key, auto } }); toast.show(auto ? "Follow-up sends this task" : "This task stays with you"); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Couldn't change Auto-send for this task."); }
    finally { setSaving(false); void cache.invalidateQueries(); }
  };
  const where = row?.state === "queued" && strip?.phase === "queued" ? ` · in the next message to ${strip.to}${strip.reason === SETTLE_REASON && strip.at ? `, at ${clock(strip.at)}` : ""}` : row?.state === "sent" && strip?.phase === "sent" ? ` · ${stripLine(strip).lead.toLowerCase()}${strip.at ? ` at ${clock(strip.at)}` : ""}` : "";
  return <Modal title="Task" icon={<Icon name="ListTodo" size={18} color={c.foreground} />} open={!!row} onOpenChange={next => { if (!next) onClose(); }}>
    <Modal.Content contentContainerStyle={{ padding: compact ? 16 : 20, gap: 14 }}>
      {row && <>
        <View style={{ gap: 6 }}>
          <RichText selectable style={[t.title, { fontSize: 16, lineHeight: 22 }]}>{repairTitle(row)}</RichText>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
            <Chip theme={theme} label={row.pr} color={chipColor(row, c)} />
            <Text style={t.meta}>{row.text}{where}</Text>
          </View>
        </View>
        {row.state !== "done" && row.state !== "sent" && <View style={{ paddingTop: 12, gap: 4, borderTopWidth: 1, borderTopColor: c.border }}>
          <Switch theme={theme} compact={compact} label="Auto-send" value={!manual} disabled={saving} accessibilityLabel={`Auto-send ${row.task.title}`}
            hint={`Follow-up sends this to ${strip?.to ?? w.mainAgentTitle ?? "the main agent"}. ${AUTO_OFF_HINT}.`} onChange={next => void setAuto(next)} />
          <Text style={t.meta}>{AUTO_OFF_HINT}</Text>
        </View>}
        {row.state === "queued" && !!w.nextMessage && <View style={{ gap: 6 }}>
          <Text style={t.label}>Next message</Text>
          <MessageText text={w.nextMessage} highlight={row.task.title} theme={theme} />
        </View>}
      </>}
    </Modal.Content>
  </Modal>;
}

export function TasksCard({ workspace: w, theme, compact, open, toggle, onOpenQuestion, openAgent, now = Date.now() }: { workspace: Workspace; theme: Theme; compact: boolean; open: (key: string) => boolean; toggle: (key: string) => void; onOpenQuestion?: (id: string) => void; openAgent?: (agentId: string) => void; now?: number }) {
  const c = theme.colors; const t = text(c);
  const [selected, setSelected] = useState<string | null>(null);
  const [repair, setRepair] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const all = followUpObligations(w);
  // Live state of the agents working tasks name: the engine stores it with runtimeBusy (directory metadata, wakes
  // nothing), so the row, the sheet, the live line and Home all read the same states.
  const agents = w.taskAgents ?? {};
  const outstanding = all.filter(o => !finished(o));
  const completed = all.filter(finished);
  // Repairs are tasks (Q49): the PR conditions Follow-up found sit with everyone's tasks, problems first.
  const strip = messageStrip(w, now);
  const repairs = repairRows(w);
  const left = repairs.open.length + outstanding.length;
  const doneCount = completed.length + repairs.done.length;
  const showDone = open("tasks-done");
  const repairRow = [...repairs.open, ...repairs.done].find(r => r.task.key === repair) ?? null;
  return <Card theme={theme} compact={compact} icon="ListTodo" title="Tasks" count={left ? `${left} left` : undefined}>
    {strip && <StripRow strip={strip} w={w} theme={theme} compact={compact} onPreview={() => setPreview(true)} openAgent={openAgent} />}
    {!all.length && !repairs.open.length && !repairs.done.length && <View style={{ paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: c.border }}>
      <Text style={t.meta}>No tasks. Follow-up adds one when a PR needs fixing, and the agent records work that outlives a merge here, like a migration to run or a production check.</Text>
    </View>}
    {repairs.open.map(r => <RepairTaskRow key={r.task.key} row={r} w={w} theme={theme} compact={compact} onOpen={() => setRepair(r.task.key)} />)}
    {outstanding.map(o => { const q = linkedQuestion(o, w); return <TaskRow key={o.id} o={o} w={w} agents={agents} openAgent={openAgent} theme={theme} compact={compact} onOpen={() => q && onOpenQuestion ? onOpenQuestion(q.id) : setSelected(o.id)} />; })}
    {doneCount > 0 && <FoldRow theme={theme} compact={compact} open={showDone} onPress={() => toggle("tasks-done")} icon="Check" iconColor={c.statusSuccess} label={`${doneCount} done`} />}
    {showDone && repairs.done.map(r => <RepairTaskRow key={`done:${r.task.key}`} row={r} w={w} theme={theme} compact={compact} onOpen={() => setRepair(r.task.key)} />)}
    {showDone && completed.map(o => <TaskRow key={o.id} o={o} w={w} agents={agents} openAgent={openAgent} theme={theme} compact={compact} onOpen={() => setSelected(o.id)} />)}
    <TaskSheet o={all.find(o => o.id === selected) ?? null} w={w} agents={agents} openAgent={openAgent} theme={theme} compact={compact} onClose={() => setSelected(null)} />
    <RepairSheet row={repairRow} w={w} strip={strip} theme={theme} compact={compact} onClose={() => setRepair(null)} />
    <PreviewSheet open={preview} w={w} strip={strip} theme={theme} compact={compact} onClose={() => setPreview(false)} />
  </Card>;
}
