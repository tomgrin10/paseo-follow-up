import { ActivityIndicator, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSelect, SettingsSwitch, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { agentSettingsRpc, setAgentSettingRpc, setWaitRpc } from "../shared/contracts";
import { WAIT_HINT, WAIT_NOT_ATTACHED, WAIT_TITLE, waitNote } from "../shared/wait";
import { isJobRole, type AgentRole, type AgentSettingsView, type SavedRole } from "../shared/agent-settings";
import { NO_PROMPT_MODE, SETTINGS_ORDER, isReset, resetEntry } from "../shared/job-rows";
import { JobRows, agentSettingsKey, useAgentSettings, type JobExtra } from "./job-rows";
import { Button, errorText, text, type Theme } from "./kit";

export { agentSettingsKey } from "./job-rows";
const key = agentSettingsKey;
const DEFAULT = "__default";

type Role = AgentSettingsView["roles"][number];

/**
 * Settings → Agents: the same job rows as setup's Helper agents step (client/job-rows.tsx), plus each row's More with
 * what only Settings has: permissions, limits, schedule and Reset to defaults. The provider catalog is read once when
 * this screen opens (cached on the server), never polled.
 */
export function AgentSettings({ theme, compact }: Pick<PluginSurfaceProps, "theme"> & { compact: boolean }) {
  const c = theme.colors; const t = text(c);
  const { query } = useAgentSettings();
  const data = query.data;
  const more: JobExtra = {
    // The toggle names what's inside, so nobody opens it to find out.
    label: r => r.role === "ranker" ? "Schedule, limits and reset" : isJobRole(r.role) ? "Limits and reset" : r.same ? "Reset" : "Permissions and reset",
    render: (r, save, busy) => <RoleMore r={r} save={save} busy={busy} theme={theme} compact={compact} invalid={!!data?.invalid.includes(r.role)} />,
  };
  const info = "Which agent Follow-up uses for each of its own jobs. Recommended picks come from what Paseo has: with Claude, Haiku for summaries, Sonnet for AI priority, the newest Opus for the Overseer and the main agent's setup for recovery; otherwise a model of the size each job needs. Summaries and AI priority are one-shot jobs: on a provider other than Claude or Codex, each runs as a short hidden agent that's archived when it answers. Changes apply from the next call; the Overseer switches when you restart it.";
  return <SettingsSection title="Helper agents" info={info}>
    <SettingsCard>
      <JobRows theme={theme} compact={compact} order={SETTINGS_ORDER} extra={more} />
    </SettingsCard>
    {/* Once, after the rows: what can't be picked and why (the pickers only list what can). */}
    {!!data?.catalog && unavailableLine(data.catalog.providers) && <Text style={[t.meta, { paddingHorizontal: 4 }]}>{unavailableLine(data.catalog.providers)}</Text>}
  </SettingsSection>;
}

/**
 * Settings → Agents → Wait for background jobs: one switch, on by default. Shares the Agents screen's query, so it
 * costs no extra read. When the switch is on but Wait isn't attached (the standalone plugin is installed, or the host
 * doesn't serve plugin tools), an amber alert under it says so and what to do; the hint stays.
 */
export function WaitSettings({ theme }: Pick<PluginSurfaceProps, "theme">) {
  const c = theme.colors; const t = text(c);
  const read = useRpc(agentSettingsRpc); const write = useRpc(setWaitRpc); const cache = useQueryClient(); const toast = useToast();
  const query = useQuery({ queryKey: key, queryFn: () => read({ catalog: true }), staleTime: 5 * 60_000 });
  const change = useMutation({
    mutationFn: (enable_wait: boolean) => write({ enable_wait }),
    onSuccess: value => { cache.setQueryData(key, value); toast.show(`${WAIT_TITLE}: ${value.wait?.enable_wait ? "on" : "off"}`, { variant: "success" }); },
    onError: error => toast.error(errorText(error)),
  });
  const wait = query.data?.wait;
  const note = wait ? waitNote(wait) : null;
  return <SettingsSection title="Background jobs">
    {/* The card's place is kept while loading, so the Models section below doesn't jump. */}
    {query.isPending && <SettingsCard><View style={{ minHeight: 72, justifyContent: "center", paddingHorizontal: 16 }}><ActivityIndicator accessibilityLabel="Loading the Wait setting" color={c.foregroundMuted} style={{ alignSelf: "flex-start" }} /></View></SettingsCard>}
    {query.error && <SettingsCard><SettingsAction label="Couldn't load the Wait setting" hint={errorText(query.error)} actionLabel="Retry" onPress={() => void query.refetch()} /></SettingsCard>}
    {wait && <SettingsCard>
      <SettingsSwitch label={WAIT_TITLE} hint={WAIT_HINT} value={wait.enable_wait} disabled={change.isPending} onValueChange={value => change.mutate(value)} />
      {note && wait.enable_wait && <Text accessibilityRole="alert" style={[t.meta, { color: c.statusWarning, paddingHorizontal: 16, paddingBottom: 12 }]}>{`${WAIT_NOT_ATTACHED} ${note}`}</Text>}
    </SettingsCard>}
  </SettingsSection>;
}

/** A row's More in Settings: permissions (Paseo agents), limits and schedule (jobs), and Reset to defaults. */
function RoleMore({ r, save, busy, theme, compact, invalid }: { r: Role; save: (entry: SavedRole | null) => void; busy: boolean; theme: Theme; compact: boolean; invalid: boolean }) {
  const c = theme.colors; const t = text(c);
  const { query } = useAgentSettings();
  const catalog = query.data?.catalog?.providers ?? [];
  const role = r.role;
  const jobs = isJobRole(role);
  const current = catalog.find(p => p.id === r.provider);
  const base: SavedRole = { provider: r.provider, model: r.model, thinking: r.thinking, ...(jobs ? {} : { mode: r.mode }), ...(role === "recovery" ? { same: r.same } : {}),
    ...(jobs ? { dailyCap: r.dailyCap ?? undefined, maxPromptChars: r.maxPromptChars ?? undefined } : {}), ...(role === "ranker" ? { cadenceMinutes: r.cadenceMinutes ?? undefined } : {}) };
  const set = (patch: SavedRole) => save({ ...base, ...patch });
  const modes = current?.modes ?? [];
  const modeDefault = modes.find(m => m.id === current?.defaultMode);
  const modeLabel = (m: { id: string; label: string }) => NO_PROMPT_MODE[r.provider] === m.id ? `${m.label} · no prompts` : m.label;
  // Reset puts back the declared defaults, unless they can't run here: then the recommendation, with default limits.
  const reset = resetEntry(role, query.data?.catalog);
  const resetDone = isReset(r, query.data?.catalog);
  const schedule = role === "ranker" ? "limits and schedule" : jobs ? "limits" : "permissions";
  const resetText = reset.entry ? `Back to the recommended ${reset.label}, with the default ${schedule}.` : `Everything back to ${roleDefaultText(role)}, ${schedule} too.`;
  return <>
    {invalid && <Text style={[t.meta, { paddingHorizontal: 16, paddingTop: 10 }]}>Part of the saved setting wasn't valid, so its default is used.</Text>}
    {!jobs && !r.same && modes.length > 0 && <SettingsSelect label="Permissions" hint="It runs unattended, so pick a mode that doesn't prompt." value={r.mode ?? DEFAULT}
      options={[{ value: DEFAULT, label: modeDefault ? `Default (${modeLabel(modeDefault)})` : "Default" }, ...modes.map(m => ({ value: m.id, label: modeLabel(m) }))]} disabled={busy}
      onValueChange={value => set({ mode: value === DEFAULT ? null : value })} />}
    {role === "about" && <SettingsSelect label="Written ahead per day" hint="Summaries written in the background for workspaces in Needs you. Opening a workspace always writes one when needed."
      value={String(r.dailyCap ?? 60)} options={withCurrent([0, 20, 60, 120, 200], r.dailyCap ?? 60).map(n => ({ value: String(n), label: n === 0 ? "None" : String(n) }))} disabled={busy}
      onValueChange={value => set({ dailyCap: Number(value) })} />}
    {role === "ranker" && <SettingsSelect label="Ranks every" value={String(r.cadenceMinutes ?? 60)} disabled={busy}
      options={withCurrent([15, 30, 60, 120, 240], r.cadenceMinutes ?? 60).map(n => ({ value: String(n), label: n < 60 ? `${n} minutes` : n === 60 ? "Hour" : `${n / 60} hours` }))}
      onValueChange={value => set({ cadenceMinutes: Number(value) })} />}
    {role === "ranker" && <SettingsSelect label="At most per day" value={String(r.dailyCap ?? 24)} disabled={busy}
      options={withCurrent([6, 12, 24, 48, 96], r.dailyCap ?? 24).map(n => ({ value: String(n), label: String(n) }))}
      onValueChange={value => set({ dailyCap: Number(value) })} />}
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: compact ? 14 : 16, paddingVertical: 8, borderTopWidth: 1, borderTopColor: c.border }}>
      <Text style={[t.meta, { flex: 1 }]}>{resetText}</Text>
      <Button theme={theme} compact={compact} kind="ghost" title="Reset to defaults" disabled={busy || (resetDone && !invalid)} onPress={() => save(reset.entry)} />
    </View>
  </>;
}

const roleDefaultText = (role: AgentRole) => role === "recovery" ? "the main agent's setup" : role === "overseer" ? "Claude, newest Opus" : role === "about" ? "Claude Haiku" : "Claude Sonnet, hourly";
/** "Not available in Paseo: Claude and Pi (turned off in Paseo); Antigravity (not installed)." Grouped by reason; a
 * provider whose name is also on a ready one isn't listed, so the line never contradicts the rows. */
function unavailableLine(providers: readonly { label: string; available: boolean; reason: string | null }[]): string | null {
  const ready = new Set(providers.filter(p => p.available).map(p => p.label));
  const groups = new Map<string, string[]>();
  for (const p of providers) if (!p.available && !ready.has(p.label)) {
    const why = (p.reason ?? "unavailable").replace(/\.$/, "");
    groups.set(why, [...(groups.get(why) ?? []), p.label]);
  }
  if (!groups.size) return null;
  const list = (names: string[]) => names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Not available in Paseo: ${[...groups].map(([why, names]) => `${list(names)} (${why[0].toLowerCase()}${why.slice(1)})`).join("; ")}.`;
}
const withCurrent = (list: number[], value: number) => [...new Set([...list, value])].sort((a, b) => a - b);
