import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Image, Modal as RNModal, View, useWindowDimensions } from "react-native";
import { Pressable, Text } from "./text";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, ScrollView } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { releaseNotesRpc, whatsNewSeenRpc } from "../shared/contracts";
import { LAST_SEEN_KEY, recentNotes, whatsNew, type NoteBlock, type ReleaseNote, type ReleaseNotesView } from "../shared/changelog";
import { deviceStorage } from "../shared/settings-nav";
import { Button, text, type Theme } from "./kit";
import { useOnboarding } from "./onboarding";
import { useReducedMotion } from "./motion";
import { ImageViewer, ImageViewerContext, refocus, useImageViewer, viewerInline, type ViewedImage } from "./image-viewer";

/**
 * Release notes on the client: What's new after an update, the full list, and Home's quiet version line. The notes
 * come from the installed package's CHANGELOG.md through `follow.release-notes`, read once per app session.
 */

export const releaseNotesKey = ["follow-up", "release-notes"];
export function useReleaseNotes() {
  const read = useRpc(releaseNotesRpc);
  return useQuery({ queryKey: releaseNotesKey, queryFn: () => read({}), staleTime: Infinity, retry: 1 });
}

const fmtDate = (iso: string | null) => iso ? new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : null;

/** Hidden from screen readers: a visual separator only. */
const Dot = ({ style }: { style: object }) => <Text style={style} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden>·</Text>;

/**
 * The text measure in the wide dialog: text lines stop here (about 75 characters) while screenshots use the full
 * width. Unset (no cap) in the host's 520px dialog, on phones and in Settings' inline notes.
 */
const MeasureContext = createContext<number | undefined>(undefined);
const useMeasure = () => { const m = useContext(MeasureContext); return m ? { maxWidth: m } : null; };

/** One bullet: a small dot and its text. */
function Bullet({ text: line, theme, compact }: { text: string; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  return <View style={[{ flexDirection: "row", gap: 8 }, useMeasure()]}>
    <View style={{ width: 4, height: 4, borderRadius: 2, marginTop: compact ? 8 : 7, backgroundColor: c.foregroundMuted }} />
    <Text style={[t.body, { flex: 1 }]}>{line}</Text>
  </View>;
}

/**
 * A screenshot in the notes: at most its CSS width (never larger than the UI it shows) and at most the column, left
 * aligned like the text, at its own shape (reserved before it loads, so nothing below it jumps), in a hairline frame
 * with the host's radius. It loads by URL; if it can't (offline, blocked), it is left out entirely, with
 * no empty frame. It is a button (react-native-web maps no role from "imagebutton"). A tap shows it larger in Follow-up's image viewer, over the notes; it never opens a browser tab.
 */
function NoteImage({ block, theme, compact }: { block: Extract<NoteBlock, { kind: "image" }>; theme: Theme; compact: boolean }) {
  const c = theme.colors;
  const [failed, setFailed] = useState(false);
  const [aspect, setAspect] = useState(block.aspect ?? 16 / 10);
  const viewer = useImageViewer();
  const self = useRef<View>(null);
  // Outside a notes dialog (Settings' inline notes) the image shows its own viewer.
  const [own, setOwn] = useState(false);
  if (failed) return null;
  const image: ViewedImage = { url: block.url, label: block.text, width: block.width, aspect };
  return <>
  <Pressable ref={self} role="button" accessibilityLabel={block.text} accessibilityHint="Shows the image larger"
    onPress={() => { if (viewer) viewer(image, self.current); else setOwn(true); }}
    style={state => ({ alignSelf: "stretch", maxWidth: block.width ?? undefined, marginVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: (state as { hovered?: boolean }).hovered ? c.foregroundMuted : c.border, overflow: "hidden", backgroundColor: c.surface1, opacity: state.pressed ? 0.85 : 1, cursor: "zoom-in" } as object)}>
    <Image source={{ uri: block.url }} accessibilityIgnoresInvertColors resizeMode="cover" style={{ width: "100%", aspectRatio: aspect }}
      onError={() => setFailed(true)}
      onLoad={e => { const src = (e.nativeEvent as { source?: { width?: number; height?: number } } | undefined)?.source; if (!block.aspect && src?.width && src?.height) setAspect(src.width / src.height); }} />
  </Pressable>
  {own && <ImageViewer image={image} inline={false} onClose={() => { setOwn(false); refocus(self.current); }} />}
  </>;
}

/**
 * One version's notes. Shared by What's new, the release notes and Settings. A curated section (headings, paragraphs
 * and images, like 2.0.0) reads in full as written: its opening paragraph a step larger as the intro, and whatever
 * follows a `---` rule (the credits) as a quiet footnote. A list of bullets folds past `max` behind "Show all N".
 */
export function VersionNotes({ note, theme, compact = false, max = 8 }: { note: ReleaseNote; theme: Theme; compact?: boolean; max?: number }) {
  const c = theme.colors; const t = text(c, compact);
  const [all, setAll] = useState(false);
  const measure = useMeasure();
  if (note.blocks?.length) {
    const lead: object = { fontSize: compact ? 16 : 15, lineHeight: compact ? 24 : 22 };
    const quietFrom = note.blocks.findIndex(b => b.kind === "rule");
    // Headings sit a step above body text and closer to the paragraph they open than to the one before.
    return <View style={{ gap: 6 }}>
      {note.blocks.map((b, i) => {
        const quiet = quietFrom >= 0 && i > quietFrom;
        if (b.kind === "image") return <NoteImage key={i} block={b} theme={theme} compact={compact} />;
        if (b.kind === "rule") return <View key={i} style={{ height: 1, backgroundColor: c.border, marginTop: 16, marginBottom: 4 }} />;
        // Section headings: semibold, one step above body (body 13/14, heading 15/17, the title role), clearly headings.
        if (b.kind === "heading") return <Text key={i} accessibilityRole="header" style={[quiet ? [t.meta, { fontWeight: "600" }] : [t.title, { fontWeight: "600", marginTop: i ? 16 : 0 }], measure]}>{b.text}</Text>;
        if (b.kind === "text") return <Text key={i} style={[quiet ? t.meta : i === 0 ? [t.body, lead] : t.body, measure]}>{b.text}</Text>;
        return <Bullet key={i} text={b.text} theme={theme} compact={compact} />;
      })}
    </View>;
  }
  const items = all ? note.items : note.items.slice(0, max);
  return <View style={{ gap: 6 }}>
    {items.map((item, i) => <Bullet key={i} text={item} theme={theme} compact={compact} />)}
    {!all && note.items.length > max && <Pressable accessibilityRole="button" onPress={() => setAll(true)} hitSlop={compact ? { top: 14, bottom: 14, left: 8, right: 8 } : 6}
      style={{ minHeight: compact ? 44 : undefined, justifyContent: "center", alignSelf: "flex-start" }}>
      <Text style={[t.label, { color: c.foreground, fontWeight: "600" }]}>{`Show all ${note.items.length}`}</Text>
    </Pressable>}
  </View>;
}

/** "1.4.0-beta.14 · Nov 10", a heading for screen readers. `dateOnly` when the title already names the version. */
function VersionHeader({ note, theme, compact, dateOnly = false }: { note: ReleaseNote; theme: Theme; compact: boolean; dateOnly?: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const date = fmtDate(note.date);
  if (dateOnly) return date ? <Text style={t.meta}>{`Released ${date}`}</Text> : null;
  return <View accessibilityRole="header" accessibilityLabel={`${note.version}${date ? `, ${date}` : ""}`} style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
    <Text style={[t.label, { fontVariant: ["tabular-nums"] }]}>{note.version}</Text>
    {date && <><Dot style={t.meta} /><Text style={t.meta}>{date}</Text></>}
  </View>;
}

/** An older version, folded to its first note; opens in place. */
function FoldedVersion({ note, theme, compact }: { note: ReleaseNote; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const [open, setOpen] = useState(false);
  return <View style={{ borderTopWidth: 1, borderTopColor: c.border }}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} aria-expanded={open} accessibilityLabel={`${note.version}${note.date ? `, ${fmtDate(note.date)}` : ""}`} onPress={() => setOpen(o => !o)}
      // Hover fill only with a pointer; on touch a row would otherwise keep the last tap's fill.
      style={state => ({ flexDirection: "row", alignItems: "center", gap: 8, minHeight: compact ? 48 : 36, paddingVertical: 6, marginHorizontal: -8, paddingHorizontal: 8, borderRadius: 6, backgroundColor: state.pressed ? c.surface2 : !compact && (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
      <Icon name={open ? "ChevronDown" : "ChevronRight"} size={14} color={c.foregroundMuted} />
      <Text accessibilityRole="header" style={[t.label, { fontVariant: ["tabular-nums"], flexShrink: 0 }]}>{note.version}</Text>
      {note.date && <Text style={[t.meta, { flexShrink: 0 }]}>{fmtDate(note.date)}</Text>}
      {!open && <Text numberOfLines={1} style={[t.meta, { flex: 1, minWidth: 0 }]}>{note.items[0] ?? note.blocks?.find(b => b.kind === "text" || b.kind === "bullet")?.text ?? ""}</Text>}
    </Pressable>
    {open && <View style={{ paddingLeft: 22, paddingBottom: 12 }}><VersionNotes note={note} theme={theme} compact={compact} /></View>}
  </View>;
}

/**
 * Newest open, the next ones folded, then "and N older versions" past `cap` (a button only when `onMore` shows them).
 * `titled`: the sheet's title already names the newest version, so its header shows just the date.
 */
export function NotesList({ notes, theme, compact, cap = 10, onMore, titled = false }: { notes: readonly ReleaseNote[]; theme: Theme; compact: boolean; cap?: number; onMore?: () => void; titled?: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const [first, ...rest] = notes;
  if (!first) return null;
  const shown = rest.slice(0, cap - 1);
  const hidden = rest.length - shown.length;
  const more = `and ${hidden} older version${hidden === 1 ? "" : "s"}`;
  return <View style={{ gap: 0 }}>
    <View style={{ gap: 8, paddingBottom: 14 }}><VersionHeader note={first} theme={theme} compact={compact} dateOnly={titled} /><VersionNotes note={first} theme={theme} compact={compact} /></View>
    {shown.map(n => <FoldedVersion key={n.version} note={n} theme={theme} compact={compact} />)}
    {hidden > 0 && (onMore
      ? <Pressable accessibilityRole="button" onPress={onMore} style={{ borderTopWidth: 1, borderTopColor: c.border, minHeight: compact ? 48 : 36, justifyContent: "center" }}>
        <Text style={[t.meta, { color: c.foreground, fontWeight: "600" }]}>{more}</Text>
      </Pressable>
      : <View style={{ borderTopWidth: 1, borderTopColor: c.border, minHeight: compact ? 48 : 36, justifyContent: "center" }}><Text style={t.meta}>{more}</Text></View>)}
  </View>;
}

/** The host sheet's own inset on the phone, so our body lines up with its title. */
const SHEET_INSET = 24;
/**
 * From this window width the notes get a wider dialog of their own: the host's Modal is 520px wide with no way to
 * widen it, which leaves Home's screenshot at under half its size on a large screen. Below it, the host's dialog.
 */
const WIDE_FROM = 1280; const WIDE_CARD = 840; const TEXT_MEASURE = 600;

/**
 * The wide dialog, drawn like the host's (same dim, card, header and X) so the two widths read as one dialog.
 * `onDismiss` is the notes' own close: Esc, the dim and the X all go through it.
 */
function WideDialog({ title, open, onDismiss, theme, width, children, overlay }: { title: string; open: boolean; onDismiss: () => void; theme: Theme; width: number; children: ReactNode; overlay?: ReactNode }) {
  const c = theme.colors;
  const reduced = useReducedMotion();
  const close = useRef<View>(null);
  useEffect(() => { if (open) (close.current as unknown as { focus?: () => void } | null)?.focus?.(); }, [open]);
  return <RNModal transparent visible={open} animationType={reduced ? "none" : "fade"} onRequestClose={onDismiss}>
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, backgroundColor: "rgba(0,0,0,0.55)" }}>
      <Pressable accessible={false} focusable={false} importantForAccessibility="no" onPress={onDismiss} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }} />
      <View role="dialog" aria-modal aria-label={title} style={{ width, maxHeight: "85%", flexShrink: 1, minHeight: 0, overflow: "hidden", backgroundColor: c.surface0, borderRadius: 12, borderWidth: 1, borderColor: c.surface2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 24, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: c.surface2 }}>
          <Text role="heading" numberOfLines={1} style={{ flex: 1, minWidth: 0, color: c.foreground, fontSize: 14, fontWeight: "500" }}>{title}</Text>
          <Pressable ref={close} accessibilityRole="button" accessibilityLabel="Close" onPress={onDismiss} style={state => ({ padding: 8, marginRight: -8, borderRadius: 8, backgroundColor: (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
            {state => <Icon name="X" size={16} color={state.pressed ? c.foreground : c.foregroundMuted} />}
          </Pressable>
        </View>
        <ScrollView style={{ flexShrink: 1, minHeight: 0 }} contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 16, paddingBottom: 16, gap: 12 }}>{children}</ScrollView>
      </View>
      {overlay}
    </View>
  </RNModal>;
}

/**
 * "What's new in X": the host's dialog on desktop (a wider one of ours from 1280px windows), its sheet on the phone.
 * On the phone our own scroll body with a pinned footer, so Close stays in thumb reach however long the notes are.
 * "See all release notes" switches the same sheet to every version, so nothing navigates away from under it. A tapped
 * screenshot opens the image viewer over the notes; Esc or a click closes the viewer first, then the notes.
 */
export function WhatsNewSheet({ open, notes, all, theme, compact, onClose, startAll = false }: { open: boolean; notes: readonly ReleaseNote[]; all: readonly ReleaseNote[]; theme: Theme; compact: boolean; onClose: () => void; startAll?: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const [full, setFull] = useState(startAll);
  const [viewing, setViewing] = useState<{ image: ViewedImage; from: unknown } | null>(null);
  const win = useWindowDimensions();
  const list = full ? all : notes;
  const newest = list[0];
  if (!newest) return null;
  const wide = !compact && win.width >= WIDE_FROM;
  const closeViewer = () => { const from = viewing?.from; setViewing(null); refocus(from); };
  const dismiss = () => { if (viewing) closeViewer(); else onClose(); };
  const meta = !full && list.length > 1 ? `${list.length} versions since you last looked` : null;
  const body = <>
    {meta && <Text style={t.meta}>{meta}</Text>}
    <NotesList notes={list} theme={theme} compact={compact} cap={full ? all.length : 10} onMore={full ? undefined : () => setFull(true)} titled={!full} />
  </>;
  const footer = (pinned: boolean) => <View style={{ borderTopWidth: 1, borderTopColor: c.border, flexDirection: compact ? "column" : "row", alignItems: compact ? "stretch" : "center", justifyContent: full ? "flex-end" : "space-between", gap: compact ? 4 : 8,
    ...(pinned ? { backgroundColor: c.surface1, paddingHorizontal: SHEET_INSET - 8, paddingTop: 8, paddingBottom: 12 } : { paddingTop: 12, marginTop: 4 }) }}>
    {!full && all.length > list.length && <Button title="See all release notes" kind="ghost" theme={theme} compact={compact} grow={compact} onPress={() => setFull(true)} />}
    <Button title="Close" kind="secondary" theme={theme} compact={compact} grow={compact} onPress={onClose} />
  </View>;
  const viewer = viewing && <ImageViewer image={viewing.image} inline={viewerInline(compact)} onClose={closeViewer} />;
  const provide = (children: ReactNode) => <ImageViewerContext.Provider value={(image, from) => setViewing({ image, from })}>
    <MeasureContext.Provider value={wide ? TEXT_MEASURE : undefined}>{children}</MeasureContext.Provider>
  </ImageViewerContext.Provider>;
  const title = full ? "Release notes" : `What's new in ${newest.version}`;
  // The viewer always sits outside the scroll view: react-native-web's ScrollView sets translateZ(0), which would trap
  // the viewer's fixed position inside the dialog.
  if (wide) return <WideDialog title={title} open={open} onDismiss={dismiss} theme={theme} width={Math.min(WIDE_CARD, win.width - 96)} overlay={viewer}>
    {provide(<>{body}{footer(false)}</>)}
  </WideDialog>;
  return <Modal title={title} open={open} onOpenChange={next => { if (!next) dismiss(); }}>
    {compact
      ? <Modal.Content scrollable={false} contentContainerStyle={{ padding: 0, gap: 0 }} style={{ flex: 1 }}>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: SHEET_INSET, paddingTop: 12, paddingBottom: 16, gap: 12 }}>{provide(body)}</ScrollView>
        {footer(true)}{viewer}
      </Modal.Content>
      // Desktop: the host's dialog at its 85% height with our own scroll body, so the viewer can sit outside it; Esc and
      // the X close it too (the viewer first).
      : <Modal.Content scrollable={false} contentContainerStyle={{ padding: 0, gap: 0 }} style={{ flex: 1 }}>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 4, paddingBottom: 16, gap: 12 }}>{provide(<>{body}{footer(false)}</>)}</ScrollView>
        {viewer}
      </Modal.Content>}
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

/** What's new opened by hand (Home's footer): since the previous version, or every version with `all`. */
export function ReleaseNotesSheet({ theme, compact, all = false, onClose }: { theme: Theme; compact: boolean; all?: boolean; onClose: () => void }) {
  const view = useReleaseNotes().data;
  if (!view) return null;
  return <WhatsNewSheet open notes={recentNotes(view)} all={view.notes} startAll={all} theme={theme} compact={compact} onClose={onClose} />;
}
