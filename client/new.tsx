import { PriorityLine } from "./home-chrome";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Platform, View, useWindowDimensions, type ViewStyle } from "react-native";
import { Pressable, Text } from "./text";
import { useRpc, type PluginHostProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { ScrollView } from "./keyboard";
import { Field as TextField } from "./field";
import { AttachImageButton, ImageField, useImageAttachments, type ImageAttachments } from "./image-attach";
import { imagesWord } from "../shared/images";
import { agentSettingsRpc, dispatchPreviewRpc, dispatchRecordsRpc, dispatchRpc, dispatchSettingsRpc, dispatchSourcesRpc, dispatchUndoRpc, setDispatchSettingsRpc } from "../shared/contracts";
import type { ActionAgent, DispatchPlan, DispatchRecord, DispatchSources } from "../shared/dispatch";
import type { Catalog } from "../shared/agent-settings";
import { isMac } from "../shared/search-key";
import {
  actionBar, dispatchSteps, homeRecords, kindIcon, moveSelection, newKey, newRows, recordLine, rowSource, sourceLine, targetLine,
  UNDO_MINUTES, type NewRow, type Step,
  ambiguousNote, failureRemedy,
} from "../shared/new-view";
import { errorText, useNow } from "./kit";
import { ActionRow, BarBtn, Choices, focusRing } from "./action-row";
import { Spinner } from "./motion";
import { pushToast } from "./toast-store";
import { tint, withAlpha, type Colors, type Theme } from "./theme";
import { createHostSlot } from "./host-slot";
import { NEW_NAME, NEW_OF, NEW_WORK } from "../shared/new-name";

/**
 * New (docs/dispatch.md): start work from a Linear issue, a GitHub issue or PR, a link or a sentence. One dialog over
 * everything on desktop (the sources on the left, everything about the chosen one on the right, the action bar across
 * the bottom), two screens on a phone (the list with the bar in thumb reach, then the preview). Opened from Home's
 * + New, the sidebar's New row, ⌘K and the New-from-anywhere key, all through `openNew` (one surface, one path).
 * new-reads-nothing-while-closed: nothing here runs until it opens; open, it reads the list once and a preview per
 * selection, and polls one record only while a dispatch is starting.
 */

// ---------- the request (new-opens-where-you-are: the host on screen shows it, client/host-slot.tsx) ----------

export type NewRequest = { source?: string };
const slot = createHostSlot<NewRequest>();
/**
 * Opens New on the Home on screen. With none on screen (a chat in front, or only a Home Paseo keeps mounted behind),
 * the request is kept and `navigate` (default: the fallback) opens Home; its host shows it. Home passes
 * `navigate: null` for the `new` param it was opened with, so a request never navigates twice.
 */
export const openNew = (request: NewRequest = {}, opts?: { navigate?: ((r: NewRequest) => void) | null }) => slot.open(request, opts);
/** index.client.tsx: how to reach a host when none is on screen. */
export const setNewFallback = (open: ((r: NewRequest) => void) | null) => slot.setFallback(open);
export const closeNew = () => slot.close();
/** Test seam. */
export const newRequestNow = () => slot.now();
/** Whether New is on screen now: the New key closes it only then, else it opens New where the developer is. */
export const newShowing = () => slot.showing();
/** Whether New is open (the sidebar row's active state, the key toggling it). */
export const useNewOpen = () => slot.useOpen();
/** Whether a request is open, without subscribing (toasts that New would cover). */
const newIsOpen = () => !!slot.now();

// ---------- small pieces ----------

/** The ambiguous note's project chips before "Other…" opens the full list. */
const CHOICES_SHOWN = 4;

const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, SFMono-Regular, Menlo, monospace" });
type Hover = { hovered?: boolean; pressed?: boolean; focused?: boolean };

function Kbd({ label, c }: { label: string; c: Colors }) {
  if (Platform.OS !== "web") return null;
  return <View accessibilityElementsHidden importantForAccessibility="no" style={{ borderWidth: 1, borderColor: c.border, borderRadius: 4, paddingHorizontal: 4, minWidth: 18, alignItems: "center" }}>
    <Text style={{ color: c.foregroundMuted, fontSize: 11, lineHeight: 16, fontFamily: Platform.OS === "web" ? "system-ui, -apple-system, sans-serif" : undefined }}>{label}</Text>
  </View>;
}

/**
 * A value chip: tapping opens its choices (a trailing ▾), or, with `choice`, commits at once (no ▾: it's a choice, not
 * a menu). A guess is dashed in the muted foreground, which keeps 3:1 against the surface in both themes.
 */
function Chip({ label, icon, onPress, c, compact, dashed, mono, accessibilityLabel, open, choice, tag }: { label: string; icon?: string; onPress?: () => void; c: Colors; compact: boolean; dashed?: boolean; mono?: boolean; accessibilityLabel: string; open?: boolean; choice?: boolean; tag?: string }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={choice ? {} : { expanded: !!open }} disabled={!onPress} onPress={onPress}
    style={(s: Hover & { focused?: boolean }) => ({ flexDirection: "row", alignItems: "center", gap: 6, minHeight: compact ? 44 : 30, paddingHorizontal: 10, borderRadius: 6, borderWidth: 1,
      borderStyle: dashed ? "dashed" : "solid", borderColor: open ? c.accent : dashed ? c.foregroundMuted : c.border, backgroundColor: s.pressed ? c.surface2 : s.hovered ? c.surface1 : c.surface0, alignSelf: "flex-start", maxWidth: "100%", ...focusRing(c, s.focused) })}>
    {icon && <Icon name={icon} size={14} color={c.foregroundMuted} />}
    <Text numberOfLines={1} style={{ color: c.foreground, fontSize: compact ? 14 : 13, flexShrink: 1, ...(mono ? { fontFamily: MONO, fontSize: 12 } : {}) }}>{label}</Text>
    {tag && <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 11 }}>{tag}</Text>}
    {onPress && !choice && <Icon name="ChevronDown" size={13} color={c.foregroundMuted} />}
  </Pressable>;
}

function EditLine({ value, onDone, c, compact, mono, label }: { value: string; onDone: (next: string | null) => void; c: Colors; compact: boolean; mono?: boolean; label: string }) {
  const [text, setText] = useState(value);
  return <TextField autoFocus value={text} onChangeText={setText} accessibilityLabel={label} onSubmitEditing={() => onDone(text.trim() || null)} onBlur={() => onDone(text.trim() || null)}
    blurOnSubmit selectTextOnFocus
    style={{ minHeight: compact ? 44 : 30, borderWidth: 1, borderColor: c.accent, borderRadius: 6, paddingHorizontal: 8, color: c.foreground, backgroundColor: c.surface0, fontSize: mono ? 12 : compact ? 14 : 13, fontFamily: mono ? MONO : undefined, flex: 1 }} />;
}

/** A grid row of the preview: the label column, then the value and its reason. */
function Field({ label, children, c, compact, reason }: { label: string; children: ReactNode; c: Colors; compact: boolean; reason?: ReactNode }) {
  return <View style={compact ? { gap: 6 } : { flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
    <Text style={{ color: c.foregroundMuted, fontSize: compact ? 13 : 13, width: compact ? undefined : 120, paddingTop: compact ? 0 : 6, fontWeight: compact ? "600" : "400" }}>{label}</Text>
    <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>{children}{!compact && reason}</View>
      {compact && reason}
    </View>
  </View>;
}

// ---------- the preview (right pane on desktop, the second screen on a phone) ----------

type Overrides = { projectId?: string; base?: string; branch?: string; title?: string; workspace?: "worktree" | "local"; agent?: ActionAgent; note?: string };
type Open = null | "project" | "base" | "workspace" | "branch" | "title" | "agent" | "note";

/** `images`: how many pasted images go with the words, so what is sent is on screen before the click. */
function SourceCard({ plan, c, compact, images = 0 }: { plan: DispatchPlan; c: Colors; compact: boolean; images?: number }) {
  const s = plan.source;
  const body = s.kind === "text" ? "" : s.body.replace(/\s+/g, " ").trim();
  return <View style={{ borderWidth: 1, borderColor: c.border, borderRadius: 10, padding: compact ? 14 : 14, gap: 6, backgroundColor: c.surface1 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <Icon name={kindIcon(s.kind)} size={14} color={c.foregroundMuted} />
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{sourceLine(s)}{images ? ` · ${imagesWord(images)}` : ""}</Text>
      {s.state && <View style={{ paddingHorizontal: 6, borderRadius: 4, backgroundColor: tint(c.statusWarning, c) }}><Text style={{ color: c.foreground, fontSize: 12 }}>{s.state}</Text></View>}
      {s.team && <View style={{ paddingHorizontal: 6, borderRadius: 4, backgroundColor: c.surface2 }}><Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Team {s.team}</Text></View>}
    </View>
    <Text accessibilityRole="header" numberOfLines={3} style={{ color: c.foreground, fontSize: compact ? 16 : 15, lineHeight: compact ? 22 : 21, fontWeight: "600" }}>{s.kind === "text" ? s.body || s.title : s.title}</Text>
    {!!body && <Text numberOfLines={2} style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 18 }}>{body}</Text>}
    {!s.read && s.kind === "linear" && <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Linear couldn't be read: the agent gets the key and link and reads it itself.</Text>}
  </View>;
}

function agentText(plan: DispatchPlan): string {
  const p = plan.agentPick.picked;
  return p?.mode ? `${plan.agent} · ${p.mode}` : plan.agent || `${NEW_OF} default agent`;
}

function Preview({ plan, overrides, setOverrides, c, compact, busy, catalog, loadCatalog, projects, loadProjects, saveBase, instructions, setInstructions, reopen, img }: {
  /** The dialog's pasted images: a paste or drop on the note adds them too (shown here on a phone, under the task field on desktop). */
  img: ImageAttachments;
  plan: DispatchPlan; overrides: Overrides; setOverrides: (o: Overrides) => void; c: Colors; compact: boolean; busy: boolean;
  catalog: Catalog | null; loadCatalog: () => void; projects: { id: string; name: string }[] | null; loadProjects: () => void; saveBase: (projectId: string, base: string) => void;
  instructions: boolean; setInstructions: (v: boolean) => void; reopen?: "agent" | "base" | null;
}) {
  const [open, setOpen] = useState<Open>(reopen ?? null);
  useEffect(() => { if (reopen === "agent") loadCatalog(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (o: Open) => setOpen(v => v === o ? null : o);
  const set = (o: Overrides) => setOverrides({ ...overrides, ...o });
  const pr = plan.source.kind === "pr";
  const ambiguous = plan.where.how === "ambiguous";
  const { ask: askLine, note: noteLine } = ambiguousNote(plan.source.team, plan.where.reason);
  const candidates = (projects ?? plan.where.candidates.map(x => ({ id: x.id, name: x.name }))).map(p => ({ id: p.id, label: p.name, on: p.id === plan.where.projectId, hint: plan.where.candidates.find(x => x.id === p.id)?.lastUsed ? "last used" : undefined }));
  const provider = catalog?.providers.find(p => p.id === (overrides.agent?.provider ?? plan.agentPick.picked?.provider));
  return <View style={{ gap: compact ? 16 : 14, opacity: busy ? 0.6 : 1 }} pointerEvents={busy ? "none" : "auto"}>
    <SourceCard plan={plan} c={c} compact={compact} images={img.images.length} />
    {plan.existing && <View accessibilityRole="alert" style={{ flexDirection: "row", gap: 10, padding: 12, borderRadius: 8, backgroundColor: c.surface2 }}>
      <Icon name="ExternalLink" size={16} color={c.foreground} />
      <View style={{ flex: 1 }}>
        <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "600" }}>{plan.source.key ?? "This"} already has a workspace: {plan.existing.title}</Text>
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Open it to carry on there, or start another workspace below.</Text>
      </View>
    </View>}
    {ambiguous ? <View style={{ gap: 8, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: withAlpha(c.statusWarning, 0.5), backgroundColor: tint(c.statusWarning, c) }}>
      <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "600" }}>{askLine}</Text>
      {!!noteLine && <Text style={{ color: c.foreground, fontSize: 12 }}>{noteLine}</Text>}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {plan.where.candidates.slice(0, CHOICES_SHOWN).map(p => <Chip key={p.id} c={c} compact={compact} icon="Folder" choice label={p.name} tag={p.lastUsed ? "last used" : undefined} accessibilityLabel={`Start in ${p.name}`} onPress={() => set({ projectId: p.id })} />)}
        {plan.where.candidates.length > CHOICES_SHOWN && <Chip c={c} compact={compact} label="Other…" open={open === "project"} accessibilityLabel="Another project" onPress={() => { loadProjects(); toggle("project"); }} />}
      </View>
    </View>
      : <Field c={c} compact={compact} label="Project" reason={<Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{plan.where.guess ? "Guess: last used project" : plan.where.how === "picked" && plan.source.team ? `Saved for ${plan.source.team} · change it in Settings → ${NEW_WORK}` : plan.where.reason}</Text>}>
        <Chip c={c} compact={compact} icon="Folder" label={plan.where.projectName ?? "Pick"} dashed={plan.where.guess} open={open === "project"} accessibilityLabel={`Project: ${plan.where.projectName}. Change`} onPress={() => { loadProjects(); toggle("project"); }} />
      </Field>}
    {open === "project" && <Choices c={c} compact={compact} items={candidates} onPick={id => { set({ projectId: id }); setOpen(null); }} />}
    {ambiguous ? <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>From, branch and agent fill in once you pick a project.</Text> : <View style={{ gap: compact ? 16 : 14 }}>
      {plan.base && <Field c={c} compact={compact} label="From" reason={<Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{plan.base.reason}</Text>}>
        {open === "base" ? <EditLine c={c} compact={compact} label="Base branch" value={plan.base.name} onDone={v => { setOpen(null); if (v && v !== plan.base?.name) { set({ base: v }); if (plan.where.projectId) saveBase(plan.where.projectId, v); } }} />
          : <Chip c={c} compact={compact} label={plan.base.name} icon="GitBranch" accessibilityLabel={`Base branch ${plan.base.name}. Change`} onPress={() => toggle("base")} />}
      </Field>}
      {!pr && <Field c={c} compact={compact} label="Workspace">
        <Chip c={c} compact={compact} icon={plan.workspace === "local" ? "Folder" : "GitFork"} label={plan.workspace === "local" ? "Project directory" : "New worktree"} open={open === "workspace"} accessibilityLabel="Workspace. Change" onPress={() => toggle("workspace")} />
      </Field>}
      {open === "workspace" && <Choices c={c} compact={compact} items={[{ id: "worktree" as const, label: "New worktree", hint: "its own branch and folder", on: plan.workspace === "worktree" }, { id: "local" as const, label: "Project directory", hint: "work in the checkout itself", on: plan.workspace === "local" }]} onPick={id => { set({ workspace: id }); setOpen(null); }} />}
      {plan.branch && <Field c={c} compact={compact} label="Branch">
        {open === "branch" ? <EditLine c={c} compact={compact} mono label="Branch" value={plan.branch} onDone={v => { setOpen(null); if (v && v !== plan.branch) set({ branch: v }); }} />
          : <Pressable accessibilityRole="button" accessibilityLabel={`Branch ${plan.branch}. Edit`} onPress={() => toggle("branch")} style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: compact ? 44 : 30, flexShrink: 1 }}>
            <Text numberOfLines={1} style={{ color: c.foreground, fontFamily: MONO, fontSize: 12, flexShrink: 1 }}>{plan.branch}</Text><Icon name="Pencil" size={13} color={c.foregroundMuted} />
          </Pressable>}
      </Field>}
      <Field c={c} compact={compact} label="Title">
        {open === "title" ? <EditLine c={c} compact={compact} label="Title" value={plan.title} onDone={v => { setOpen(null); if (v && v !== plan.title) set({ title: v }); }} />
          : <Pressable accessibilityRole="button" accessibilityLabel={`Title ${plan.title}. Edit`} onPress={() => toggle("title")} style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: compact ? 44 : 30, flexShrink: 1 }}>
            <Text numberOfLines={1} style={{ color: c.foreground, fontSize: compact ? 14 : 13, flexShrink: 1 }}>{plan.title}</Text><Icon name="Pencil" size={13} color={c.foregroundMuted} />
          </Pressable>}
      </Field>
      <Field c={c} compact={compact} label="Agent" reason={<Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{plan.agentPick.isDefault ? "Follow-up's default" : "For this one"}</Text>}>
        <Chip c={c} compact={compact} icon="Bot" label={agentText(plan)} open={open === "agent"} accessibilityLabel={`Agent ${agentText(plan)}. Change`} onPress={() => { loadCatalog(); toggle("agent"); }} />
      </Field>
      {open === "agent" && (!catalog ? <View style={{ padding: 10 }}><Spinner color={c.foregroundMuted} size={14} label="Loading agents" /></View> : <View style={{ gap: 6 }}>
        <Choices c={c} compact={compact} items={catalog.providers.filter(p => p.available).map(p => ({ id: p.id, label: p.label, on: p.id === provider?.id }))} onPick={id => set({ agent: { provider: id } })} />
        {provider && provider.models.length > 0 && <Choices c={c} compact={compact} items={provider.models.map(m => ({ id: m.id, label: m.label, on: m.id === (overrides.agent?.model ?? plan.agentPick.picked?.model) }))} onPick={id => set({ agent: { ...overrides.agent, provider: provider.id, model: id } })} />}
        {provider && provider.modes.length > 0 && <Choices c={c} compact={compact} items={provider.modes.map(m => ({ id: m.id, label: m.label, on: m.id === (overrides.agent?.mode ?? plan.agentPick.picked?.mode) }))} onPick={id => { set({ agent: { ...overrides.agent, provider: provider.id, mode: id } }); setOpen(null); }} />}
      </View>)}
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: instructions }} accessibilityLabel={instructions ? "Hide instructions" : "Show instructions"} onPress={() => setInstructions(!instructions)}
        style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44 }}>
        <Icon name={instructions ? "ChevronDown" : "ChevronRight"} size={15} color={c.foreground} />
        <Text style={{ color: c.foreground, fontSize: compact ? 14 : 13, fontWeight: "500" }}>{instructions ? "Hide instructions" : "Show instructions"}</Text>
        {!compact && <Text style={{ color: c.foregroundMuted, fontSize: 12, flex: 1 }}>what the agent gets as its first message</Text>}
        {!compact && <Kbd c={c} label={isMac() ? "⌘I" : "Ctrl I"} />}
      </Pressable>
      {instructions && <View style={{ borderRadius: 8, backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border, padding: 12, gap: 8 }}>
        {/* Its own scroll past ~16 lines, so opening it always shows the start and the pane scrolls to it (NewDialog). */}
        <ScrollView style={{ maxHeight: compact ? 320 : 280 }} nestedScrollEnabled>
          <Text selectable style={{ color: c.foreground, fontSize: 12, lineHeight: 18, fontFamily: MONO }}>{plan.instructions}</Text>
        </ScrollView>
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Follow-up then adds its usual workspace instructions.</Text>
      </View>}
      {open === "note" || overrides.note ? <ImageField model={img} theme={{ colors: c }} compact={compact} row={compact}><TextField multiline autoFocus={open === "note"} value={overrides.note ?? ""} onChangeText={note => set({ note })} placeholder="A note for the agent" placeholderTextColor={c.foregroundMuted} accessibilityLabel="Note for the agent"
        style={{ minHeight: 64, borderWidth: 1, borderColor: c.border, borderRadius: 8, padding: 10, color: c.foreground, backgroundColor: c.surface0, fontSize: 13, textAlignVertical: "top" }} /></ImageField>
        : <Pressable accessibilityRole="button" accessibilityLabel="Add a note for the agent" onPress={() => setOpen("note")} style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44 }}>
          <Icon name="Plus" size={15} color={c.foregroundMuted} />
          <Text style={{ color: c.foreground, fontSize: compact ? 14 : 13 }}>Add a note for the agent</Text>
          {!compact && <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>goes after the action's instructions</Text>}
        </Pressable>}
    </View>}
  </View>;
}

// ---------- a dispatch in progress, created, failed ----------

function StepList({ steps, c }: { steps: Step[]; c: Colors }) {
  return <View style={{ gap: 10 }}>
    {steps.map(s => <View key={s.label} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
      {s.state === "active" ? <Spinner color={c.foreground} size={14} label={s.label} />
        : <Icon name={s.state === "done" ? "CircleCheck" : s.state === "failed" ? "TriangleAlert" : "Circle"} size={16} color={s.state === "done" ? c.statusSuccess : s.state === "failed" ? c.statusWarning : c.foregroundMuted} />}
      <Text style={{ color: s.state === "waiting" || s.state === "skipped" ? c.foregroundMuted : c.foreground, fontSize: 13 }}>{s.label}</Text>
    </View>)}
  </View>;
}

function RecordPane({ record, c, compact, now }: { record: DispatchRecord; c: Colors; compact: boolean; now: number }) {
  const steps = dispatchSteps(record);
  if (record.state === "created") {
    const { minutesLeft, undo } = recordLine(record, now);
    return <View accessibilityRole="alert" style={{ gap: 12, padding: 16, borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Icon name="CircleCheck" size={20} color={c.statusSuccess} />
        <Text style={{ color: c.foreground, fontSize: compact ? 16 : 15, fontWeight: "600", flex: 1 }}>Started {record.title}</Text>
      </View>
      <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>{record.actionName} in {record.projectName}{record.branch ? ` on ${record.branch}` : ""}. {undo ? `Undo archives the workspace; it's offered for ${minutesLeft} more minute${minutesLeft === 1 ? "" : "s"}.` : ""}</Text>
      <StepList steps={steps} c={c} />
    </View>;
  }
  if (record.state === "failed") return <View accessibilityRole="alert" style={{ gap: 10, padding: 16, borderRadius: 10, borderWidth: 1, borderColor: withAlpha(c.statusWarning, 0.55), backgroundColor: tint(c.statusWarning, c) }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
      <Icon name="TriangleAlert" size={18} color={c.statusWarning} />
      <Text style={{ color: c.foreground, fontSize: 15, fontWeight: "600", flex: 1 }}>{record.title} didn't start</Text>
    </View>
    <Text selectable style={{ color: c.foreground, fontSize: 13 }}>{record.error}</Text>
    {record.leftBehind && <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "600" }}>{record.leftBehind}</Text>}
    <StepList steps={steps} c={c} />
  </View>;
  return <View style={{ gap: 14, padding: 16, borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }}>
    <Text style={{ color: c.foreground, fontSize: 15, fontWeight: "600" }}>Starting {record.title}</Text>
    <StepList steps={steps} c={c} />
    <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{record.state === "queued" && record.error ? "Paseo can't be reached; Follow-up retries until it can. " : ""}You can close this; Follow-up finishes it.</Text>
  </View>;
}

// ---------- the list ----------

function ListRow({ row, selected, c, compact, onPress, chevron }: { row: NewRow; selected: boolean; c: Colors; compact: boolean; onPress: () => void; chevron: boolean }) {
  const base = (s: Hover): ViewStyle => ({ flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: compact ? 12 : 9, paddingHorizontal: compact ? 16 : 12, borderLeftWidth: 2,
    borderLeftColor: selected ? c.foreground : "transparent", backgroundColor: selected ? c.surface2 : s.hovered ? c.surface1 : "transparent", borderRadius: compact ? 0 : 6, minHeight: compact ? 56 : 0 });
  if (row.kind === "search") return <Pressable accessibilityRole="button" accessibilityLabel={`Search all of Linear for ${row.query}`} onPress={onPress} style={base}>
    <Icon name="Search" size={15} color={c.foregroundMuted} />
    <Text numberOfLines={1} style={{ color: c.foreground, fontSize: compact ? 14 : 13, flex: 1 }}>Search all of Linear for “{row.query}”</Text>
  </Pressable>;
  if (row.kind === "words") return <Pressable accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={`Start from your words: ${row.title}`} onPress={onPress} style={base}>
    <Icon name="Type" size={15} color={c.foregroundMuted} />
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text numberOfLines={1} style={{ color: c.foreground, fontSize: compact ? 15 : 13 }}>Start from your words</Text>
      <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12 }}>{row.title}</Text>
    </View>
    {chevron && <Icon name="ChevronRight" size={16} color={c.foregroundMuted} />}
  </Pressable>;
  if (row.kind === "pasted") return <Pressable accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={`Pasted: ${row.title}`} onPress={onPress} style={base}>
    <Icon name={row.icon} size={15} color={c.foregroundMuted} />
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text numberOfLines={1} style={{ color: c.foreground, fontSize: compact ? 15 : 13 }}>{row.title}</Text>
      <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12 }}>Pasted</Text>
    </View>
    {chevron && <Icon name="ChevronRight" size={16} color={c.foregroundMuted} />}
  </Pressable>;
  // a-taken-issue-is-not-a-suggestion: the issues a live workspace already has, folded into one quiet last row.
  if (row.kind === "fold") return <Pressable accessibilityRole="button" accessibilityState={{ expanded: row.open, selected }} accessibilityLabel={`${row.title}. ${row.open ? "Hide them" : "Show them"}`} onPress={onPress}
    style={(s: Hover) => ({ ...base(s), alignItems: "center", marginTop: compact ? 0 : 6 })}>
    <Icon name={row.open ? "ChevronDown" : "ChevronRight"} size={15} color={c.foregroundMuted} />
    <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: compact ? 14 : 12, flex: 1 }}>{row.title}</Text>
  </Pressable>;
  const routeColor = row.route.tone === "warn" ? c.statusWarning : row.route.tone === "open" && !row.taken ? c.foreground : c.foregroundMuted;
  // A taken issue (inside the open fold) is muted: it's somebody's work already, and ↵ opens its workspace.
  const ink = row.taken && !selected ? c.foregroundMuted : c.foreground;
  const meta = [row.state, row.age].filter(Boolean).join(" · ");
  return <Pressable accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={`${row.key} ${row.title}, ${row.reason ? `${row.reason}, from Compass, ` : ""}${row.state ? `${row.state}, ` : ""}${row.taken ? `already in ${row.route.text}` : row.route.text}`} onPress={onPress} style={base}>
    <View style={{ paddingTop: 2 }}><Icon name={row.icon} size={15} color={row.icon === "Contrast" && !row.taken ? c.statusWarning : c.foregroundMuted} /></View>
    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
      <Text numberOfLines={compact ? 2 : 1} style={{ color: ink, fontSize: compact ? 15 : 13 }}><Text style={{ color: c.foregroundMuted }}>{row.key}  </Text>{row.title}</Text>
      {/* A Compass suggestion says why it's on top, as Home's rows do (the reason line with its source). */}
      {!!row.reason && <PriorityLine reason={row.reason} source={{ kind: "compass", label: "Compass" }} c={c} size={12} lines={compact ? 2 : 1} />}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
        {!!meta && <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{meta} · </Text>}
        {row.route.tone === "open" && <Icon name="ExternalLink" size={12} color={routeColor} />}
        <Text numberOfLines={1} style={{ color: routeColor, fontSize: 12, flexShrink: 1 }}>{row.route.text}</Text>
        {row.tag && <Text style={{ color: c.foregroundMuted, fontSize: 12 }}> · {row.tag}</Text>}
      </View>
    </View>
    {chevron && <Icon name="ChevronRight" size={16} color={c.foregroundMuted} />}
  </Pressable>;
}

/** Task field heights: a real task fits, and it grows with what's written up to `max`, then scrolls. */
/** What the field takes, under it while empty; the phone's fits one line at 390. */
const FIELD_HINT = { desktop: "A Linear key or link, a GitHub issue or PR, any link, or a sentence", phone: "A Linear key, an issue or PR, a link or a sentence" };
const FIELD_LINES = { desktop: { min: 96, max: 176 }, phone: { min: 88, max: 160 } };
/**
 * The task field, Dispatch's main element (2026-11-25, the developer: "the main text area … should be bigger … centered
 * at the top"): multi-line, wide, growing with the words. Desktop: across the top of the dialog, centred, above the
 * list and the preview. Phones: the top of the list screen. Enter still starts the selected action on desktop (the
 * dialog's key listener); pasted text keeps its lines.
 */
function TaskField({ query, setQuery, img, c, compact }: { query: string; setQuery: (q: string) => void; img: ImageAttachments; c: Colors; compact: boolean }) {
  // The field opens focused (desktop) and says so: an accent border while it has focus.
  const [focused, setFocused] = useState(false);
  const size = compact ? FIELD_LINES.phone : FIELD_LINES.desktop;
  const [height, setHeight] = useState(size.min);
  const fit = (h: number) => setHeight(Math.max(size.min, Math.min(size.max, Math.ceil(h))));
  // Web: react-native-web reports no content size for a textarea, so measure it after each change (shrink to fit, read
  // its scroll height). Native: onContentSizeChange below.
  const input = useRef<unknown>(null);
  useLayoutEffect(() => {
    const el = input.current as { style?: { height: string }; scrollHeight?: number } | null;
    if (Platform.OS !== "web" || !el?.style || el.scrollHeight === undefined) return;
    const was = el.style.height; el.style.height = "0px"; const h = el.scrollHeight; el.style.height = was;
    fit(h);
  }, [query, compact]); // eslint-disable-line react-hooks/exhaustive-deps
  return <ImageField model={img} theme={{ colors: c }} compact={compact} attach="inline">
    <View style={{ borderWidth: focused ? 2 : 1, borderColor: focused ? c.accent : c.border, borderRadius: 10, padding: focused ? 0 : 1, backgroundColor: c.surface0 }}>
      <TextField ref={input as never} nativeID="follow-up-new-field" value={query} onChangeText={setQuery} autoFocus={!compact} multiline placeholder="Describe the task, or paste a link" placeholderTextColor={c.foregroundMuted}
        accessibilityLabel="Task" accessibilityHint={FIELD_HINT.desktop} autoCorrect={false} autoCapitalize="none" blurOnSubmit={false} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        onContentSizeChange={e => { if (Platform.OS !== "web") fit(e.nativeEvent.contentSize.height + 16); }}
        style={{ height, color: c.foreground, fontSize: compact ? 16 : 15, lineHeight: 22, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 4, textAlignVertical: "top", ...(Platform.OS === "web" ? { outlineStyle: "none", resize: "none" } as object : {}) }} />
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 4, paddingHorizontal: 6, paddingBottom: 6, minHeight: compact ? 44 : 32 }}>
        <Text numberOfLines={1} style={{ flex: 1, color: c.foregroundMuted, fontSize: 12, paddingLeft: 8 }}>{query ? (compact ? "" : "⇧↵ new line") : FIELD_HINT[compact ? "phone" : "desktop"]}</Text>
        {/* After ⌘V, the field's own paste hint, so the chip never reads as this button's key. */}
        {!compact && !query && <Kbd c={c} label={isMac() ? "⌘V" : "Ctrl V"} />}
        <AttachImageButton model={img} theme={{ colors: c }} compact={compact} />
        {!!query && <Pressable accessibilityRole="button" accessibilityLabel="Clear" onPress={() => setQuery("")} style={{ width: compact ? 44 : 32, height: compact ? 44 : 32, alignItems: "center", justifyContent: "center" }}><Icon name="X" size={14} color={c.foregroundMuted} /></Pressable>}
      </View>
    </View>
  </ImageField>;
}

function SourcesPane({ sources, rows, selected, query, setQuery, onRow, onRefresh, c, compact, error, searching, chevrons, empty, img, field = true }: {
  /** False on desktop, where the task field sits across the top of the dialog instead. */
  field?: boolean;
  /** The dialog's pasted images: a paste or drop on the task field adds them; their thumbnails show under it. */
  img: ImageAttachments;
  sources: DispatchSources | null; rows: NewRow[]; selected: string | null; query: string; setQuery: (q: string) => void; onRow: (row: NewRow) => void; onRefresh: () => void; empty: string | null;
  c: Colors; compact: boolean; error: string | null; searching: string | null; chevrons: boolean;
}) {
  const status = sources?.linear.status;
  return <View style={{ flex: 1, minHeight: 0 }}>
    {field && <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 }}><TaskField query={query} setQuery={setQuery} img={img} c={c} compact={compact} /></View>}
    <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: compact ? 16 : 16, paddingVertical: 6, gap: 6 }}>
      <Text style={{ color: c.foregroundMuted, fontSize: compact ? 13 : 11, fontWeight: "600", letterSpacing: compact ? 0 : 0.5, textTransform: compact ? "none" : "uppercase" }}>{searching ? "Linear" : status === "missing" ? "Start from" : "My issues"}</Text>
      <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12, flex: 1 }}>{searching ? `· “${searching}”` : status === "missing" ? "· a link or your words" : compact ? "· Linear" : "· Linear · in progress and todo"}</Text>
      {status === "ok" && <Pressable accessibilityRole="button" accessibilityLabel="Read Linear again" hitSlop={8} onPress={onRefresh} style={{ width: compact ? 44 : 28, height: compact ? 44 : 28, alignItems: "center", justifyContent: "center" }}><Icon name="RefreshCw" size={14} color={c.foregroundMuted} /></Pressable>}
    </View>
    {!sources && !error ? <View style={{ padding: 16 }}><Spinner color={c.foregroundMuted} size={14} label="Reading your Linear issues" /></View>
      : <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: compact ? 0 : 8, paddingBottom: 12, gap: compact ? 0 : 2 }} keyboardShouldPersistTaps="handled">
        {(status === "error" || error) && <View accessibilityRole="alert" style={{ margin: compact ? 16 : 8, padding: 12, borderRadius: 8, backgroundColor: tint(c.statusWarning, c), gap: 8 }}>
          <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "600" }}>Couldn't read Linear</Text>
          <Text style={{ color: c.foreground, fontSize: 12 }}>{error ?? (sources?.linear.status === "error" ? sources.linear.error : "")} Paste a key or link to start from it anyway.</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Read Linear again" onPress={onRefresh} style={(s: Hover & { focused?: boolean }) => ({ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 6, minHeight: compact ? 44 : 32, minWidth: 44, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: s.hovered ? c.surface1 : c.surface0, ...focusRing(c, s.focused) })}>
            <Icon name="RefreshCw" size={14} color={c.foreground} /><Text style={{ color: c.foreground, fontSize: 13, fontWeight: "600" }}>Retry</Text>
          </Pressable>
        </View>}
        {status === "missing" && !query && <View style={{ paddingHorizontal: 16, paddingVertical: 8, gap: 6 }}>
          <Text style={{ color: c.foreground, fontSize: 13 }}>Start from a link or your words: paste a GitHub issue or PR link, or describe the task.</Text>
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Your Linear issues show here once Linear is connected in mcpproxy, as for the Summary.</Text>
        </View>}
        {!!empty && <Text style={{ color: c.foreground, fontSize: 13, paddingHorizontal: compact ? 16 : 12, paddingTop: 4, paddingBottom: 8 }}>{empty}</Text>}
        {rows.map((row, i) => <View key={row.id} style={compact && i ? { borderTopWidth: 1, borderTopColor: c.border, marginHorizontal: 16 } : undefined}>
          <View style={compact && i ? { marginHorizontal: -16 } : undefined}><ListRow row={row} selected={row.id === selected} c={c} compact={compact} chevron={chevrons} onPress={() => onRow(row)} /></View>
        </View>)}
        {status === "ok" && !rows.length && !query && <Text style={{ color: c.foregroundMuted, fontSize: 12, paddingHorizontal: 16, paddingVertical: 8 }}>No issues in progress or todo. Describe the task, or paste a link.</Text>}
        {!!sources?.recent.length && !query && <View style={{ paddingHorizontal: compact ? 16 : 8, paddingTop: 14, gap: 4 }}>
          <Text style={{ color: c.foregroundMuted, fontSize: compact ? 13 : 11, fontWeight: "600", letterSpacing: compact ? 0 : 0.5, textTransform: compact ? "none" : "uppercase" }}>Started from here</Text>
          {sources.recent.map(r => <Text key={r.id} numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12 }}>{r.title} · {r.actionName} · {r.state === "created" ? "started" : r.state}</Text>)}
        </View>}
      </ScrollView>}
  </View>;
}

/**
 * The fold selected (a-taken-issue-is-not-a-suggestion): what it holds and what ↵ does, never a blank pane. Each taken
 * issue names the workspace that has it; picking one there shows Open it.
 */
function TakenPane({ row, rows, c }: { row: Extract<NewRow, { kind: "fold" }>; rows: NewRow[]; c: Colors }) {
  return <View style={{ padding: 24, gap: 10 }}>
    <Text style={{ color: c.foreground, fontSize: 14, fontWeight: "600" }}>{row.title}</Text>
    <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>They're already being worked on, so {NEW_NAME} doesn't suggest them. Pick one to open its workspace.</Text>
    {row.open && <View style={{ gap: 4 }}>{rows.filter((r): r is Extract<NewRow, { kind: "issue" }> => r.kind === "issue" && r.taken).map(r =>
      <Text key={r.id} numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12 }}><Text style={{ color: c.foreground }}>{r.key}</Text>  {r.route.text}</Text>)}</View>}
    {Platform.OS === "web" && <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}><Kbd c={c} label="↵" /><Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{row.open ? "hides them" : "shows them"}</Text></View>}
  </View>;
}

// ---------- the dialog ----------

type DomKey = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; repeat: boolean; isComposing?: boolean; target: unknown; preventDefault(): void; stopPropagation(): void };
type Phase = { kind: "edit" } | { kind: "sending" } | { kind: "record"; id: string };

type Shown = { source: string; rowId: string | null; plan: DispatchPlan } | null;
/** The preview for the selected row: its own, or while its words change, the last one it had. */
export function steadyPlan(shown: Shown, source: string | null, rowId: string | null): DispatchPlan | null {
  if (!source || !shown) return null;
  return shown.source === source || (rowId !== null && shown.rowId === rowId) ? shown.plan : null;
}
/** A preview answer that says what's already on screen keeps the old object, so nothing below it re-renders. */
export function samePlan(prev: Shown, source: string, rowId: string | null, plan: DispatchPlan): Shown {
  if (prev && prev.rowId === rowId && JSON.stringify(prev.plan) === JSON.stringify(plan)) return prev.source === source ? prev : { ...prev, source };
  return { source, rowId, plan };
}
export function NewDialog({ request, theme, layout, navigation, onClose, openSettings }: { request: NewRequest; theme: Theme; layout: PluginHostProps["layout"]; navigation?: { openWorkspace(i: { workspaceId: string }): void }; onClose: () => void; openSettings?: () => void }) {
  const c = theme.colors; const compact = layout.compact;
  // The callers, kept in a ref: effects below must not re-run (and re-read) because a host hands out new functions.
  const calls = { readSources: useRpc(dispatchSourcesRpc), readPreview: useRpc(dispatchPreviewRpc), send: useRpc(dispatchRpc), readRecords: useRpc(dispatchRecordsRpc),
    undoRpc: useRpc(dispatchUndoRpc), readSettings: useRpc(dispatchSettingsRpc), writeSettings: useRpc(setDispatchSettingsRpc), readAgents: useRpc(agentSettingsRpc) };
  const rpcs = useRef(calls); rpcs.current = calls;
  const readSources = (i: Parameters<typeof calls.readSources>[0]) => rpcs.current.readSources(i);
  const readPreview = (i: Parameters<typeof calls.readPreview>[0]) => rpcs.current.readPreview(i);
  const send = (i: Parameters<typeof calls.send>[0]) => rpcs.current.send(i);
  const readRecords = (i: Parameters<typeof calls.readRecords>[0]) => rpcs.current.readRecords(i);
  const undoRpc = (i: Parameters<typeof calls.undoRpc>[0]) => rpcs.current.undoRpc(i);
  const readSettings = (i: Parameters<typeof calls.readSettings>[0]) => rpcs.current.readSettings(i);
  const writeSettings = (i: Parameters<typeof calls.writeSettings>[0]) => rpcs.current.writeSettings(i);
  const readAgents = (i: Parameters<typeof calls.readAgents>[0]) => rpcs.current.readAgents(i);
  const [sources, setSources] = useState<DispatchSources | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [query, setQuery] = useState(request.source ?? "");
  const [searched, setSearched] = useState<{ query: string; sources: DispatchSources } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Overrides>({});
  const [planFor, setPlanFor] = useState<{ source: string; rowId: string | null; plan: DispatchPlan } | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "edit" });
  const [record, setRecord] = useState<DispatchRecord | null>(null);
  const [instructions, setInstructions] = useState(false);
  // After a failure's remedy (Change agent / Change base), the preview opens with that field's choices showing.
  const [reopen, setReopen] = useState<"agent" | "base" | null>(null);
  // Opening the instructions brings them into view: they sit near the end of the preview, below the fold.
  const pane = useRef<{ scrollToEnd?(o: { animated: boolean }): void } | null>(null);
  useEffect(() => { if (!instructions) return; const t = setTimeout(() => pane.current?.scrollToEnd?.({ animated: true }), 60); return () => clearTimeout(t); }, [instructions]);
  const [more, setMore] = useState(false);
  const [screen, setScreen] = useState<"list" | "preview">("list");
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [projects, setProjects] = useState<{ id: string; name: string }[] | null>(null);
  const now = useNow(15_000);

  const load = (fresh = false) => {
    setListError(null);
    readSources(fresh ? { fresh: true } : {}).then(s => setSources(s as DispatchSources)).catch(e => setListError(errorText(e)));
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = searched && searched.query === query.trim() ? searched.sources : sources;
  const [foldOpen, setFoldOpen] = useState(false);
  const { rows, selected: preselected, empty } = useMemo(() => newRows(shown, query, now, foldOpen), [shown, query, now, foldOpen]);
  const selected = picked && rows.some(r => r.id === picked) ? picked : preselected;
  const row = rows.find(r => r.id === selected) ?? null;
  const source = rowSource(row);
  // A new row starts from its own defaults: the overrides belonged to the last one. Typing more words is the same row
  // (the preview stays steady), so a picked project, agent or note survives the next keystroke.
  const rowId = row?.id ?? null;
  useEffect(() => { setOverrides({}); setMore(false); setReopen(null); }, [rowId]);
  useEffect(() => { setPicked(null); }, [query]);

  // One preview per selection or change, the newest winning.
  const seq = useRef(0);
  useEffect(() => {
    if (!source) return;
    const n = ++seq.current;
    const t = setTimeout(() => {
      readPreview({ source, ...overrides, note: overrides.note || undefined }).then(p => { if (n === seq.current) { setPlanFor(prev => samePlan(prev, source, rowId, p as DispatchPlan)); setPlanError(null); } })
        .catch(e => { if (n === seq.current) setPlanError(errorText(e)); });
    }, planFor?.source === source || planFor?.rowId === rowId ? 150 : 0);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, JSON.stringify(overrides)]);
  // The preview on screen is the selected row's: another row's shows nothing until its own arrives, and the same row
  // keeps its last preview while the next one loads (typing never blanks it, preview-stays-while-typing).
  const planNow = steadyPlan(planFor, source, rowId);
  // Pasted images (every-agent-field-takes-images), one model for the task field and the note: they go with the new
  // agent's first message. Who takes them is the agent this dispatch starts (the Agent chip, else the action's).
  const imageProvider = overrides.agent?.provider ?? planNow?.agentPick.picked?.provider ?? null;
  const img = useImageAttachments({ target: imageProvider ? { kind: "provider", provider: imageProvider } : null });

  // While a dispatch starts: read its record each second (the dialog is open; Home's row takes over once it closes).
  // A fixed beat, not a chain: a read that fails or never answers mustn't end the polling. The newest answer wins.
  const polling = phase.kind === "record" && (!record || ["queued", "creating", "starting"].includes(record.state));
  const recordId = phase.kind === "record" ? phase.id : null;
  useEffect(() => {
    if (!polling || !recordId) return;
    let live = true; let asked = 0; let shown = 0;
    const t = setInterval(() => {
      const n = ++asked;
      readRecords({}).then(r => { const next = r.records.find(x => x.id === recordId); if (live && next && n > shown) { shown = n; setRecord(next); } }).catch(() => undefined);
    }, 1000);
    return () => { live = false; clearInterval(t); };
  }, [polling, recordId]); // eslint-disable-line react-hooks/exhaustive-deps

  const search = () => {
    const q = query.trim(); if (!q) return;
    readSources({ query: q }).then(s => { setSearched({ query: q, sources: s as DispatchSources }); }).catch(e => setListError(errorText(e)));
  };
  const start = async (actionId: string) => {
    if (!source || phase.kind !== "edit") return;
    setPhase({ kind: "sending" }); setMore(false);
    try {
      const images = img.uploads();
      const out = await send({ source, actionId, ...overrides, note: overrides.note || undefined, ...(images ? { images } : {}) }) as { dispatchId: string; record: DispatchRecord };
      setRecord(out.record); setPhase({ kind: "record", id: out.dispatchId }); img.clear();
    } catch (e) { setPhase({ kind: "edit" }); setPlanError(errorText(e)); }
  };
  const openWorkspace = (workspaceId: string) => { navigation?.openWorkspace({ workspaceId }); onClose(); };
  const undo = async () => {
    if (!record) return;
    try { const r = await undoRpc({ dispatchId: record.id }); setRecord(r); pushToast("success", `Undone: ${r.title}`); onClose(); }
    catch (e) { pushToast("error", errorText(e)); }
  };
  const another = () => { setPhase({ kind: "edit" }); setRecord(null); setQuery(""); img.clear(); setPicked(null); setScreen("list"); load(); };
  // An agent that can't take the pasted images: the actions wait, and the field says why (before Start, never after).
  const plainBar = actionBar(planNow);
  const bar = img.blocked && plainBar.kind === "actions" ? { ...plainBar, disabled: img.blocked } : plainBar;
  const created = phase.kind === "record" && record?.state === "created";
  const failed = phase.kind === "record" && record?.state === "failed";
  const remedy = failed && record ? failureRemedy(record) : null;
  const busy = phase.kind !== "edit";

  // Desktop keys: one capture listener while the dialog is open (web).
  const live = useRef({ rows, selected, bar, created, row, busy });
  live.current = { rows, selected, bar, created, row, busy };
  useEffect(() => {
    if (Platform.OS !== "web" || compact) return;
    const doc = (globalThis as { document?: { addEventListener(t: string, f: (e: DomKey) => void, cap: boolean): void; removeEventListener(t: string, f: (e: DomKey) => void, cap: boolean): void } }).document;
    if (!doc) return;
    const onKey = (e: DomKey) => {
      const t = e.target as { tagName?: string; id?: string } | null;
      const tag = (t?.tagName ?? "").toUpperCase();
      const editing = (tag === "TEXTAREA" || tag === "INPUT") && t?.id !== "follow-up-new-field";
      const field = t?.id === "follow-up-new-field" ? t as { value?: string } : null;
      const k = newKey(e, isMac(), { editing, created: !!live.current.created, lines: !!field?.value?.includes("\n") });
      if (!k) return;
      const s = live.current;
      if (k === "close") { e.preventDefault(); e.stopPropagation(); onClose(); return; }
      if (k === "open") { const id = record?.workspaceId; if (id) { e.preventDefault(); openWorkspace(id); } return; }
      if (k === "undo") { e.preventDefault(); void undo(); return; }
      if (s.busy) return;
      e.preventDefault(); e.stopPropagation();
      if (k === "down" || k === "up") setPicked(moveSelection(s.rows, s.selected, k === "down" ? 1 : -1));
      else if (k === "instructions") setInstructions(v => !v);
      else if (k === "primary" && s.row?.kind === "search") search();
      else if (k === "primary" && s.row?.kind === "fold") setFoldOpen(v => !v);
      else if (k === "primary") { if (s.bar.kind === "existing") openWorkspace(s.bar.workspaceId); else if (s.bar.primary && !s.bar.disabled) void start(s.bar.primary.id); }
      else if (k === "second" && s.bar.kind === "actions" && s.bar.second && !s.bar.disabled) void start(s.bar.second.id);
    };
    doc.addEventListener("keydown", onKey, true);
    return () => doc.removeEventListener("keydown", onKey, true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compact, record]);

  const loadCatalog = () => { if (!catalog) readAgents({ catalog: true }).then(v => setCatalog(v.catalog)).catch(() => setCatalog({ providers: [], error: null, fetchedAt: null })); };
  const loadProjects = () => { if (!projects) readSettings({}).then(v => setProjects((v as { projects: { id: string; name: string }[] }).projects)).catch(() => undefined); };
  const saveBase = (projectId: string, base: string) => { void writeSettings({ bases: { [projectId]: base } }).catch(() => undefined); };

  const onRow = (r: NewRow) => {
    if (r.kind === "search") { search(); return; }
    if (r.kind === "fold") { setFoldOpen(v => !v); setPicked(r.id); return; }
    setPicked(r.id);
    if (compact) setScreen("preview");
  };

  const right = phase.kind === "record" && record ? <RecordPane record={record} c={c} compact={compact} now={now} />
    : planNow ? <Preview plan={planNow} overrides={overrides} setOverrides={setOverrides} c={c} compact={compact} busy={busy} catalog={catalog} loadCatalog={loadCatalog} projects={projects} loadProjects={loadProjects} saveBase={saveBase} instructions={instructions} setInstructions={setInstructions} reopen={reopen} img={img} />
    : source ? <View style={{ padding: 16 }}><Spinner color={c.foregroundMuted} size={14} label="Reading the source" /></View>
    : row?.kind === "fold" ? <TakenPane row={row} rows={rows} c={c} />
    : <View style={{ padding: 24, gap: 6 }}>
      <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>Pick an issue or write the task above. What will start shows here first: the project, branch, agent and the agent's first message.</Text>
    </View>;
  const recordBar = phase.kind === "record" && record ? <View style={{ flexDirection: compact ? "column" : "row", gap: 8, alignItems: compact ? "stretch" : "center" }}>
    {created && record.workspaceId && <BarBtn c={c} compact={compact} primary disabled={false} b={{ name: "Open workspace", icon: "ExternalLink", key: isMac() ? "⌘↵" : "Ctrl ↵" }} onPress={() => openWorkspace(record.workspaceId!)} />}
    {created && recordLine(record, now).undo && <BarBtn c={c} compact={compact} primary={false} disabled={false} b={{ name: "Undo", icon: "Undo2", key: isMac() ? "⌘Z" : "Ctrl Z" }} onPress={() => void undo()} />}
    {failed && remedy && <BarBtn c={c} compact={compact} primary disabled={false} b={{ name: remedy.label, icon: remedy.field === "agent" ? "Bot" : "GitBranch", key: null }} onPress={() => { setReopen(remedy.field); setPhase({ kind: "edit" }); setRecord(null); if (compact) setScreen("preview"); }} />}
    {failed && <BarBtn c={c} compact={compact} primary={!remedy} disabled={false} b={{ name: "Try again", icon: "RotateCw", key: null }} onPress={() => { setReopen(null); setPhase({ kind: "edit" }); setRecord(null); if (compact) setScreen("preview"); }} />}
    {(created || failed) && <BarBtn c={c} compact={compact} primary={false} disabled={false} b={{ name: "Start another", icon: "Plus", key: null }} onPress={another} />}
    {!created && !failed && <BarBtn c={c} compact={compact} primary={false} disabled={false} b={{ name: "Close", icon: "X", key: null }} onPress={onClose} />}
    {created && !compact && <Text style={{ color: c.foregroundMuted, fontSize: 12, flex: 1, textAlign: "right" }}>Start another keeps {record.projectName} and {record.actionName} first.</Text>}
  </View> : null;
  const errorLine = planError && <Text accessibilityRole="alert" style={{ color: c.statusDanger, fontSize: 12 }}>{planError}</Text>;

  if (compact) {
    const onPreview = screen === "preview" || phase.kind === "record";
    return <View style={{ flex: 1, backgroundColor: c.surface0 }}>
      {/* Paseo's own header (with its back) sits above: this row is slim, and its one back arrow only ever means
          "back to the list" (the preview screen); × closes New. */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingLeft: onPreview && phase.kind === "edit" ? 6 : 16, paddingRight: 6, minHeight: 48, borderBottomWidth: 1, borderBottomColor: c.border }}>
        {onPreview && phase.kind === "edit" && <Pressable accessibilityRole="button" accessibilityLabel="Back to the list" onPress={() => setScreen("list")} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
          <Icon name="ChevronLeft" size={22} color={c.foreground} />
        </Pressable>}
        <Text accessibilityRole="header" numberOfLines={1} style={{ color: c.foreground, fontSize: 16, fontWeight: "600", flex: 1 }}>{onPreview && planNow?.source.key ? planNow.source.key : NEW_NAME}</Text>
        {openSettings && <Pressable accessibilityRole="button" accessibilityLabel={`${NEW_OF} actions in Settings`} onPress={openSettings} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}><Icon name="Settings" size={20} color={c.foreground} /></Pressable>}
        <Pressable accessibilityRole="button" accessibilityLabel={`Close ${NEW_NAME}`} onPress={onClose} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}><Icon name="X" size={20} color={c.foreground} /></Pressable>
      </View>
      {onPreview ? <ScrollView ref={pane as never} style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 12 }} keyboardShouldPersistTaps="handled">{right}{errorLine}</ScrollView>
        : <SourcesPane sources={shown} rows={rows} selected={selected} query={query} setQuery={setQuery} onRow={onRow} onRefresh={() => load(true)} c={c} compact error={listError} searching={searched && searched.query === query.trim() ? searched.query : null} chevrons empty={empty} img={img} />}
      {(recordBar || planNow || planError) && <View style={{ borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.surface1, padding: 16, paddingBottom: Platform.OS === "ios" ? 34 : 16, gap: 8 }}>
        {recordBar ?? <>
          {planNow && <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
            <Icon name={kindIcon(planNow.source.kind)} size={14} color={c.foregroundMuted} />
            <Text numberOfLines={2} style={{ color: c.foregroundMuted, fontSize: 13, flex: 1 }}>{[targetLine(planNow), img.images.length ? imagesWord(img.images.length) : ""].filter(Boolean).join(" · ")}</Text>
          </View>}
          {!onPreview && errorLine}
          {planNow ? <ActionRow bar={bar} c={c} compact onAction={id => void start(id)} onOpen={openWorkspace} more={more} setMore={setMore} /> : null}
        </>}
      </View>}
    </View>;
  }

  return <View style={{ flex: 1, minHeight: 0 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 20, paddingRight: 10, height: 52, borderBottomWidth: 1, borderBottomColor: c.border }}>
      <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: 16, fontWeight: "600", flex: 1 }}>{NEW_NAME}</Text>
      {openSettings && <Pressable accessibilityRole="button" accessibilityLabel={`${NEW_OF} actions in Settings`} onPress={openSettings} style={(s: Hover) => ({ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8, height: 32, borderRadius: 6, backgroundColor: s.hovered ? c.surface1 : "transparent" })}>
        <Icon name="Settings" size={15} color={c.foregroundMuted} /><Text style={{ color: c.foregroundMuted, fontSize: 13 }}>Actions</Text>
      </Pressable>}
      <Pressable accessibilityRole="button" accessibilityLabel={`Close ${NEW_NAME}`} onPress={onClose} style={(s: Hover) => ({ width: 32, height: 32, borderRadius: 6, alignItems: "center", justifyContent: "center", backgroundColor: s.hovered ? c.surface1 : "transparent" })}>
        <Icon name="X" size={17} color={c.foregroundMuted} />
      </Pressable>
    </View>
    <View style={{ alignItems: "center", paddingHorizontal: 24, paddingTop: 20, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: c.border, opacity: busy ? 0.55 : 1 }} pointerEvents={busy ? "none" : "auto"}>
      <View style={{ width: "100%", maxWidth: 760 }}><TaskField query={query} setQuery={setQuery} img={img} c={c} compact={false} /></View>
    </View>
    <View style={{ flex: 1, minHeight: 0, flexDirection: "row" }}>
      <View style={{ width: 360, borderRightWidth: 1, borderRightColor: c.border, opacity: busy ? 0.55 : 1 }} pointerEvents={busy ? "none" : "auto"}>
        <SourcesPane field={false} sources={shown} rows={rows} selected={selected} query={query} setQuery={setQuery} onRow={onRow} onRefresh={() => load(true)} c={c} compact={false} error={listError} searching={searched && searched.query === query.trim() ? searched.query : null} chevrons={false} empty={empty} img={img} />
      </View>
      <ScrollView ref={pane as never} style={{ flex: 1 }} contentContainerStyle={{ padding: 20, gap: 12 }} keyboardShouldPersistTaps="handled">{right}{errorLine}</ScrollView>
    </View>
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 1, borderTopColor: c.border }}>
      <View style={{ flex: 1 }}>{recordBar ?? (planNow ? <ActionRow bar={bar} c={c} compact={false} onAction={id => void start(id)} onOpen={openWorkspace} more={more} setMore={setMore} /> : null)}</View>
      {!recordBar && Platform.OS === "web" && <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingBottom: 8 }}>
        <Kbd c={c} label="↑" /><Kbd c={c} label="↓" /><Text style={{ color: c.foregroundMuted, fontSize: 12, marginRight: 8 }}>move</Text>
        <Kbd c={c} label="esc" /><Text style={{ color: c.foregroundMuted, fontSize: 12 }}>close</Text>
      </View>}
    </View>
  </View>;
}

/**
 * Mount on Home: the host on screen shows New while it's open (pickNewHost). Desktop web: a dialog over everything (fixed, one
 * scrim across Paseo's sidebar too). Phones: a full screen over Home.
 */
export function NewHost({ theme, layout, navigation, openSettings }: { theme: Theme; layout: PluginHostProps["layout"]; navigation?: { openWorkspace(i: { workspaceId: string }): void }; openSettings?: () => void }) {
  const { request, probe: anchor } = slot.useHost();
  const win = useWindowDimensions();
  if (!request) return anchor;
  const c = theme.colors;
  const dialog = <NewDialog key={request.token} request={request} theme={theme} layout={layout} navigation={navigation} onClose={closeNew} openSettings={openSettings && (() => { closeNew(); openSettings(); })} />;
  if (layout.compact) return <>{anchor}<View role="dialog" aria-modal aria-label={NEW_NAME} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 50, backgroundColor: c.surface0 }}>{dialog}</View></>;
  const width = Math.min(1060, win.width - 64), height = Math.min(796, win.height - 64);
  return <>{anchor}<View role="dialog" aria-modal aria-label={NEW_NAME} style={{ position: (Platform.OS === "web" ? "fixed" : "absolute") as ViewStyle["position"], top: 0, left: 0, right: 0, bottom: 0, zIndex: 1000, alignItems: "center", justifyContent: "center" }}>
    <Pressable accessible={false} focusable={false} importantForAccessibility="no" onPress={closeNew} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.42)" }} />
    <View style={{ width, height, borderRadius: 12, overflow: "hidden", backgroundColor: c.surface0, borderWidth: 1, borderColor: c.border, boxShadow: "0px 24px 64px rgba(0,0,0,0.28)" } as ViewStyle}>{dialog}</View>
  </View></>;
}

// ---------- Home's row for recent dispatches ----------

/**
 * Home's strip of New's dispatches (from the home feed: no reads of its own): in progress, failed in the last hour, or
 * still undoable. A dispatch that finishes while New is closed says so in a toast with Undo.
 */
export function DispatchRows({ records, theme, compact, navigation }: { records: DispatchRecord[]; theme: Theme; compact: boolean; navigation?: { openWorkspace(i: { workspaceId: string }): void } }) {
  const c = theme.colors;
  const now = useNow(15_000);
  const undoCall = useRpc(dispatchUndoRpc);
  const undoRef = useRef(undoCall); undoRef.current = undoCall;
  const shown = homeRecords(records, now);
  const seen = useRef(new Map<string, string>());
  const undo = useCallback(async (r: DispatchRecord) => {
    try { await undoRef.current({ dispatchId: r.id }); pushToast("success", `Undone: ${r.title}`); } catch (e) { pushToast("error", errorText(e)); }
  }, []);
  useEffect(() => {
    for (const r of records) {
      const before = seen.current.get(r.id);
      seen.current.set(r.id, r.state);
      if (before && before !== r.state && r.state === "created" && !newIsOpen()) pushToast("success", `Started ${r.title}`, recordLine(r, Date.now()).undo ? [{ label: "Undo", onPress: () => void undo(r) }] : [], { durationMs: 10_000 });
      if (before && before !== r.state && r.state === "failed" && !newIsOpen()) pushToast("warning", `${r.title} didn't start: ${r.error ?? ""}`);
    }
  }, [records, undo]);
  if (!shown.length) return null;
  return <View style={{ gap: 2, paddingHorizontal: compact ? 16 : 16 }}>
    {shown.map(r => {
      const l = recordLine(r, now);
      const color = l.tone === "failed" ? c.statusWarning : l.tone === "done" ? c.statusSuccess : c.foregroundMuted;
      // A failed one reopens New on its source (the reason is the second line); a started one opens its workspace.
      const again = l.tone === "failed" ? r.source.key ?? r.source.url ?? r.source.title : null;
      const onRow = again ? () => openNew({ source: again }) : r.workspaceId && navigation ? () => navigation.openWorkspace({ workspaceId: r.workspaceId! }) : undefined;
      return <View key={r.id} style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: compact ? 56 : 40 }}>
        {l.tone === "busy" ? <Spinner color={c.foregroundMuted} size={13} label="Starting" /> : <Icon name={l.tone === "failed" ? "TriangleAlert" : "CircleCheck"} size={15} color={color} />}
        <Pressable accessibilityRole="button" accessibilityLabel={`${l.title}. ${l.line}${again ? ". Try again" : ""}`} disabled={!onRow} onPress={onRow}
          style={(s: Hover & { focused?: boolean }) => ({ flex: 1, minWidth: 0, minHeight: compact ? 44 : 32, justifyContent: "center", paddingVertical: 4, borderRadius: 6, backgroundColor: s.hovered && onRow ? c.surface1 : "transparent", ...focusRing(c, s.focused) })}>
          <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 13 }}>{l.title}</Text>
          <Text numberOfLines={2} style={{ color: c.foregroundMuted, fontSize: 12 }}>{l.line}</Text>
        </Pressable>
        {again && <Pressable accessibilityRole="button" accessibilityLabel={`Try ${r.title} again`} onPress={() => openNew({ source: again })} style={(s: Hover & { focused?: boolean }) => ({ paddingHorizontal: 10, minHeight: compact ? 44 : 28, minWidth: 44, borderRadius: 6, justifyContent: "center", backgroundColor: s.hovered ? c.surface1 : "transparent", ...focusRing(c, s.focused) })}>
          <Text style={{ color: c.foreground, fontSize: 12, fontWeight: "600" }}>Try again</Text>
        </Pressable>}
        {l.undo && <Pressable accessibilityRole="button" accessibilityLabel={`Undo ${r.title}`} onPress={() => void undo(r)} style={(s: Hover & { focused?: boolean }) => ({ paddingHorizontal: 10, minHeight: compact ? 44 : 28, minWidth: 44, borderRadius: 6, justifyContent: "center", backgroundColor: s.hovered ? c.surface1 : "transparent", ...focusRing(c, s.focused) })}>
          <Text style={{ color: c.foreground, fontSize: 12, fontWeight: "600" }}>Undo</Text>
        </Pressable>}
      </View>;
    })}
  </View>;
}
export { UNDO_MINUTES };
