import { useState } from "react";
import { View } from "react-native";
import { Pressable, Text } from "./text";
import { Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useRpc } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import type { Obligation, Workspace } from "../shared/model";
import { atChoices, atProblem, clockLabel, DIDNT_GO_OUT, localTimeText, parseLocalTime, TRIGGER_HELP, type TaskTrigger } from "../shared/task-trigger";
import { taskTriggerRpc } from "../shared/contracts";
import { linkedQuestion, type TaskStatus } from "../shared/task-status";
import { finishedParts, summaryParts, taskSummary, taskViewRows, type TaskViewRow } from "../shared/task-view";
import { Button, Card, text, type Theme, SubmitScope } from "./kit";
import { usePagedList } from "./paged-list";
import { Spinner } from "./motion";
import type { Colors } from "./theme";
import { RichText } from "./rich-text";
import { runAction } from "./toasts";
import { DeliveryGlyph } from "./messages";

// The agent's tasks, as the developer sees them (invariant tasks-are-the-agent-s, shared/task-view.ts): one collapsed
// line by default, a row per open task saying what moves it, stale and due first, finished tasks in Activity.

function TriggerEditor({ obligation: o, workspace, theme, compact }: { obligation: Obligation; workspace: Workspace; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c);
  const [event, setEvent] = useState<TaskTrigger["event"] | "manual">(o.enable_follow_up && o.trigger ? o.trigger.event : "manual");
  const [days, setDays] = useState(String(o.trigger?.delayDays ?? 0));
  const [prs, setPrs] = useState(o.afterPrs);
  // At a time: a quick pick or a typed time, on the device's clock (the developer's zone). Opened with a time already
  // set, the field starts there; else in 30 minutes.
  const now = Date.now();
  const choices = atChoices(now);
  const [when, setWhen] = useState(() => localTimeText(o.trigger?.event === "at" && o.trigger.at && Date.parse(o.trigger.at) > now ? Date.parse(o.trigger.at) : choices[0].at));
  const at = parseLocalTime(when, now);
  const timeProblem = event === "at" ? atProblem(at, now) : null;
  // A time that already went out (or couldn't): said once, so a new time reads as sending it again.
  const before = o.trigger?.event === "at" ? o.trigger.notSent ? `${DIDNT_GO_OUT} at ${clockLabel(o.trigger.at ?? "", now)}: ${o.trigger.notSent}.` : o.trigger.sentAt ? `Went out ${clockLabel(o.trigger.sentAt, now)}.` : null : null;
  const rpc = useRpc(taskTriggerRpc); const cache = useQueryClient(); const toast = useToast();
  const gated = event === "merge" || event === "deploy";
  const valid = event === "at" ? !timeProblem : !gated || prs.length > 0 && /^\d+$/.test(days) && Number(days) <= 3650;
  // Quick action: Save doesn't wait on the server; a toast confirms it, or says what failed with Retry.
  const save = { isPending: false, mutate: () => void runAction({
    label: "Schedule", toast, run: () => rpc({ workspaceId: workspace.id, obligationId: o.id, expectedRevision: o.revision, afterPrs: event === "now" ? [] : prs, trigger: event === "manual" ? null : event === "at" ? { event, delayDays: 0, at: new Date(at!).toISOString() } : { event, delayDays: gated ? Number(days) : 0 } }),
    success: () => ({ message: "Schedule saved" }), onSuccess: () => { void cache.invalidateQueries(); }, onError: () => { void cache.invalidateQueries(); },
    failure: `Schedule for ${o.title} not saved`,
  }) };
  const busy = save.isPending;
  const options = [["manual", "Not sent"], ["now", "Now"], ["at", "At a time"], ["merge", "After merge"], ["deploy", "After deploy"]] as const;
  const chip = (selected: boolean) => ({ minHeight: compact ? 44 : 30, justifyContent: "center" as const, paddingHorizontal: 11, borderRadius: 999, borderWidth: 1, borderColor: selected ? c.accent : c.border, backgroundColor: selected ? c.accent : "transparent" });
  return <SubmitScope enabled={!busy && valid} onSubmit={() => save.mutate()} style={{ gap: 10 }}>
    <View style={{ gap: 4 }}>
      <Text style={t.label}>Send to the agent</Text>
      <Text style={t.meta}>{TRIGGER_HELP[event]}</Text>
    </View>
    <View accessibilityRole="radiogroup" accessibilityLabel={`Send trigger for ${o.title}`} style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {options.map(([value, label]) => <Pressable key={value} accessibilityRole="radio" accessibilityLabel={label} aria-checked={event === value} accessibilityState={{ checked: event === value, disabled: busy }} disabled={busy} onPress={() => { setEvent(value); }}
        style={chip(event === value)}>
        <Text style={{ fontSize: 12, fontWeight: "600", color: event === value ? c.accentForeground : c.foreground }}>{label}</Text>
      </Pressable>)}
    </View>
    {event === "at" && <View style={{ gap: 8 }}>
      {before && <Text style={t.meta}>{before} Pick a new time to send it again.</Text>}
      {/* Quick picks fill the field: small outlined buttons, never a second selected state beside the trigger choice. */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {choices.map(ch => <Pressable key={ch.label} accessibilityRole="button" accessibilityLabel={`${ch.label}: fill in ${localTimeText(ch.at)}`} disabled={busy} hitSlop={compact ? 0 : 6} onPress={() => setWhen(localTimeText(ch.at))}
          style={state => ({ minHeight: compact ? 44 : 26, justifyContent: "center", paddingHorizontal: 9, borderRadius: 6, borderWidth: 1, borderColor: c.border, opacity: state.pressed ? 0.6 : 1 })}>
          <Text style={{ fontSize: 12, color: c.foreground, fontVariant: ["tabular-nums"] }}>{ch.label}</Text>
        </Pressable>)}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <TextInput accessibilityLabel="Send at, date and time" value={when} editable={!busy} onChangeText={setWhen} autoCapitalize="none" autoCorrect={false}
          style={{ width: 150, minHeight: compact ? 44 : 32, paddingHorizontal: 10, borderRadius: 6, borderWidth: 1, borderColor: timeProblem ? c.statusDanger : c.border, color: c.foreground, backgroundColor: c.surface1, fontSize: 13, fontVariant: ["tabular-nums"] }} />
        <Text style={[t.meta, timeProblem ? { color: c.statusDanger } : null]}>{timeProblem ?? `Sends ${clockLabel(new Date(at!).toISOString(), Date.now())}, your time`}</Text>
      </View>
    </View>}
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

/** "Open agent" ("Open chat" for a closed one): goes to the task's agent's chat on the developer's tap. An archived one is just the words. */
function OpenAgentLink({ status, openAgent, theme, compact, lead = true }: { status: TaskStatus; openAgent?: (agentId: string) => void; theme: Theme; compact: boolean; /** A "·" before it, when it follows other words on the line. */ lead?: boolean }) {
  const c = theme.colors;
  if (!status.agentId || !openAgent) return null;
  const id = status.agentId;
  return <>{lead && <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17 }} accessibilityElementsHidden importantForAccessibility="no">·</Text>}<Pressable accessibilityRole="link" accessibilityLabel={`${status.link ?? "Open agent"}: ${status.text}`} hitSlop={compact ? 12 : 6} onPress={() => openAgent(id)}
    style={state => ({ flexDirection: "row", alignItems: "center", gap: 3, borderRadius: 4, opacity: state.pressed ? 0.6 : 1, ...((state as { hovered?: boolean }).hovered ? { textDecorationLine: "underline" } : {}) } as object)}>
    <Text style={{ color: c.foreground, fontSize: 12, lineHeight: 17, fontWeight: "500" }}>{status.link ?? "Open agent"}</Text>
    <Icon name="ArrowUpRight" size={12} color={c.foreground} />
  </Pressable></>;
}

/** A small dot: the due row's mark (muted) and the stale one's (foreground: amber is Needs you's alone, invariant 89). */
const Dot = ({ color, size = 6 }: { color: string; size?: number }) => <View style={{ width: 14, height: 14, alignItems: "center", justifyContent: "center" }}><View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} /></View>;

/** One glyph per kind of move, all muted but stale (foreground): the shape says what moves it before the words do. */
function TaskGlyph({ row, w, colors }: { row: TaskViewRow; w: Workspace; colors: Colors }) {
  const muted = colors.foregroundMuted;
  switch (row.kind) {
    // Stale is the one mark with colour, and a size step so it never leans on hue alone; due is muted like the rest.
    case "stale": return <Dot color={colors.foreground} size={8} />;
    case "due": return <Dot color={muted} size={7} />;
    case "working": return row.status.tone === "working" ? <Spinner color={colors.accent} size={13} /> : <Dot color={muted} />;
    case "blocked": return <Icon name="CirclePause" size={14} color={muted} />;
    case "after-pr": return <Icon name="GitPullRequest" size={14} color={muted} />;
    case "recheck": return <Icon name="CalendarClock" size={14} color={muted} />;
    case "scheduled":
      if (row.status.tone === "queued" || row.status.tone === "sent") return <DeliveryGlyph state={row.status.tone} w={w} colors={colors} />;
      // A time trigger that couldn't go out is the developer's to notice (amber, its own shape); one that went out is a send.
      if (row.o.trigger?.event === "at" && row.o.trigger.notSent) return <Icon name="CircleAlert" size={14} color={colors.foreground} />;
      if (row.o.trigger?.event === "at" && row.o.trigger.sentAt) return <Icon name="Send" size={14} color={muted} />;
      return <Icon name="Clock" size={14} color={muted} />;
    case "needs-you": return <Icon name={linkedQuestion(row.o, w)?.need === "action" ? "Hand" : "MessageCircleQuestion"} size={14} color={muted} />;
    default: return <Dot color={muted} />;
  }
}

/** The meta line: "Stale" in amber, the rest muted; everything else muted. */
function MetaLine({ row, theme }: { row: TaskViewRow; theme: Theme }) {
  const c = theme.colors; const t = text(c);
  if (row.kind !== "stale" && !row.meta.startsWith(DIDNT_GO_OUT)) return <Text style={[t.meta, { fontVariant: ["tabular-nums"] }]}>{row.meta}</Text>;
  const [word, ...rest] = row.meta.split(" · ");
  return <Text style={[t.meta, { fontVariant: ["tabular-nums"] }]}><Text style={{ color: c.foreground, fontWeight: "600" }}>{word}</Text>{rest.length ? ` · ${rest.join(" · ")}` : ""}</Text>;
}

/** The agent's own words under a stale or due row, two lines at most; the whole note opens with the row. */
function Note({ text: note, theme, full }: { text: string; theme: Theme; full: boolean }) {
  const c = theme.colors;
  return <View style={{ marginTop: 3, paddingLeft: 8, borderLeftWidth: 2, borderLeftColor: c.border }}>
    <RichText selectable={full} numberOfLines={full ? undefined : 2} linkColor={c.foreground} style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{`Agent's note: ${note}`}</RichText>
  </View>;
}

function TaskRow({ row, w, theme, compact, open, onPress, openAgent, onSchedule }: { row: TaskViewRow; w: Workspace; theme: Theme; compact: boolean; open: boolean; onPress: () => void; openAgent?: (agentId: string) => void; onSchedule: () => void }) {
  const c = theme.colors; const t = text(c);
  const o = row.o;
  const inNeeds = row.kind === "needs-you";
  const evidence = (o.evidence ?? "").trim();
  // A row opens in place (no sheet for a two-line fact): the agent's whole note, its agent, and the developer's override.
  const detail = open && !inNeeds;
  const prs = o.afterPrs.map(p => `#${p.split("#")[1]}`).join(", ");
  return <View style={{ borderTopWidth: 1, borderTopColor: c.border, backgroundColor: detail ? c.surface1 : "transparent" }}>
    <Pressable accessibilityRole="button" aria-expanded={inNeeds ? undefined : open} accessibilityState={inNeeds ? undefined : { expanded: open }}
      accessibilityLabel={`Task: ${o.title}. ${row.meta}. ${inNeeds ? "Open it in Needs you" : open ? "Hide details" : "Show details"}`} onPress={onPress}
      style={state => ({ flexDirection: "row", gap: 10, paddingHorizontal: compact ? 14 : 12, paddingVertical: 9, minHeight: compact ? 52 : 44, backgroundColor: state.pressed ? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
      <View style={{ width: 16, paddingTop: 2, alignItems: "center" }}><TaskGlyph row={row} w={w} colors={c} /></View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <RichText plain numberOfLines={detail ? undefined : 2} style={t.body}>{o.title}</RichText>
        <MetaLine row={row} theme={theme} />
        {row.note && !detail && <Note text={row.note} theme={theme} full={false} />}
      </View>
      {inNeeds && <View style={{ paddingTop: 2 }}><Icon name="ArrowUpRight" size={14} color={c.foregroundMuted} /></View>}
    </Pressable>
    {detail && <View style={{ paddingLeft: compact ? 40 : 38, paddingRight: compact ? 14 : 12, paddingBottom: 10, gap: 8 }}>
      {evidence ? <Note text={evidence} theme={theme} full /> : <Text style={t.meta}>No note yet. The agent adds one when it checks or finishes the task.</Text>}
      {prs ? <Text style={[t.meta, { paddingLeft: 10 }]}>{`Moves with ${prs}`}</Text> : null}
      {/* Lined up with the note's text, past its rule. */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, paddingLeft: 10 }}>
        <OpenAgentLink status={row.status} openAgent={openAgent} theme={theme} compact={compact} lead={false} />
        {o.status !== "working" && <><Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17 }} accessibilityElementsHidden importantForAccessibility="no">{row.status.agentId && openAgent ? "·" : ""}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={`Send ${o.title} to the agent on a schedule`} hitSlop={compact ? 12 : 6} onPress={onSchedule}
            style={state => ({ borderRadius: 4, opacity: state.pressed ? 0.6 : 1, ...((state as { hovered?: boolean }).hovered ? { textDecorationLine: "underline" } : {}) } as object)}>
            <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17 }}>Send on a schedule…</Text>
          </Pressable></>}
      </View>
    </View>}
  </View>;
}

/** The developer's override: send this task to the agent now, or after its PRs merge or deploy (an agent tool too). */
function ScheduleSheet({ o, w, theme, compact, onClose }: { o: Obligation | null; w: Workspace; theme: Theme; compact: boolean; onClose: () => void }) {
  const t = text(theme.colors);
  return <Modal title="Send on a schedule" icon={<Icon name="Clock" size={18} color={theme.colors.foreground} />} open={!!o} onOpenChange={next => { if (!next) onClose(); }}>
    <Modal.Content contentContainerStyle={{ padding: compact ? 16 : 20, gap: 14 }}>
      {o && <>
        <RichText selectable style={[t.title, { fontSize: 16, lineHeight: 22 }]}>{o.title}</RichText>
        <TriggerEditor key={`${o.id}:${o.revision}`} obligation={o} workspace={w} theme={theme} compact={compact} />
      </>}
    </Modal.Content>
  </Modal>;
}

export function TasksCard({ workspace: w, theme, compact, open, toggle, onOpenQuestion, openAgent, onShowActivity, now = Date.now() }: { workspace: Workspace; theme: Theme; compact: boolean; open: (key: string) => boolean; toggle: (key: string) => void; onOpenQuestion?: (id: string) => void; openAgent?: (agentId: string) => void; /** The footer's "in Activity": scrolls to the Activity card, where finished tasks are. */ onShowActivity?: () => void; now?: number }) {
  const c = theme.colors; const t = text(c);
  const [schedule, setSchedule] = useState<string | null>(null);
  // Live state of the agents working tasks name: the engine stores it with runtimeBusy (directory metadata, wakes
  // nothing), so the row, the live line and Home all read the same states.
  const rows = taskViewRows(w, w.taskAgents ?? {}, now);
  const sum = taskSummary(w, now, rows);
  // Opened, the card pages its rows (client/paged-list.tsx): due and stale sort first, so page 1 holds what moves.
  const page = usePagedList({ items: rows, theme, compact, noun: "tasks" });
  if (!rows.length && !sum.finished) return null;
  // Collapsed by default, in every state: the tasks are the agent's, and the line says whether it keeps up. The line
  // shows open or folded.
  const parts = summaryParts(sum);
  const footer = finishedParts(sum);
  const label = `${parts.neutral}${parts.stale ? ` · ${parts.stale}` : ""}`;
  const line = <Text numberOfLines={1} style={{ flexShrink: 1, color: c.foregroundMuted, fontSize: 12, lineHeight: 17, fontVariant: ["tabular-nums"] }}>{parts.neutral}{parts.stale ? <Text style={{ color: c.foreground, fontWeight: "600" }}>{` · ${parts.stale}`}</Text> : null}</Text>;
  return <Card theme={theme} compact={compact} icon="ListTodo" title="Agent's tasks" fold={{ id: "tasks", defaultOpen: false, summary: line, openSummary: line, label }}>
    {page.shown.map(r => {
      const q = linkedQuestion(r.o, w);
      return <TaskRow key={r.o.id} row={r} w={w} theme={theme} compact={compact} open={open(`task:${r.o.id}`)} openAgent={openAgent} onSchedule={() => setSchedule(r.o.id)}
        onPress={() => r.kind === "needs-you" && q && onOpenQuestion ? onOpenQuestion(q.id) : toggle(`task:${r.o.id}`)} />;
    })}
    {page.footer}
    {!rows.length && <View style={{ paddingHorizontal: compact ? 14 : 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: c.border }}>
      <Text style={t.meta}>Nothing open. The agent records work that outlives a merge here, like a migration to run or a production check.</Text>
    </View>}
    {footer && (onShowActivity
      // "in Activity" is a link: finished tasks are listed there (tasks-are-the-agent-s). The whole row is the target
      // (44pt on touch), and the label says where it goes when read alone.
      ? <Pressable accessibilityRole="link" accessibilityLabel={`${footer.count}. Show finished tasks in Activity`} onPress={onShowActivity}
          hitSlop={compact ? undefined : { top: 8, bottom: 8 }}
          style={{ paddingHorizontal: compact ? 14 : 12, paddingVertical: 9, minHeight: compact ? 44 : undefined, justifyContent: "center", borderTopWidth: 1, borderTopColor: c.border }}>
        <Text style={[t.meta, { fontVariant: ["tabular-nums"] }]}>{`${footer.count} · `}<Text style={{ color: c.foreground, textDecorationLine: "underline" }}>{footer.place}</Text></Text>
      </Pressable>
      : <View style={{ paddingHorizontal: compact ? 14 : 12, paddingVertical: 9, borderTopWidth: 1, borderTopColor: c.border }}>
        <Text style={[t.meta, { fontVariant: ["tabular-nums"] }]}>{footer.text}</Text>
      </View>)}
    <ScheduleSheet o={w.obligations.find(o => o.id === schedule) ?? null} w={w} theme={theme} compact={compact} onClose={() => setSchedule(null)} />
  </Card>;
}
