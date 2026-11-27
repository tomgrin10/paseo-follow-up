import { useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, View } from "react-native";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { Icon, SettingsSection, SettingsSelect, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pressable, Text } from "./text";
import { Button, IconButton, SubmitScope, Switch, errorText, text, type Theme } from "./kit";
import { RichText } from "./rich-text";
import { raised, tint } from "./theme";
import { compassFindRpc, compassRpc, readCompassRpc, setCompassRpc } from "../shared/contracts";
import {
  COMPASS, ROLES, ROLE_INFO, type CompassChange, type CompassNote, type CompassSource, type GlossaryEntry, type Place, type Preset, type PresetView, type Role, type Who,
  CADENCES, type CompassSettings, trackerRef,
} from "../shared/compass";
import { type PlanView } from "../shared/morning-brief";
import { NEW_NAME, NEW_OF } from "../shared/new-name";
import { Field } from "./field";

export const compassKey = ["follow-up", "compass"];

type View_ = {
  settings: { sources: CompassSource[]; instructions: string; glossary: GlossaryEntry[]; cadence: CompassSettings["cadence"]; routing: CompassSettings["routing"] };
  readers: { conversation: boolean; history: boolean; doc: boolean; tracker: boolean; calendar: boolean };
  presets: PresetView[];
  blocked: string | null;
  places: Record<string, { status: string; readAt: string | null; at: string | null; error: string | null }>;
  notes: CompassNote[];
  workspaces: Record<string, string>;
  unplaced: number;
  lastRead: { at: string; trigger: string; ok: boolean; notes: number; error: string | null } | null;
  today: { extractions: number; cap: number };
  running: boolean;
  /** This week's plan (Settings → Compass reads every priority input in one view). */
  plan?: PlanView;
};
type Found = { id: string; name: string; place: Place; detail?: string };
type FindKind = "people" | "channels" | "docs" | "file" | "trackers" | "calendars";

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const placeName = (p: Place) => p.kind === "conversation" ? (p.sub === "dm" ? `DM with ${p.name}` : `#${p.name}`)
  : p.kind === "tracker" ? `${trackerRef(p.id)?.tracker === "github" ? "GitHub" : "Linear"} ${p.scope} ${p.name}` : p.kind === "doc" && p.path ? `${p.name} (this machine)` : p.kind === "calendar" && p.filter === "with-guests" ? `${p.name}, meetings with guests` : p.name;
/**
 * "DM with Dana" when the source is one person read in their DM; "Dana in #planning"; "Everyone in #team"; a tracker
 * or calendar place alone (its items are read by rule, so nobody's words are picked).
 */
const whoWhere = (s: CompassSource) => s.who.kind === "person" && s.places.length === 1 && s.places[0].kind === "conversation" && s.places[0].sub === "dm" && s.places[0].id === s.who.person.id
  ? placeName(s.places[0]) : s.places.every(p => p.kind === "tracker" || p.kind === "calendar") ? s.places.map(placeName).join(", ") : `${whoName(s.who)} in ${s.places.map(placeName).join(", ")}`;
const day = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
const whoName = (w: Who) => w.kind === "person" ? w.person.name : w.kind === "people" ? w.people.map(p => p.name).join(", ") : w.kind === "me" ? "You" : "Everyone";

/** Settings → Compass's one read: the sources, their notes, the plan and the inputs (`follow.compass`, as `compass` reads it). */
export function useCompassView<T = View_>() {
  const read = useRpc(compassRpc);
  return useQuery({ queryKey: compassKey, queryFn: async () => await read({}) as T, refetchInterval: q => (q.state.data as View_ | undefined)?.running ? 2_000 : 30_000 });
}
function useCompassChange() {
  const write = useRpc(setCompassRpc); const cache = useQueryClient(); const toast = useToast();
  return useMutation({
    mutationFn: async (input: CompassChange) => await write(input) as View_,
    onSuccess: value => cache.setQueryData(compassKey, value),
    onError: error => toast.error(errorText(error)),
  });
}

/**
 * Settings → Compass → What sets your priorities (docs/compass.md, one-place-for-priority-inputs): every input AI
 * priority reads, in one list. First the Compass sources, the people and places the developer picked (one editor for
 * every source; presets only fill its fields), then `after`: the built-in inputs (the Linear queue, DMs and mentions,
 * the calendar, mail, review requests) and the mcpproxy servers Ask could read. Every change goes through the RPC
 * `set_compass` runs, and Read now through `read_compass`.
 */
export function CompassSection({ theme, compact, after }: { theme: Theme; compact: boolean; after?: ReactNode }) {
  const c = theme.colors; const t = text(c, compact);
  const readNow = useRpc(readCompassRpc);
  const cache = useQueryClient(); const toast = useToast();
  const query = useCompassView();
  const change = useCompassChange();
  const reading = useMutation({
    mutationFn: async () => await readNow({}) as { running: boolean; view: View_ },
    onSuccess: r => cache.setQueryData(compassKey, r.view),
    onError: error => toast.error(errorText(error)),
  });
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const data = query.data;
  const full = !!data && data.settings.sources.length >= COMPASS.sources;
  return <SettingsSection title="What sets your priorities" info="Everything AI priority, Needs you and the brief read, in one list. The people you add are read each workday morning, and during the day while Follow-up is open: Follow-up keeps a note of each priority with their words, and AI priority ranks your work by it. Only the people you pick are read, only through read-only tools, and a fast model with no tools reads them. Nothing is ever posted. Agents can set it up too.">
    {query.isPending && <ActivityIndicator accessibilityLabel="Loading Compass" color={c.foregroundMuted} style={{ alignSelf: "flex-start", marginVertical: 8 }} />}
    {query.error && <Text style={[t.meta, { color: c.statusWarning }]}>{`Couldn't load Compass: ${errorText(query.error)}`}</Text>}
    {data?.blocked && <Line icon="TriangleAlert" tone={c.statusWarning} text={data.blocked} theme={theme} compact={compact} />}
    {data && <View style={{ ...raised(c), borderRadius: 10, backgroundColor: c.surface1, overflow: "hidden" }}>
      {data.settings.sources.length === 0 && editing !== "new" && <View style={{ padding: compact ? 14 : 12, paddingBottom: 2, gap: 4 }}>
        <Text style={[t.label, { color: c.foreground }]}>Nobody sets your priorities here yet</Text>
        <Text style={t.meta}>Add the person, channel, doc, tracker or calendar that decides what you work on first, like your product lead's DM. Or ask the Overseer to set it up for you.</Text>
      </View>}
      {data.settings.sources.map((s, i) => editing === s.id
        ? <SourceEditor key={s.id} view={data} source={s} first={i === 0} busy={change.isPending} theme={theme} compact={compact} onCancel={() => setEditing(null)}
            onSave={input => change.mutate(input, { onSuccess: () => setEditing(null) })} onRemove={() => change.mutate({ remove: s.id }, { onSuccess: () => setEditing(null) })} />
        : <SourceRow key={s.id} view={data} source={s} first={i === 0} busy={change.isPending} theme={theme} compact={compact} onEdit={() => setEditing(s.id)}
            onToggle={on => change.mutate({ source: { id: s.id, enabled: on } })} />)}
      {editing === "new" && <SourceEditor view={data} first={data.settings.sources.length === 0} busy={change.isPending} theme={theme} compact={compact} onCancel={() => setEditing(null)}
        onSave={input => change.mutate(input, { onSuccess: () => setEditing(null) })} />}
      {/* Right under the sources it adds to, before the built-in inputs: on a phone it never sits a screen below them. */}
      {editing !== "new" && <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, paddingHorizontal: compact ? 14 : 12, paddingVertical: compact ? 10 : 10, borderTopWidth: data.settings.sources.length || editing ? 1 : 0, borderTopColor: c.border }}>
        {full
          ? <Text style={t.meta}>{`Compass holds ${COMPASS.sources} sources. Remove one to add another.`}</Text>
          : <Button title="Add a source" icon="Plus" theme={theme} compact={compact} disabled={!!editing} onPress={() => setEditing("new")} />}
        {data.settings.sources.length > 0 && <Button title="Read now" icon="RotateCcw" kind="ghost" theme={theme} compact={compact} loading={reading.isPending || data.running} disabled={!!data.blocked} onPress={() => reading.mutate()} />}
        {data.settings.sources.length > 0 && <Text style={[t.meta, { flexShrink: 1 }]}>{statusLine(data)}</Text>}
      </View>}
      {after}
    </View>}
  </SettingsSection>;
}

/** Settings → Compass → How to read your Compass: the words every source is read with, and the glossary. */
export function CompassReading({ theme, compact }: { theme: Theme; compact: boolean }) {
  const query = useCompassView(); const change = useCompassChange();
  const data = query.data;
  if (!data) return null;
  return <SettingsSection title="How to read your Compass" info="Words every source is read with; each source's own How to read this comes after them. They change how messages are understood, never what is read.">
    <ReadingNotes value={data.settings.instructions} busy={change.isPending} theme={theme} compact={compact} onSave={v => change.mutate({ instructions: v })} />
    <Glossary entries={data.settings.glossary} busy={change.isPending} theme={theme} compact={compact} onSave={g => change.mutate({ glossary: g })} />
  </SettingsSection>;
}

/** The daytime read's choices (the-brief-has-one-timer): only while Follow-up is open, on workdays 08:00-20:00. */
const CADENCE_LABEL: Record<CompassSettings["cadence"], string> = { off: "Mornings only", "1h": "Every hour", "2h": "Every 2 hours", "4h": "Every 4 hours" };
/** Where Compass's suggestions go: an issue nobody started that a source said matters. */
const ROUTING_LABEL: Record<CompassSettings["routing"]["suggestions"], string> = { "needs-you-and-new": `Needs you and ${NEW_NAME}`, "new-only": `${NEW_NAME} only`, off: "Off" };

/**
 * When's Compass rows: the daytime read (Off, 1, 2 or 4 h while the app is open) and where suggestions go. The same
 * `set_compass` change an agent sends ({ cadence }, { routing }).
 */
export function CompassWhen({ theme, compact, part }: { theme: Theme; compact: boolean; part: "cadence" | "routing" }) {
  const query = useCompassView(); const change = useCompassChange();
  const data = query.data;
  if (!data || !data.settings.sources.length) return null;
  const s = data.settings;
  // One row each, so the settings card draws its divider between them.
  if (part === "cadence") return <SettingsSelect label="During the day" hint={s.cadence === "off" ? "Compass reads once, at the morning read. Read now reads at once." : "While Follow-up is open, on workdays from 08:00 to 20:00. Each read takes only what's new, and nothing is read while the app is closed."}
    value={s.cadence} disabled={change.isPending} options={CADENCES.map(v => ({ value: v, label: CADENCE_LABEL[v] }))} onValueChange={cadence => change.mutate({ cadence: cadence as CompassSettings["cadence"] })} />;
  return <SettingsSelect label="Issues nobody's on" hint={s.routing.suggestions === "off" ? "Compass notes still reorder AI priority; none suggests an issue." : s.routing.suggestions === "new-only" ? `Listed first in ${NEW_OF} My issues, with why.` : `A strong ask due within ${s.routing.urgentWithinWorkdays} workdays goes to Needs you, from a source with Needs you on. The rest are first in ${NEW_NAME}.`}
    value={s.routing.suggestions} disabled={change.isPending} options={(Object.keys(ROUTING_LABEL) as CompassSettings["routing"]["suggestions"][]).map(v => ({ value: v, label: ROUTING_LABEL[v] }))}
    onValueChange={suggestions => change.mutate({ routing: { suggestions: suggestions as CompassSettings["routing"]["suggestions"] } })} />;
}

/** "Read 09:02 · 3 notes live · 1 not matched to a workspace", or why the last read failed. */
function statusLine(v: View_): string {
  if (v.running) return "Reading…";
  // One source already shows its count on its row; the total is news only with several.
  const parts = [v.lastRead ? `Read ${clock(v.lastRead.at)}` : "Not read yet", ...(v.settings.sources.length > 1 ? [`${v.notes.length} note${v.notes.length === 1 ? "" : "s"} live`] : [])];
  if (v.unplaced) parts.push(`${v.unplaced} not matched to a workspace`);
  if (v.today.extractions >= v.today.cap) parts.push(`paused until tomorrow: ${v.today.cap} reads today`);
  return parts.join(" · ");
}

function Line({ icon, tone, text: line, theme, compact }: { icon: string; tone: string; text: string; theme: Theme; compact: boolean }) {
  const t = text(theme.colors, compact);
  return <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
    <View style={{ paddingTop: compact ? 4 : 3 }}><Icon name={icon} size={12} color={tone} /></View>
    <Text style={[t.meta, { color: tone, flex: 1 }]}>{line}</Text>
  </View>;
}

/**
 * One source, in the same row style as the built-in inputs below it (one list): its name, one line with its roles,
 * where it reads and its notes, a warning when a place failed, then a chevron that opens the rest (the plan it brought,
 * its reading notes, its live notes, Edit) and its switch.
 */
function SourceRow({ view, source, first, busy, onEdit, onToggle, theme, compact }: { view: View_; source: CompassSource; first: boolean; busy: boolean; onEdit: () => void; onToggle: (on: boolean) => void; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const notes = view.notes.filter(n => n.source === source.id); const live = notes.length;
  const [open, setOpen] = useState(false);
  const states = source.places.map(p => view.places[`${p.kind}:${p.id}`]);
  const bad = states.find(p => p && (p.status === "failed" || p.status === "paused"));
  const slow = states.some(p => p?.status === "slow-path");
  // A place's note that isn't a failure (a busy place's newest 40, a long gap's newest pages) rides under the meta line.
  const info = states.find(p => p && (p.status === "ok" || p.status === "slow-path") && p.error)?.error ?? null;
  const meta = [source.roles.map(r => ROLE_INFO[r].label).join(", "), whoWhere(source), source.enabled ? (live ? `${live} note${live === 1 ? "" : "s"} live` : "no notes live") : null, slow ? "read by search, slower" : null].filter(Boolean).join(" · ");
  return <View style={{ flexDirection: "row", gap: 10, alignItems: "flex-start", padding: compact ? 14 : 12, borderTopWidth: first ? 0 : 1, borderTopColor: c.border }}>
    <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
      <RichText plain style={[t.label, { color: source.enabled ? c.foreground : c.foregroundMuted }]}>{source.label}</RichText>
      <RichText plain style={t.meta}>{meta}</RichText>
      {source.enabled && bad?.error && <Line icon="TriangleAlert" tone={c.statusWarning} text={bad.error} theme={theme} compact={compact} />}
      {source.enabled && !bad && info && <Text style={t.meta}>{info}</Text>}
      {open && <View style={{ gap: 8, paddingTop: 8 }}>
        {source.enabled && source.roles.includes("plan") && <PlanLine source={source} plan={view.plan} theme={theme} compact={compact} />}
        {source.instructions ? <RichText plain style={[t.meta, { fontStyle: "italic" }]}>{`“${source.instructions}”`}</RichText> : source.places.every(p => p.kind === "tracker" || p.kind === "calendar") ? <Text style={t.meta}>Read by rule, with no model.</Text> : <Text style={t.meta}>No reading notes: read with its roles' notes and yours.</Text>}
        {source.enabled && live > 0 && <NoteList notes={notes} view={view} theme={theme} compact={compact} />}
        <View style={{ flexDirection: "row" }}><Button title="Edit source" icon="Pencil" theme={theme} compact={compact} disabled={busy} onPress={onEdit} accessibilityLabel={`Edit ${source.label}`} /></View>
      </View>}
    </View>
    <IconButton theme={theme} compact={compact} icon={open ? "ChevronUp" : "ChevronDown"} label={`${open ? "Hide" : "Show"} ${source.label}'s notes and settings`} onPress={() => setOpen(o => !o)} />
    <Switch theme={theme} compact={compact} label={compact ? "" : source.enabled ? "On" : "Off"} accessibilityLabel={`Read ${source.label}`} value={source.enabled} disabled={busy} onChange={onToggle} />
  </View>;
}

/**
 * This week's plan under the source that posted it ("This week's plan · Week of Nov 23 · posted Sun 18:05 · 14 items, 3
 * without an issue", with Open), or that none has come from it yet. Plans come from Compass on arrival.
 */
function PlanLine({ source, plan, theme, compact }: { source: CompassSource; plan?: PlanView; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  if (!plan || plan.mode === "off" || plan.source === "env") return null;
  const mine = plan.found?.source === source.id ? plan.found : plan.previous?.source === source.id && !plan.found ? plan.previous : null;
  const inUse = !!mine && plan.url === mine.url;
  const posted = mine?.postedAt ? new Date(mine.postedAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : null;
  const last = inUse && plan.previous?.url === mine?.url && !plan.found;
  const line = inUse ? `Shared ${last ? "last week's plan" : "this week's plan"}${plan.read?.title ? `, ${plan.read.title}` : ""}${posted ? ` · ${posted}` : ""}`
    : mine ? "Shared a plan; a pasted link is in use instead" : "No plan shared yet: the newest claude.ai artifact becomes the plan";
  return <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
    <View style={{ paddingTop: compact ? 4 : 3 }}><Icon name={inUse ? "Check" : "Map"} size={12} color={inUse ? c.statusSuccess : c.foregroundMuted} /></View>
    <RichText plain style={[t.meta, { flexShrink: 1, minWidth: 0 }]}>{line}</RichText>
    {inUse && <Pressable accessibilityRole="link" accessibilityLabel={`Open this week's plan from ${source.label}`} onPress={() => void openExternalUrl(mine!.url).catch(() => undefined)} hitSlop={compact ? 0 : 6}
      style={{ minHeight: compact ? 44 : 20, marginTop: compact ? -12 : 0, justifyContent: compact ? "center" : "flex-start" }}>
      <Text style={[t.meta, { color: c.accent, fontWeight: "600" }]}>Open</Text>
    </Pressable>}
  </View>;
}

/**
 * What Compass understood from a source: each live note, the words it quotes, its date and where it went. The quote is
 * the proof (a-compass-note-quotes-its-source), so it is always shown.
 */
function NoteList({ notes, view, theme, compact }: { notes: CompassNote[]; view: View_; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  // A rule note (tracker, calendar) quotes its title then its fields: the title is already the note's line, so only the
  // fields show; a meeting's raw start time is said by "Until" instead.
  const quoteOf = (n: CompassNote) => {
    if (!n.quote) return null;
    const cut = n.quote.indexOf(" · ");
    if (cut < 0 || !n.quote.slice(0, cut).includes(n.what)) return n.quote;
    const rest = n.quote.slice(cut + 3);
    return /^\d{4}-\d\d-\d\d(T|$)/.test(rest) ? null : rest;
  };
  const where = (n: CompassNote) => n.match.workspace ? view.workspaces[n.match.workspace] ?? "its workspace" : n.match.issue ? n.match.issue : "not matched to a workspace";
  return <View style={{ gap: 10, paddingTop: 2 }}>
    {notes.map(n => <View key={n.id} style={{ gap: 2, paddingLeft: 10, borderLeftWidth: 2, borderLeftColor: c.border }}>
      <RichText plain style={[t.body, { color: c.foreground }]}>{n.what}</RichText>
      {quoteOf(n) && <RichText plain numberOfLines={3} style={[t.meta, { fontStyle: "italic" }]}>{`“${quoteOf(n)}”`}</RichText>}
      <Text style={[t.meta, { fontVariant: ["tabular-nums"] }]}>{[n.until ? `Until ${day(n.until)}` : null, ROLE_INFO[n.role].label, where(n)].filter(Boolean).join(" · ")}</Text>
    </View>)}
  </View>;
}

/** What the editor picks places with, by the kind of place a source reads. */
const PICKS: Record<Place["kind"], { kinds: FindKind[]; first: string; more: string }> = {
  conversation: { kinds: ["channels"], first: "Pick a channel", more: "Add" },
  doc: { kinds: ["docs", "file"], first: "Pick a doc", more: "Add" },
  tracker: { kinds: ["trackers"], first: "Pick a project or label", more: "Add" },
  calendar: { kinds: ["calendars"], first: "Pick a calendar", more: "Add" },
};
type WhoMode = "people" | "anyone" | "me";

/**
 * The one editor for adding and changing a source. A preset only fills the fields. Every place is picked from what a
 * reader finds (compass_find: the chat, docs, tracker and calendar tools' own results, or a file checked on this
 * machine), so every place has its reader's own id. Whose words count for a conversation or a doc: some people,
 * everyone there, or you; a tracker's or a calendar's items are read by rule, so nobody is picked.
 */
function SourceEditor({ view, source, first, busy, onSave, onCancel, onRemove, theme, compact }: { view: View_; source?: CompassSource; first: boolean; busy: boolean; onSave: (c: CompassChange) => void; onCancel: () => void; onRemove?: () => void; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const [preset, setPreset] = useState<Preset | null>(source ? null : view.presets.find(p => p.offered) ?? null);
  const [people, setPeople] = useState<Found[]>(source ? source.who.kind === "person" ? [{ id: source.who.person.id, name: source.who.person.name, place: null! }] : source.who.kind === "people" ? source.who.people.map(p => ({ id: p.id, name: p.name, place: null! })) : [] : []);
  const [mode, setMode] = useState<WhoMode>(source ? (source.who.kind === "me" ? "me" : source.who.kind === "anyone" ? "anyone" : "people") : preset?.who === "me" ? "me" : preset?.who === "anyone" ? "anyone" : "people");
  const [places, setPlaces] = useState<Place[]>(source?.places ?? []);
  const [roles, setRoles] = useState<Role[]>(source?.roles ?? preset?.roles ?? ["priorities"]);
  const [label, setLabel] = useState(source?.label ?? "");
  const [notes, setNotes] = useState(source?.instructions ?? "");
  const [picking, setPicking] = useState<FindKind | null>(null);
  const kind: Place["kind"] = source?.places[0]?.kind ?? preset?.reader ?? "conversation";
  const ruled = kind === "tracker" || kind === "calendar";
  const usePreset = (p: Preset) => { setPreset(p); setRoles(p.roles); setMode(p.who === "me" ? "me" : p.who === "anyone" ? "anyone" : "people"); setPlaces([]); setPicking(null); if (p.who !== "person" && p.who !== "people") setPeople([]); };
  const dmOnly = preset?.sub === "dm";
  const addPerson = (f: Found) => {
    setPicking(null);
    setPeople(ps => ps.some(p => p.id === f.id) || ps.length >= COMPASS.people ? ps : [...ps, f]);
    // A person's DM preset: their DM is the place.
    if (dmOnly) setPlaces(ps => ps.some(p => p.id === f.id) ? ps : [...ps, f.place].slice(0, COMPASS.places));
    if (!label && !source) setLabel(f.name);
  };
  const addPlace = (f: Found) => { setPicking(null); setPlaces(ps => ps.some(p => p.kind === f.place.kind && p.id === f.place.id) ? ps : [...ps, f.place].slice(0, COMPASS.places)); if (!label && !source && (ruled || mode !== "people")) setLabel(kind === "calendar" ? "Calendar deadlines" : f.name); };
  // Trackers and calendars are read by rule: their items, whoever wrote them (a calendar is yours).
  const who: Who | null = ruled ? (kind === "calendar" ? { kind: "me" } : { kind: "anyone" }) : mode === "me" ? { kind: "me" } : mode === "anyone" ? { kind: "anyone" }
    : people.length === 1 ? { kind: "person", person: { id: people[0].id, name: people[0].name } } : people.length > 1 ? { kind: "people", people: people.map(p => ({ id: p.id, name: p.name })) } : null;
  const ready = !!who && places.length > 0 && roles.length > 0;
  const save = () => who && onSave({ source: { ...(source ? { id: source.id } : {}), ...(label.trim() ? { label: label.trim() } : {}), who, places, roles, instructions: notes } });
  const chip = (title: string, onRemoveChip: () => void, key: string) => <View key={key} style={{ flexDirection: "row", alignItems: "center", gap: 4, minHeight: compact ? 44 : 28, maxWidth: "100%", paddingLeft: 10, paddingRight: 4, borderRadius: 6, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface0 }}>
    <Text numberOfLines={1} style={[t.body, { flexShrink: 1 }]}>{title}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${title}`} onPress={onRemoveChip} hitSlop={6} style={{ minWidth: compact ? 36 : 22, minHeight: compact ? 36 : 22, alignItems: "center", justifyContent: "center" }}>
      <Icon name="X" size={12} color={c.foregroundMuted} />
    </Pressable>
  </View>;
  // On a phone a label sits on its own line above its controls, as "Start from" does; on desktop, a column.
  const labelCol = (s: string) => <Text style={[t.meta, compact ? { width: "100%" } : { width: 96 }]}>{s}</Text>;
  const row = { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 } as const;
  const pill = (on: boolean, title: string, onPress: () => void, role: "radio" | "checkbox", key: string) => <Pressable key={key} accessibilityRole={role} accessibilityState={{ checked: on }} onPress={onPress}
    style={state => ({ minHeight: compact ? 44 : 28, paddingHorizontal: 10, borderRadius: 999, justifyContent: "center", borderWidth: 1, borderColor: on ? c.accent : c.border,
      backgroundColor: on ? tint(c.accent, c) : (state as { hovered?: boolean }).hovered ? c.surface2 : "transparent" })}>
    <Text style={{ color: on ? c.foreground : c.foregroundMuted, fontSize: 12, fontWeight: "500" }}>{title}</Text>
  </Pressable>;
  const picks = PICKS[kind].kinds.filter(k => k !== "docs" || view.readers.doc);
  const missing = view.presets.filter(p => !p.offered);
  return <SubmitScope enabled={ready && !busy} onSubmit={save} style={{ padding: compact ? 14 : 12, gap: 12, borderTopWidth: first ? 0 : 1, borderTopColor: c.border, backgroundColor: c.surface1 }}>
    {!source && <Text accessibilityRole="header" style={[t.body, { color: c.foreground, fontWeight: "600" }]}>New source</Text>}
    {!source && <View style={{ gap: 6 }}>
      <Text style={[t.meta, { color: c.foreground, fontWeight: "600" }]}>Start from</Text>
      <View style={row}>
        {view.presets.filter(p => p.offered).map(p => <Pressable key={p.id} accessibilityRole="radio" accessibilityState={{ checked: preset?.id === p.id }} onPress={() => usePreset(p)}
          style={state => ({ minHeight: compact ? 44 : 30, paddingHorizontal: 12, borderRadius: 6, justifyContent: "center", borderWidth: 1, borderColor: preset?.id === p.id ? c.accent : c.border,
            backgroundColor: preset?.id === p.id ? tint(c.accent, c) : (state as { hovered?: boolean }).hovered ? c.surface2 : c.surface0 })}>
          <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "500" }}>{p.label}</Text>
        </Pressable>)}
      </View>
      {preset && <Text style={t.meta}>{preset.hint}</Text>}
      {/* A preset whose reader isn't here is never a dead control: it isn't offered, and one line says why. */}
      {[...new Set(missing.map(p => p.why))].map(why => <Text key={why} style={t.meta}>{`${missing.filter(p => p.why === why).map(p => p.label).join(", ")}: ${why}`}</Text>)}
    </View>}
    {!ruled && <View style={{ gap: 6 }}>
      {!dmOnly && <View style={row}>
        {labelCol("Whose words")}
        {(["people", "anyone", "me"] as const).map(m => pill(mode === m, m === "people" ? "Some people" : m === "anyone" ? "Everyone there" : "Yours", () => { setMode(m); if (m !== "people") { setPeople([]); setPicking(null); } }, "radio", m))}
      </View>}
      {mode === "people" && <View style={row}>
        {dmOnly ? labelCol("Whose words") : !compact && labelCol("")}
        {people.map(p => chip(p.name, () => { setPeople(ps => ps.filter(x => x.id !== p.id)); if (dmOnly) setPlaces(ps => ps.filter(x => x.id !== p.id)); }, p.id))}
        {people.length < COMPASS.people && <Button title={people.length ? "Add a person" : "Pick a person"} icon="Plus" kind={people.length ? "ghost" : "secondary"} theme={theme} compact={compact} onPress={() => setPicking(picking === "people" ? null : "people")} />}
      </View>}
      {mode === "anyone" && <Text style={t.meta}>{`Everyone's messages there, the newest ${COMPASS.items} a read. Your reading notes can narrow it ("only the leads").`}</Text>}
    </View>}
    {picking === "people" && <FindPicker kind="people" theme={theme} compact={compact} onCancel={() => setPicking(null)} onPick={addPerson} />}
    <View style={row}>
      {labelCol("Where")}
      {places.map(p => chip(placeName(p), () => setPlaces(ps => ps.filter(x => x !== p)), `${p.kind}:${p.id}`))}
      {places.length < COMPASS.places && !dmOnly && picks.map((k, i) => <Button key={k} title={k === "file" ? "A file on this machine" : places.length ? PICKS[kind].more : PICKS[kind].first} icon={k === "file" ? "FileText" : "Plus"}
        kind={places.length || i > 0 ? "ghost" : "secondary"} theme={theme} compact={compact} onPress={() => setPicking(picking === k ? null : k)} />)}
      {dmOnly && !places.length && <Text style={t.meta}>Their DM with you, once you pick them.</Text>}
    </View>
    {picking && picking !== "people" && <FindPicker kind={picking} theme={theme} compact={compact} onCancel={() => setPicking(null)} onPick={addPlace} />}
    {kind === "calendar" && places.length > 0 && <View style={row}>
      {labelCol("Which events")}
      {(["with-guests", "all"] as const).map(f => pill((places[0].kind === "calendar" ? places[0].filter ?? "all" : "all") === f, f === "with-guests" ? "Meetings with guests" : "All events",
        () => setPlaces(ps => ps.map(p => p.kind === "calendar" ? { ...p, filter: f } : p)), "radio", f))}
    </View>}
    {ruled && <Text style={t.meta}>{kind === "tracker"
      ? "Read by rule, with no model: each open issue in it is a note quoting its own fields, and one that leaves it ends its note."
      : "Read by rule, with no model: a meeting in the next two weeks lends its date to the work it matches; one about nothing here isn't kept."}</Text>}
    <View style={{ gap: 6 }}>
      <Text style={[t.meta, { color: c.foreground, fontWeight: "600" }]}>What it tells you</Text>
      <View style={row}>
        {ROLES.map(r => { const on = roles.includes(r); return pill(on, ROLE_INFO[r].label, () => setRoles(rs => on ? rs.filter(x => x !== r) : [...rs, r]), "checkbox", r); })}
      </View>
    </View>
    {!ruled && <View style={{ gap: 6 }}>
      <Text style={[t.meta, { color: c.foreground, fontWeight: "600" }]}>How to read this</Text>
      <Field accessibilityLabel="How to read this source" multiline value={notes} onChangeText={v => setNotes(v.slice(0, COMPASS.sourceInstructions))} placeholder={kind === "doc" ? "Lines under 'This week' are the plan. A line starting with ! is urgent." : "P0 means today, P1 this week. Ignore hiring talk."}
        placeholderTextColor={c.foregroundMuted} style={{ minHeight: 64, padding: 10, borderRadius: 6, borderWidth: 1, borderColor: c.border, color: c.foreground, fontSize: 13, backgroundColor: c.surface0, textAlignVertical: "top" }} />
      <Text style={t.meta}>{`Your words for the model that reads it. They change how it is read, never what is read. ${notes.length}/${COMPASS.sourceInstructions}`}</Text>
    </View>}
    <View style={row}>
      {labelCol("Name")}
      <Field accessibilityLabel="Source name" value={label} onChangeText={setLabel} placeholder={kind === "tracker" ? "priority/high" : kind === "doc" ? "Now" : kind === "calendar" ? "Calendar deadlines" : "Dana · product"} placeholderTextColor={c.foregroundMuted}
        style={{ flex: 1, minWidth: 160, minHeight: compact ? 44 : 32, paddingHorizontal: 10, borderRadius: 6, borderWidth: 1, borderColor: c.border, color: c.foreground, fontSize: 13, backgroundColor: c.surface0 }} />
    </View>
    <View style={[row, { justifyContent: "space-between" }]}>
      <View style={row}>
        <Button title={source ? "Save" : "Add source"} kind="primary" shortcut theme={theme} compact={compact} loading={busy} disabled={!ready} onPress={save} />
        <Button title="Cancel" kind="ghost" theme={theme} compact={compact} onPress={onCancel} />
      </View>
      {onRemove && <Button title="Remove source" kind="ghost" icon="Trash2" theme={theme} compact={compact} disabled={busy} onPress={onRemove} />}
    </View>
    {!ready && <Text style={t.meta}>{!who ? "Pick whose words count." : !places.length ? "Pick where to read." : "Give it at least one role."}</Text>}
  </SubmitScope>;
}

const FIND_COPY: Record<FindKind, { label: string; placeholder: string }> = {
  people: { label: "Search people", placeholder: "Search people by name" },
  channels: { label: "Search channels", placeholder: "Search channels by name" },
  docs: { label: "Search docs", placeholder: "Search pages by title" },
  file: { label: "File path", placeholder: "/home/you/notes/now.md" },
  trackers: { label: "Search trackers", placeholder: "A Linear project, or owner/repo for GitHub" },
  calendars: { label: "Calendars", placeholder: "" },
};

/**
 * A place or person from a reader's own results (compass_find): people, channels, docs, a file checked on this machine,
 * tracker scopes, calendars. Only results with the reader's own id can be picked. A file is checked on Enter or
 * Check; calendars list at once.
 */
function FindPicker({ kind, onPick, onCancel, theme, compact }: { kind: FindKind; onPick: (f: Found) => void; onCancel: () => void; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const find = useRpc(compassFindRpc);
  const file = kind === "file"; const auto = kind === "calendars";
  const [q, setQ] = useState(""); const [debounced, setDebounced] = useState(auto ? "calendar" : "");
  useEffect(() => { if (file || auto) return; const id = setTimeout(() => setDebounced(q.trim()), 350); return () => clearTimeout(id); }, [q, file, auto]);
  const results = useQuery({ queryKey: ["follow-up", "compass-find", kind, debounced], enabled: debounced.length >= 2, staleTime: file ? 0 : 60_000,
    queryFn: async () => await find({ kind, query: debounced }) as { results: Found[]; error: string | null } });
  const copy = FIND_COPY[kind];
  // Its own scope: Enter checks a file here, and never reaches the editor's scope around it (which would swallow it).
  return <SubmitScope enabled={file && q.trim().length >= 2} onSubmit={() => setDebounced(q.trim())} style={{ borderWidth: 1, borderColor: c.border, borderRadius: 8, backgroundColor: c.surface0, overflow: "hidden" }}>
    <View style={{ flexDirection: "row", gap: 8, padding: 8, alignItems: "center" }}>
      {auto ? <Text style={[t.meta, { flex: 1 }]}>{results.isFetching ? "Looking…" : "The calendars your calendar tool lists"}</Text>
        : <Field autoFocus accessibilityLabel={copy.label} value={q} onChangeText={setQ} placeholder={copy.placeholder}
          placeholderTextColor={c.foregroundMuted} autoCapitalize="none" autoCorrect={false}
          style={{ flex: 1, minWidth: 0, minHeight: compact ? 44 : 32, paddingHorizontal: 10, borderRadius: 6, borderWidth: 1, borderColor: c.border, color: c.foreground, fontSize: 13, backgroundColor: c.surface1, ...(file && q ? { fontFamily: "ui-monospace, Menlo, monospace" } : {}) }} />}
      {file && <Button title="Check" theme={theme} compact={compact} disabled={q.trim().length < 2} loading={results.isFetching} onPress={() => setDebounced(q.trim())} />}
      <Button title="Cancel" kind="ghost" theme={theme} compact={compact} onPress={onCancel} />
    </View>
    {file && !debounced && <Text style={[t.meta, { paddingHorizontal: 12, paddingBottom: 8 }]}>A Markdown or text file, up to 64 KB. Compass reads it only when it changes, and its path never leaves this machine.</Text>}
    {!file && !auto && results.isFetching && <Text style={[t.meta, { paddingHorizontal: 12, paddingBottom: 8 }]}>Searching…</Text>}
    {results.data?.error && <Text style={[t.meta, { paddingHorizontal: 12, paddingBottom: 8, color: c.statusWarning }]}>{results.data.error}</Text>}
    {(results.data?.results ?? []).map(r => <Pressable key={r.id} accessibilityRole="button" onPress={() => onPick(r)}
      style={state => ({ minHeight: compact ? 44 : 34, paddingHorizontal: 12, paddingVertical: 6, justifyContent: "center", borderTopWidth: 1, borderTopColor: c.border, backgroundColor: state.pressed || (state as { hovered?: boolean }).hovered ? c.surface2 : "transparent" })}>
      <Text style={t.body}>{kind === "channels" ? `#${r.name}` : r.name}</Text>
      {r.detail && <RichText plain style={t.meta}>{r.detail}</RichText>}
    </Pressable>)}
    {debounced.length >= 2 && !results.isFetching && !results.data?.results.length && !results.data?.error && <Text style={[t.meta, { paddingHorizontal: 12, paddingBottom: 8 }]}>{`Nothing matches "${debounced}".`}</Text>}
  </SubmitScope>;
}

/** "How to read your Compass": the developer's words for every source, saved on Save. */
function ReadingNotes({ value, busy, onSave, theme, compact }: { value: string; busy: boolean; onSave: (v: string) => void; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const dirty = draft.trim() !== value.trim();
  return <SubmitScope enabled={dirty && !busy} onSubmit={() => onSave(draft)} style={{ gap: 6 }}>
    <Field accessibilityLabel="How to read your Compass" multiline value={draft} onChangeText={v => setDraft(v.slice(0, COMPASS.instructions))} placeholder="P0 means today. 'The renewal' is the acme renewal. Customer asks wait for the plan unless they name a date."
      placeholderTextColor={c.foregroundMuted} style={{ minHeight: 72, padding: 10, borderRadius: 6, borderWidth: 1, borderColor: c.border, color: c.foreground, fontSize: 13, backgroundColor: c.surface0, textAlignVertical: "top" }} />
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      <Text style={[t.meta, { flex: 1, minWidth: 180 }]}>{`For every source. ${draft.length}/${COMPASS.instructions}`}</Text>
      {dirty && <Button title="Save" kind="primary" shortcut theme={theme} compact={compact} loading={busy} onPress={() => onSave(draft)} />}
    </View>
  </SubmitScope>;
}

/** The glossary: your words → an issue key. Matching reads it before anything else, word for word. */
function Glossary({ entries, busy, onSave, theme, compact }: { entries: GlossaryEntry[]; busy: boolean; onSave: (g: GlossaryEntry[]) => void; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const [words, setWords] = useState(""); const [key, setKey] = useState("");
  const means = (g: GlossaryEntry) => "issue" in g.means ? g.means.issue : "workspace" in g.means ? `workspace ${g.means.workspace}` : g.means.account;
  const field = { minHeight: compact ? 44 : 32, paddingHorizontal: 10, borderRadius: 6, borderWidth: 1, borderColor: c.border, color: c.foreground, fontSize: 13, backgroundColor: c.surface0 } as const;
  const add = () => { onSave([...entries, { words: words.trim(), means: { issue: key.trim().toUpperCase() } }]); setWords(""); setKey(""); };
  return <View style={{ gap: 6 }}>
    <Text style={[t.label, { color: c.foreground }]}>Glossary</Text>
    <Text style={t.meta}>Your own words for your work. When a note says one, it goes to that issue's workspace.</Text>
    {entries.map(g => <View key={g.words} style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: compact ? 44 : 28 }}>
      <RichText plain style={[t.body, { color: c.foreground }]}>{`“${g.words}”`}</RichText>
      <Icon name="ArrowRight" size={12} color={c.foregroundMuted} />
      <Text style={[t.body, { fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12 }]}>{means(g)}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${g.words}`} disabled={busy} onPress={() => onSave(entries.filter(x => x !== g))} hitSlop={6}
        style={{ minWidth: compact ? 44 : 22, minHeight: compact ? 44 : 22, alignItems: "center", justifyContent: "center" }}>
        <Icon name="X" size={12} color={c.foregroundMuted} />
      </Pressable>
    </View>)}
    {entries.length < COMPASS.glossary && <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      <Field accessibilityLabel="Word" value={words} onChangeText={setWords} placeholder="Phoenix" placeholderTextColor={c.foregroundMuted} style={[field, { flexGrow: 1, flexBasis: 120, minWidth: 0 }]} />
      <Icon name="ArrowRight" size={12} color={c.foregroundMuted} />
      <Field accessibilityLabel="Issue key" value={key} onChangeText={setKey} placeholder="ACME-40" autoCapitalize="characters" placeholderTextColor={c.foregroundMuted} style={[field, { flexGrow: 1, flexBasis: 100, minWidth: 0, fontFamily: "ui-monospace, Menlo, monospace" }]} />
      <Button title="Add" icon="Plus" theme={theme} compact={compact} loading={busy} disabled={words.trim().length < 2 || key.trim().length < 3} onPress={add} />
    </View>}
  </View>;
}
