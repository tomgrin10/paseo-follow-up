import { useState } from "react";
import { View } from "react-native";
import { Pressable, Text } from "./text";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { Icon, SettingsAction, SettingsCard, SettingsSection, SettingsSelect, copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { dismissUpdateNoticeRpc, installUpdateRpc, setUpdatesRpc, updatesRpc } from "../shared/contracts";
import { MODE_HINT, MODE_LABEL, UPDATE_MODES, channelHint, checkedText, copyCommand, statusCopy, versionMark, type StatusAction, type UpdateMode, type UpdatesView } from "../shared/updates";
import { writeCategory } from "../shared/settings-nav";
import type { Channel } from "../shared/version";
import { Button, errorText, space, text, useNow, type Theme } from "./kit";
import { Spinner } from "./motion";
import { Disclosure } from "./settings-shell";
import { withAlpha } from "./theme";
import { OptionCard } from "./questions";
import { ReleaseNotesSheet, VersionNotes } from "./release-notes";

export const updatesKey = ["follow-through", "updates"];

/** The server's updates view. Reading it never asks the registry; `check` does (rate-limited on the server). */
export function useUpdates(check?: "settings") {
  const read = useRpc(updatesRpc);
  return useQuery({ queryKey: updatesKey, queryFn: () => read(check ? { check } : {}), staleTime: 60_000,
    // While installing, the plugin reloads under us: keep asking every few seconds until it's back.
    refetchInterval: q => { const k = (q.state.data as UpdatesView | undefined)?.phase.kind; return k === "installing" || k === "checking" ? 3000 : false; } });
}

const toneColor = (tone: "success" | "warning" | "muted", c: Theme["colors"]) => tone === "success" ? c.statusSuccess : tone === "warning" ? c.statusWarning : c.foregroundMuted;
/** Home's top line: an update to install (Tell me mode) or a rollback. One slot; the rollback wins. */
export function UpdateNotice({ theme, compact, openSettings }: { theme: Theme; compact: boolean; openSettings: () => void }) {
  const c = theme.colors; const t = text(c);
  const query = useUpdates(); const cache = useQueryClient(); const toast = useToast();
  const dismiss = useRpc(dismissUpdateNoticeRpc); const install = useRpc(installUpdateRpc);
  const [confirm, setConfirm] = useState(false);
  const run = useMutation({ mutationFn: (fn: () => Promise<UpdatesView>) => fn(), onSuccess: v => cache.setQueryData(updatesKey, v), onError: e => toast.error(errorText(e)) });
  const n = query.data?.notice;
  if (!n) return null;
  const rolled = n.kind === "rolled-back";
  const title = rolled ? `Update to ${n.version} failed, rolled back` : `Follow-up ${n.version} is available`;
  const detail = rolled ? `You're on ${n.from} again. Nothing to do.` : "Installing reloads Follow-up for a few seconds.";
  return <View accessibilityRole="summary" style={{ marginHorizontal: compact ? space(true).gutter : 24, marginTop: 8, marginBottom: 4, borderRadius: 8, borderWidth: 1,
    borderColor: rolled ? withAlpha(c.statusWarning, 0.6) : c.border, backgroundColor: c.surface1, paddingHorizontal: 12, paddingVertical: 10, gap: 8 }}>
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
      <View style={{ paddingTop: 2 }}><Icon name={rolled ? "Undo2" : "CircleArrowUp"} size={15} color={rolled ? c.statusWarning : c.foregroundMuted} /></View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={t.label}>{title}</Text>
        <Text style={t.meta}>{confirm ? "Some agents are mid-turn. Open agent chats lose Follow-up's tools until you reopen them; their work and history are kept." : detail}</Text>
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel={rolled ? "Dismiss" : "Not now"} hitSlop={8} onPress={() => run.mutate(() => dismiss({ id: n.id }))}
        style={state => ({ width: compact ? 44 : 32, height: compact ? 44 : 32, marginTop: compact ? -12 : -6, marginRight: compact ? -12 : -8, alignItems: "center", justifyContent: "center", borderRadius: 6, backgroundColor: state.pressed ? c.surface2 : "transparent" })}>
        <Icon name="X" size={14} color={c.foregroundMuted} />
      </Pressable>
    </View>
    <View style={{ flexDirection: "row", gap: 8, paddingLeft: 25 }}>
      {rolled ? <Button title="Details" theme={theme} compact={compact} onPress={() => { writeCategory("general"); openSettings(); }} />
        : confirm ? <>
          <Button title="Install now" theme={theme} compact={compact} loading={run.isPending} onPress={() => run.mutate(() => install({ version: n.version, anyway: true }))} />
          <Button title="Cancel" kind="ghost" theme={theme} compact={compact} onPress={() => setConfirm(false)} />
        </> : <Button title="Install" theme={theme} compact={compact} loading={run.isPending} onPress={() => run.mutate(async () => { const v = await install({ version: n.version }); if (v.phase.kind === "waiting" && v.phase.busy) setConfirm(true); return v; })} />}
    </View>
  </View>;
}

/** The status card at the top of Settings → General. */
function StatusCard({ view, theme, compact, onWhatsNew }: { view: UpdatesView; theme: Theme; compact: boolean; onWhatsNew: () => void }) {
  const c = theme.colors; const t = text(c);
  const now = useNow(30_000);
  const read = useRpc(updatesRpc); const install = useRpc(installUpdateRpc);
  const cache = useQueryClient(); const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const run = useMutation({ mutationFn: (fn: () => Promise<UpdatesView>) => fn(), onSuccess: v => cache.setQueryData(updatesKey, v), onError: e => toast.error(errorText(e)) });
  const s = statusCopy(view, now);
  const color = toneColor(s.tone, c);
  const p = view.phase;
  const version = "version" in p ? p.version : view.version;
  const act: Record<StatusAction, { title: string; onPress: () => void; icon?: string }> = {
    check: { title: "Check now", onPress: () => run.mutate(() => read({ check: "manual" })) },
    install: { title: "Install now", onPress: () => run.mutate(async () => { const v = await install({ version }); if (v.phase.kind === "waiting" && v.phase.busy) setConfirm(true); return v; }) },
    "install-anyway": { title: "Install now anyway", onPress: () => setConfirm(true) },
    retry: { title: "Try again", onPress: () => run.mutate(() => install({ version })) },
    "copy-details": { title: "Copy details", onPress: () => void copyText(`${s.title}\n${s.detail}`).then(() => toast.show("Copied"), () => toast.error("Couldn't copy")) },
    "copy-command": { title: "Copy install command", onPress: () => void copyText(copyCommand(version)).then(() => toast.show("Copied. Run it on the computer running Paseo."), () => toast.error("Couldn't copy")) },
    "view-npm": { title: "View on npm", onPress: () => void openExternalUrl(`https://www.npmjs.com/package/paseo-follow-up/v/${encodeURIComponent(version)}`).catch(() => undefined) },
    "whats-new": { title: "What's new", onPress: onWhatsNew },
  };
  const checking = run.isPending && run.variables != null;
  const pending = view.pendingNotes;
  return <View style={{ borderRadius: 10, borderWidth: 1, borderColor: s.tone === "warning" ? withAlpha(c.statusWarning, 0.6) : c.border, backgroundColor: c.surface1, padding: compact ? 16 : 14, gap: 4 }}>
    <View accessibilityLiveRegion="polite" style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
      <View style={{ width: 16, paddingTop: 1, alignItems: "center" }}>{s.spinning ? <Spinner color={color} size={14} /> : <Icon name={s.icon} size={16} color={color} />}</View>
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <Text style={t.label}>{s.title}</Text>
        <Text style={t.meta}>{confirm ? "Open agent chats lose Follow-up's tools until you reopen them. Their work and history are kept." : s.detail}</Text>
      </View>
    </View>
    {(confirm || s.primary || s.secondary.length > 0 || view.installKind === "npm") && <View style={{ flexDirection: compact ? "column" : "row", alignItems: compact ? "stretch" : "center", gap: 8, marginTop: 10, paddingLeft: 26 }}>
      {/* Phones: one full-width button per row, so a ghost button below a bordered one doesn't float. */}
      <View style={compact ? { flexDirection: "column", alignItems: "stretch", gap: 8 } : { flexDirection: "row", flexWrap: "wrap", gap: 8, flex: 1 }}>
        {confirm ? <>
          <Button title="Install now" kind="primary" theme={theme} compact={compact} loading={run.isPending} onPress={() => run.mutate(() => install({ version, anyway: true }).finally(() => setConfirm(false)))} />
          <Button title="Cancel" kind="ghost" theme={theme} compact={compact} onPress={() => setConfirm(false)} />
        </> : <>
          {s.primary && <Button title={act[s.primary].title} kind="primary" theme={theme} compact={compact} loading={run.isPending && s.primary === "install"} onPress={act[s.primary].onPress} />}
          {s.secondary.map((a, i) => <Button key={a} title={act[a].title} kind={i === 0 && !s.primary ? "secondary" : "ghost"} theme={theme} compact={compact} loading={a === "check" && checking} onPress={act[a].onPress} />)}
        </>}
      </View>
      {view.installKind === "npm" && <Text style={[t.small, compact ? null : { textAlign: "right" }]}>{checkedText(view.checkedAt, now)}</Text>}
    </View>}
    {pending.length > 0 && (p.kind === "available" || p.kind === "waiting" || p.kind === "untrusted") && <View style={{ marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: c.border, gap: 8, paddingLeft: 26 }}>
      <Text style={t.small}>{`What's in ${pending[0]!.version}`}</Text>
      <VersionNotes note={pending[0]!} theme={theme} max={6} />
      {pending.length > 1 && <Text style={t.small}>{`and ${pending.length - 1} earlier version${pending.length === 2 ? "" : "s"} since yours`}</Text>}
    </View>}
  </View>;
}

const HISTORY_RESULT: Record<string, string> = { updated: "Updated", "rolled-back": "Rolled back", failed: "Failed", skipped: "Skipped" };
const stamp = (at: number) => { const d = new Date(at); return `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

/**
 * Settings → General's updates: the status card (version, last check, Check now, what's available or went wrong),
 * the two settings, all release notes and the history. Opening it asks npm at most once a minute, never when Off.
 */
export function UpdatesSections({ theme, compact }: { theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c);
  const query = useUpdates("settings");
  const write = useRpc(setUpdatesRpc); const cache = useQueryClient(); const toast = useToast();
  // null: closed; false: What's new (since the last update); true: every version.
  const [sheet, setSheet] = useState<boolean | null>(null);
  const save = useMutation({ mutationFn: (input: { mode?: UpdateMode; channel?: Channel }) => write(input), onSuccess: v => cache.setQueryData(updatesKey, v), onError: e => toast.error(errorText(e)) });
  const view = query.data;
  if (query.isLoading) return <Spinner color={c.foregroundMuted} size={16} label="Loading updates" />;
  if (!view) return <SettingsSection title="Updates"><Text accessibilityRole="alert" style={{ color: c.statusDanger }}>{query.error ? errorText(query.error) : "Couldn't load updates."}</Text></SettingsSection>;
  return <View style={{ gap: 18 }}>
    <SettingsSection title="Updates">
      <StatusCard view={view} theme={theme} compact={compact} onWhatsNew={() => setSheet(false)} />
    </SettingsSection>
    <SettingsSection title={view.installKind === "npm" ? "How Follow-up updates" : "Release notes"}>
      <SettingsCard>
        {view.installKind === "npm" && <>
        <SettingsSelect<UpdateMode> label="When a new version is out" hint={MODE_HINT[view.mode]} value={view.mode} disabled={save.isPending}
          options={UPDATE_MODES.map(m => ({ value: m, label: MODE_LABEL[m] }))} onValueChange={mode => save.mutate({ mode })} />
        <SettingsSelect<Channel> label="Channel" hint={channelHint(view)} value={view.channel} disabled={save.isPending}
          options={[{ value: "stable", label: "Stable" }, { value: "beta", label: "Beta" }]}
          onValueChange={channel => save.mutate({ channel }, { onSuccess: () => toast.show(channel === "stable" ? "Switched to Stable. Nothing changes until a newer stable is out." : "Switched to Beta. The next check looks for betas.") })} />
        </>}
        <SettingsAction label="Release notes" hint={`Every version up to ${view.version}, newest first.`} actionLabel="See all" onPress={() => setSheet(true)} />
      </SettingsCard>
    </SettingsSection>
    {view.installKind === "npm" && view.history.length > 0 && <Disclosure id="updates.history" title="Update history" summary={`${HISTORY_RESULT[view.history[0]!.result]} ${stamp(view.history[0]!.at)}`} defaultOpen={false} theme={theme} compact={compact}>
      {view.history.slice(0, 10).map((h, i) => <View key={i} style={{ paddingHorizontal: compact ? 16 : 14, paddingVertical: 8, borderTopWidth: i ? 1 : 0, borderTopColor: c.border, gap: 2 }}>
        <Text style={t.meta}>{`${stamp(h.at)} · ${h.from} → ${h.to} · ${HISTORY_RESULT[h.result]}`}</Text>
        {h.reason && <Text style={t.small}>{h.reason}</Text>}
      </View>)}
    </Disclosure>}
    {sheet != null && <ReleaseNotesSheet theme={theme} compact={compact} all={sheet} onClose={() => setSheet(null)} />}
  </View>;
}

const SETUP_CARDS: { mode: UpdateMode; hint: string }[] = [
  { mode: "auto", hint: "Waits until your agents are idle. Rolls back if the new version fails." },
  { mode: "notify", hint: "Shows new versions on Home. You choose when to install." },
  { mode: "off", hint: "No checks. You can check from Settings → General." },
];
/**
 * Setup's Updates step: the same RPCs and controls as Settings → General, as radio cards. Reads without asking npm.
 * Saves on change; passing the step or skipping setup on a fresh install saves the pre-selected mode (server side).
 */
export function UpdatesStep({ theme, compact }: { theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c);
  const query = useUpdates();
  const write = useRpc(setUpdatesRpc); const cache = useQueryClient(); const toast = useToast();
  const save = useMutation({ mutationFn: (input: { mode?: UpdateMode; channel?: Channel }) => write(input), onSuccess: v => cache.setQueryData(updatesKey, v), onError: e => toast.error(errorText(e)) });
  const view = query.data;
  if (query.isLoading) return <Spinner color={c.foregroundMuted} size={16} label="Loading updates" />;
  if (!view) return <Text accessibilityRole="alert" style={[t.meta, { color: c.statusDanger }]}>{query.error ? errorText(query.error) : "Couldn't load updates."}</Text>;
  if (view.installKind !== "npm") return <Text style={t.body}>Updates are managed by your checkout. Pull and rebuild to update.</Text>;
  return <View style={{ gap: 12 }}>
    <View accessibilityRole="radiogroup" accessibilityLabel="Updates" style={{ gap: 6 }}>
      {SETUP_CARDS.map(card => <OptionCard key={card.mode} theme={theme} compact={compact} label={MODE_LABEL[card.mode]} consequence={card.hint} recommended={card.mode === "auto"}
        selected={view.mode === card.mode} disabled={save.isPending} onPress={() => view.mode !== card.mode && save.mutate({ mode: card.mode })} />)}
    </View>
    <SettingsCard>
      <SettingsSelect<Channel> label="Channel" hint={channelHint(view)} value={view.channel} disabled={save.isPending}
        options={[{ value: "stable", label: "Stable" }, { value: "beta", label: "Beta" }]} onValueChange={channel => save.mutate({ channel })} />
    </SettingsCard>
    <Text style={t.small}>Follow-up only installs versions npm confirms were built from github.com/tomgrin10/paseo-follow-up.</Text>
  </View>;
}

/**
 * The tiny version marker at the top of Home and the panel: "v1.4.0-beta.34", muted caption, then the update state
 * ("update", "updating", "check") and a warning dot only when something needs a look. Phones keep the version and
 * the dot, so the status chips beside it keep their room. Tapping opens Settings → General (Release notes live there).
 * Loading takes no width; a failed read shows nothing. `touch`: a 44pt box (react-native-web ignores hitSlop).
 */
export function VersionMark({ theme, touch, openSettings }: { theme: Theme; touch: boolean; openSettings: () => void }) {
  const c = theme.colors; const t = text(c, touch);
  const query = useUpdates();
  if (!query.data) return null;
  const mark = versionMark(query.data);
  const style = touch ? t.meta : t.small;
  const box = touch ? { minHeight: 44, paddingHorizontal: 10, justifyContent: "center" as const } : { paddingHorizontal: 4, paddingVertical: 4 };
  return <Pressable accessibilityRole="button" accessibilityLabel={mark.label} accessibilityHint="Opens Follow-up settings, General" hitSlop={touch ? undefined : 8}
    onPress={() => { writeCategory("general"); openSettings(); }} style={[box, { flexShrink: 1, minWidth: 0 }]}>
    {state => { const hover = !!(state as { hovered?: boolean }).hovered || state.pressed; const line = hover ? { color: c.foreground, textDecorationLine: "underline" as const } : null;
      return <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text numberOfLines={1} style={[style, { flexShrink: 1 }, line]}>{mark.version}</Text>
        {(mark.dot || (!touch && mark.suffix)) && <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          {mark.dot && <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.statusWarning }} />}
          {!touch && mark.suffix && <Text numberOfLines={1} style={[style, line]}>{mark.suffix}</Text>}
        </View>}
      </View>; }}
  </Pressable>;
}
