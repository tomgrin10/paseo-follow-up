import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon, SettingsSelect, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { agentSettingsRpc, setAgentSettingRpc } from "../shared/contracts";
import { displayPreferences } from "../shared/display";
import { ROLE_DEFAULTS, ROLE_INFO, isJobRole, modelName, providerName, type AgentRole, type AgentSettingsView, type CatalogProvider, type SavedRole } from "../shared/agent-settings";
import { NO_PROMPT_MODE, jobRow, jobsHeader, preselect as toPreselect, recommendedEntry, type JobRowModel } from "../shared/job-rows";
import { Button, Chip, Switch, errorText, text, type Theme } from "./kit";
import { Spinner, useReducedMotion } from "./motion";

/**
 * The helper jobs as rows: setup's Helper agents step and Settings → Agents both render <JobRows>, so they show the same
 * thing for the same job (tests/job-rows.test.ts). What a row says comes from shared/job-rows.ts.
 */
export const agentSettingsKey = ["follow-through", "agent-settings"];
type RoleView = AgentSettingsView["roles"][number];
const SAME = "__same";
const DEFAULT = "__default";
const SWITCH: Partial<Record<AgentRole, "enable_overseer" | "enable_ranker">> = { overseer: "enable_overseer", ranker: "enable_ranker" };

/** The one read of roles and the provider catalog, shared by every screen that shows the jobs. */
export function useAgentSettings() {
  const read = useRpc(agentSettingsRpc); const write = useRpc(setAgentSettingRpc); const cache = useQueryClient(); const toast = useToast();
  const query = useQuery({ queryKey: agentSettingsKey, queryFn: () => read({ catalog: true }), staleTime: 5 * 60_000,
    // Only while Paseo is still discovering providers (right after it starts): ask again until they settle.
    refetchInterval: q => (q.state.data as AgentSettingsView | undefined)?.catalog?.providers.some(p => p.reason === "Still loading") && q.state.dataUpdateCount < 10 ? 5000 : false });
  const change = useMutation({
    mutationFn: (input: { role: AgentRole; entry: SavedRole | null; quiet?: boolean }) => write({ role: input.role, entry: input.entry }),
    onSuccess: (value, input) => {
      cache.setQueryData(agentSettingsKey, value);
      void cache.invalidateQueries({ queryKey: ["follow-through", "about"] });
      const r = value.roles.find(x => x.role === input.role);
      if (r && !input.quiet) toast.show(input.role === "overseer" ? `Overseer: ${r.summary}. Restart it from Home to switch.` : `${ROLE_INFO[input.role].title}: ${r.summary}`, { variant: "success" });
    },
    onError: error => toast.error(errorText(error)),
  });
  const refresh = () => read({ catalog: true, fresh: true }).then(v => cache.setQueryData(agentSettingsKey, v), e => toast.error(errorText(e)));
  return { query, change, refresh, toast };
}

export type JobExtra = (r: RoleView, save: (entry: SavedRole | null) => void, busy: boolean) => ReactNode;

export function JobRows({ theme, compact, order, extra, preselect = false }: {
  theme: Theme; compact: boolean; order: readonly AgentRole[];
  /** Settings only: controls behind each row's More (limits, schedule, permissions, Reset to defaults). */
  extra?: JobExtra;
  /** Setup only: fill in the recommendation for jobs with nothing saved whose default can't run here. */
  preselect?: boolean;
}) {
  const c = theme.colors; const t = text(c, compact);
  const { query, change, refresh, toast } = useAgentSettings();
  const display = useSettings(displayPreferences);
  const [open, setOpen] = useState<AgentRole | null>(null);
  const [bulk, setBulk] = useState(false);
  const data = query.data;
  const catalog = data?.catalog ?? null;
  const roles = order.map(role => data?.roles.find(r => r.role === role)).filter((r): r is RoleView => !!r);
  const rows = roles.map(r => jobRow(r, catalog));
  const header = jobsHeader(rows, catalog, query.isPending);
  const busy = change.isPending || bulk;

  // Preselect once per open, quietly: there was no choice, and the default couldn't run.
  const filled = useRef(false);
  useEffect(() => {
    if (!preselect || filled.current || !data) return;
    const todo = toPreselect(data.roles, data.catalog);
    if (!data.catalog || data.catalog.providers.some(p => p.reason === "Still loading")) return;
    filled.current = true;
    void (async () => { for (const p of todo) await change.mutateAsync({ ...p, quiet: true }).catch(() => undefined); })();
  }, [preselect, data, change]);

  const useAll = async () => {
    setBulk(true);
    let overseer = false;
    try {
      for (const [i, row] of rows.entries()) {
        if (!row.rec || row.recommended) continue;
        await change.mutateAsync({ role: row.role, entry: recommendedEntry(roles[i], row.rec), quiet: true });
        if (row.role === "overseer") overseer = true;
      }
      toast.show(overseer ? "Using the recommended models. A running Overseer switches when you restart it from Home." : "Using the recommended models.", { variant: "success" });
    } catch { /* the mutation's toast says why */ } finally { setBulk(false); }
  };

  if (query.error) return <View style={{ padding: 16, gap: 8 }}>
    <Text accessibilityRole="alert" style={[t.meta, { color: c.statusWarning }]}>{`Couldn't load the helper agents: ${errorText(query.error)}`}</Text>
    <Button theme={theme} compact={compact} title="Retry" onPress={() => void query.refetch()} />
  </View>;
  const action = header.action === "use" ? <Button theme={theme} compact={compact} title="Use recommended" loading={bulk} disabled={busy} onPress={() => void useAll()} />
    : header.action === "retry" ? <Button theme={theme} compact={compact} title="Retry" disabled={busy} onPress={() => void refresh()} />
    : header.action === "check" ? <Button theme={theme} compact={compact} title="Check again" disabled={busy} onPress={() => void refresh()} /> : null;
  return <View>
    <View style={{ flexDirection: compact ? "column" : "row", alignItems: compact ? "flex-start" : "center", gap: compact ? 8 : 12, paddingHorizontal: compact ? 14 : 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.border }}>
      <View style={{ flex: compact ? undefined : 1, flexDirection: "row", alignItems: "center", gap: 8 }}>
        {header.text === "Reading your providers…" && <Spinner color={c.foregroundMuted} size={14} />}
        <Text accessibilityRole={header.tone === "warning" ? "alert" : undefined} style={[t.meta, header.tone === "warning" ? { color: c.statusWarning } : null]}>{header.text}</Text>
      </View>
      {action}
    </View>
    {roles.map((r, i) => {
      const field = SWITCH[r.role];
      const on = field && display.status === "ready" ? display.values[field] !== false : null;
      return <JobRow key={r.role} first={i === 0} row={rows[i]} r={r} catalog={catalog?.providers ?? []} loading={!catalog} theme={theme} compact={compact} busy={busy}
        open={open === r.role} onToggle={() => setOpen(open === r.role ? null : r.role)}
        enabled={field ? on : undefined} onEnable={field && display.status === "ready" ? v => void display.save({ ...display.values, [field]: v }, display.revision).catch(e => toast.error(errorText(e))) : undefined}
        save={entry => change.mutate({ role: r.role, entry })} extra={extra} />;
    })}
  </View>;
}

export function JobRow({ row, r, catalog, loading, theme, compact, busy, open, onToggle, enabled, onEnable, save, extra, first }: {
  row: JobRowModel; r: RoleView; catalog: CatalogProvider[]; loading: boolean; theme: Theme; compact: boolean; busy: boolean;
  open: boolean; onToggle: () => void; enabled?: boolean | null; onEnable?: (v: boolean) => void;
  save: (entry: SavedRole | null) => void; extra?: JobExtra; first: boolean;
}) {
  const c = theme.colors; const t = text(c, compact);
  const reduced = useReducedMotion();
  const [more, setMore] = useState(false);
  const off = enabled === false;
  const pad = compact ? 14 : 16;
  const use = row.rec && !row.recommended ? () => save(recommendedEntry(r, row.rec!)) : null;
  return <View style={{ borderTopWidth: first ? 0 : 1, borderTopColor: c.border, paddingHorizontal: pad, paddingVertical: 14, gap: 2 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
      <Text accessibilityRole="header" style={[t.label, { flex: 1 }]}>{row.title}</Text>
      {enabled !== undefined && <Switch theme={theme} compact={compact} label={enabled ? "On" : "Off"} accessibilityLabel={row.title} value={enabled} disabled={!onEnable} onChange={v => onEnable?.(v)} />}
    </View>
    <Text style={t.meta}>{row.does}</Text>
    <View style={{ opacity: off ? 0.6 : 1, gap: 6, marginTop: 8 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        {loading
          ? <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: compact ? 44 : 32 }}><Spinner color={c.foregroundMuted} size={14} /><Text style={t.meta}>Reading your providers…</Text></View>
          : <Pressable accessibilityRole="button" accessibilityLabel={`${row.title} model: ${row.pick}. Change`} accessibilityState={{ expanded: open, disabled: busy }} aria-expanded={open}
              disabled={busy && !open} onPress={onToggle}
              style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 8, minHeight: compact ? 44 : 32, maxWidth: "100%", paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: pressed ? c.surface2 : c.surface0 })}>
              <Text numberOfLines={1} style={[t.body, { color: c.foreground, flexShrink: 1 }]}>{row.pick}</Text>
              <Icon name={open ? "ChevronUp" : "ChevronDown"} size={14} color={c.foregroundMuted} />
            </Pressable>}
        {row.recommended && <Chip theme={theme} label="Recommended" color={c.foregroundMuted} />}
      </View>
      <Text style={[t.meta, { fontSize: 12, lineHeight: 16 }]}>{row.hint ? `${row.need} ${row.hint}` : row.need}</Text>
      {row.notice && <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 8 }}>
        <Text accessibilityRole={row.notice.tone === "warning" ? "alert" : undefined} style={[t.meta, { fontSize: 12, lineHeight: 16, color: row.notice.tone === "warning" ? c.statusWarning : c.foregroundMuted }]}>{row.notice.text}</Text>
        {use && <Pressable accessibilityRole="button" accessibilityLabel={`Use ${row.recPick} for ${row.title}`} disabled={busy} onPress={use} hitSlop={8} style={{ minHeight: compact ? 44 : 24, justifyContent: "center" }}>
          <Text style={[t.label, { fontSize: 12, textDecorationLine: "underline" }]}>Use</Text>
        </Pressable>}
      </View>}
      {open && !loading && <View style={{ marginTop: 4, borderWidth: 1, borderColor: c.border, borderRadius: 10, overflow: "hidden" }}>
        <RolePickers r={r} catalog={catalog} busy={busy} save={save} />
      </View>}
      {extra && <>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: more }} aria-expanded={more} accessibilityLabel={`More ${row.title} settings`} onPress={() => setMore(!more)} hitSlop={6}
          style={{ flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start", minHeight: compact ? 44 : 24 }}>
          <Text style={[t.meta, { color: c.foreground }]}>More</Text>
          <Icon name={more ? "ChevronUp" : "ChevronDown"} size={12} color={c.foregroundMuted} />
        </Pressable>
        {more && <View style={{ borderWidth: 1, borderColor: c.border, borderRadius: 10, overflow: "hidden", opacity: reduced ? 1 : 1 }}>{extra(r, save, busy)}</View>}
      </>}
    </View>
  </View>;
}

/** Provider, Model and Effort: the same pickers in setup and Settings. */
export function RolePickers({ r, catalog, busy, save }: { r: RoleView; catalog: CatalogProvider[]; busy: boolean; save: (entry: SavedRole | null) => void }) {
  const role = r.role;
  const jobs = isJobRole(role);
  const usable = catalog.filter(p => p.available);
  const current = catalog.find(p => p.id === r.provider);
  const base: SavedRole = { provider: r.provider, model: r.model, thinking: r.thinking, ...(jobs ? {} : { mode: r.mode }), ...(role === "recovery" ? { same: r.same } : {}),
    ...(jobs ? { dailyCap: r.dailyCap ?? undefined, maxPromptChars: r.maxPromptChars ?? undefined } : {}), ...(role === "ranker" ? { cadenceMinutes: r.cadenceMinutes ?? undefined } : {}) };
  const set = (patch: SavedRole) => save({ ...base, ...patch });
  const providerLabel = providerName(r.provider, current?.label);
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
    set({ same: false, provider: value, model: same ? defaults.model : null, thinking: null, ...(jobs ? {} : { mode: same ? defaults.mode : NO_PROMPT_MODE[value] ?? p?.defaultMode ?? null }) });
  };
  const models = current?.models ?? [];
  const model = r.model ? models.find(m => m.id === r.model) : null;
  const providerDefault = models.find(m => m.isDefault);
  const defaultModel = role === "overseer" && r.provider === "claude" ? "Default (newest Opus)" : providerDefault ? `Default (${providerDefault.label})` : "Default";
  const modelOptions = [{ value: DEFAULT, label: defaultModel }, ...models.map(m => ({ value: m.id, label: m.label })),
    ...(r.model && !model ? [{ value: r.model, label: modelName(r.model) }] : [])];
  const thinking = (model ?? providerDefault)?.thinking ?? [];
  const thinkingDefault = thinking.find(o => o.isDefault);
  return <>
    <SettingsSelect label="Provider" value={r.same ? SAME : r.provider} options={providerOptions} disabled={busy || !catalog.length} onValueChange={pickProvider} />
    {!r.same && <SettingsSelect label="Model" value={r.model ?? DEFAULT} options={modelOptions} disabled={busy || !catalog.length}
      onValueChange={value => set({ model: value === DEFAULT ? null : value, thinking: null })} />}
    {!r.same && (thinking.length > 0 || !!r.thinking) && <SettingsSelect label="Effort" value={r.thinking ?? DEFAULT}
      options={[{ value: DEFAULT, label: thinkingDefault ? `Default (${thinkingDefault.label})` : "Default" }, ...thinking.map(o => ({ value: o.id, label: o.label })), ...(r.thinking && !thinking.some(o => o.id === r.thinking) ? [{ value: r.thinking, label: r.thinking }] : [])]} disabled={busy}
      onValueChange={value => set({ thinking: value === DEFAULT ? null : value })} />}
  </>;
}
