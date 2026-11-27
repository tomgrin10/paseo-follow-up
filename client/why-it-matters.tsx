import { useState } from "react";
import { View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pressable, Text } from "./text";
import { Button, IconButton, SubmitScope, errorText, text, type Theme } from "./kit";
import { RichText } from "./rich-text";
import { useChatComposer } from "./put-in-chat";
import { putInChat } from "../shared/put-in-chat";
import { compassNoteRpc, compassRpc, listRpc } from "../shared/contracts";
import { HAND_LABEL, HAND_SOURCE, STRENGTHS, noteWho, type CompassNote, type CompassSource, type NoteAction, type Place } from "../shared/compass";
import { PRIORITY_SOURCE_LABEL, type PrioritySourceKind } from "../shared/priorities";
import { compassKey } from "./compass-settings";
import { Field } from "./field";

type View_ = {
  settings: { sources: CompassSource[] };
  notes: CompassNote[];
  priority?: { rank: number; of: number; reason: string; source: { kind: PrioritySourceKind; label: string } | null } | null;
  overseer?: string | null;
};

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
const when = (iso: string) => new Date(iso).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dayOf = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
const where = (p: Place | undefined) => !p ? null : p.kind === "conversation" ? (p.sub === "dm" ? "in your DM" : `in #${p.name}`) : `in ${p.name}`;
const STRENGTH_LABEL = { high: "High", normal: "Normal", low: "Low" } as const;
/** Dates the editor offers, relative to today: the words a person would use, as dates. */
function dateChoices(now = new Date()): { label: string; day: string | null }[] {
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const plus = (n: number) => { const d = new Date(now); d.setDate(d.getDate() + n); return d; };
  const friday = plus((5 - now.getDay() + 7) % 7 || 7);
  return [{ label: "Today", day: iso(now) }, { label: "Tomorrow", day: iso(plus(1)) }, { label: "Friday", day: iso(friday) }, { label: "In a week", day: iso(plus(7)) }, { label: "No date", day: null }];
}

/**
 * Why it matters (docs/compass.md): under the panel's goal, where AI priority puts this workspace and the Compass notes
 * behind it. It is not a second Summary: the Summary says what the work is, this says why it ranks where it does. Each
 * note shows its words, who said them, where and until when, with Ask the Overseer and a menu (Tell the agent, Edit,
 * Move, Unpin). Nothing here reaches an agent without a click (compass-reaches-an-agent-only-by-a-click).
 */
export function WhyItMatters({ workspace, theme, compact, openAgent }: { workspace: { id: string; title: string }; theme: Theme; compact: boolean; openAgent?: (agentId: string) => void }) {
  const c = theme.colors; const t = text(c, compact);
  const read = useRpc(compassRpc);
  const query = useQuery({ queryKey: [...compassKey, workspace.id], queryFn: async () => await read({ workspace: workspace.id }) as View_, staleTime: 60_000 });
  const [more, setMore] = useState(false);
  const v = query.data;
  const notes = v?.notes ?? [];
  if (!v || (!v.priority && !notes.length)) return null;
  const shown = more ? notes : notes.slice(0, 1);
  const echo = v.priority?.source?.kind === "compass" && notes.length > 0;
  return <View accessibilityRole="summary" accessibilityLabel="Why it matters" style={{ gap: 8, paddingVertical: 8, paddingHorizontal: compact ? 12 : 10, borderRadius: 8, backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <Icon name="Compass" size={12} color={c.foregroundMuted} />
      <Text style={[t.small, { color: c.foregroundMuted, fontWeight: "600" }]}>Why it matters</Text>
    </View>
    {v.priority && <Text style={[t.meta, { color: c.foreground }]}>
      {/* "1st of 1" says nothing: with one workspace ranked, it is simply the top. */}
      <Text style={{ fontWeight: "600", fontVariant: ["tabular-nums"] }}>{v.priority.of > 1 ? `${ordinal(v.priority.rank)} of ${v.priority.of}` : "Top"}</Text>
      {/* A Compass reason restates the notes right below it, so the line keeps only the rank; another source's reason
          is news here and stays. */}
      <Text style={{ color: c.foregroundMuted }}>{echo ? " in AI priority" : " in AI priority · "}</Text>
      {!echo && <Text style={{ fontStyle: "italic" }}>{v.priority.reason}</Text>}
      {v.priority.source && v.priority.source.kind !== "compass" ? <Text style={{ color: c.foregroundMuted }}>{` · ${PRIORITY_SOURCE_LABEL[v.priority.source.kind]}`}</Text> : null}
    </Text>}
    {shown.map(n => <NoteCard key={n.id} note={n} view={v} workspace={workspace} theme={theme} compact={compact} openAgent={openAgent} />)}
    {notes.length > 1 && <Pressable accessibilityRole="button" accessibilityState={{ expanded: more }} onPress={() => setMore(m => !m)} hitSlop={compact ? 0 : 6}
      style={{ alignSelf: "flex-start", minHeight: compact ? 44 : 20, justifyContent: "center" }}>
      <Text style={[t.meta, { color: c.foreground, fontWeight: "600" }]}>{more ? "Show less" : `+${notes.length - 1} more`}</Text>
    </Pressable>}
  </View>;
}

function NoteCard({ note: n, view: v, workspace, theme, compact, openAgent }: { note: CompassNote; view: View_; workspace: { id: string; title: string }; theme: Theme; compact: boolean; openAgent?: (agentId: string) => void }) {
  const c = theme.colors; const t = text(c, compact);
  const toast = useToast(); const cache = useQueryClient();
  const act = useRpc(compassNoteRpc);
  const [open, setOpen] = useState<"menu" | "edit" | "move" | "unpin" | null>(null);
  const [full, setFull] = useState(false);
  const composer = useChatComposer(v.overseer ?? null);
  const source = v.settings.sources.find(s => s.id === n.source);
  const place = source?.places.find(p => `${p.kind}:${p.id}` === n.place);
  const label = n.source === HAND_SOURCE ? HAND_LABEL : source?.label ?? "A removed source";
  const meta = [label, when(n.at), where(place), n.until ? `until ${dayOf(n.until)}` : null].filter(Boolean).join(" · ");
  const change = useMutation({
    mutationFn: async (a: NoteAction) => await act(a) as { told: { agentId: string } | null },
    onSuccess: (r, a) => {
      setOpen(null);
      void cache.invalidateQueries({ queryKey: compassKey });
      if (a.action === "tell") toast.show("Sent to the main agent", { variant: "success" });
      else if (a.action === "unpin") toast.show("Unpinned. It leaves AI priority now.", { variant: "success" });
      else if (a.action === "edit" && a.workspace) toast.show("Moved", { variant: "success" });
      void r;
    },
    onError: e => toast.error(errorText(e)),
  });
  // Ask the Overseer: the note goes into its message box, unsent, so the developer decides (docs/compass.md).
  const ask = async () => {
    const words = `About ${workspace.title}: ${noteWho(n)}${n.quote ? `, ${when(n.at)}: "${n.quote}"` : `: ${n.what}`}. What should I do?`;
    try {
      if (!composer) throw new Error("no composer");
      await putInChat(composer, words);
      if (v.overseer) openAgent?.(v.overseer);
    } catch {
      await copyText(words).catch(() => undefined);
      toast.show("Copied. Paste it to the Overseer.", { variant: "success" });
    }
  };
  const busy = change.isPending;
  const action = (title: string, icon: string, onPress: () => void, kind: "ghost" | "secondary" = "ghost") =>
    <Button key={title} title={title} icon={icon} kind={kind} theme={theme} compact={compact} disabled={busy} onPress={onPress} />;
  return <View style={{ gap: 3, paddingLeft: 10, borderLeftWidth: 2, borderLeftColor: c.border }}>
    {/* ⋯ rides on the note's own line: a row of its own cost a phone 44 px per note. */}
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 4 }}>
      <View style={{ flex: 1, minWidth: 0 }}><RichText plain style={[t.body, { color: c.foreground }]}>{n.what}</RichText></View>
      <View style={{ marginVertical: compact ? -10 : -4, marginRight: compact ? -10 : -4 }}>
        <IconButton icon="Ellipsis" label={open === "menu" ? "Hide note actions" : "More actions for this note"} onPress={() => setOpen(o => o ? null : "menu")} theme={theme} compact={compact} />
      </View>
    </View>
    {n.quote && <Pressable accessibilityRole="button" accessibilityLabel={full ? "Show less of the quote" : "Show the whole quote"} onPress={() => setFull(f => !f)}>
      <RichText plain numberOfLines={full ? undefined : 2} style={[t.meta, { fontStyle: "italic" }]}>{`“${n.quote}”`}</RichText>
    </Pressable>}
    <Text style={[t.meta, { fontVariant: ["tabular-nums"] }]}>{meta}</Text>
    {(n.link || v.overseer) && <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4, marginLeft: compact ? -12 : -8 }}>
      {n.link && action("Open message", "ExternalLink", () => { void import("@getpaseo/plugin/client").then(m => m.openExternalUrl(n.link!)).catch(() => undefined); })}
      {v.overseer && action("Ask the Overseer", "MessageSquare", () => void ask())}
    </View>}
    {open === "menu" && <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, marginLeft: compact ? -12 : -8 }}>
      {action("Tell the agent", "Send", () => change.mutate({ action: "tell", id: n.id }))}
      {action("Edit", "Pencil", () => setOpen("edit"))}
      {action("Move to another workspace", "ArrowRightLeft", () => setOpen("move"))}
      {action("Unpin", "PinOff", () => setOpen("unpin"))}
    </View>}
    {open === "edit" && <NoteEditor note={n} busy={busy} theme={theme} compact={compact} onCancel={() => setOpen(null)} onSave={a => change.mutate({ action: "edit", id: n.id, ...a })} />}
    {open === "move" && <MovePicker current={workspace.id} busy={busy} theme={theme} compact={compact} onCancel={() => setOpen(null)} onPick={id => change.mutate({ action: "edit", id: n.id, workspace: id })} />}
    {open === "unpin" && <View style={{ gap: 6 }}>
      <Text style={t.meta}>Unpin this note? It leaves AI priority now. A later message about it brings a new note.</Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button title="Unpin" kind="primary" theme={theme} compact={compact} loading={busy} onPress={() => change.mutate({ action: "unpin", id: n.id })} />
        <Button title="Cancel" kind="ghost" theme={theme} compact={compact} onPress={() => setOpen(null)} />
      </View>
    </View>}
  </View>;
}

/** Edit a note's date and strength. A date is the words a person would use; the note keeps its quote. */
function NoteEditor({ note: n, busy, onSave, onCancel, theme, compact }: { note: CompassNote; busy: boolean; onSave: (a: { until?: string | null; strength?: CompassNote["strength"] }) => void; onCancel: () => void; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const [until, setUntil] = useState<string | null>(n.until);
  const [strength, setStrength] = useState(n.strength);
  const chip = (label: string, on: boolean, onPress: () => void) => <Pressable key={label} accessibilityRole="radio" accessibilityState={{ checked: on }} onPress={onPress}
    style={{ minHeight: compact ? 44 : 28, paddingHorizontal: 10, borderRadius: 999, justifyContent: "center", borderWidth: 1, borderColor: on ? c.accent : c.border, backgroundColor: on ? c.surface2 : "transparent" }}>
    <Text style={{ color: on ? c.foreground : c.foregroundMuted, fontSize: 12, fontWeight: "500" }}>{label}</Text>
  </Pressable>;
  const dates = dateChoices();
  const dirty = until !== n.until || strength !== n.strength;
  const save = () => onSave({ ...(until !== n.until ? { until } : {}), ...(strength !== n.strength ? { strength } : {}) });
  return <SubmitScope enabled={dirty && !busy} onSubmit={save} style={{ gap: 8, paddingTop: 4 }}>
    <Text style={[t.meta, { color: c.foreground, fontWeight: "600" }]}>Until</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {dates.map(d => chip(d.label, until === d.day, () => setUntil(d.day)))}
      {until && !dates.some(d => d.day === until) && chip(dayOf(until), true, () => undefined)}
    </View>
    <Text style={[t.meta, { color: c.foreground, fontWeight: "600" }]}>How much it matters</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{STRENGTHS.map(s => chip(STRENGTH_LABEL[s], strength === s, () => setStrength(s)))}</View>
    <View style={{ flexDirection: "row", gap: 8 }}>
      <Button title="Save" kind="primary" shortcut theme={theme} compact={compact} loading={busy} disabled={!dirty} onPress={save} />
      <Button title="Cancel" kind="ghost" theme={theme} compact={compact} onPress={onCancel} />
    </View>
  </SubmitScope>;
}

/** Pick the workspace a note is about: the workspaces Follow-up tracks, by title. */
function MovePicker({ current, busy, onPick, onCancel, theme, compact }: { current: string; busy: boolean; onPick: (id: string) => void; onCancel: () => void; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const list = useRpc(listRpc);
  const [q, setQ] = useState("");
  const all = useQuery({ queryKey: ["follow-up", "compass-move"], staleTime: 60_000, queryFn: async () => (await list({})).workspaces.filter(w => !w.archived && w.id !== current).map(w => ({ id: w.id, title: w.title })) });
  const found = (all.data ?? []).filter(w => w.title.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 6);
  return <View style={{ gap: 6, paddingTop: 4 }}>
    <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
      <Field autoFocus accessibilityLabel="Search workspaces" value={q} onChangeText={setQ} placeholder="Move to which workspace?" placeholderTextColor={c.foregroundMuted}
        style={{ flex: 1, minWidth: 0, minHeight: compact ? 44 : 32, paddingHorizontal: 10, borderRadius: 6, borderWidth: 1, borderColor: c.border, color: c.foreground, fontSize: 13, backgroundColor: c.surface0 }} />
      <Button title="Cancel" kind="ghost" theme={theme} compact={compact} onPress={onCancel} />
    </View>
    {all.isPending && <Text style={t.meta}>Loading workspaces…</Text>}
    {all.error && <Text style={[t.meta, { color: c.statusWarning }]}>{`Couldn't list workspaces: ${errorText(all.error)}`}</Text>}
    {found.map(w => <Pressable key={w.id} accessibilityRole="button" disabled={busy} onPress={() => onPick(w.id)}
      style={state => ({ minHeight: compact ? 44 : 32, paddingHorizontal: 10, justifyContent: "center", borderRadius: 6, backgroundColor: (state as { hovered?: boolean }).hovered ? c.surface2 : "transparent" })}>
      <RichText plain style={t.body}>{w.title}</RichText>
    </Pressable>)}
    {all.data && !found.length && <Text style={t.meta}>{q.trim() ? `No workspace matches "${q.trim()}".` : "No other workspace to move it to."}</Text>}
  </View>;
}
