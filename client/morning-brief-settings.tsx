import { useEffect, useRef, useState, type ReactNode } from "react";
import { PagedRows } from "./paged-list";
import { ActivityIndicator, View } from "react-native";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { Icon, SettingsAction, SettingsCard, SettingsSection, SettingsSelect, SettingsSwitch, copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pressable, Text } from "./text";
import { Button, IconButton, Switch, errorText, text, type Theme } from "./kit";
import { raised, tint, withAlpha } from "./theme";
import { CompassReading, CompassSection, CompassWhen, compassKey } from "./compass-settings";
import { briefSettingsRpc, briefSourcesRpc, setBriefPlanRpc, setBriefSettingsRpc, setBriefSourcesRpc } from "../shared/contracts";
import { ASK_COST, inputLabel, inputRole, type BriefSource, type SourcesChange, type SourcesView } from "../shared/brief-sources";
import { ASK } from "../shared/ask";
import { QUEUE_STATE_TYPES, WEEKDAYS, defaultWorkdays, isZone, type Weekday } from "../shared/linear-queue";
import {
  PLAN_MODES, planCard, queueStateLabel, type BriefSettingsView, type PlanChange, type PlanMode, type PlanView, type QueueChange,
} from "../shared/morning-brief";
import { Field } from "./field";

export const briefSettingsKey = ["follow-up", "brief-settings"];
export const briefSourcesKey = ["follow-up", "brief-sources"];
const MODE_LABEL: Record<PlanMode, string> = { compass: "Compass", link: "A link", off: "Off" };

/**
 * Settings → Compass (docs/compass.md#settings, one-place-for-priority-inputs): the one place for what sets the
 * developer's priorities. What sets your priorities lists every input AI priority reads (the Compass sources, then the
 * Linear queue, DMs and mentions, the calendar, mail, review requests and Ask servers, each with its role); then this
 * week's plan, How to read your Compass, When, and Connections. Every change goes through the RPCs the agent tools run
 * (set_compass, and set_brief_settings for the brief's own When).
 */
export function MorningBriefCategory({ theme, compact }: { theme: Theme; compact: boolean }) {
  const c = theme.colors;
  const read = useRpc(briefSettingsRpc);
  const query = useQuery({ queryKey: briefSettingsKey, queryFn: async () => await read({}) as BriefSettingsView, refetchInterval: 15_000 });
  const sources = useSourcesView();
  if (query.isPending) return <ActivityIndicator accessibilityLabel="Loading Compass settings" color={c.foregroundMuted} style={{ alignSelf: "flex-start", marginVertical: 8 }} />;
  if (query.error || !query.data) return <SettingsCard><SettingsAction label="Couldn't load Compass settings" hint={query.error ? errorText(query.error) : undefined} actionLabel="Retry" onPress={() => void query.refetch()} /></SettingsCard>;
  return <>
    <CompassSection theme={theme} compact={compact} after={<InputRows view={query.data} sources={sources} theme={theme} compact={compact} />} />
    <PlanSection view={query.data} theme={theme} compact={compact} />
    <CompassReading theme={theme} compact={compact} />
    <WhenSection view={query.data} theme={theme} compact={compact} />
    <ConnectionsSection sources={sources} theme={theme} compact={compact} />
  </>;
}

/**
 * The built-in inputs' read: every server mcpproxy has, matched by its tools (never its name), plus GitHub and Paseo.
 * Opening Settings asks mcpproxy again (once per visit); after that the screen only re-reads Follow-up's own state.
 */
function useSourcesView() {
  const read = useRpc(briefSourcesRpc); const write = useRpc(setBriefSourcesRpc);
  const cache = useQueryClient(); const toast = useToast();
  const checked = useRef(false);
  // While mcpproxy is being asked or a source read again, look again soon; otherwise every 15 s.
  const query = useQuery({ queryKey: briefSourcesKey, refetchInterval: q => q.state.data?.checking || q.state.data?.retrying.length || q.state.data?.previewing?.length ? 1_500 : 15_000,
    queryFn: async () => { const check = !checked.current; checked.current = true; return await read({ check }) as SourcesView; } });
  const change = useMutation({
    mutationFn: async (input: SourcesChange) => await write(input) as SourcesView,
    onSuccess: value => { cache.setQueryData(briefSourcesKey, value); void cache.invalidateQueries({ queryKey: compassKey }); },
    onError: error => toast.error(errorText(error)),
  });
  return { query, change };
}
type SourcesState = ReturnType<typeof useSourcesView>;

/**
 * The built-in inputs as rows of What sets your priorities, after the Compass sources: each with its role, its switch,
 * its health, and (behind its chevron) its own setting: the queue's states, the chat window, the calendar's days.
 * Servers no recipe fits follow under "Other servers on mcpproxy", for Ask.
 */
function InputRows({ view, sources, theme, compact }: { view: BriefSettingsView; sources: SourcesState; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const writeQueue = useRpc(setBriefSettingsRpc); const cache = useQueryClient(); const toast = useToast();
  const { query, change } = sources;
  const windows = useMutation({
    mutationFn: async (input: QueueChange) => await writeQueue(input) as BriefSettingsView,
    onSuccess: value => cache.setQueryData(briefSettingsKey, value),
    onError: error => toast.error(errorText(error)),
  });
  const data = query.data;
  // What the brief reads first (Paseo's own state is always read, so it isn't a row); servers it could Ask (off) after them.
  const used = (data?.sources ?? []).filter(r => r.kind !== "skipped" && r.id !== "paseo" && !(r.kind === "ask" && !r.on));
  const askable = (data?.sources ?? []).filter(r => r.kind === "ask" && !r.on);
  const pending = change.isPending ? change.variables : null;
  const checking = !!data?.checking || !!pending?.check;
  const toastCopy = (command: string) => { void copyText(command).then(() => toast.show("Copied", { variant: "success" }), () => toast.error("Couldn't copy here")); };
  const q = view.queue;
  const detail = (row: BriefSource): { line: string; body: ReactNode } | null => {
    if (row.recipe === "linear") return { line: q.states.map(queueStateLabel).join(", "), body: <ChipGroup label="Counts as the queue" hint="Issues assigned to you in these states. At least one."
      options={QUEUE_STATE_TYPES.map(st => ({ value: st, label: queueStateLabel(st) }))} value={q.states} disabled={windows.isPending}
      onChange={states => windows.mutate({ states: states as typeof q.states })} theme={theme} compact={compact} /> };
    if (row.recipe === "chat") return { line: `last ${q.chatHours} h`, body: <SettingsCard><SettingsSelect label="Chat window" hint="How far back AI priority reads DMs and mentions." value={String(q.chatHours)} disabled={windows.isPending}
      options={[24, 48, 72].map(h => ({ value: String(h), label: `Last ${h} h` }))} onValueChange={v => windows.mutate({ chatHours: Number(v) as 24 | 48 | 72 })} /></SettingsCard> };
    if (row.recipe === "calendar") return { line: q.calendarDays === 2 ? "today and tomorrow" : "today", body: <SettingsCard><SettingsSelect label="Meetings" hint="Which meetings AI priority reads." value={String(q.calendarDays)} disabled={windows.isPending}
      options={[{ value: "1", label: "Today" }, { value: "2", label: "Today and tomorrow" }]} onValueChange={v => windows.mutate({ calendarDays: Number(v) as 1 | 2 })} /></SettingsCard> };
    return null;
  };
  return <>
    {query.isPending && <View style={{ padding: compact ? 14 : 12, borderTopWidth: 1, borderTopColor: c.border }}><ActivityIndicator accessibilityLabel="Checking sources" color={c.foregroundMuted} style={{ alignSelf: "flex-start" }} /></View>}
    {query.error && <View style={{ padding: compact ? 14 : 12, borderTopWidth: 1, borderTopColor: c.border }}><Warning text={`Couldn't read the built-in sources: ${errorText(query.error)}`} action={<Button title="Retry" kind="ghost" theme={theme} compact={compact} onPress={() => void query.refetch()} />} theme={theme} compact={compact} /></View>}
    {used.length > 0 && <View style={{ paddingHorizontal: compact ? 14 : 12, paddingTop: 12, paddingBottom: 2, borderTopWidth: 1, borderTopColor: c.border }}>
      <Text style={[t.meta, { color: c.foreground, fontWeight: "600" }]}>Built in</Text>
    </View>}
    <PagedRows items={[...used, ...askable]} theme={theme} compact={compact} noun="sources" row={(row, i) => <View key={row.id}>
      {i === used.length && <View style={{ paddingHorizontal: compact ? 14 : 12, paddingTop: 12, paddingBottom: 2, borderTopWidth: 1, borderTopColor: c.border, gap: 2 }}>
        <Text style={[t.meta, { color: c.foreground, fontWeight: "600" }]}>Other servers on mcpproxy</Text>
        <Text style={t.meta}>No recipe fits these. Preview one to see what a fast model would pick out for you.</Text>
      </View>}
      <SourceRow row={row} first={false} theme={theme} compact={compact} checking={checking} sweepAt={q.sweepAt} detail={detail(row)}
        busy={data!.retrying.includes(row.id) || (!!pending && (pending.retry === row.id || (pending.on ? row.id in pending.on : false)))}
        previewing={data!.previewing.includes(row.id) || pending?.preview === row.id}
        onToggle={on => change.mutate({ on: { [row.id]: on } })} onRetry={() => change.mutate({ retry: row.id })} onCheck={() => change.mutate({ check: true })} onCopy={toastCopy}
        onPreview={() => change.mutate({ preview: row.id })} />
    </View>} />
  </>;
}

/**
 * Connections: what mcpproxy and GitHub let Follow-up read. One line (how many inputs read, or what failed), the
 * servers it can't read (folded), and Check sources again.
 */
function ConnectionsSection({ sources, theme, compact }: { sources: SourcesState; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const { query, change } = sources;
  const data = query.data;
  const [showNotRead, setShowNotRead] = useState(false);
  if (!data) return null;
  const notRead = data.sources.filter(r => r.kind === "skipped");
  const checking = !!data.checking || !!(change.isPending && change.variables?.check);
  return <SettingsSection title="Connections" info="What mcpproxy and GitHub let Follow-up read. Each source is found by the tools mcpproxy offers, never by its name, and only its read-only tools are ever called.">
    {/* Each input's own failure is on its row above; Connections says only what no row can: mcpproxy itself failing. */}
    {data.error ? <Warning text={data.error} theme={theme} compact={compact} /> : <Text style={t.meta}>{connectionsLine(data.sources)}</Text>}
    {notRead.length > 0 && <View style={{ gap: 6 }}>
      <Pressable accessibilityRole="button" aria-expanded={showNotRead} accessibilityState={{ expanded: showNotRead }} onPress={() => setShowNotRead(v => !v)}
        style={{ flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start", minHeight: compact ? 44 : 24 }}>
        <Text style={t.meta}>{`${notRead.length} more on mcpproxy Follow-up can't read`}</Text>
        <Icon name={showNotRead ? "ChevronUp" : "ChevronDown"} size={13} color={c.foregroundMuted} />
      </Pressable>
      {showNotRead && <PagedRows items={notRead} theme={theme} compact={compact} noun="servers" row={row => <View key={row.id} style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: 6 }}>
        <Text style={[t.meta, MONO, { color: c.foreground }]}>{row.label}</Text>
        <Text style={t.meta}>{row.detail ?? row.adds}</Text>
      </View>} />}
    </View>}
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      <Button title="Check sources again" icon="RotateCcw" theme={theme} compact={compact} loading={checking} onPress={() => change.mutate({ check: true })} />
      {data.checking ? <Text style={t.meta}>Asking mcpproxy…</Text> : data.checkedAt && <Text style={t.meta}>{`Checked ${clock(data.checkedAt)}`}</Text>}
    </View>
  </SettingsSection>;
}

/** "6 inputs read", or "6 inputs read · 2 need attention above": the count, never each row's failure again. */
function connectionsLine(rows: readonly BriefSource[]): string {
  const used = rows.filter(r => r.on && r.kind !== "skipped");
  // Names, not the failures: each row above already says what's wrong and how to fix it.
  const bad = used.filter(r => r.health === "failed" || r.health === "sign-in").map(r => inputLabel(r));
  const names = bad.length > 2 ? `${bad.slice(0, 2).join(", ")} and ${bad.length - 2} more` : bad.join(" and ");
  return `${used.length} input${used.length === 1 ? "" : "s"} read${bad.length ? ` · ${names} need${bad.length === 1 ? "s" : ""} attention above` : ""}`;
}

const MONO = { fontFamily: "ui-monospace, Menlo, monospace", fontSize: 11 } as const;
/** 24-hour time, like the sweep's "07:00". */
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** An amber line: the icon stays beside the first line, the text wraps under itself, an action follows it. */
function Warning({ text: line, action, theme, compact }: { text: string; action?: ReactNode; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  return <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
    <View style={{ paddingTop: compact ? 4 : 3 }}><Icon name="TriangleAlert" size={12} color={c.statusWarning} /></View>
    <View style={{ flex: 1, minWidth: 0, flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 8 }}>
      <Text style={[t.meta, { color: c.statusWarning, flexShrink: 1 }]}>{line}</Text>
      {action}
    </View>
  </View>;
}

/**
 * One source: healthy ones show no colour; one that failed says why in amber with Retry, one that needs a sign-in
 * gives the command to copy and Check again.
 */
function SourceRow({ row, first, busy, checking, previewing, sweepAt, detail, onToggle, onRetry, onCheck, onCopy, onPreview, theme, compact }: {
  row: BriefSource; first: boolean; busy: boolean; checking: boolean; previewing: boolean; sweepAt: string; detail: { line: string; body: ReactNode } | null; onToggle: (on: boolean) => void; onRetry: () => void; onCheck: () => void; onCopy: (command: string) => void; onPreview: () => void; theme: Theme; compact: boolean;
}) {
  const c = theme.colors; const t = text(c, compact);
  const bad = row.on && (row.health === "failed" || row.health === "sign-in");
  const [open, setOpen] = useState(false);
  // Its role first (one-place-for-priority-inputs), then its own setting's value, then the last read.
  const meta = [row.kind === "ask" && !row.on ? null : inputRole(row), detail?.line ?? row.adds, row.on && row.health === "ok" && row.readAt ? `read ${clock(row.readAt)}` : null].filter(Boolean).join(" · ");
  const label = inputLabel(row);
  // An Ask source that's off turns on only after a fresh preview that didn't fail (the server refuses otherwise).
  const ask = row.kind === "ask";
  const fresh = !!row.asked?.canTurnOn;
  // Never previewed: Preview sits where the switch would. After a preview, its card carries Turn on and Preview again.
  const needsPreview = ask && !row.on && !row.asked && !previewing;
  const action = (title: string, onPress: () => void, loading: boolean, icon = "RotateCcw", label?: string) => <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} disabled={loading} hitSlop={compact ? 0 : 6}
    style={{ flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start", minHeight: compact ? 44 : 18, opacity: loading ? 0.6 : 1 }}>
    {loading ? <ActivityIndicator size="small" color={c.accent} /> : <Icon name={icon} size={12} color={c.accent} />}
    <Text style={[t.meta, { color: c.accent, fontWeight: "600" }]}>{title}</Text>
  </Pressable>;
  return <View style={{ flexDirection: "row", gap: 10, alignItems: "flex-start", padding: compact ? 14 : 12, borderTopWidth: first ? 0 : 1, borderTopColor: c.border }}>
    <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: 6 }}>
        {/* An Ask source's label is its server's own name: set as an identifier, like the server tags. */}
        <Text style={[t.label, { color: row.on ? c.foreground : c.foregroundMuted }, ask ? { fontFamily: MONO.fontFamily } : null]}>{label}</Text>
        {/* The mcpproxy server it reads, unless it says the same as the label. */}
        {row.server && row.server.toLowerCase() !== label.toLowerCase() && <Text style={[t.meta, MONO]}>{row.server}</Text>}
      </View>
      <Text style={t.meta}>{meta}</Text>
      {bad && <Warning text={row.detail ?? (row.health === "sign-in" ? "Needs a sign-in." : "The last read failed.")} theme={theme} compact={compact}
        action={row.health === "failed" ? action("Retry", onRetry, busy) : action("Check again", onCheck, checking)} />}
      {bad && row.command && <View style={{ flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", maxWidth: "100%", marginLeft: 18, paddingLeft: 10, borderRadius: 6, backgroundColor: c.surface2 }}>
        <Text selectable numberOfLines={1} style={{ flexShrink: 1, color: c.foreground, fontSize: 12, lineHeight: 17, fontFamily: MONO.fontFamily }}>{row.command}</Text>
        <IconButton theme={theme} compact={compact} icon="Copy" label={`Copy ${row.command}`} onPress={() => onCopy(row.command!)} />
      </View>}
      {!row.on && row.detail && <Text style={t.meta}>{row.detail}</Text>}
      {/* Phones: the 44 pt target stays, but its slack overlaps the row's padding instead of adding a gap under it. */}
      {needsPreview && <View style={compact ? { marginTop: -6, marginBottom: -12 } : null}>{action("Preview", onPreview, false, "Eye", `Preview what Ask would read from ${row.label}`)}</View>}
      {ask && !row.on && (previewing || row.asked) && <AskPreview row={row} previewing={previewing} fresh={fresh} sweepAt={sweepAt} onPreview={onPreview} onToggle={onToggle} busy={busy} theme={theme} compact={compact} />}
      {ask && row.on && row.asked && !row.asked.preview && !row.asked.error && <Text style={t.meta}>{row.asked.items.length ? `Found ${row.asked.items.length} for you at ${clock(row.asked.at)}` : `Nothing for you at ${clock(row.asked.at)}`}</Text>}
      {open && detail && <View style={{ paddingTop: 8 }}>{detail.body}</View>}
    </View>
    {detail && <IconButton theme={theme} compact={compact} icon={open ? "ChevronUp" : "ChevronDown"} label={`${open ? "Hide" : "Show"} ${label}'s setting`} onPress={() => setOpen(o => !o)} />}
    {ask && !row.on
      ? <Text style={[t.meta, { minHeight: compact ? 44 : 28, lineHeight: compact ? 44 : 28 }]}>Off</Text>
      : row.canToggle
      ? <Switch theme={theme} compact={compact} label={compact ? "" : row.on ? "On" : "Off"} accessibilityLabel={`Read ${label}`} value={row.on} disabled={busy} onChange={onToggle} />
      : <Text style={[t.meta, { minHeight: compact ? 44 : 28, lineHeight: compact ? 44 : 28 }]}>Always</Text>}
  </View>;
}

/** A due date in the screen's voice: today, tomorrow, else "Tue 3 Mar". */
function dueText(due: string): string {
  const d = new Date(due.length <= 10 ? `${due}T12:00:00` : due);
  if (Number.isNaN(d.getTime())) return due.slice(0, 10);
  const day = (x: Date) => x.toDateString();
  const now = new Date(); const tomorrow = new Date(now.getTime() + 86_400_000);
  return day(d) === day(now) ? "today" : day(d) === day(tomorrow) ? "tomorrow" : d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}

/**
 * An Ask source's preview: what one ask found (or why it failed), the tools it read, and Turn on. Nothing is on until
 * the developer turns it on here. A preview over a day old says so and asks for a new one.
 */
function AskPreview({ row, previewing, fresh, sweepAt, onPreview, onToggle, busy, theme, compact }: { row: BriefSource; previewing: boolean; fresh: boolean; sweepAt: string; onPreview: () => void; onToggle: (on: boolean) => void; busy: boolean; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const a = row.asked;
  const stale = !!a && !a.error && !fresh;
  const n = a?.items.length ?? 0;
  return <View style={{ marginTop: 8, gap: 8, padding: compact ? 12 : 10, borderRadius: 6, backgroundColor: c.surface2 }}>
    {previewing
      ? <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><ActivityIndicator size="small" color={c.foregroundMuted} /><Text style={[t.meta, { flexShrink: 1 }]}>{`Asking ${row.label}… a fast model picks up to ${ASK.calls} read-only lookups.`}</Text></View>
      : a?.error
        ? <Warning text={`The preview failed: ${a.error}`} theme={theme} compact={compact} />
        : a && <>
          <Text style={t.label}>{n ? `${row.label} would add ${n === 1 ? "this" : `these ${n}`} to today's brief` : `Nothing from ${row.label} for you today`}</Text>
          {a.items.map((it, i) => {
            const due = it.due && !/\bdue\b/i.test(it.why) ? `Due ${dueText(it.due)}` : null;
            const second = [due, it.why].filter(Boolean).join(" · ");
            const body = <>
              <Text style={t.body} numberOfLines={2}>{it.title}{it.url ? "  " : ""}{it.url ? <Icon name="ExternalLink" size={12} color={c.foregroundMuted} /> : null}</Text>
              {!!second && <Text style={t.meta} numberOfLines={2}>{second}</Text>}
            </>;
            return it.url
              ? <Pressable key={i} accessibilityRole="link" accessibilityLabel={`Open ${it.title} in ${row.label}`} onPress={() => void openExternalUrl(it.url!).catch(() => undefined)} style={{ gap: 1, minHeight: compact ? 44 : undefined, justifyContent: "center" }}>{body}</Pressable>
              : <View key={i} style={{ gap: 1 }}>{body}</View>;
          })}
          <Text style={t.meta}>{a.tools.length ? <>Read with <Text style={[t.meta, MONO]}>{a.tools.slice(0, 3).join(", ")}</Text>{` · read-only · previewed ${clock(a.at)}`}</> : `No lookups fit · previewed ${clock(a.at)}`}</Text>
          {stale && <Text style={t.meta}>{`This preview is over a day old. Preview again to turn ${row.label} on.`}</Text>}
        </>}
    {!previewing && <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        {a && !a.error && fresh && <Button title="Turn on" kind="primary" theme={theme} compact={compact} loading={busy} onPress={() => onToggle(true)} accessibilityLabel={`Turn on Ask for ${row.label}`} />}
        <Button title={a ? "Preview again" : "Preview"} kind={stale ? "primary" : "ghost"} icon={a?.error ? "RotateCcw" : "Eye"} theme={theme} compact={compact} onPress={onPreview} />
      </View>
      {a && !a.error && fresh && <Text style={t.meta}>{`Then asked once each workday morning, after the ${sweepAt} sweep, with ${ASK_COST}.`}</Text>}
    </View>}
  </View>;
}

function usePlanChange() {
  const write = useRpc(setBriefPlanRpc); const cache = useQueryClient(); const toast = useToast();
  return useMutation({
    mutationFn: async (input: PlanChange) => await write(input) as PlanView,
    onSuccess: plan => { cache.setQueryData<BriefSettingsView>(briefSettingsKey, v => v ? { ...v, plan } : v); void cache.invalidateQueries({ queryKey: briefSettingsKey }); void cache.invalidateQueries({ queryKey: compassKey }); },
    onError: error => toast.error(errorText(error)),
  });
}

/**
 * This week's plan: Compass (the newest claude.ai artifact a source with Posts the plan shares, as Compass reads
 * it), A link, or Off. Who posts it is a source above, never a picker here (one-place-for-priority-inputs).
 */
function PlanSection({ view, theme, compact }: { view: BriefSettingsView; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const plan = view.plan;
  const change = usePlanChange();
  // "Use a link" with nothing pasted yet shows the field without saving a mode that has no link.
  const [picked, setPicked] = useState<PlanMode | null>(null);
  const mode = picked ?? plan.mode;
  useEffect(() => { if (picked && picked === plan.mode) setPicked(null); }, [picked, plan.mode]);
  const env = plan.source === "env";
  const choose = (m: PlanMode) => {
    if (m === "link" && !plan.link) { setPicked("link"); return; }
    setPicked(null);
    if (m !== plan.mode) change.mutate({ mode: m });
  };
  const reading = !!plan.url && !plan.read && change.isSuccess;
  const card = planCard({ ...plan, mode }, Date.now(), view.clock.timeZone, reading);
  return <SettingsSection title="This week's plan" info="AI priority ranks your work with it, and the brief shows it. A Compass source with Posts the plan brings it: the newest claude.ai artifact they share, read as soon as Compass sees it. Agents can set it too.">
    {env
      ? <Text style={t.meta}>Set by the environment (FOLLOW_UP_PLAN_URL), which wins over these settings. Unset it to choose here.</Text>
      : <Segmented<PlanMode> label="Where the plan comes from" value={mode} options={PLAN_MODES.map(m => ({ value: m, label: MODE_LABEL[m] }))} onChange={choose} disabled={change.isPending} theme={theme} compact={compact} />}
    {!env && mode === "link" && <LinkField initial={plan.link ?? ""} busy={change.isPending} onUse={link => change.mutate({ link, mode: "link" })} theme={theme} compact={compact} />}
    {card && <PlanCardView card={card} busy={change.isPending} theme={theme} compact={compact} onAnother={() => setPicked("link")} onPaste={link => change.mutate({ link, mode: "link" })} />}
    {!env && plan.unmoved.length > 0 && <Warning text={`Who posts the plan moved into Compass as a source, but chat search couldn't find ${plan.unmoved.join(", ")}. Add them to a source with Posts the plan.`} theme={theme} compact={compact} />}
    {!env && mode === "link" && plan.sources.length > 0 && <SettingsCard>
      <SettingsSwitch label="Replace when a newer one arrives" hint={`A plan that ${plan.sources.map(x => `“${x.label}”`).join(" or ")} shares after you pasted this one takes over.`} value={plan.replaceWhenNewer} disabled={change.isPending}
        onValueChange={value => change.mutate({ replaceWhenNewer: value })} />
    </SettingsCard>}
  </SettingsSection>;
}

/** Three choices in one row: 44 px tall on a phone. */
function Segmented<V extends string>({ label, value, options, onChange, disabled, theme, compact }: { label: string; value: V; options: { value: V; label: string }[]; onChange: (v: V) => void; disabled?: boolean; theme: Theme; compact: boolean }) {
  const c = theme.colors;
  return <View accessibilityRole="radiogroup" accessibilityLabel={label} style={{ flexDirection: "row", alignSelf: compact ? "stretch" : "flex-start", backgroundColor: c.surface2, borderRadius: 8, padding: 2, gap: 2 }}>
    {options.map(choice => {
      const on = choice.value === value;
      return <Pressable key={choice.value} accessibilityRole="radio" accessibilityState={{ checked: on, disabled }} disabled={disabled} onPress={() => onChange(choice.value)}
        style={state => ({ flexGrow: compact ? 1 : 0, flexBasis: compact ? 0 : "auto", minHeight: compact ? 44 : 30, paddingHorizontal: 12, borderRadius: 6, alignItems: "center", justifyContent: "center",
          backgroundColor: on ? c.surface0 : (state as { hovered?: boolean }).hovered ? tint(c.foreground, c) : "transparent", ...(on ? { boxShadow: "0px 0px 0px 1px rgba(127,127,127,0.18)" } : {}) })}>
        <Text numberOfLines={1} style={{ color: on ? c.foreground : c.foregroundMuted, fontSize: compact ? 14 : 13, fontWeight: "500", textAlign: "center" }}>{choice.label}</Text>
      </Pressable>;
    })}
  </View>;
}

/** A text field; `mono` sets the typed value in monospace (a link), never the placeholder. */
function field(theme: Theme, compact: boolean, mono = false) {
  const c = theme.colors;
  return { flex: 1, minWidth: 0, minHeight: compact ? 44 : 32, paddingHorizontal: 10, borderRadius: 6, borderWidth: 1, borderColor: c.border, color: c.foreground, fontSize: 13, backgroundColor: c.surface0, ...(mono ? { fontFamily: "ui-monospace, Menlo, monospace" } : {}) } as const;
}

function LinkField({ initial, busy, onUse, theme, compact, placeholder = "https://claude.ai/artifact/…" }: { initial: string; busy: boolean; onUse: (link: string) => void; theme: Theme; compact: boolean; placeholder?: string }) {
  const c = theme.colors;
  const [value, setValue] = useState(initial);
  useEffect(() => setValue(initial), [initial]);
  const dirty = value.trim() !== initial && value.trim().length > 0;
  return <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
    <Field accessibilityLabel="The plan's link" value={value} onChangeText={setValue} placeholder={placeholder} placeholderTextColor={c.foregroundMuted} autoCapitalize="none" autoCorrect={false}
      onSubmitEditing={() => dirty && onUse(value.trim())} style={field(theme, compact, value.length > 0)} />
    {/* Shown once there's something new to use: then it's the screen's one primary action. */}
    {dirty && <Button title="Use it" kind="primary" theme={theme} compact={compact} loading={busy} onPress={() => onUse(value.trim())} />}
  </View>;
}

function PlanCardView({ card, busy, onAnother, onPaste, theme, compact }: { card: NonNullable<ReturnType<typeof planCard>>; busy: boolean; onAnother: () => void; onPaste: (link: string) => void; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const warn = card.tone === "warn";
  const icon = card.tone === "ok" ? "Check" : warn ? "TriangleAlert" : "Info";
  const iconColor = card.tone === "ok" ? c.statusSuccess : warn ? c.statusWarning : c.foregroundMuted;
  return <View accessibilityRole={warn ? "alert" : undefined} style={{ flexDirection: "row", gap: 10, padding: compact ? 14 : 12, borderRadius: 8, borderWidth: 1, borderColor: warn ? withAlpha(c.statusWarning, 0.4) : c.border, backgroundColor: warn ? withAlpha(c.statusWarning, 0.14) : c.surface1 }}>
    <View style={{ paddingTop: 2 }}><Icon name={icon} size={14} color={iconColor} /></View>
    <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
      <Text style={t.label}>{card.title}</Text>
      <Text style={t.meta}>{card.line}</Text>
      {warn && card.inUse && <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 4 }}>
        <Text style={t.meta}>{card.inUse.line}</Text>
        <Button title="Open" kind="ghost" icon="ExternalLink" theme={theme} compact={compact} onPress={() => void openExternalUrl(card.inUse!.url).catch(() => undefined)} />
      </View>}
      {card.tone === "ok" && <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {card.actions.includes("open") && <Button title="Open" icon="ExternalLink" grow={compact} theme={theme} compact={compact} onPress={() => void openExternalUrl(card.url).catch(() => undefined)} />}
        {card.actions.includes("another") && <Button title="Use another link" grow={compact} theme={theme} compact={compact} onPress={onAnother} />}
      </View>}
      {warn && card.paste && <LinkField initial="" busy={busy} onUse={onPaste} theme={theme} compact={compact} placeholder="Paste this week's link" />}
    </View>
  </View>;
}

const SWEEP_TIMES = ["05:00", "05:30", "06:00", "06:30", "07:00", "07:30", "08:00", "08:30", "09:00", "09:30", "10:00"];

/**
 * When: the brief's own settings (the morning read's time, "changes since", the zone and the workdays). Compass's
 * morning read, the queue's sweep and the sources check all run once a workday at this time (the-brief-has-one-timer).
 */
function WhenSection({ view, theme, compact }: { view: BriefSettingsView; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const write = useRpc(setBriefSettingsRpc); const cache = useQueryClient(); const toast = useToast();
  const change = useMutation({
    mutationFn: async (input: QueueChange) => await write(input) as BriefSettingsView,
    onSuccess: value => cache.setQueryData(briefSettingsKey, value),
    onError: error => toast.error(errorText(error)),
  });
  const q = view.queue;
  const times = [...new Set([...SWEEP_TIMES, q.sweepAt])].sort();
  const zoneFrom = view.clock.zoneFrom === "setting" ? "set here" : view.clock.zoneFrom === "device" ? "this device's" : "the host's";
  const usual = defaultWorkdays(view.clock.timeZone);
  return <SettingsSection title="When" info="The morning read: Compass reads its sources, the Linear queue is swept and mcpproxy is asked again, once each workday at this time. During the day Compass reads again while Follow-up is open. The brief's changes are counted from your last read.">
    <SettingsCard>
      <SettingsSelect label="Morning read at" hint={`On workdays, in ${view.clock.timeZone}.`} value={q.sweepAt} disabled={change.isPending}
        options={times.map(v => ({ value: v, label: v }))} onValueChange={sweepAt => change.mutate({ sweepAt })} />
      <CompassWhen theme={theme} compact={compact} part="cadence" />
      <CompassWhen theme={theme} compact={compact} part="routing" />
      <SettingsSelect label="Changes since" hint={q.since === "read" ? "What moved since you last read the brief; before your first read, since the last workday's sweep." : "What moved since the last workday's sweep, however often you look."}
        value={q.since} disabled={change.isPending} options={[{ value: "read", label: "Your last read" }, { value: "workday", label: "Your last workday" }]} onValueChange={since => change.mutate({ since })} />
    </SettingsCard>
    <ZoneField view={view} zoneFrom={zoneFrom} busy={change.isPending} onChange={timeZone => change.mutate({ timeZone })} theme={theme} compact={compact} />
    <ChipGroup label="Workdays" hint={q.workdays ? "Set here." : "The zone's usual week."} options={WEEKDAYS.map(d => ({ value: d, label: d }))} value={q.workdays ?? usual} disabled={change.isPending}
      onChange={days => change.mutate({ workdays: sameDays(days, usual) ? null : days as Weekday[] })} theme={theme} compact={compact} />
  </SettingsSection>;
}
const sameDays = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every(d => b.includes(d));

/** A labelled row of on/off chips (checkboxes): at least one stays on. 44 px on a phone. */
function ChipGroup({ label, hint, options, value, onChange, disabled, theme, compact }: { label: string; hint?: string; options: { value: string; label: string }[]; value: readonly string[]; onChange: (v: string[]) => void; disabled?: boolean; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  return <View style={{ gap: 6 }}>
    <Text style={t.label}>{label}</Text>
    {hint && <Text style={t.meta}>{hint}</Text>}
    <View role="group" aria-label={label} style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {options.map(choice => {
        const on = value.includes(choice.value);
        const last = on && value.length === 1;
        return <Pressable key={choice.value} accessibilityRole="checkbox" accessibilityState={{ checked: on, disabled: disabled || last }} accessibilityLabel={choice.label} disabled={disabled || last}
          onPress={() => onChange(on ? value.filter(x => x !== choice.value) : options.map(x => x.value).filter(x => x === choice.value || value.includes(x)))}
          style={state => ({ minWidth: compact ? 44 : 40, minHeight: compact ? 44 : 30, paddingHorizontal: 10, borderRadius: 6, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, borderWidth: 1,
            borderColor: on ? withAlpha(c.accent, 0.55) : c.border, backgroundColor: on ? withAlpha(c.accent, 0.1) : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
          {on && <Icon name="Check" size={12} color={c.foreground} />}
          <Text style={{ color: on ? c.foreground : c.foregroundMuted, fontSize: 13, fontWeight: "500" }}>{choice.label}</Text>
        </Pressable>;
      })}
    </View>
  </View>;
}

function ZoneField({ view, zoneFrom, busy, onChange, theme, compact }: { view: BriefSettingsView; zoneFrom: string; busy: boolean; onChange: (z: string | null) => void; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const [value, setValue] = useState(view.queue.timeZone ?? "");
  useEffect(() => setValue(view.queue.timeZone ?? ""), [view.queue.timeZone]);
  const v = value.trim();
  const valid = !v || isZone(v);
  const dirty = v !== (view.queue.timeZone ?? "");
  return <View style={{ gap: 6 }}>
    <Text style={t.meta}>{`Time zone: ${view.clock.timeZone} (${zoneFrom})`}</Text>
    <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
      <Field accessibilityLabel="Time zone" value={value} onChangeText={setValue} placeholder="Automatic: this device's zone" placeholderTextColor={c.foregroundMuted} autoCapitalize="none" autoCorrect={false}
        onSubmitEditing={() => valid && dirty && onChange(v || null)} style={field(theme, compact)} />
      {dirty && <Button title={v ? "Save" : "Use automatic"} theme={theme} compact={compact} disabled={!valid} loading={busy} onPress={() => onChange(v || null)} />}
    </View>
    {!valid && <Text accessibilityRole="alert" style={[t.meta, { color: c.statusDanger }]}>Use an IANA time zone, like Europe/Paris.</Text>}
  </View>;
}
