import { useState } from "react";
import { NEW_ROW } from "../shared/new-name";
import { useNewRowSetting } from "./new-entry";
import { ActivityIndicator, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Text } from "./text";
import { Button, IconButton, SubmitScope, Switch, errorText, text, type Theme } from "./kit";
import { raised } from "./theme";
import { focusRing } from "./action-row";
import { isMac } from "../shared/search-key";
import { dispatchActionsRpc, dispatchSettingsRpc, setDispatchActionsRpc, setDispatchSettingsRpc } from "../shared/contracts";
import type { z } from "zod";
import type { DispatchAction, actionChangeSchema, settingsChangeSchema } from "../shared/dispatch";
import { actionRows, learnedTeams, teamKey, type ActionRowModel, type SettingsView } from "../shared/new-settings";
import { NEW_NAME, NEW_OF, NEW_WORK } from "../shared/new-name";

export const newActionsKey = ["follow-up", "dispatch-actions"];
export const newSettingsKey = ["follow-up", "dispatch-settings"];
type ActionsView = { actions: DispatchAction[]; edited: boolean };
type ActionChange = z.infer<typeof actionChangeSchema>;
type SettingsChange = z.infer<typeof settingsChangeSchema>;
const PICK = "__pick";
const RESET_ALL = "__reset-all";

/**
 * Settings → New work (docs/dispatch.md#settings): the actions New offers (order, show or hide, reset to built-in),
 * where work goes (team rules, the no-team rule) and the base per project. Read when the tab opens, never polled;
 * every change goes through the RPCs the agent tools run (set_dispatch_actions, set_dispatch_settings).
 */
export function NewWorkCategory({ theme, compact, openAgents }: { theme: Theme; compact: boolean; openAgents?: () => void }) {
  const t = text(theme.colors, compact);
  return <>
    <ActionsSection theme={theme} compact={compact} />
    <WhereSection theme={theme} compact={compact} />
    <BasesSection theme={theme} compact={compact} />
    <SidebarSection theme={theme} compact={compact} />
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 8, rowGap: 4, paddingHorizontal: 4 }}>
      <Text style={t.meta}>{`${NEW_OF} agent is set in Agents → ${NEW_WORK}.`}</Text>
      {openAgents && <Button theme={theme} compact={compact} kind="ghost" icon="ArrowRight" title="Open Agents" accessibilityLabel="Open Settings, Agents" onPress={openAgents} />}
    </View>
  </>;
}

/** The sidebar's New row, on or off (new-row-is-optional), and, while on, the tip about Paseo's own New workspace. */
function SidebarSection({ theme, compact }: { theme: Theme; compact: boolean }) {
  const t = text(theme.colors, compact);
  const row = useNewRowSetting();
  return <SettingsSection title="Sidebar">
    <SettingsCard>
      <SettingsSwitch label={NEW_ROW.label} hint={compact ? NEW_ROW.hint(null, null) : NEW_ROW.hint(row.key, isMac() ? "⌘K" : "Ctrl K")} value={row.value ?? true} disabled={row.value === null || row.saving} onValueChange={row.set} />
    </SettingsCard>
    {row.value !== false && <Text style={[t.meta, { paddingHorizontal: 4 }]}>{NEW_ROW.paseo}</Text>}
  </SettingsSection>;
}

function useActions() {
  const read = useRpc(dispatchActionsRpc);
  return useQuery({ queryKey: newActionsKey, queryFn: async () => await read({}) as ActionsView, staleTime: 30_000 });
}
function useNewSettings() {
  const read = useRpc(dispatchSettingsRpc);
  return useQuery({ queryKey: newSettingsKey, queryFn: async () => await read({}) as SettingsView, staleTime: 30_000 });
}

function ActionsSection({ theme, compact }: { theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const query = useActions();
  const write = useRpc(setDispatchActionsRpc); const cache = useQueryClient(); const toast = useToast();
  const change = useMutation({
    mutationFn: async (change: ActionChange) => await write({ change }),
    onSuccess: (value, change) => cache.setQueryData<ActionsView>(newActionsKey, { actions: value.actions as DispatchAction[], edited: change.op !== "reset-all" }),
    onError: error => toast.error(errorText(error)),
  });
  const info = `What ${NEW_NAME} offers for an issue, a link or your words, in this order: the first one shown is ↵, the second ⌥↵, the rest are under More. A hidden action stays here. Agents can add their own; an action is a template, never code.`;
  const rows = query.data ? actionRows(query.data.actions) : [];
  const [confirm, setConfirm] = useState<string | null>(null);
  const added = query.data?.actions.filter(a => !a.builtin).length ?? 0;
  return <SettingsSection title="Actions" info={info}>
    {query.isPending && <ActivityIndicator accessibilityLabel={`Loading ${NEW_OF} actions`} color={c.foregroundMuted} style={{ alignSelf: "flex-start", marginVertical: 8 }} />}
    {query.error && <SettingsCard><SettingsAction label={`Couldn't load ${NEW_OF} actions`} hint={errorText(query.error)} actionLabel="Retry" onPress={() => void query.refetch()} /></SettingsCard>}
    {query.data && <View style={{ ...raised(c), borderRadius: 10, backgroundColor: c.surface1, overflow: "hidden" }}>
      {rows.map((row, i) => <ActionRowView key={row.id} row={row} first={i === 0} theme={theme} compact={compact} busy={change.isPending}
        confirming={confirm === row.id} onConfirm={v => setConfirm(v ? row.id : null)}
        onChange={op => { setConfirm(null); change.mutate(op); }} index={i} />)}
    </View>}
    {query.data && <Text style={[t.meta, { paddingHorizontal: 4 }]}>{`In ${NEW_NAME}, the first two shown get ↵ and ⌥↵; the rest are under More.`}</Text>}
    {/* Reset all removes added actions, so it asks in place first, like Delete. */}
    {query.data?.edited && <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      {confirm === RESET_ALL
        ? <>
          <Button theme={theme} compact={compact} kind="danger" icon="RotateCcw" title={added ? `Reset and remove ${added} added` : "Reset all"} disabled={change.isPending} onPress={() => { setConfirm(null); change.mutate({ op: "reset-all" }); }} />
          <Button theme={theme} compact={compact} kind="ghost" title="Keep them" onPress={() => setConfirm(null)} />
        </>
        : <Button theme={theme} compact={compact} icon="RotateCcw" title="Reset all to built-in" disabled={change.isPending} onPress={() => setConfirm(RESET_ALL)} />}
      <Text style={[t.meta, { flexShrink: 1 }]}>{added ? `Restores the built-in order and text, and removes ${added === 1 ? "the action" : `the ${added} actions`} added here.` : "Restores the built-in order and text."}</Text>
    </View>}
  </SettingsSection>;
}

function ActionRowView({ row, first, index, theme, compact, busy, confirming, onConfirm, onChange }: {
  row: ActionRowModel; first: boolean; index: number; theme: Theme; compact: boolean; busy: boolean; confirming: boolean;
  onConfirm: (v: boolean) => void; onChange: (change: ActionChange) => void;
}) {
  const c = theme.colors; const t = text(c, compact);
  const tags = [row.key, row.scope, row.origin, row.hidden ? "Hidden" : null].filter((x): x is string => !!x);
  const spoken = (tag: string) => tag === "↵" ? `Enter in ${NEW_NAME}` : tag === "⌥↵" ? `${isMac() ? "Option" : "Alt"} Enter in ${NEW_NAME}` : tag;
  const fg = row.hidden ? c.foregroundMuted : c.foreground;
  return <View style={{ borderTopWidth: first ? 0 : 1, borderTopColor: c.border, paddingHorizontal: compact ? 12 : 16, paddingVertical: compact ? 10 : 12, gap: 8 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
      <Icon name={row.icon} size={16} color={fg} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 6, rowGap: 2 }}>
          <Text style={{ color: fg, fontSize: compact ? 15 : 13, fontWeight: "600" }}>{row.name}</Text>
          {tags.map(tag => <View key={tag} accessible accessibilityLabel={spoken(tag)} style={{ borderRadius: 4, borderWidth: 1, borderColor: c.border, paddingHorizontal: 5, paddingVertical: 1 }}>
            <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{tag}</Text>
          </View>)}
        </View>
        {!!row.description && <Text style={[t.meta, { color: c.foregroundMuted }]}>{row.description}</Text>}
      </View>
      <IconButton theme={theme} compact={compact} icon="ArrowUp" label={`Move ${row.name} up`} disabled={busy || row.first} onPress={() => onChange({ op: "move", id: row.id, to: index - 1 })} />
      <IconButton theme={theme} compact={compact} icon="ArrowDown" label={`Move ${row.name} down`} disabled={busy || row.last} onPress={() => onChange({ op: "move", id: row.id, to: index + 1 })} />
      <Switch theme={theme} compact={compact} label="" accessibilityLabel={`Show ${row.name} in ${NEW_NAME}`} value={!row.hidden} disabled={busy} onChange={on => onChange({ op: "hide", id: row.id, hidden: !on })} />
    </View>
    {(row.canReset || row.canDelete) && <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, paddingLeft: 16 }}>
      {row.canReset && <Button theme={theme} compact={compact} kind="ghost" icon="RotateCcw" title="Reset to built-in" disabled={busy} onPress={() => onChange({ op: "reset", id: row.id })} />}
      {row.canDelete && (confirming
        ? <>
          <Button theme={theme} compact={compact} kind="danger" icon="Trash2" title={`Delete ${row.name}`} disabled={busy} onPress={() => onChange({ op: "delete", id: row.id })} />
          <Button theme={theme} compact={compact} kind="ghost" title="Keep it" onPress={() => onConfirm(false)} />
        </>
        : <Button theme={theme} compact={compact} kind="ghost" icon="Trash2" title="Delete" disabled={busy} onPress={() => onConfirm(true)} />)}
    </View>}
  </View>;
}

function useSettingsChange() {
  const write = useRpc(setDispatchSettingsRpc); const cache = useQueryClient(); const toast = useToast();
  return useMutation({
    mutationFn: async (change: SettingsChange) => await write(change) as SettingsView,
    onSuccess: value => cache.setQueryData(newSettingsKey, value),
    onError: error => toast.error(errorText(error)),
  });
}

/** Where work goes: a team's rule wins over what its past work learned; the no-team rule covers everything else. */
function WhereSection({ theme, compact }: { theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const query = useNewSettings(); const change = useSettingsChange();
  const [team, setTeam] = useState(""); const [project, setProject] = useState(PICK);
  const [removing, setRemoving] = useState<string | null>(null);
  const view = query.data;
  const info = `Which project ${NEW_NAME} starts an issue's work in. A link to a repository and an issue that already has a workspace go there; otherwise the team's rule, then where the team's past work went, then the rule below. When ${NEW_NAME} isn't sure it asks, and your pick is saved as the team's rule.`;
  const projectOptions = (view?.projects ?? []).map(p => ({ value: p.id, label: p.name }));
  const key = teamKey(team);
  // The fields clear only once the rule is saved: a failed save keeps what was typed.
  const add = () => change.mutate({ rules: { [key]: project } }, { onSuccess: () => { setTeam(""); setProject(PICK); } });
  return <SettingsSection title="Where work goes" info={info}>
    {query.isPending && <ActivityIndicator accessibilityLabel={`Loading where ${NEW_NAME} starts work`} color={c.foregroundMuted} style={{ alignSelf: "flex-start", marginVertical: 8 }} />}
    {query.error && <SettingsCard><SettingsAction label={`Couldn't load ${NEW_OF} rules`} hint={errorText(query.error)} actionLabel="Retry" onPress={() => void query.refetch()} /></SettingsCard>}
    {view && <>
      <SettingsCard>
        <SettingsSelect label="Everything else" hint="Issues from a team without a rule or a clear history, links and your words." value={view.noTeam} disabled={change.isPending}
          options={[{ value: "last", label: "The project you used last" }, { value: "ask", label: "Ask which project" }]} onValueChange={noTeam => change.mutate({ noTeam })} />
      </SettingsCard>
      <SettingsCard>
        {view.rules.map(rule => <View key={rule.team}>
          <SettingsSelect label={`${rule.team} issues`} hint={rule.project ? undefined : "That project is gone: pick another or remove the rule."}
            value={rule.project ? rule.projectId : PICK} disabled={change.isPending}
            options={[...(rule.project ? [] : [{ value: PICK, label: "Pick a project" }]), ...projectOptions]}
            onValueChange={v => v !== PICK && change.mutate({ rules: { [rule.team]: v } })} />
          {/* Removing is its own control, asked twice in place; never an option hidden in the project list. */}
          <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 8, paddingHorizontal: 12, paddingBottom: 8, marginTop: -4 }}>
            {removing === rule.team
              ? <>
                <Button theme={theme} compact={compact} kind="ghost" title="Keep" onPress={() => setRemoving(null)} />
                <Button theme={theme} compact={compact} kind="danger" title={`Remove ${rule.team}'s rule`} disabled={change.isPending} onPress={() => { setRemoving(null); change.mutate({ rules: { [rule.team]: null } }); }} />
              </>
              : <Button theme={theme} compact={compact} kind="ghost" title="Remove" accessibilityLabel={`Remove ${rule.team}'s rule`} disabled={change.isPending} onPress={() => setRemoving(rule.team)} />}
          </View>
        </View>)}
        {!view.rules.length && <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}><Text style={t.meta}>No team rules yet. {NEW_NAME} learns from where each team's work went; add a rule to fix one.</Text></View>}
        {/* Three native rows, never one row of nested fields: a select squeezed beside an input cuts "Pick a project". */}
        <SettingsRow label="Add a rule" hint="A Linear team's key, like ACME.">
          <TeamInput theme={theme} compact={compact} value={team} onChange={setTeam} />
        </SettingsRow>
        <SettingsSelect label="Its project" value={project} options={[{ value: PICK, label: "Pick a project" }, ...projectOptions]} onValueChange={setProject} />
        <SettingsAction label={!key ? "Type a team key and pick its project" : project === PICK ? `Pick ${key}'s project` : `${key} issues → ${projectOptions.find(o => o.value === project)?.label ?? project}`}
          actionLabel="Add rule" disabled={!key || project === PICK || change.isPending} onPress={add} />
      </SettingsCard>
      {learnedTeams(view).map(l => <SettingsCard key={l.team}>
        <SettingsAction label={`${l.team} → ${l.project}`} hint={`Learned: ${l.count} ${l.team} workspaces started there.`} actionLabel="Make it a rule" disabled={change.isPending}
          onPress={() => change.mutate({ rules: { [l.team]: l.projectId } })} />
      </SettingsCard>)}
    </>}
  </SettingsSection>;
}

function TeamInput({ theme, compact, value, onChange }: { theme: Theme; compact: boolean; value: string; onChange: (v: string) => void }) {
  const c = theme.colors; const [focused, setFocused] = useState(false);
  return <TextInput value={value} onChangeText={onChange} placeholder="Team key" placeholderTextColor={c.foregroundMuted} accessibilityLabel="Team key" autoCapitalize="characters" autoCorrect={false}
    onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
    style={{ minWidth: 120, minHeight: compact ? 44 : 32, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: focused ? c.accent : c.border, color: c.foreground, backgroundColor: c.surface0, fontSize: compact ? 15 : 13, ...focusRing(c, false) }} />;
}

/** The base a new worktree starts from, per project; empty is the repository's default branch. */
function BasesSection({ theme, compact }: { theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const query = useNewSettings(); const change = useSettingsChange();
  const view = query.data;
  if (!view) return null;
  const worktrees = view.projects.filter(p => p.worktree);
  return <SettingsSection title="Bases" info="The branch a new worktree starts from. Empty: the repository's default branch. The dialog can change it for one start; that saves it here too.">
    <SettingsCard>
      {worktrees.map(p => <BaseRow key={p.id} theme={theme} compact={compact} name={p.name} saved={view.bases.find(b => b.projectId === p.id)?.base ?? ""} busy={change.isPending}
        onSave={(base, done) => change.mutate({ bases: { [p.id]: base || null } }, { onSuccess: done })} />)}
      {!worktrees.length && <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}><Text style={t.meta}>{`No project here is a git repository, so ${NEW_NAME} opens work in place.`}</Text></View>}
    </SettingsCard>
  </SettingsSection>;
}

function BaseRow({ theme, compact, name, saved, busy, onSave }: { theme: Theme; compact: boolean; name: string; saved: string; busy: boolean; onSave: (base: string, done: () => void) => void }) {
  const c = theme.colors;
  const [draft, setDraft] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const value = draft ?? saved;
  const dirty = draft !== null && draft.trim() !== saved;
  // The draft stays until the save lands: a failed save keeps what was typed.
  const save = () => { if (dirty) onSave(draft!.trim(), () => setDraft(null)); else setDraft(null); };
  return <SettingsRow label={name}>
    <SubmitScope enabled={dirty && !busy} onSubmit={save} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <TextInput value={value} onChangeText={setDraft} placeholder="Repository default" placeholderTextColor={c.foregroundMuted} accessibilityLabel={`Base for ${name}`} autoCapitalize="none" autoCorrect={false}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onSubmitEditing={save}
        style={{ minWidth: compact ? 140 : 180, minHeight: compact ? 44 : 32, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: focused ? c.accent : c.border, color: c.foreground, backgroundColor: c.surface0, fontSize: compact ? 15 : 13, fontFamily: "ui-monospace, Menlo, monospace" }} />
      {dirty && <Button theme={theme} compact={compact} kind="primary" shortcut title="Save" disabled={busy} onPress={save} />}
    </SubmitScope>
  </SettingsRow>;
}
