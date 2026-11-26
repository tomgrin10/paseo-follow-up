import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PagedRows } from "./paged-list";
import { ActivityIndicator, Platform, View } from "react-native";
import * as PluginClient from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, ScrollView } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { prStatsFeed, prStatsRpc } from "../shared/contracts";
import { PERIODS, type Period } from "../shared/pr-stats";
import { COLUMNS, columnMax, DEFAULT_SORT, durationWords, isSortKey, medianCell, PERIOD_LABELS, personLine, personWords, rangeWords, sortPeople, syncLine, teamFacts, type Person, type SortKey } from "../shared/pr-stats-page";
import type { PrStatsOutput } from "../shared/pr-stats-settings";
import { Button, errorText, IconButton, PrLinkButton, space, text, useNow, type Theme } from "./kit";
import { PrStatsSettings } from "./pr-stats-settings";
import { Pressable, Text } from "./text";
import { withAlpha } from "./theme";

/**
 * The PR stats page (Home's view `stats`, docs/pr-stats.md#the-page): the leaderboard. One row per person with
 * PRs opened, merged, their PRs' median wait for a first review (p75 on hover), reviews given and review turnaround,
 * sortable by every column, opened first. A row opens the person: a sheet on desktop, its own screen on a phone (the
 * host's ← goes back). Bars are neutral ink: the table is history, not a queue, so nothing here is amber.
 *
 * Reads: one `follow.pr-stats` for the repository and period on screen. The page's feed (`follow.pr-stats-feed`, only
 * while it is mounted) makes the repository sync every 5 minutes and pushes its status, and the page re-reads when the
 * status moves; on a host without subscriptions it re-reads every 5 minutes instead. Nothing polls once it closes.
 */
export type StatsParams = { repo?: string; period?: string; person?: string; sort?: string };
export type StatsDeps = { onHome: () => void; openSettings: () => void; openStats: (params: StatsParams) => void };
const FALLBACK_POLL_MS = 5 * 60_000;
/**
 * Paseo 0.16's `useSubscription`; a 0.15 host's plugin client has none (calling it threw "is not a function"). The host
 * is fixed for the app's life, so the hook chosen here never changes between renders; without it the page re-reads on
 * FALLBACK_POLL_MS while it is on screen.
 */
const useFeed: typeof PluginClient.useSubscription = typeof (PluginClient as { useSubscription?: unknown }).useSubscription === "function"
  ? PluginClient.useSubscription : (() => ({ status: "closed" as const })) as never;
export const prStatsKey = (repo: string | null, period: string, person: string | null) => ["follow-up", "pr-stats", repo, period, person];

export function StatsPage({ theme, compact, params, deps }: { theme: Theme; compact: boolean; params: StatsParams; deps: StatsDeps }) {
  const c = theme.colors; const t = text(c, compact); const sp = space(compact);
  const read = useRpc(prStatsRpc); const cache = useQueryClient();
  const [repo, setRepo] = useState<string | null>(params.repo ?? null);
  const [period, setPeriod] = useState<Period>(PERIODS.includes(params.period as Period) ? params.period as Period : "week");
  const [sort, setSort] = useState<SortKey>(isSortKey(params.sort) ? params.sort : DEFAULT_SORT);
  const [sheet, setSheet] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // A phone opened on a person (its own screen): the drill-down is the page.
  const person = compact ? params.person ?? null : null;
  const query = useQuery({ queryKey: prStatsKey(repo, period, person), queryFn: () => read({ ...(repo ? { repo } : {}), period, ...(person ? { person } : {}) }), placeholderData: prev => prev, staleTime: 60_000 });
  const out = query.data;
  const shown = out?.repo ?? null;
  // The feed: only while this page is on screen, for the repository it shows.
  const feed = useFeed(prStatsFeed, { repo: shown ?? "example/none" }, () => { void cache.invalidateQueries({ queryKey: ["follow-up", "pr-stats", shown] }); void cache.invalidateQueries({ queryKey: ["follow-up", "pr-stats", null] }); });
  const live = !!shown && feed.status === "live";
  useEffect(() => {
    if (live || !shown) return;
    const timer = setInterval(() => void query.refetch(), FALLBACK_POLL_MS);
    return () => clearInterval(timer);
  }, [live, shown, query]);
  const now = Math.floor(useNow(30_000) / 1000);
  const refresh = async () => {
    setRefreshing(true);
    try { const fresh = await read({ ...(shown ? { repo: shown } : {}), period, fresh: true, ...(person ? { person } : {}) }); cache.setQueryData(prStatsKey(repo, period, person), fresh); }
    catch { void query.refetch(); } finally { setRefreshing(false); }
  };
  const openPerson = (login: string) => compact ? deps.openStats({ repo: shown ?? undefined, period, person: login, sort }) : setSheet(login);

  const header = <View style={{ gap: 6 }}>
    {!compact && <Button theme={theme} kind="ghost" icon="House" title="Home" onPress={deps.onHome} />}
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text accessibilityRole="header" numberOfLines={1} style={t.headline}>{person ? person : "PR stats"}</Text>
        {person && out?.repo && <Text style={t.meta}>{`${out.repo} · ${PERIOD_LABELS[period]}`}</Text>}
      </View>
      {out?.model && <IconButton theme={theme} compact={compact} icon="RefreshCw" label="Read GitHub now" tooltip spinning={refreshing} disabled={refreshing} onPress={() => void refresh()} />}
      <IconButton theme={theme} compact={compact} icon="Settings" label="PR statistics settings" tooltip onPress={deps.openSettings} />
    </View>
  </View>;

  const body = (() => {
    if (query.isPending) return <ActivityIndicator accessibilityLabel="Loading PR stats" color={c.foregroundMuted} style={{ alignSelf: "flex-start", marginTop: 12 }} />;
    if (query.error && !out) return <View style={{ gap: 10 }}>
      <Text accessibilityRole="alert" style={[t.body, { color: c.statusDanger }]}>{`Couldn't read PR stats: ${errorText(query.error)}`}</Text>
      <Button theme={theme} compact={compact} title="Try again" onPress={() => void query.refetch()} />
    </View>;
    if (!out) return null;
    if (out.empty || !out.model) return <NotOnYet theme={theme} compact={compact} />;
    if (person) return <PersonView theme={theme} compact={compact} out={out} login={person} />;
    return <Leaderboard theme={theme} compact={compact} out={out} now={now} period={period} sort={sort} onSort={setSort}
      onPeriod={setPeriod} onRepo={setRepo} onPerson={openPerson} onSettings={deps.openSettings} />;
  })();

  return <View style={{ flex: 1, backgroundColor: c.surface0 }}>
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: compact ? sp.gutter : 28, paddingBottom: 48, gap: 14, maxWidth: 1120, width: "100%", alignSelf: "center" }}>
      {header}
      {body}
    </ScrollView>
    {sheet && shown && <PersonSheet theme={theme} compact={compact} repo={shown} period={period} login={sheet} onClose={() => setSheet(null)} />}
  </View>;
}

/** No repository on: what the page is for, and the switches to turn one on (the opt-in sheet), nothing fake. */
function NotOnYet({ theme, compact }: { theme: Theme; compact: boolean }) {
  const t = text(theme.colors, compact);
  return <View style={{ gap: 12, maxWidth: 720 }}>
    <Text style={t.body}>See who opens, merges and reviews PRs, and how long PRs wait for a first review, from each repository's own GitHub data. Turn it on per repository; it reads GitHub slowly in the background and stays on this machine.</Text>
    <PrStatsSettings theme={theme} compact={compact} onPage />
  </View>;
}

export function Leaderboard({ theme, compact, out, now, period, sort, onSort, onPeriod, onRepo, onPerson, onSettings }: {
  theme: Theme; compact: boolean; out: PrStatsOutput; now: number; period: Period; sort: SortKey;
  onSort: (k: SortKey) => void; onPeriod: (p: Period) => void; onRepo: (r: string) => void; onPerson: (login: string) => void; onSettings?: () => void;
}) {
  const c = theme.colors; const t = text(c, compact);
  const model = out.model!;
  const sync = syncLine(out, now);
  const rows = useMemo(() => sortPeople(model.people, sort), [model.people, sort]);
  const max = useMemo(() => columnMax(model.people), [model.people]);
  const facts = teamFacts(model);
  const soFar = sync?.soFar ? " so far" : "";
  const toneColor = sync?.tone === "danger" ? c.statusDanger : sync?.tone === "warning" ? c.statusWarning : c.foregroundMuted;
  return <View style={{ gap: 14 }}>
    <View style={{ flexDirection: compact ? "column" : "row", alignItems: compact ? "stretch" : "center", gap: 10, flexWrap: "wrap" }}>
      <RepoPicker theme={theme} compact={compact} out={out} onRepo={onRepo} />
      <Segmented theme={theme} compact={compact} label="Period" value={period} options={PERIODS.map(p => ({ value: p, text: PERIOD_LABELS[p] }))} onChange={onPeriod} />
    </View>
    <View style={{ gap: 4 }}>
      <Text style={t.meta}>{`${rangeWords(out)} · ${out.clock === "working" ? "working hours" : "calendar time"} · ${out.timeZone}`}</Text>
      {sync && <View style={{ flexDirection: "row", gap: 6, alignItems: "flex-start" }}>
        <Icon name={sync.tone === "danger" ? "CircleAlert" : sync.tone === "warning" ? "TriangleAlert" : "Clock"} size={13} color={toneColor} />
        <Text style={[t.meta, { flex: 1, color: toneColor }]}>{sync.text}</Text>
      </View>}
      {out.teamNotice && <Text style={t.meta}>{out.teamNotice}</Text>}
    </View>
    {model.people.length > 1 && <View accessibilityLabel="Team" style={{ flexDirection: "row", flexWrap: "wrap", columnGap: compact ? 16 : 22, rowGap: 6 }}>
      {facts.map(f => <Hover key={f.label} text={f.hover}><Text style={t.meta}><Text style={[t.body, { fontWeight: "600", fontVariant: ["tabular-nums"] }]}>{f.value}</Text>{` ${f.label}${soFar}`}</Text></Hover>)}
    </View>}
    {!model.people.length
      ? <View style={{ gap: 10, paddingVertical: 20, alignItems: "flex-start" }}>
        <Text style={[t.body, { color: c.foregroundMuted }]}>{`No PRs opened or reviewed ${period === "week" ? "this week" : period === "last-week" ? "last week" : `in the last ${period === "30d" ? 30 : 90} days`}.`}</Text>
        {out.sync?.error
          ? onSettings && <Button theme={theme} compact={compact} title="Open settings" onPress={onSettings} />
          : period !== "90d" && <Button theme={theme} compact={compact} title={period === "30d" ? "Show 90 days" : "Show 30 days"} onPress={() => onPeriod(period === "30d" ? "90d" : "30d")} />}
      </View>
      : model.people.length === 1
      ? <View style={{ gap: 10 }}><Text style={[t.body, { fontWeight: "600" }]}>{model.people[0]!.login}</Text><PersonLoader theme={theme} compact={compact} repo={out.repo!} period={period} login={model.people[0]!.login} /></View>
      : compact
      ? <PhoneTable theme={theme} rows={rows} max={max} sort={sort} onSort={onSort} onPerson={onPerson} />
      : <DesktopTable theme={theme} rows={rows} max={max} sort={sort} onSort={onSort} onPerson={onPerson} />}
    {model.people.length > 1 && <Text style={t.small}>{`Medians need 3 PRs or more (a dash below that). Wait counts from the ask${out.clock === "working" ? ", in working hours" : ""}; stacked PRs from when their parent was reached. Bots and hidden people aren't counted.`}</Text>}
  </View>;
}

/** The repository on screen; with more than one, a chip opening the list. */
function RepoPicker({ theme, compact, out, onRepo }: { theme: Theme; compact: boolean; out: PrStatsOutput; onRepo: (r: string) => void }) {
  const c = theme.colors; const t = text(c, compact);
  const [open, setOpen] = useState(false);
  const many = out.repos.length > 1;
  const chip = <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
    <Icon name="BookMarked" size={compact ? 16 : 14} color={c.foregroundMuted} />
    <Text style={[t.label]}>{out.repo}</Text>
    {out.repos.find(r => r.repo === out.repo)?.state === "paused" && <Text style={t.meta}>paused</Text>}
    {many && <Icon name="ChevronDown" size={14} color={c.foregroundMuted} />}
  </View>;
  if (!many) return <View style={{ minHeight: compact ? 44 : 32, justifyContent: "center" }}>{chip}</View>;
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel={`Repository ${out.repo}, change`} onPress={() => setOpen(true)}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({ minHeight: compact ? 44 : 32, paddingHorizontal: 10, borderRadius: 8, justifyContent: "center", alignSelf: "flex-start", borderWidth: 1, borderColor: c.border, backgroundColor: pressed || hovered ? c.surface2 : c.surface1 })}>{chip}</Pressable>
    {open && <Modal title="Repository" open onOpenChange={next => { if (!next) setOpen(false); }}>
      <Modal.Content contentContainerStyle={{ padding: compact ? 8 : 12 }}>
        {out.repos.map(r => <Pressable key={r.repo} accessibilityRole="button" accessibilityState={{ selected: r.repo === out.repo }} onPress={() => { setOpen(false); onRepo(r.repo); }}
          style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({ minHeight: 44, paddingHorizontal: 12, borderRadius: 8, flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: pressed || hovered ? c.surface2 : "transparent" })}>
          <Text style={[t.body, { flex: 1 }]}>{r.repo}</Text>
          {r.state === "paused" && <Text style={t.meta}>paused</Text>}
          {r.repo === out.repo && <Icon name="Check" size={14} color={c.foreground} />}
        </Pressable>)}
      </Modal.Content>
    </Modal>}
  </>;
}

/** A row of choices, one selected (radio semantics). */
function Segmented<V extends string>({ theme, compact, label, value, options, onChange }: { theme: Theme; compact: boolean; label: string; value: V; options: { value: V; text: string }[]; onChange: (v: V) => void }) {
  const c = theme.colors;
  return <View accessibilityRole="radiogroup" accessibilityLabel={label} style={{ flexDirection: "row", padding: 2, gap: 2, borderRadius: 8, backgroundColor: c.surface2, alignSelf: compact ? "stretch" : "flex-start", ...(compact ? { width: "100%" as const } : {}) }}>
    {options.map(o => {
      const on = o.value === value;
      return <Pressable key={o.value} accessibilityRole="radio" accessibilityState={{ checked: on }} onPress={() => onChange(o.value)}
        style={({ hovered }: { pressed: boolean; hovered?: boolean }) => ({ flexGrow: compact ? 1 : 0, minHeight: compact ? 40 : 28, paddingHorizontal: compact ? 6 : 12, borderRadius: 6, alignItems: "center", justifyContent: "center",
          backgroundColor: on ? c.surface0 : hovered ? withAlpha(c.foreground, 0.05) : "transparent", ...(on ? { shadowColor: "#000", shadowOpacity: 0.08, shadowRadius: 2, shadowOffset: { width: 0, height: 1 } } : {}) })}>
        <Text numberOfLines={1} style={{ color: on ? c.foreground : c.foregroundMuted, fontSize: compact ? 13 : 12, lineHeight: 17, fontWeight: on ? "600" : "500" }}>{o.text}</Text>
      </Pressable>;
    })}
  </View>;
}

/** A neutral inline bar: square at the baseline, a rounded data end, on a faint track. Decorative: the number beside it is the value. */
function Bar({ theme, value, max, width }: { theme: Theme; value: number | null; max: number; width: number }) {
  const c = theme.colors;
  const share = value === null || max <= 0 ? 0 : Math.max(value > 0 ? 0.03 : 0, value / max);
  return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width, height: 6, borderRadius: 3, backgroundColor: withAlpha(c.foreground, 0.07), overflow: "hidden" }}>
    {value !== null && share > 0 && <View style={{ width: `${Math.round(share * 1000) / 10}%`, height: 6, borderTopRightRadius: 3, borderBottomRightRadius: 3, backgroundColor: withAlpha(c.foreground, 0.55) }} />}
  </View>;
}

/** The desktop hover title (React Native Web drops `title` on a Pressable, so it goes on a wrapper's node). */
function Hover({ text: tip, children }: { text?: string; children: ReactNode }) {
  const ref = useRef<View | null>(null);
  useEffect(() => { if (tip && Platform.OS === "web") (ref.current as unknown as { setAttribute?: (k: string, v: string) => void } | null)?.setAttribute?.("title", tip); }, [tip]);
  return <View ref={ref}>{children}</View>;
}

function cellText(p: Person, key: SortKey): { text: string; hover?: string; value: number | null } {
  if (key === "wait" || key === "turnaround") return medianCell(key === "wait" ? p.wait : p.turnaround);
  const n = key === "opened" ? p.opened : key === "merged" ? p.merged : p.reviews;
  const stacks = key === "opened" ? p.openedStacks : key === "reviews" ? p.reviewStacks : 0;
  return { text: String(n), value: n, hover: stacks && stacks < n ? `${n} PRs in ${stacks} stacks` : undefined };
}

function Avatar({ theme, login }: { theme: Theme; login: string }) {
  const c = theme.colors;
  return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: c.surface2, alignItems: "center", justifyContent: "center" }}>
    <Text style={{ color: c.foregroundMuted, fontSize: 11, lineHeight: 14, fontWeight: "600" }}>{login.slice(0, 1).toUpperCase()}</Text>
  </View>;
}

const BAR_W = 72;
function DesktopTable({ theme, rows, max, sort, onSort, onPerson }: { theme: Theme; rows: Person[]; max: Record<SortKey, number>; sort: SortKey; onSort: (k: SortKey) => void; onPerson: (login: string) => void }) {
  const c = theme.colors; const t = text(c);
  return <View role="table" style={{ borderWidth: 1, borderColor: c.border, borderRadius: 10, backgroundColor: c.surface1, overflow: "hidden" }}>
    <View role="row" style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, minHeight: 36, borderBottomWidth: 1, borderBottomColor: c.border }}>
      <Text role="columnheader" style={[t.meta, { flex: 1.2, minWidth: 140 }]}>Person</Text>
      {COLUMNS.map(col => {
        const on = col.key === sort;
        return <Pressable key={col.key} accessibilityRole="button" accessibilityLabel={`Sort by ${col.long}${on ? ", sorted, highest first" : ""}`} onPress={() => onSort(col.key)}
          style={({ hovered }: { pressed: boolean; hovered?: boolean }) => ({ flex: 1, minHeight: 36, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 4, paddingLeft: 8, opacity: hovered && !on ? 0.8 : 1 })}>
          <Text numberOfLines={1} style={[t.meta, on ? { color: c.foreground, fontWeight: "600" } : null]}>{col.label}</Text>
          {on && <Icon name="ArrowDown" size={12} color={c.foreground} />}
        </Pressable>;
      })}
    </View>
    <PagedRows items={rows} theme={theme} compact={false} noun="people" row={(p, i) => <Pressable key={p.login} accessibilityRole="button" accessibilityLabel={`${p.login}: ${personWords(p)}. Opens their PRs and reviews.`} onPress={() => onPerson(p.login)}
      style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => ({ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, minHeight: 44, borderTopWidth: i ? 1 : 0, borderTopColor: c.border, backgroundColor: pressed ? c.surface2 : hovered ? withAlpha(c.foreground, 0.03) : "transparent" })}>
      <View style={{ flex: 1.2, minWidth: 140, flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Avatar theme={theme} login={p.login} />
        <Text numberOfLines={1} style={[t.body, { flexShrink: 1 }]}>{p.login}</Text>
      </View>
      {COLUMNS.map(col => {
        const cell = cellText(p, col.key);
        return <View key={col.key} style={{ flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 10, paddingLeft: 8 }}>
          {cell.value !== null && <Bar theme={theme} value={cell.value} max={max[col.key]} width={BAR_W} />}
          <Hover text={cell.hover}><Text style={[t.body, { minWidth: 56, textAlign: "right", fontVariant: ["tabular-nums"], color: cell.value === null ? c.foregroundMuted : c.foreground }]}>{cell.text}</Text></Hover>
        </View>;
      })}
    </Pressable>} resetKey={sort} />
  </View>;
}

/** Phones: each row shows the sorted column's value with its bar and every column in one muted line; it opens the person. */
function PhoneTable({ theme, rows, max, sort, onSort, onPerson }: { theme: Theme; rows: Person[]; max: Record<SortKey, number>; sort: SortKey; onSort: (k: SortKey) => void; onPerson: (login: string) => void }) {
  const c = theme.colors; const t = text(c, true);
  const [open, setOpen] = useState(false);
  const col = COLUMNS.find(x => x.key === sort)!;
  return <View style={{ borderWidth: 1, borderColor: c.border, borderRadius: 12, backgroundColor: c.surface1, overflow: "hidden" }}>
    <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: 16, paddingRight: 8, minHeight: 52, borderBottomWidth: 1, borderBottomColor: c.border }}>
      <Text style={[t.meta, { flex: 1 }]}>Sorted by</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`Sorted by ${col.long}, change`} onPress={() => setOpen(true)}
        style={({ pressed }: { pressed: boolean }) => ({ minHeight: 44, paddingHorizontal: 10, borderRadius: 8, flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: pressed ? c.surface2 : "transparent" })}>
        <Text style={t.label}>{col.long}</Text><Icon name="ChevronDown" size={14} color={c.foregroundMuted} />
      </Pressable>
    </View>
    <PagedRows items={rows} theme={theme} compact noun="people" resetKey={sort} row={(p, i) => {
      const cell = cellText(p, sort);
      return <Pressable key={p.login} accessibilityRole="button" accessibilityLabel={`${p.login}: ${personWords(p)}. Opens their PRs and reviews.`} onPress={() => onPerson(p.login)}
        style={({ pressed }: { pressed: boolean }) => ({ flexDirection: "row", alignItems: "center", gap: 12, paddingLeft: 16, paddingRight: 10, paddingVertical: 12, borderTopWidth: i ? 1 : 0, borderTopColor: c.border, backgroundColor: pressed ? c.surface2 : "transparent" })}>
        <Avatar theme={theme} login={p.login} />
        <View style={{ flex: 1, gap: 6 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Text numberOfLines={1} style={[t.body, { flex: 1 }]}>{p.login}</Text>
            {cell.value !== null && <Bar theme={theme} value={cell.value} max={max[sort]} width={64} />}
            <Text style={[t.body, { minWidth: 72, textAlign: "right", fontVariant: ["tabular-nums"], fontWeight: "600", color: cell.value === null ? c.foregroundMuted : c.foreground }]}>{cell.text}</Text>
          </View>
          <Text style={t.meta}>{personLine(p, sort)}</Text>
        </View>
        <Icon name="ChevronRight" size={16} color={c.foregroundMuted} />
      </Pressable>;
    }} />
    {open && <Modal title="Sort by" open onOpenChange={next => { if (!next) setOpen(false); }}>
      <Modal.Content contentContainerStyle={{ padding: 8 }}>
        {COLUMNS.map(x => <Pressable key={x.key} accessibilityRole="radio" accessibilityState={{ checked: x.key === sort }} onPress={() => { setOpen(false); onSort(x.key); }}
          style={({ pressed }: { pressed: boolean }) => ({ minHeight: 48, paddingHorizontal: 12, borderRadius: 8, flexDirection: "row", alignItems: "center", backgroundColor: pressed ? c.surface2 : "transparent" })}>
          <Text style={[t.body, { flex: 1 }]}>{x.long}</Text>
          {x.key === sort && <Icon name="Check" size={16} color={c.foreground} />}
        </Pressable>)}
      </Modal.Content>
    </Modal>}
  </View>;
}

/** Desktop: the person over the table. Reads the same model with `person`. */
function PersonSheet({ theme, compact, repo, period, login, onClose }: { theme: Theme; compact: boolean; repo: string; period: Period; login: string; onClose: () => void }) {
  return <Modal title={`${login} · ${PERIOD_LABELS[period]}`} open onOpenChange={next => { if (!next) onClose(); }}>
    <Modal.Content contentContainerStyle={{ padding: 20, gap: 14 }}>
      <PersonLoader theme={theme} compact={compact} repo={repo} period={period} login={login} />
    </Modal.Content>
  </Modal>;
}

/** Reads one person's drill-down (`person`) for the sheet and for a repository with one person. */
/** A median under 3 samples, in words: none yet, or how many of the 3 it needs. */
const tooFew = (n: number) => n ? `- (${n} so far; it needs 3)` : "- (none yet)";

function PersonLoader({ theme, compact, repo, period, login }: { theme: Theme; compact: boolean; repo: string; period: Period; login: string }) {
  const c = theme.colors; const t = text(c, compact);
  const read = useRpc(prStatsRpc);
  const query = useQuery({ queryKey: prStatsKey(repo, period, login), queryFn: () => read({ repo, period, person: login }), staleTime: 60_000 });
  if (query.error) return <Text accessibilityRole="alert" style={[t.body, { color: c.statusDanger }]}>{errorText(query.error)}</Text>;
  if (!query.data) return <ActivityIndicator accessibilityLabel={`Loading ${login}'s PRs`} color={c.foregroundMuted} style={{ alignSelf: "flex-start" }} />;
  return <PersonView theme={theme} compact={compact} out={query.data} login={login} />;
}

/** One person: their numbers, their PRs in the period (each one click away) and the reviews they gave. */
export function PersonView({ theme, compact, out, login }: { theme: Theme; compact: boolean; out: PrStatsOutput; login: string }) {
  const c = theme.colors; const t = text(c, compact);
  const d = out.person?.login === login ? out.person : null;
  const row = d?.row ?? out.model?.people.find(p => p.login === login) ?? null;
  const [all, setAll] = useState(false);
  // Each list folds to its first 8; Show all opens pages, never every PR of a 25,000-record repository (client/paged-list.tsx).
  const fold = { open: all, onToggle: () => setAll(v => !v), preview: 8, theme, compact } as const;
  const wait = row ? medianCell(row.wait) : null, turn = row ? medianCell(row.turnaround) : null;
  return <View style={{ gap: 14 }}>
    {row && <View style={{ gap: 4 }}>
      <Text style={t.body}>{`${row.opened} PR${row.opened === 1 ? "" : "s"} opened${row.openedStacks && row.openedStacks < row.opened ? ` in ${row.openedStacks} stacks` : ""} · ${row.merged} merged`}</Text>
      <Text style={t.meta}>{`Median wait for a first review ${wait!.text === "-" ? tooFew(row.wait.n) : `${wait!.text}, over the ${row.wait.n} first reviews in this period${row.wait.p75 === null ? "" : `; 3 in 4 within ${durationWords(row.wait.p75)}`}`}`}</Text>
      <Text style={t.meta}>{`${row.reviews} review${row.reviews === 1 ? "" : "s"} given · median turnaround ${turn!.text === "-" ? tooFew(row.turnaround.n) : `${turn!.text} from the request, over ${row.turnaround.n}`}`}</Text>
    </View>}
    {!d && <ActivityIndicator color={c.foregroundMuted} style={{ alignSelf: "flex-start" }} />}
    {d && <>
      <Text style={t.section}>{`Opened by ${login}`}</Text>
      {d.prs.length ? <PagedRows items={d.prs} {...fold} noun="PRs" row={p => <PrLine key={p.number} theme={theme} compact={compact} number={p.number} url={p.url} title={p.title}
        line={p.waiting ? `waiting ${p.wait === null ? "" : durationWords(p.wait)} for a first review` : [p.wait === null ? "no review yet" : `first review ${durationWords(p.wait)}${p.firstResponder ? ` by ${p.firstResponder}` : ""}`, p.merged ? "merged" : p.state === "C" ? "closed" : "open", p.size].join(" · ")} />} />
        : <Text style={t.meta}>None in this period.</Text>}
      <Text style={t.section}>{`Reviews by ${login}`}</Text>
      {d.reviewed.length ? <PagedRows items={d.reviewed} {...fold} noun="reviews" row={r => <PrLine key={`r${r.number}`} theme={theme} compact={compact} number={r.number} url={r.url} title={r.title} line={`${r.author ? `by ${r.author} · ` : ""}${new Date(r.at * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: out.timeZone })}`} />} />
        : <Text style={t.meta}>None in this period.</Text>}
    </>}
  </View>;
}

function PrLine({ theme, compact, number, url, title, line }: { theme: Theme; compact: boolean; number: number; url: string; title: string; line: string }) {
  const c = theme.colors; const t = text(c, compact);
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: c.border }}>
    <View style={{ flex: 1, gap: 2 }}>
      <Text numberOfLines={compact ? 2 : 1} style={t.body}><Text style={{ color: c.foregroundMuted, fontVariant: ["tabular-nums"] }}>{`#${number} `}</Text>{title}</Text>
      <Text style={t.meta}>{line}</Text>
    </View>
    <PrLinkButton theme={theme} compact={compact} link={{ url, number, label: `Open #${number} ${title}` }} />
  </View>;
}
