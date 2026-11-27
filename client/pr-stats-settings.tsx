import { useEffect, useState, type ReactNode } from "react";
import { PagedRows } from "./paged-list";
import { ActivityIndicator, View } from "react-native";
import { Text } from "./text";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, SettingsAction, SettingsCard, SettingsSection, SettingsSelect, SettingsSwitch, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { prStatsSettingsRpc, setPrStatsRpc } from "../shared/contracts";
import { estimateBlocked, estimateLines, sizeWords, statsRepoLine, statsRepoWait, statsRepoWaitTone, type SetPrStatsInput, type StatsSettingsView, type StatsTeam } from "../shared/pr-stats-settings";
import { Button, errorText, SubmitScope, text, type Theme } from "./kit";
import { Pressable } from "./text";
import { Field } from "./field";

export const prStatsSettingsKey = ["follow-up", "pr-stats-settings"];
type Row = StatsSettingsView["repos"][number];
const REPO = /^[\w.-]+\/[\w.-]+$/;
export const PR_STATS_INFO = "PR statistics show who opens PRs and whose PRs wait longest for a first review, from each repository's own GitHub data. Turn them on per repository. They read GitHub slowly in the background, stop whenever GitHub's limit drops under 40% so your agents and PR checks come first, and stay on this machine.";

/**
 * Settings → Following → PR statistics: one switch per repository Follow-up knows. Turning one on opens the opt-in
 * sheet (the estimate first, `OptInSheet`); turning one off asks in place, with keeping the data as the default and
 * deleting it as the quiet extra. Options per repository (window, team, hidden people) fold under it; the clock and
 * GitHub share are host-wide.
 */
let openStatsPage: (() => void) | null = null;
/** index.client.tsx: how Settings opens the PR stats page ("Open PR stats"). */
export function setOpenStats(open: () => void): void { openStatsPage = open; }

export function PrStatsSettings({ theme, compact, onPage = false }: { theme: Theme; compact: boolean; /** Drawn on the page itself (no "Open PR stats"). */ onPage?: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const read = useRpc(prStatsSettingsRpc); const write = useRpc(setPrStatsRpc); const cache = useQueryClient(); const toast = useToast();
  const query = useQuery({ queryKey: prStatsSettingsKey, queryFn: () => read({}), staleTime: 30_000, refetchInterval: 60_000 });
  const change = useMutation({
    mutationFn: (input: SetPrStatsInput & { toast?: string }) => { const { toast: _, ...rest } = input; return write(rest); },
    onSuccess: (v, input) => { cache.setQueryData(prStatsSettingsKey, v); if (input.toast) toast.show(input.toast, { variant: "success" }); },
    onError: e => toast.error(errorText(e)),
  });
  const [optIn, setOptIn] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState<string | null>(null);
  const [adding, setAdding] = useState("");
  const data = query.data;
  const withStats = data?.repos.filter(r => r.state !== "off") ?? [];
  const alreadyOn = data?.repos.find(r => r.repo === adding.trim() && r.state !== "off") ?? null;
  const addValid = REPO.test(adding.trim()) && !alreadyOn;
  return <SettingsSection title="PR statistics" info={PR_STATS_INFO}>
    {query.isPending && <ActivityIndicator accessibilityLabel="Loading PR statistics settings" color={c.foregroundMuted} style={{ alignSelf: "flex-start", marginVertical: 8 }} />}
    {query.error && <SettingsCard><SettingsAction label="Couldn't load PR statistics" hint={errorText(query.error)} actionLabel="Retry" onPress={() => void query.refetch()} /></SettingsCard>}
    {data && <>
      <SettingsCard>
        <PagedRows items={data.repos} theme={theme} compact={compact} noun="repositories" row={row => <View key={row.repo}>
          <SettingsSwitch label={row.repo} hint={statsRepoLine(row, data.timeZone)} value={row.state === "on"} disabled={change.isPending}
            onValueChange={on => {
              if (on && row.state === "paused") change.mutate({ repo: row.repo, enable: true, toast: `${row.repo}: PR statistics on` });
              else if (on) setOptIn(row.repo);
              else setConfirmOff(row.repo);
            }} />
          {confirmOff === row.repo && <TurnOffConfirm row={row} theme={theme} compact={compact} busy={change.isPending}
            onKeep={() => { setConfirmOff(null); change.mutate({ repo: row.repo, enable: false, toast: `${row.repo}: paused, data kept` }); }}
            onDelete={() => { setConfirmOff(null); change.mutate({ repo: row.repo, enable: false, delete: true, toast: `${row.repo}: off, data deleted` }); }}
            onCancel={() => setConfirmOff(null)} />}
          <RepoWait row={row} theme={theme} compact={compact} />
          {row.state === "on" && <OptionsFold row={row} theme={theme} compact={compact}>
            <RepoOptions row={row} theme={theme} compact={compact} busy={change.isPending} set={(input, label) => change.mutate({ repo: row.repo, ...input, toast: `${row.repo}: ${label}` })} />
          </OptionsFold>}
        </View>} />
        {/* A repository Follow-up hasn't seen yet. */}
        <SubmitScope enabled={addValid} onSubmit={() => setOptIn(adding.trim())} style={{ flexDirection: compact ? "column" : "row", alignItems: compact ? "stretch" : "center", gap: 8, paddingHorizontal: compact ? 16 : 14, paddingVertical: 10, borderTopWidth: data.repos.length ? 1 : 0, borderTopColor: c.border }}>
          <Field accessibilityLabel="Another repository, owner/repo" value={adding} onChangeText={setAdding} placeholder="Another repository: owner/repo" placeholderTextColor={c.foregroundMuted} autoCapitalize="none" autoCorrect={false}
            style={{ flex: compact ? undefined : 1, minWidth: 0, minHeight: compact ? 44 : 32, paddingHorizontal: 10, borderRadius: 6, borderWidth: 1, borderColor: c.border, color: c.foreground, fontSize: compact ? 15 : 13, backgroundColor: c.surface0 }} />
          {!!adding.trim() && <Button theme={theme} compact={compact} grow={compact} icon="Plus" title="Add" disabled={!addValid} onPress={() => setOptIn(adding.trim())} />}
        </SubmitScope>
        {!!adding.trim() && !alreadyOn && !REPO.test(adding.trim()) && <Text style={[t.meta, { paddingHorizontal: compact ? 16 : 14, paddingBottom: 10, marginTop: -4 }]}>Use owner/repo, like example/app.</Text>}
        {alreadyOn && <Text style={[t.meta, { paddingHorizontal: compact ? 16 : 14, paddingBottom: 10, marginTop: -4 }]}>{`${alreadyOn.repo} is already ${alreadyOn.state === "on" ? "on" : "listed above (paused): turn its switch on"}.`}</Text>}
      </SettingsCard>
      {!data.repos.length && <Text style={t.meta}>Repositories show here once Follow-up sees a PR in them or a project with a GitHub remote, or add one above.</Text>}
      {withStats.length > 0 && !onPage && openStatsPage && <SettingsCard><SettingsAction label="PR stats" hint="Who opens PRs and whose PRs wait longest, per repository." actionLabel="Open PR stats" onPress={() => openStatsPage?.()} /></SettingsCard>}
      {withStats.length > 0 && <Text style={[t.meta, { marginTop: 4, paddingHorizontal: compact ? 6 : 5 }]}>All repositories</Text>}
      {withStats.length > 0 && <SettingsCard>
        <SettingsSelect label="GitHub share for stats" hint="At most this much of GitHub's hourly limit in any hour; stats always stop under 40% left." value={String(Math.round(data.settings.slice * 100))} disabled={change.isPending}
          options={["1", "2", "5", "10"].map(v => ({ value: v, label: `${v}%` }))} onValueChange={v => change.mutate({ slice: Number(v) / 100, toast: `Stats may use ${v}% of GitHub's limit` })} />
        <SettingsSelect<"calendar" | "working"> label="Clock" hint={`Working hours use one schedule for everyone: ${hoursWords(data.hours)}, ${data.timeZone}.`} value={data.settings.clock} disabled={change.isPending}
          options={[{ value: "calendar", label: "Calendar time" }, { value: "working", label: "Working hours" }]} onValueChange={v => change.mutate({ clock: v, toast: v === "working" ? "Stats count working hours" : "Stats count calendar time" })} />
        <SettingsSwitch label="Count stacks fairly" hint="A stacked PR's review clock starts when its parent got a first review or merged, not while it waits its turn." value={data.settings.enable_stack_aware} disabled={change.isPending}
          onValueChange={v => change.mutate({ enable_stack_aware: v, toast: v ? "Stacked PRs start their clocks when reached" : "Stacked PRs start their clocks when asked" })} />
      </SettingsCard>}
    </>}
    {optIn && <OptInSheet repo={optIn} theme={theme} compact={compact} onClose={() => setOptIn(null)}
      onTurnOn={() => { const repo = optIn; setOptIn(null); setAdding(""); change.mutate({ repo, enable: true, toast: `${repo}: PR statistics on. The first read runs in the background.` }); }} />}
  </SettingsSection>;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hhmm = (m: number) => `${Math.floor(m / 60)}${m % 60 ? `:${String(m % 60).padStart(2, "0")}` : ""}`;
export function hoursWords(h: { days: number[]; from: number; to: number }): string {
  const days = [...h.days].sort((a, b) => a - b);
  const run = days.length > 1 && days.every((d, i) => i === 0 || d === days[i - 1]! + 1);
  return `${run ? `${DAYS[days[0]!]}–${DAYS[days.at(-1)!]}` : days.map(d => DAYS[d]).join(", ")} ${hhmm(h.from)}–${hhmm(h.to)}`;
}
const teamWords = (team: StatsTeam) => team.kind === "everyone" ? "everyone" : team.kind === "people" ? `${team.logins.length} ${team.logins.length === 1 ? "person" : "people"}` : `@${team.team}`;
function repoOptionsSummary(row: Row): string {
  const s = row.settings!;
  return [`${s.windowDays} days`, teamWords(s.team), s.ignore.length ? `${s.ignore.length} hidden` : null].filter(Boolean).join(" · ");
}

/** A repository's options, folded under its own row at the row's left edge: "Options · 90 days · 4 people ›". */
function OptionsFold({ row, theme, compact, children }: { row: Row; theme: Theme; compact: boolean; children: ReactNode }) {
  const c = theme.colors; const t = text(c, compact);
  const [open, setOpen] = useState(false);
  const summary = repoOptionsSummary(row);
  return <View>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} aria-expanded={open} accessibilityLabel={`${row.repo} options, ${summary}`} accessibilityHint={open ? "Collapses" : "Expands"} onPress={() => setOpen(!open)}
      style={state => ({ flexDirection: "row", alignItems: "center", gap: 6, minHeight: compact ? 44 : 28, paddingHorizontal: compact ? 16 : 14, marginTop: -6, paddingBottom: compact ? 4 : 8,
        backgroundColor: state.pressed ? c.surface2 : "transparent" })}>
      <Text numberOfLines={1} style={[t.meta, { flexShrink: 1 }]}>{`Options · ${summary}`}</Text>
      <Icon name={open ? "ChevronDown" : "ChevronRight"} size={13} color={c.foregroundMuted} />
    </Pressable>
    {open && <View style={{ borderTopWidth: 1, borderTopColor: c.border }}>{children}</View>}
  </View>;
}

/**
 * Why a repository on isn't reading, on its own line under its row: red with a next step when GitHub refused it,
 * amber while it waits for GitHub's limit or its share, muted while this machine is busy.
 */
function RepoWait({ row, theme, compact }: { row: Row; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const words = statsRepoWait(row); const tone = statsRepoWaitTone(row);
  if (!words || !tone) return null;
  const color = tone === "danger" ? c.statusDanger : tone === "warning" ? c.statusWarning : c.foregroundMuted;
  const next = tone === "danger" ? " Check this GitHub account can read it, or turn it off." : "";
  return <View style={{ flexDirection: "row", gap: 6, paddingHorizontal: compact ? 16 : 14, paddingBottom: 10, marginTop: -4 }}>
    <View style={{ paddingTop: compact ? 3 : 2 }}><Icon name={tone === "danger" ? "CircleAlert" : "Clock"} size={13} color={color} /></View>
    <Text style={[t.meta, { flex: 1, color }]}>{`${words}${next}`}</Text>
  </View>;
}

/** The quiet two-choice confirm in place (Q123's pattern): keep the data is the bordered default; delete is quiet red text. */
function TurnOffConfirm({ row, theme, compact, busy, onKeep, onDelete, onCancel }: { row: Row; theme: Theme; compact: boolean; busy: boolean; onKeep: () => void; onDelete: () => void; onCancel: () => void }) {
  const c = theme.colors; const t = text(c, compact);
  const n = row.settings?.status?.records ?? 0;
  return <View accessibilityRole="alert" style={{ flexDirection: compact ? "column" : "row", alignItems: compact ? "stretch" : "center", gap: compact ? 10 : 16, paddingHorizontal: compact ? 16 : 14, paddingVertical: 12, borderTopWidth: 1, borderTopColor: c.border, borderStyle: "dashed" }}>
    <Text style={[t.body, { flex: compact ? undefined : 1 }]}>{`Stop reading ${row.repo}? Its stored PRs stay readable unless you delete them.`}</Text>
    <View style={{ flexDirection: compact ? "column-reverse" : "row", alignItems: compact ? "stretch" : "center", gap: 8 }}>
      {n > 0 && <Button theme={theme} compact={compact} kind="danger" title={`Also delete the ${n.toLocaleString("en-US")} PRs`} disabled={busy} onPress={onDelete} accessibilityHint="Turns stats off and deletes what was read. This can't be undone." />}
      {!compact && <Button theme={theme} compact={compact} kind="ghost" title="Cancel" onPress={onCancel} />}
      <Button theme={theme} compact={compact} kind="secondary" title="Turn off, keep data" disabled={busy} onPress={onKeep} />
      {compact && <Button theme={theme} compact={compact} kind="ghost" title="Cancel" onPress={onCancel} />}
    </View>
  </View>;
}

/** Window, team filter and hidden people for one repository. */
function RepoOptions({ row, theme, compact, busy, set }: { row: Row; theme: Theme; compact: boolean; busy: boolean; set: (input: Omit<SetPrStatsInput, "repo">, label: string) => void }) {
  const c = theme.colors; const t = text(c, compact);
  const s = row.settings!;
  const [teamDraft, setTeamDraft] = useState(s.team.kind === "people" ? s.team.logins.join(", ") : s.team.kind === "github" ? s.team.team : "");
  const [teamKind, setTeamKind] = useState<StatsTeam["kind"]>(s.team.kind);
  const [hidden, setHidden] = useState(s.ignore.join(", "));
  const members = s.status?.teamMembers;
  const teamHint = s.team.kind === "github" && members?.team === s.team.team && members.error ? `Can't read the team @${s.team.team} with this GitHub account, so stats show everyone. Pick people instead, or give gh read:org.`
    : teamKind === "people" ? "Logins, separated by commas." : teamKind === "github" ? "org/team-slug, read once a day." : "Everyone who opened or reviewed a PR here, minus bots and hidden people.";
  const logins = (v: string) => [...new Set(v.split(/[\s,]+/).map(x => x.trim().replace(/^@/, "")).filter(Boolean))];
  const field = { flex: 1, minWidth: 0, minHeight: compact ? 44 : 32, paddingHorizontal: 10, borderRadius: 6, borderWidth: 1, borderColor: c.border, color: c.foreground, fontSize: compact ? 15 : 13, backgroundColor: c.surface0 } as const;
  const slug = teamDraft.trim().replace(/^@/, "");
  const draftTeam: StatsTeam | null = teamKind === "people" ? (logins(teamDraft).length ? { kind: "people", logins: logins(teamDraft) } : null)
    : teamKind === "github" ? (/^[\w.-]+\/[\w.-]+$/.test(slug) ? { kind: "github", team: slug } : null) : { kind: "everyone" };
  const teamProblem = teamDraft.trim() && !draftTeam ? (teamKind === "people" ? "Add at least one login." : "Use org/team-slug, like example/backend.") : null;
  const teamChanged = !!draftTeam && JSON.stringify(draftTeam) !== JSON.stringify(s.team);
  const saveTeam = () => { if (draftTeam && teamChanged) set({ team: draftTeam }, draftTeam.kind === "people" ? `team: ${draftTeam.logins.length} people` : draftTeam.kind === "github" ? `team: @${draftTeam.team}` : "team: everyone"); };
  const hiddenChanged = logins(hidden).join(",") !== s.ignore.join(",");
  const pad = { paddingHorizontal: compact ? 16 : 14, paddingBottom: 10 };
  return <View style={{ paddingBottom: 6 }}>
    <SettingsSelect label="History" hint="How far back stats read. Longer reads more once, then costs the same to keep current." value={String(s.windowDays)} disabled={busy}
      options={[30, 90, 180].map(d => ({ value: String(d), label: `${d} days` }))} onValueChange={v => set({ windowDays: Number(v) as 30 | 90 | 180 }, `${v} days of history`)} />
    <SettingsSelect<StatsTeam["kind"]> label="Team" hint={teamHint} value={teamKind} disabled={busy}
      options={[{ value: "everyone", label: "Everyone" }, { value: "people", label: "Picked people" }, { value: "github", label: "A GitHub team" }]}
      onValueChange={v => { setTeamKind(v); setTeamDraft(v === s.team.kind ? (s.team.kind === "people" ? s.team.logins.join(", ") : s.team.kind === "github" ? s.team.team : "") : ""); if (v === "everyone") set({ team: { kind: "everyone" } }, "team: everyone"); }} />
    {teamKind !== "everyone" && <SubmitScope enabled={!busy && teamChanged} onSubmit={saveTeam} style={[pad, { flexDirection: "row", alignItems: "center", gap: 8 }]}>
      <Field accessibilityLabel={teamKind === "people" ? "Team logins" : "GitHub team, org/slug"} value={teamDraft} onChangeText={setTeamDraft} placeholder={teamKind === "people" ? "alice, bob, carol" : "example/backend"} placeholderTextColor={c.foregroundMuted} autoCapitalize="none" autoCorrect={false} style={field} />
      <Button theme={theme} compact={compact} title="Save" disabled={busy || !teamChanged} onPress={saveTeam} />
    </SubmitScope>}
    {teamKind !== "everyone" && (teamProblem || teamKind !== s.team.kind) && <Text style={[t.meta, { paddingHorizontal: compact ? 16 : 14, paddingBottom: 10, marginTop: -4, color: teamProblem ? c.statusDanger : c.foregroundMuted }]}>{teamProblem ?? "Not saved yet: stats show the saved team until you Save."}</Text>}
    <View style={{ height: 1, backgroundColor: c.border }} />
    <View style={{ paddingHorizontal: compact ? 16 : 14, paddingTop: 10, gap: 4 }}>
      <Text style={t.body}>Hidden from stats</Text>
      <Text style={t.meta}>Bots are always hidden. Add service accounts that look like people; * matches anything.</Text>
    </View>
    <SubmitScope enabled={!busy && hiddenChanged} onSubmit={() => set({ ignore: logins(hidden) }, logins(hidden).length ? `${logins(hidden).length} hidden` : "nobody hidden")} style={[pad, { paddingTop: 8, flexDirection: "row", alignItems: "center", gap: 8 }]}>
      <Field accessibilityLabel="Hidden from stats, logins" value={hidden} onChangeText={setHidden} placeholder="deploy-robot, release-*" placeholderTextColor={c.foregroundMuted} autoCapitalize="none" autoCorrect={false} style={field} />
      <Button theme={theme} compact={compact} title="Save" disabled={busy || !hiddenChanged} onPress={() => set({ ignore: logins(hidden) }, logins(hidden).length ? `${logins(hidden).length} hidden` : "nobody hidden")} />
    </SubmitScope>
  </View>;
}

/**
 * The opt-in sheet: what turning stats on reads, costs and stores, from the repository's own count (1 GitHub point),
 * before anything is read. The switch turns on only from its Turn on; a repository the token can't read is refused here.
 */
/** A time in the developer's zone, with the weekday when it isn't today (a reset tomorrow never reads as today). */
function clockTime(ms: number): string {
  const d = new Date(ms), now = new Date();
  const hm = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? hm : `${d.toLocaleDateString([], { weekday: "short" })} ${hm}`;
}
export function OptInSheet({ repo, theme, compact, onClose, onTurnOn }: { repo: string; theme: Theme; compact: boolean; onClose: () => void; onTurnOn: () => void }) {
  const c = theme.colors; const t = text(c, compact);
  const read = useRpc(prStatsSettingsRpc);
  // A count held by the gate is never cached: reopening counts again, and one held behind another read retries by itself.
  const query = useQuery({ queryKey: [...prStatsSettingsKey, "estimate", repo], queryFn: () => read({ repo, estimate: true }), retry: false,
    staleTime: q => q.state.data?.estimate?.wait ? 0 : 5 * 60_000, refetchInterval: q => q.state.data?.estimate?.wait?.reason === "busy" ? 5000 : false });
  const e = query.data?.estimate ?? null;
  const slice = query.data?.settings.slice ?? 0.05;
  const lines = e ? estimateLines(e, slice) : null;
  // No count never means no way forward (invariant 106): the sheet says what Turn on does and why, in plain words, and
  // Turn on stays live, except for a repository this account can't read. A count still going after 3 s doesn't hold it.
  const blocked = query.isPending ? null : estimateBlocked(e, query.error ? errorText(query.error) : null, clockTime);
  const [slow, setSlow] = useState(false);
  useEffect(() => { if (!query.isPending) return; const t = setTimeout(() => setSlow(true), 3000); return () => clearTimeout(t); }, [query.isPending]);
  const canTurnOn = !!lines || !!blocked?.canTurnOn || (query.isPending && slow);
  const facts = !!lines || (!!blocked && !e?.unreadable);
  const point = (icon: string, main: ReactNode, sub?: string) => <View style={{ flexDirection: "row", gap: 10 }}>
    <View style={{ paddingTop: compact ? 2 : 1 }}><Icon name={icon} size={16} color={c.foregroundMuted} /></View>
    <View style={{ flex: 1, gap: 2 }}><Text style={t.body}>{main}</Text>{sub && <Text style={t.meta}>{sub}</Text>}</View>
  </View>;
  return <Modal title={`Turn on PR stats for ${repo}?`} open onOpenChange={next => { if (!next) onClose(); }}>
    <Modal.Content contentContainerStyle={{ padding: compact ? 16 : 20 }}>
      <SubmitScope enabled={canTurnOn} onSubmit={onTurnOn} style={{ gap: compact ? 16 : 14, maxWidth: 560 }}>
        {query.isPending && <View style={{ gap: 4 }}>
          <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}><ActivityIndicator color={c.foregroundMuted} /><Text style={t.meta}>Counting PRs changed in the last 90 days…</Text></View>
          {slow && <Text style={t.meta}>Still counting. You can turn stats on now; they show their progress here.</Text>}
        </View>}
        {blocked && <View style={{ gap: 4 }}>
          <Text accessibilityRole={blocked.tone === "danger" ? "alert" : undefined} style={[t.body, { color: blocked.tone === "danger" ? c.statusDanger : c.foreground }]}>{blocked.lead}</Text>
          <Text style={t.meta}>{blocked.reason}</Text>
        </View>}
        {lines && e && <>
          <Text style={[t.body, { color: c.foregroundMuted }]}>About <Text style={[t.body, { fontWeight: "600" }]}>{`${e.prs!.toLocaleString("en-US")} PRs`}</Text> changed in the last 90 days.</Text>
          {point("Gauge", <>Reading them costs about <Text style={[t.body, { fontWeight: "600" }]}>{`${e.points!.toLocaleString("en-US")} GitHub points`}</Text>{`, ${lines.time.replace(/^About /, "").toLowerCase()}`}</>,
            `Never more than ${Math.round(slice * 100)}% of your hourly limit (${e.slicePoints.toLocaleString("en-US")} points). Staying current: about 1–15 points an hour.`)}
        </>}
        {/* What turning on means doesn't depend on the count: shown whenever Turn on is offered. */}
        {facts && <>
          {/* The budget-low reason already says the 40% rule; say it once. */}
          {e?.wait?.reason !== "budget" && point("CirclePause", "Stats pause whenever less than 40% of your GitHub limit is left, so your agents and PR checks always come first.")}
          {point("Lock", `Stored on this machine only${e?.bytes ? `, about ${sizeWords(e.bytes)}` : ""}: numbers, times, logins and PR titles.`, "No code and no comment text. Bots are left out.")}
          <Text style={t.meta}>90 days · everyone · calendar time. Change these in the repository's options.</Text>
        </>}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
          <Button theme={theme} compact={compact} grow={compact} kind="ghost" title="Cancel" onPress={onClose} />
          <Button shortcut theme={theme} compact={compact} grow={compact} kind="primary" title="Turn on" disabled={!canTurnOn} onPress={onTurnOn} />
        </View>
      </SubmitScope>
    </Modal.Content>
  </Modal>;
}
