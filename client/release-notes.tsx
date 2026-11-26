import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { PagedRows, usePagedList } from "./paged-list";
import { Image, Platform, Modal as RNModal, View, useWindowDimensions, type ScrollView as NativeScrollView, type StyleProp, type ViewStyle } from "react-native";
import { Pressable, Text } from "./text";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, ScrollView } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { releaseNotesRpc, whatsNewSeenRpc } from "../shared/contracts";
import { LAST_SEEN_KEY, deviceSeenFrom, inlineRuns, notesFeed, plainInline, whatsNew, type FeedNote, type InlineRun, type NoteBlock, type ReleaseNote, type ReleaseNotesView } from "../shared/changelog";
import { deviceStorage, viewStatus } from "../shared/settings-nav";
import { useViewVersion } from "./view-store";
import { Button, text, type Theme } from "./kit";
import { useOnboarding } from "./onboarding";
import { useReducedMotion } from "./motion";
import { NOTES_SCROLL_ATTR, notesScrollbarCss } from "../shared/notes-scrollbar";
import { ImageViewer, ImageViewerContext, refocus, useImageViewer, viewerInline, type ViewedImage } from "./image-viewer";

/**
 * Release notes on the client: What's new, one scroll of every stable version's notes, shown after an update and from
 * Home's version line and Settings. The notes come from the installed package's CHANGELOG.md through
 * `follow.release-notes`, read once per app session.
 */

export const releaseNotesKey = ["follow-up", "release-notes"];
/** The updater's view (`client/updates.tsx` reads it); here only for its pending notes. */
export const updatesKey = ["follow-up", "updates"];
export function useReleaseNotes() {
  const read = useRpc(releaseNotesRpc);
  return useQuery({ queryKey: releaseNotesKey, queryFn: () => read({}), staleTime: Infinity, retry: 1 });
}

/** A version's date in full, as Paseo's notes write it: "November 26, 2026". */
const fmtDate = (iso: string | null) => iso ? new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : null;


/** A line's text with its bold runs semibold (the weight headings use), or the plain text when nothing is bold. */
const inline = (line: string, runs?: InlineRun[]): ReactNode =>
  runs ? runs.map((r, i) => r.bold ? <Text key={i} style={{ fontWeight: "600" }}>{r.text}</Text> : r.text) : line;

/** One bullet: a small dot and its text. */
function Bullet({ text: line, runs, theme, compact }: { text: string; runs?: InlineRun[]; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  return <View style={{ flexDirection: "row", gap: 8 }}>
    <View style={{ width: 4, height: 4, borderRadius: 2, marginTop: compact ? 8 : 7, backgroundColor: c.foregroundMuted }} />
    <Text style={[t.body, { flex: 1 }]}>{inline(line, runs)}</Text>
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
 * One version's notes. Shared by What's new and Settings' update card. A curated section (an intro, headings,
 * paragraphs and images, like 2.0.0) reads in full as written, its intro as the first paragraph; whatever follows a
 * `---` rule (the credits) reads as a quiet footnote. Every bullet shows: only a caller that previews a version
 * (Settings' "What's in X", `max`) folds a long list behind "Show all N".
 */
export function VersionNotes({ note, theme, compact = false, max = Infinity }: { note: ReleaseNote; theme: Theme; compact?: boolean; max?: number }) {
  const c = theme.colors; const t = text(c, compact);
  const [all, setAll] = useState(false);
  // A preview (`max`) folds behind "Show all N", which opens pages, never every bullet (client/paged-list.tsx).
  const page = usePagedList({ items: note.items, open: all, onToggle: () => setAll(v => !v), preview: max, theme, compact, noun: "changes" });
  if (note.blocks?.length) {
    const quietFrom = note.blocks.findIndex(b => b.kind === "rule");
    // Headings sit a step above body text and closer to the paragraph they open than to the one before.
    return <View style={{ gap: 8 }}>
      {note.blocks.map((b, i) => {
        const quiet = quietFrom >= 0 && i > quietFrom;
        if (b.kind === "image") return <NoteImage key={i} block={b} theme={theme} compact={compact} />;
        if (b.kind === "rule") return <View key={i} style={{ height: 1, backgroundColor: c.border, marginTop: 16, marginBottom: 4 }} />;
        // Section headings: body size, semibold (the label role), so in the feed the version number stays the strongest
        // line and a curated section's headings read as its parts, never as versions of their own.
        if (b.kind === "heading") return <Text key={i} accessibilityRole="header" style={[quiet ? [t.meta, { fontWeight: "600" }] : [t.label, { marginTop: i ? 12 : 0 }]]}>{b.text}</Text>;
        if (b.kind === "text") return <Text key={i} style={[quiet ? t.meta : t.body]}>{inline(b.text, b.runs)}</Text>;
        return <Bullet key={i} text={b.text} runs={b.runs} theme={theme} compact={compact} />;
      })}
    </View>;
  }
  return <View style={{ gap: 8 }}>
    {page.shown.map((item, i) => { const runs = inlineRuns(item); return <Bullet key={i} text={plainInline(item)} runs={runs.some(r => r.bold) ? runs : undefined} theme={theme} compact={compact} />; })}
    {page.footer}
  </View>;
}

/**
 * A version's header row, as Paseo's own What's new draws it: the number on the left, an Installed pill on the one
 * this host runs, the date on the right, and a rule under it. A heading for screen readers ("2.4.1, installed,
 * November 25, 2026"), so they can jump version to version.
 */
function VersionHeader({ note, theme, compact }: { note: FeedNote; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const date = fmtDate(note.date);
  return <View accessibilityRole="header" accessibilityLabel={[note.version, note.installed ? "installed" : null, date].filter(Boolean).join(", ")}
    style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingBottom: compact ? 10 : 12, borderBottomWidth: 1, borderBottomColor: c.border }}>
    <Text style={{ color: c.foreground, fontSize: compact ? 19 : 18, lineHeight: compact ? 25 : 24, fontWeight: "500", fontVariant: ["tabular-nums"] }}>{note.version}</Text>
    {note.installed && <View style={{ paddingHorizontal: 8, paddingVertical: 1, borderRadius: 999, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface2 }}>
      <Text style={[t.meta, { color: c.foregroundMuted }]}>Installed</Text>
    </View>}
    <View style={{ flex: 1 }} />
    {date && <Text numberOfLines={1} style={[t.meta, { flexShrink: 1 }]}>{date}</Text>}
  </View>;
}

/** A version can carry tens of blocks and screenshots: a page of the feed holds a few versions. */
export const VERSIONS_PER_PAGE = 5;
/** Every version, newest first: each one's header and its notes, nothing folded, `VERSIONS_PER_PAGE` versions a page. */
export function NotesFeed({ feed, theme, compact }: { feed: readonly FeedNote[]; theme: Theme; compact: boolean }) {
  return <View style={{ gap: compact ? 32 : 36 }}>
    <PagedRows items={feed} size={VERSIONS_PER_PAGE} theme={theme} compact={compact} noun="versions" row={n => <View key={n.version} style={{ gap: compact ? 14 : 16 }}>
      <VersionHeader note={n} theme={theme} compact={compact} />
      <VersionNotes note={n} theme={theme} compact={compact} />
    </View>} />
  </View>;
}

/**
 * The notes' scroll body: its scrollbar stays visible whenever the notes overflow. Web: the scoped style above, put
 * in the page once and kept to the current theme. Android: persistentScrollbar. iOS: native.
 */
function NotesScroll({ theme, style, contentContainerStyle, children }: { theme: Theme; style: StyleProp<ViewStyle>; contentContainerStyle: StyleProp<ViewStyle>; children: ReactNode }) {
  const ref = useRef<NativeScrollView>(null);
  const css = notesScrollbarCss(theme.colors);
  useEffect(() => {
    type El = { id: string; textContent: string | null; isConnected: boolean; setAttribute(k: string, v: string): void };
    const doc = (globalThis as { document?: { getElementById(id: string): El | null; createElement(tag: string): El; head: { appendChild(el: El): void } } }).document;
    if (Platform.OS !== "web" || !doc) return;
    const node = ((ref.current as unknown as { getScrollableNode?: () => unknown } | null)?.getScrollableNode?.() ?? ref.current) as { setAttribute?: (k: string, v: string) => void } | null;
    node?.setAttribute?.(NOTES_SCROLL_ATTR, "");
    const id = "follow-up-notes-scrollbar";
    const tag = doc.getElementById(id) ?? Object.assign(doc.createElement("style"), { id });
    if (tag.textContent !== css) tag.textContent = css;
    if (!tag.isConnected) doc.head.appendChild(tag);
  }, [css]);
  return <ScrollView ref={ref} style={style} contentContainerStyle={contentContainerStyle} showsVerticalScrollIndicator persistentScrollbar>{children}</ScrollView>;
}

/**
 * What's new and the release notes are one view, so one title, naming the plugin from its manifest (the view's
 * `name`): "What's new in Follow-up". Exported for the tests.
 */
export const notesTitle = (name: string) => `What's new in ${name}`;
/** The release pages, from the header's open-in-browser icon: the one URL the notes open (a screenshot never does). */
const openReleases = (url: string) => { void openExternalUrl(url).catch(() => undefined); };

/** The host sheet's own inset on the phone, so our body lines up with its title. */
const SHEET_INSET = 24;
/**
 * Desktop draws the notes in a dialog of our own, so its header can carry the open-in-browser icon beside the X (the
 * host's Modal has a title and nothing else). The dialog is as wide as the reading column plus its inset, and nothing
 * inside caps itself: text, version rules, dates, screenshots, the credits' rule and the header's icons all share one
 * right edge (2026-11-26: an 840px dialog capped only its text at 600px, leaving a dead band right of every line, the
 * rules and icons past it). A screenshot shows larger in the image viewer.
 */
const NOTES_COLUMN = 600; const DIALOG_INSET = 24;

/**
 * The desktop dialog, drawn like the host's (same dim, card and X) with Paseo's What's new header: a gift, the title,
 * the release pages and Close. `onDismiss` is the notes' own close: Esc, the dim and the X all go through it.
 */
function NotesDialog({ title, open, onDismiss, theme, width, releases, openUrl, children, overlay }: { title: string; open: boolean; onDismiss: () => void; theme: Theme; width: number; releases: string | null; openUrl: (url: string) => void; children: ReactNode; overlay?: ReactNode }) {
  const c = theme.colors;
  const reduced = useReducedMotion();
  const close = useRef<View>(null);
  useEffect(() => { if (open) (close.current as unknown as { focus?: () => void } | null)?.focus?.(); }, [open]);
  const headerButton = (state: { hovered?: boolean }) => ({ padding: 8, borderRadius: 8, backgroundColor: state.hovered ? c.surface1 : "transparent" });
  return <RNModal transparent visible={open} animationType={reduced ? "none" : "fade"} onRequestClose={onDismiss}>
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, backgroundColor: "rgba(0,0,0,0.55)" }}>
      <Pressable accessible={false} focusable={false} importantForAccessibility="no" onPress={onDismiss} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }} />
      <View role="dialog" aria-modal aria-label={title} style={{ width, maxHeight: "85%", flexShrink: 1, minHeight: 0, overflow: "hidden", backgroundColor: c.surface0, borderRadius: 12, borderWidth: 1, borderColor: c.surface2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingLeft: DIALOG_INSET, paddingRight: DIALOG_INSET - 8, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: c.surface2 }}>
          <Icon name="Gift" size={16} color={c.foregroundMuted} />
          <Text role="heading" numberOfLines={1} style={{ flex: 1, minWidth: 0, color: c.foreground, fontSize: 14, fontWeight: "500" }}>{title}</Text>
          {releases && <Pressable accessibilityRole="link" accessibilityLabel="Release notes on GitHub" accessibilityHint="Every version's full changelog, in your browser" onPress={() => openUrl(releases)} style={state => headerButton(state as { hovered?: boolean })}>
            {state => <Icon name="ExternalLink" size={16} color={state.pressed ? c.foreground : c.foregroundMuted} />}
          </Pressable>}
          <Pressable ref={close} accessibilityRole="button" accessibilityLabel="Close" onPress={onDismiss} style={state => headerButton(state as { hovered?: boolean })}>
            {state => <Icon name="X" size={16} color={state.pressed ? c.foreground : c.foregroundMuted} />}
          </Pressable>
        </View>
        <NotesScroll theme={theme} style={{ flexShrink: 1, minHeight: 0 }} contentContainerStyle={{ paddingHorizontal: DIALOG_INSET, paddingTop: 24, paddingBottom: 32 }}>{children}</NotesScroll>
      </View>
      {overlay}
    </View>
  </RNModal>;
}

/**
 * "What's new in X": every stable version's notes in one scroll, newest first, like Paseo's own (invariant 120,
 * `notes-read-like-one-feed`). It always opens at the top, the newest version; older ones are a scroll away, never a
 * fold or a second view. Desktop: our dialog, with the release pages (each version's full changelog) behind the
 * header's open-in-browser icon. Phone: the host's sheet with our scroll body and a pinned footer, so Close and the
 * release pages stay in thumb reach however long the notes are. A tapped screenshot opens the image viewer over the
 * notes; Esc or a click closes the viewer first, then the notes.
 */
export function WhatsNewSheet({ open, name, feed, releases, theme, compact, onClose, openUrl = openReleases }: { open: boolean; name: string; feed: readonly FeedNote[]; releases: string | null; theme: Theme; compact: boolean; onClose: () => void; openUrl?: (url: string) => void }) {
  const c = theme.colors;
  const [viewing, setViewing] = useState<{ image: ViewedImage; from: unknown } | null>(null);
  const win = useWindowDimensions();
  if (!feed.length) return null;
  const closeViewer = () => { const from = viewing?.from; setViewing(null); refocus(from); };
  const dismiss = () => { if (viewing) closeViewer(); else onClose(); };
  const viewer = viewing && <ImageViewer image={viewing.image} inline={viewerInline(compact)} onClose={closeViewer} />;
  const body = <ImageViewerContext.Provider value={(image, from) => setViewing({ image, from })}>
    <NotesFeed feed={feed} theme={theme} compact={compact} />
  </ImageViewerContext.Provider>;
  const title = notesTitle(name);
  // The viewer always sits outside the scroll view: react-native-web's ScrollView sets translateZ(0), which would trap
  // the viewer's fixed position inside the dialog.
  if (!compact) return <NotesDialog title={title} open={open} onDismiss={dismiss} theme={theme} releases={releases} openUrl={openUrl}
    width={Math.min(NOTES_COLUMN + 2 * DIALOG_INSET, win.width - 48)} overlay={viewer}>{body}</NotesDialog>;
  return <Modal title={title} open={open} onOpenChange={next => { if (!next) dismiss(); }}>
    <Modal.Content scrollable={false} contentContainerStyle={{ padding: 0, gap: 0 }} style={{ flex: 1 }}>
      <NotesScroll theme={theme} style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: SHEET_INSET, paddingTop: 16, paddingBottom: 24 }}>{body}</NotesScroll>
      <View style={{ borderTopWidth: 1, borderTopColor: c.border, flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: c.surface1, paddingHorizontal: SHEET_INSET - 8, paddingTop: 8, paddingBottom: 12 }}>
        {releases && <Button title="On GitHub" icon="ExternalLink" kind="ghost" theme={theme} compact accessibilityLabel="Release notes on GitHub" accessibilityHint="Every version's full changelog, in your browser" onPress={() => openUrl(releases)} />}
        <Button title="Close" kind="secondary" theme={theme} compact grow onPress={onClose} />
      </View>
      {viewer}
    </Modal.Content>
  </Modal>;
}

/** Notes for versions out but not installed, from the updater's view when it has been read (never fetched for this). */
function usePendingNotes(): readonly ReleaseNote[] {
  return useQueryClient().getQueryData<{ pendingNotes?: ReleaseNote[] }>(updatesKey)?.pendingNotes ?? [];
}

/**
 * Where "seen" lives: per device, in the device document on 0.16 (the phone included), else localStorage on web and
 * desktop. A native app without either falls back to the host's record: What's new then shows once per host there,
 * not on every launch. While the device document is still loading nothing decides (undefined), so What's new never
 * shows from a stale answer.
 */
const localStore = () => { try { return typeof (globalThis as { localStorage?: Storage }).localStorage?.getItem === "function"; } catch { return false; } };
const persistent = () => viewStatus() === "ready" || localStore();
const seenOnDevice = (view: ReleaseNotesView) => deviceSeenFrom({ status: viewStatus(), local: localStore(), stored: () => deviceStorage.get(LAST_SEEN_KEY), hostSeen: view.hostSeen });

// One What's new per app session: the first mounted Follow-up surface claims it, the rest render nothing.
let claimedBy: string | null = null;
const listeners = new Set<() => void>();
const claimVersion = () => claimedBy;
const subscribeClaim = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/**
 * Shows "What's new" once per device per version, on whichever Follow-up surface mounts first (Home, the workspace
 * panel or the sidebar item), after an update with notes (shared/changelog.ts `whatsNew`). Never on a first install,
 * after a beta, with Settings → General's switch off, or while setup is showing or still loading.
 */
export function WhatsNewGate({ surface, theme, compact }: { surface: string; theme: Theme; compact: boolean }) {
  const query = useReleaseNotes();
  // Pending counts as showing, so What's new never flashes up before the setup flow takes the screen.
  const ob = useOnboarding();
  const onboarding = ob.isPending || !!ob.data?.show;
  const owner = useSyncExternalStore(subscribeClaim, claimVersion, claimVersion);
  const seen = useRpc(whatsNewSeenRpc); const cache = useQueryClient();
  const pending = usePendingNotes();
  const [closed, setClosed] = useState(false);
  const view = query.data;
  const viewVersion = useViewVersion();
  const decision = useMemo(() => {
    const deviceSeen = view ? seenOnDevice(view) : undefined;
    return view && deviceSeen !== undefined ? whatsNew({ installed: view.version, deviceSeen, previous: view.previous, onboarding, enabled: view.enable_whats_new, notes: view.notes }) : null;
  }, [view, onboarding, viewVersion]);
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
  return <WhatsNewSheet open name={view.name} feed={notesFeed(view.notes, view.version, pending)} releases={view.releases} theme={theme} compact={compact} onClose={close} />;
}

/** What's new opened by hand (Home's version line, Settings → General): the same scroll, opened at the newest version. */
export function ReleaseNotesSheet({ theme, compact, onClose }: { theme: Theme; compact: boolean; onClose: () => void }) {
  const view = useReleaseNotes().data;
  const pending = usePendingNotes();
  if (!view) return null;
  return <WhatsNewSheet open name={view.name} feed={notesFeed(view.notes, view.version, pending)} releases={view.releases} theme={theme} compact={compact} onClose={onClose} />;
}
