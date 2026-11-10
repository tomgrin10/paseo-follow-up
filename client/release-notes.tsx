import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, ScrollView } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { releaseNotesRpc, whatsNewSeenRpc } from "../shared/contracts";
import { LAST_SEEN_KEY, recentNotes, recentUpdate, whatsNew, type ReleaseNote, type ReleaseNotesView } from "../shared/changelog";
import { deviceStorage } from "../shared/settings-nav";
import { Button, text, useNow, type Theme } from "./kit";
import { useOnboarding } from "./onboarding";

/**
 * Release notes on the client: What's new after an update, the full list, and Home's quiet version line. The notes
 * come from the installed package's CHANGELOG.md through `follow.release-notes`, read once per app session.
 */

export const releaseNotesKey = ["follow-through", "release-notes"];
export function useReleaseNotes() {
  const read = useRpc(releaseNotesRpc);
  return useQuery({ queryKey: releaseNotesKey, queryFn: () => read({}), staleTime: Infinity, retry: 1 });
}

const fmtDate = (iso: string | null) => iso ? new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : null;

/** One version's notes: "1.4.0-beta.14 · 10 Nov", then its bullets. Shared by What's new and the release notes. */
export function VersionNotes({ note, theme, max = 8 }: { note: ReleaseNote; theme: Theme; max?: number }) {
  const c = theme.colors; const t = text(c);
  const [all, setAll] = useState(false);
  const items = all ? note.items : note.items.slice(0, max);
  return <View style={{ gap: 6 }}>
    {items.map((item, i) => <View key={i} style={{ flexDirection: "row", gap: 8 }}>
      <View style={{ width: 4, height: 4, borderRadius: 2, marginTop: 7, backgroundColor: c.foregroundMuted }} />
      <Text style={[t.body, { flex: 1 }]}>{item}</Text>
    </View>)}
    {!all && note.items.length > max && <Pressable accessibilityRole="button" onPress={() => setAll(true)} hitSlop={6}>
      <Text style={[t.meta, { color: c.foreground, fontWeight: "600" }]}>{`Show all ${note.items.length}`}</Text>
    </Pressable>}
  </View>;
}

function VersionHeader({ note, theme }: { note: ReleaseNote; theme: Theme }) {
  const c = theme.colors; const t = text(c);
  const date = fmtDate(note.date);
  return <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
    <Text style={[t.label, { fontVariant: ["tabular-nums"] }]}>{note.version}</Text>
    {date && <Text style={t.meta}>{`· ${date}`}</Text>}
  </View>;
}

/** An older version, folded to its first note; opens in place. */
function FoldedVersion({ note, theme, compact }: { note: ReleaseNote; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c);
  const [open, setOpen] = useState(false);
  return <View style={{ borderTopWidth: 1, borderTopColor: c.border }}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} aria-expanded={open} accessibilityLabel={`${note.version}${note.date ? `, ${fmtDate(note.date)}` : ""}`} onPress={() => setOpen(o => !o)}
      style={state => ({ flexDirection: "row", alignItems: "center", gap: 8, minHeight: compact ? 48 : 36, paddingVertical: 6, marginHorizontal: -8, paddingHorizontal: 8, borderRadius: 6, backgroundColor: state.pressed ? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
      <Icon name={open ? "ChevronDown" : "ChevronRight"} size={14} color={c.foregroundMuted} />
      <Text style={[t.label, { fontVariant: ["tabular-nums"], flexShrink: 0 }]}>{note.version}</Text>
      {note.date && <Text style={[t.meta, { flexShrink: 0 }]}>{fmtDate(note.date)}</Text>}
      {!open && <Text numberOfLines={1} style={[t.meta, { flex: 1, minWidth: 0 }]}>{note.items[0] ?? ""}</Text>}
    </Pressable>
    {open && <View style={{ paddingLeft: 22, paddingBottom: 12 }}><VersionNotes note={note} theme={theme} /></View>}
  </View>;
}

/** Newest open, the next ones folded, then "and N older versions" past `cap`. */
export function NotesList({ notes, theme, compact, cap = 10, onMore }: { notes: readonly ReleaseNote[]; theme: Theme; compact: boolean; cap?: number; onMore?: () => void }) {
  const c = theme.colors; const t = text(c);
  const [first, ...rest] = notes;
  if (!first) return null;
  const shown = rest.slice(0, cap - 1);
  const hidden = rest.length - shown.length;
  return <View style={{ gap: 0 }}>
    <View style={{ gap: 8, paddingBottom: 14 }}><VersionHeader note={first} theme={theme} /><VersionNotes note={first} theme={theme} /></View>
    {shown.map(n => <FoldedVersion key={n.version} note={n} theme={theme} compact={compact} />)}
    {hidden > 0 && <Pressable accessibilityRole="button" onPress={onMore} disabled={!onMore}
      style={{ borderTopWidth: 1, borderTopColor: c.border, minHeight: compact ? 48 : 36, justifyContent: "center" }}>
      <Text style={[t.meta, onMore ? { color: c.foreground, fontWeight: "600" } : null]}>{`and ${hidden} older version${hidden === 1 ? "" : "s"}`}</Text>
    </Pressable>}
  </View>;
}

/**
 * "What's new in X": the host's dialog on desktop, its sheet on the phone. On the phone our own scroll body with a
 * pinned footer, so Close stays in thumb reach however long the notes are. "See all release notes" switches the same
 * sheet to every version, so nothing navigates away from under it.
 */
export function WhatsNewSheet({ open, notes, all, theme, compact, onClose, startAll = false }: { open: boolean; notes: readonly ReleaseNote[]; all: readonly ReleaseNote[]; theme: Theme; compact: boolean; onClose: () => void; startAll?: boolean }) {
  const c = theme.colors; const t = text(c);
  const [full, setFull] = useState(startAll);
  const list = full ? all : notes;
  const newest = list[0];
  if (!newest) return null;
  const meta = !full && list.length > 1 ? `${list.length} updates since you last looked` : null;
  const body = <>
    {meta && <Text style={t.meta}>{meta}</Text>}
    <NotesList notes={list} theme={theme} compact={compact} cap={full ? 50 : 10} onMore={full ? undefined : () => setFull(true)} />
  </>;
  const footer = (pinned: boolean) => <View style={{ borderTopWidth: 1, borderTopColor: c.border, flexDirection: compact ? "column" : "row", alignItems: compact ? "stretch" : "center", justifyContent: full ? "flex-end" : "space-between", gap: compact ? 4 : 8,
    ...(pinned ? { backgroundColor: c.surface1, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12 } : { paddingTop: 12, marginTop: 4 }) }}>
    {!full && all.length > list.length && <Button title="See all release notes" kind="ghost" theme={theme} compact={compact} grow={compact} onPress={() => setFull(true)} />}
    <Button title="Close" kind="secondary" theme={theme} compact={compact} grow={compact} onPress={onClose} />
  </View>;
  return <Modal title={full ? "Release notes" : `What's new in ${newest.version}`} open={open} onOpenChange={next => { if (!next) onClose(); }}>
    {compact
      ? <Modal.Content scrollable={false} contentContainerStyle={{ padding: 0, gap: 0 }} style={{ flex: 1 }}>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 16, gap: 12 }}>{body}</ScrollView>
        {footer(true)}
      </Modal.Content>
      // Desktop: the dialog sizes to its notes (up to the host's 85%); Esc and the X close it too.
      : <Modal.Content contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 4, paddingBottom: 16, gap: 12 }}>{body}{footer(false)}</Modal.Content>}
  </Modal>;
}

/**
 * Where "seen" lives. Web and desktop keep it per device (localStorage). The native app has no localStorage, so it
 * falls back to the host's record: What's new then shows once per host there, not on every launch.
 */
const persistent = () => { try { return typeof (globalThis as { localStorage?: Storage }).localStorage?.getItem === "function"; } catch { return false; } };
const seenOnDevice = (view: ReleaseNotesView) => persistent() ? deviceStorage.get(LAST_SEEN_KEY) : view.hostSeen;

// One What's new per app session: the first mounted Follow-up surface claims it, the rest render nothing.
let claimedBy: string | null = null;
const listeners = new Set<() => void>();
const claimVersion = () => claimedBy;
const subscribeClaim = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/**
 * Shows "What's new" once per device per version, on whichever Follow-up surface mounts first (Home, the workspace
 * panel or the sidebar item). Never on a first install and never while setup is showing or still loading.
 */
export function WhatsNewGate({ surface, theme, compact }: { surface: string; theme: Theme; compact: boolean }) {
  const query = useReleaseNotes();
  // Pending counts as showing, so What's new never flashes up before the setup flow takes the screen.
  const ob = useOnboarding();
  const onboarding = ob.isPending || !!ob.data?.show;
  const owner = useSyncExternalStore(subscribeClaim, claimVersion, claimVersion);
  const seen = useRpc(whatsNewSeenRpc); const cache = useQueryClient();
  const [closed, setClosed] = useState(false);
  const view = query.data;
  const decision = useMemo(() => view ? whatsNew({ installed: view.version, deviceSeen: seenOnDevice(view), previous: view.previous, onboarding, notes: view.notes }) : null, [view, onboarding]);
  useEffect(() => {
    if (!decision || !view) return;
    if (!decision.show) { if (decision.record && persistent()) deviceStorage.set(LAST_SEEN_KEY, decision.record); return; }
    if (claimedBy == null) { claimedBy = surface; listeners.forEach(l => l()); }
  }, [decision, view, surface]);
  useEffect(() => () => { if (claimedBy === surface) { claimedBy = null; listeners.forEach(l => l()); } }, [surface]);
  if (!view || !decision?.show || owner !== surface || closed) return null;
  const close = () => {
    deviceStorage.set(LAST_SEEN_KEY, view.version); setClosed(true);
    void seen({ version: view.version }).then(v => cache.setQueryData(releaseNotesKey, v), () => undefined);
  };
  return <WhatsNewSheet open notes={decision.notes} all={view.notes} theme={theme} compact={compact} onClose={close} />;
}

/** What's new opened by hand (Home's footer, Settings): since the previous version, or every version with `all`. */
export function ReleaseNotesSheet({ theme, compact, all = false, onClose }: { theme: Theme; compact: boolean; all?: boolean; onClose: () => void }) {
  const view = useReleaseNotes().data;
  if (!view) return null;
  return <WhatsNewSheet open notes={recentNotes(view)} all={view.notes} startAll={all} theme={theme} compact={compact} onClose={onClose} />;
}

/** Home's quiet footer: "Follow-up 1.4.0-beta.21 · Release notes", or "Updated to … 2h ago · What's new" for 3 days. */
export function VersionLine({ theme, compact, onOpen }: { theme: Theme; compact: boolean; onOpen: (all: boolean) => void }) {
  const c = theme.colors; const t = text(c);
  const now = useNow(60_000);
  const view = useReleaseNotes().data;
  if (!view) return <View style={{ height: 32 }} />;
  const recent = recentUpdate(view, now);
  const ago = recent ? Math.round((now - view.updatedAt!) / 3_600_000) : 0;
  const label = recent ? `Updated to ${view.version} ${ago < 1 ? "just now" : ago < 48 ? `${ago}h ago` : `${Math.round(ago / 24)} days ago`}` : `Follow-up ${view.version}`;
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 16, paddingTop: 12, paddingBottom: compact ? 0 : 48 }}>
    <Text style={t.small}>{label}</Text>
    <Text style={t.small}>·</Text>
    <Pressable accessibilityRole="link" hitSlop={compact ? 14 : 6} onPress={() => onOpen(!recent)}>
      {state => <Text style={[t.small, { color: c.foreground, textDecorationLine: (state as { hovered?: boolean }).hovered ? "underline" : "none" }]}>{recent ? "What's new" : "Release notes"}</Text>}
    </Pressable>
  </View>;
}
