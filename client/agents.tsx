import type { ReactNode } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSelect, SettingsSwitch, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { agentSettingsRpc, setAgentSettingRpc, setWaitRpc } from "../shared/contracts";
import { WAIT_HINT, WAIT_NOT_ATTACHED, WAIT_TITLE, waitNote } from "../shared/wait";
import { AGENT_ROLES, JOB_PROVIDERS, ROLE_DEFAULTS, ROLE_INFO, isJobRole, modelName, providerName, type AgentRole, type AgentSettingsView, type CatalogProvider, type SavedRole } from "../shared/agent-settings";
import { Button, errorText, text, type Theme } from "./kit";

export const agentSettingsKey = ["follow-through", "agent-settings"];
const key = agentSettingsKey;
const SAME = "__same";
const DEFAULT = "__default";
/** Each provider's "don't ask" mode, used when a Paseo agent role moves to it. */
const BYPASS: Record<string, string> = { claude: "bypassPermissions", codex: "full-access" };

type Role = AgentSettingsView["roles"][number];

/**
 * Settings → Agents: one card per special role. What it does and what it uses now, then provider, model, effort,
 * mode and limits. The provider catalog is read once when this screen opens (cached on the server), never polled.
 */
export function AgentSettings({ theme, compact, toggles = {} }: Pick<PluginSurfaceProps, "theme"> & { compact: boolean; toggles?: Partial<Record<AgentRole, ReactNode>> }) {
  const c = theme.colors; const t = text(c);
  const read = useRpc(agentSettingsRpc); const write = useRpc(setAgentSettingRpc); const cache = useQueryClient(); const toast = useToast();
  const query = useQuery({ queryKey: key, queryFn: () => read({ catalog: true }), staleTime: 5 * 60_000,
    // Only while Paseo is still discovering providers (right after it starts): ask again until they settle.
    refetchInterval: q => (q.state.data as AgentSettingsView | undefined)?.catalog?.providers.some(p => p.reason === "Still loading") && q.state.dataUpdateCount < 10 ? 5000 : false });
  const change = useMutation({
    mutationFn: (input: { role: AgentRole; entry: SavedRole | null }) => write(input),
    onSuccess: (value, input) => {
      cache.setQueryData(key, value);
      void cache.invalidateQueries({ queryKey: ["follow-through", "about"] });
      const r = value.roles.find(x => x.role === input.role);
      if (r) toast.show(input.role === "overseer" ? `Overseer: ${r.summary}. Restart it from Home to switch.` : `${ROLE_INFO[input.role].title}: ${r.summary}`, { variant: "success" });
    },
    onError: error => toast.error(errorText(error)),
  });
  const data = query.data;
  const info = "Which agent Follow-up uses for each of its own jobs. Defaults: Claude Haiku for overviews, Claude Opus for the Overseer, the main agent's own setup for recovery, Claude Sonnet for priority ranking. What's this about? and the ranker are one-shot jobs, so they run on Claude or Codex only; the Overseer and recovery can use any provider Paseo has. Changes apply from the next call; the Overseer switches when you restart it.";
  return <SettingsSection title="Models" info={info}>
    {query.isPending && <ActivityIndicator accessibilityLabel="Loading agent settings" color={c.foregroundMuted} style={{ alignSelf: "flex-start", marginVertical: 8 }} />}
    {query.error && <SettingsCard><SettingsAction label="Couldn't load agent settings" hint={errorText(query.error)} actionLabel="Retry" onPress={() => void query.refetch()} /></SettingsCard>}
    {data?.catalog?.error && <SettingsCard><SettingsAction label="Couldn't read Paseo's providers" hint={`${data.catalog.error} The current choices still work; pickers show only what's saved.`} actionLabel="Retry" onPress={() => void read({ catalog: true, fresh: true }).then(v => cache.setQueryData(key, v), e => toast.error(errorText(e)))} /></SettingsCard>}
    {data && AGENT_ROLES.map(role => {
      const r = data.roles.find(x => x.role === role);
      return r ? <RoleCard key={role} r={r} invalid={data.invalid.includes(role)} catalog={data.catalog?.providers ?? []} busy={change.isPending} toggle={toggles[role]}
        save={entry => change.mutate({ role, entry })} theme={theme} compact={compact} /> : null;
    })}
    {/* Once, after the cards: what can't be picked and why (the pickers only list what can). */}
    {!!data?.catalog?.providers.some(p => !p.available) && <Text style={[t.meta, { paddingHorizontal: 4 }]}>{`Not available in Paseo: ${data.catalog.providers.filter(p => !p.available).map(p => `${p.label} (${(p.reason ?? "unavailable").replace(/\.$/, "")})`).join(", ")}.`}</Text>}

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

function RoleCard({ r, invalid, catalog, busy, save, theme, compact, toggle }: { r: Role; invalid: boolean; catalog: CatalogProvider[]; busy: boolean; save: (entry: SavedRole | null) => void; theme: Theme; compact: boolean; toggle?: ReactNode }) {
  const c = theme.colors; const t = text(c);
  const role = r.role;
  const jobs = isJobRole(role);
  const usable = catalog.filter(p => p.available && (!jobs || (JOB_PROVIDERS as readonly string[]).includes(p.id)));
  const current = catalog.find(p => p.id === r.provider);
  const base: SavedRole = { provider: r.provider, model: r.model, thinking: r.thinking, ...(jobs ? {} : { mode: r.mode }), ...(role === "recovery" ? { same: r.same } : {}),
    ...(jobs ? { dailyCap: r.dailyCap ?? undefined, maxPromptChars: r.maxPromptChars ?? undefined } : {}), ...(role === "ranker" ? { cadenceMinutes: r.cadenceMinutes ?? undefined } : {}) };
  const set = (patch: SavedRole) => save({ ...base, ...patch });
  const providerLabel = providerName(r.provider, current?.label);
  // Saved on a provider Paseo can't use right now: say so plainly, with what happens and the way out.
  const blocked = !r.same && catalog.length > 0 && !usable.some(p => p.id === r.provider);
  const blockedReason = !current ? "not in Paseo's provider list" : !current.available ? (current.reason ?? "unavailable").replace(/\.$/, "") : "can't run one-shot jobs";

  const providerOptions = [
    ...(role === "recovery" ? [{ value: SAME, label: "Same as main agent" }] : []),
    ...usable.map(p => ({ value: p.id, label: p.label })),
    ...(!r.same && !usable.some(p => p.id === r.provider) ? [{ value: r.provider, label: `${providerLabel} · unavailable` }] : []),
  ];
  const pickProvider = (value: string) => {
    if (value === SAME) return set({ same: true });
    const p = catalog.find(x => x.id === value);
    const defaults = ROLE_DEFAULTS[role];
    const same = value === defaults.provider;
    set({ same: false, provider: value, model: same ? defaults.model : null, thinking: null, ...(jobs ? {} : { mode: same ? defaults.mode : BYPASS[value] ?? p?.defaultMode ?? null }) });
  };

  const models = current?.models ?? [];
  const model = r.model ? models.find(m => m.id === r.model) : null;
  const providerDefault = models.find(m => m.isDefault);
  const defaultModel = role === "overseer" && r.provider === "claude" ? "Default (newest Opus)" : providerDefault ? `Default (${providerDefault.label})` : "Default";
  const modelOptions = [{ value: DEFAULT, label: defaultModel }, ...models.map(m => ({ value: m.id, label: m.label })),
    ...(r.model && !model ? [{ value: r.model, label: modelName(r.model) }] : [])];
  const thinking = (model ?? providerDefault)?.thinking ?? [];
  const thinkingDefault = thinking.find(o => o.isDefault);
  const modes = current?.modes ?? [];
  const modeDefault = modes.find(m => m.id === current?.defaultMode);
  const modeLabel = (m: { id: string; label: string }) => BYPASS[r.provider] === m.id ? `${m.label} · no prompts` : m.label;

  const reset = <Button theme={theme} compact={compact} kind="ghost" icon="RotateCcw" title="Reset to default" accessibilityHint={`Back to ${roleDefaultText(role)}`} disabled={busy || (r.isDefault && !invalid)} onPress={() => save(null)} />;
  return <SettingsCard>
    <View style={{ paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10, gap: 2 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text accessibilityRole="header" style={[t.title, { flex: 1 }]}>{ROLE_INFO[role].title}</Text>
        {!compact && reset}
      </View>
      <Text style={t.meta}>{ROLE_INFO[role].does}{role === "overseer" ? " A running Overseer keeps its model until you restart it from Home." : ""}</Text>
      {invalid && <Text style={t.meta}>Part of the saved setting wasn't valid, so its default is used.</Text>}
      {blocked && <Text accessibilityRole="alert" style={[t.meta, { color: c.statusWarning }]}>{`${providerLabel} isn't available (${blockedReason}). ${role === "about" ? "Overviews will fail" : role === "ranker" ? "Ranking will fail" : role === "overseer" ? "Starting or restarting the Overseer will fail" : "Recovery agents won't start"} until you pick another provider or reset.`}</Text>}
    </View>
    {/* The role's own on/off (Overseer, AI priority) leads its card; the model rows follow. */}
    {toggle}
    <SettingsSelect label="Provider" value={r.same ? SAME : r.provider} options={providerOptions} disabled={busy || !catalog.length} onValueChange={pickProvider} />
    {!r.same && <SettingsSelect label="Model" value={r.model ?? DEFAULT} options={modelOptions} disabled={busy || !catalog.length}
      onValueChange={value => set({ model: value === DEFAULT ? null : value, thinking: null })} />}
    {!r.same && (thinking.length > 0 || !!r.thinking) && <SettingsSelect label="Effort" hint={!thinking.length && !blocked && model ? "This model lists no effort levels in Paseo; the saved one is still passed on." : undefined} value={r.thinking ?? DEFAULT}
      options={[{ value: DEFAULT, label: thinkingDefault ? `Default (${thinkingDefault.label})` : "Default" }, ...thinking.map(o => ({ value: o.id, label: o.label })), ...(r.thinking && !thinking.some(o => o.id === r.thinking) ? [{ value: r.thinking, label: r.thinking }] : [])]} disabled={busy}
      onValueChange={value => set({ thinking: value === DEFAULT ? null : value })} />}
    {!jobs && !r.same && modes.length > 0 && <SettingsSelect label="Permissions" hint="It runs unattended, so pick a mode that doesn't prompt." value={r.mode ?? DEFAULT}
      options={[{ value: DEFAULT, label: modeDefault ? `Default (${modeLabel(modeDefault)})` : "Default" }, ...modes.map(m => ({ value: m.id, label: modeLabel(m) }))]} disabled={busy}
      onValueChange={value => set({ mode: value === DEFAULT ? null : value })} />}
    {role === "about" && <SettingsSelect label="Written ahead per day" hint="Overviews written in the background for workspaces in Needs you. Opening a workspace always writes one when needed."
      value={String(r.dailyCap ?? 60)} options={withCurrent([0, 20, 60, 120, 200], r.dailyCap ?? 60).map(n => ({ value: String(n), label: n === 0 ? "None" : String(n) }))} disabled={busy}
      onValueChange={value => set({ dailyCap: Number(value) })} />}
    {role === "ranker" && <SettingsSelect label="Ranks every" value={String(r.cadenceMinutes ?? 60)} disabled={busy}
      options={withCurrent([15, 30, 60, 120, 240], r.cadenceMinutes ?? 60).map(n => ({ value: String(n), label: n < 60 ? `${n} minutes` : n === 60 ? "Hour" : `${n / 60} hours` }))}
      onValueChange={value => set({ cadenceMinutes: Number(value) })} />}
    {role === "ranker" && <SettingsSelect label="At most per day" value={String(r.dailyCap ?? 24)} disabled={busy}
      options={withCurrent([6, 12, 24, 48, 96], r.dailyCap ?? 24).map(n => ({ value: String(n), label: String(n) }))}
      onValueChange={value => set({ dailyCap: Number(value) })} />}
    {compact && <View style={{ flexDirection: "row", paddingHorizontal: 8, paddingVertical: 6 }}>{reset}</View>}
  </SettingsCard>;
}

const roleDefaultText = (role: AgentRole) => role === "recovery" ? "the main agent's setup" : role === "overseer" ? "Claude, newest Opus" : role === "about" ? "Claude Haiku" : "Claude Sonnet, hourly";
const withCurrent = (list: number[], value: number) => [...new Set([...list, value])].sort((a, b) => a - b);
