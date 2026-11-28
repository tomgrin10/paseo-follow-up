import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { Platform, View } from "react-native";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/ui";
import { Pressable, Text } from "./text";
import { Button, focusRing, type Theme } from "./kit";
import { Spinner } from "./motion";
import { isLight, raised, runningColor, withAlpha, type Colors } from "./theme";
import { FloatingSurface } from "./floating-surface";
import { useMarked, useMarkedOnScreen } from "./on-screen";
import { PermissionBlock, useAgentLive } from "./home";
import { agentTurnRpc } from "../shared/contracts";
import { isLoaded, type LoadSignals } from "../shared/agent-load";
import { errorText } from "../shared/errors";
import { since } from "../shared/now";
import { fitTurn, foldTurn, runLabel, runSteps, turnSource, type Turn, type TurnItem, type TurnRow, type TurnSource, type TurnStep } from "../shared/turn";
import { PEEK_CLOSED, peekStep, peekWait, pointerWhere, timelineOnScreen, type PeekEvent } from "../shared/peek";

/**
 * The agent's current turn, drawn the way its chat draws it (Chat Polish's look; shared/turn.ts says what is copied).
 * `TurnView` is the rows only: the peek here and the workspace view's Recent steps both draw it, each with its own
 * header and footer. `useTurn` reads the turn without waking anyone (invariant a-peek-is-bounded-and-never-wakes):
 * a loaded agent's live timeline (a tail read and one subscription while mounted), an unloaded agent's saved
 * transcript through the server (follow.agent-turn), never the daemon's timeline.
 */

const mono = Platform.OS === "ios" ? "Menlo" : "ui-monospace, SFMono-Regular, Menlo, monospace";
const TAIL = 60;
/** Live pushes re-read the tail at most this often (a turn streams many events a second). */
const COALESCE_MS = 400;
/** Hosts without timeline subscriptions: re-read while mounted. */
const POLL_MS = 2_000;

export type TurnState = { turn: Turn | null; source: TurnSource | null; at: string | null; running: boolean; error: string | null };
const NOTHING: TurnState = { turn: null, source: null, at: null, running: false, error: null };

type Entry = { seqStart: number; item: TurnItem };
type AgentHandle = ReturnType<ReturnType<typeof usePaseo>["agents"]["ref"]>;

/** The turn of `agentId` while `enabled`: live when loaded, else the saved transcript. Null id or disabled reads nothing. */
export function useTurn(agentId: string | null | undefined, enabled = true): TurnState {
  const paseo = usePaseo();
  const readSaved = useRpc(agentTurnRpc);
  const [state, setState] = useState<TurnState>(NOTHING);
  useEffect(() => {
    setState(NOTHING);
    if (!agentId || !enabled) return;
    let live = true;
    const handle: AgentHandle = paseo.agents.ref(agentId);
    let off: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let reading = false, again = false;
    const running = () => handle.status === "running";
    const readLive = async () => {
      if (reading) { again = true; return; }
      reading = true;
      try {
        const page = await handle.timeline.refetch({ direction: "tail", limit: TAIL }) as unknown as { entries: Entry[] };
        if (!live) return;
        const items = [...page.entries].sort((a, b) => a.seqStart - b.seqStart).map(e => e.item);
        setState({ turn: foldTurn(items, running()), source: "live", at: null, running: running(), error: null });
      } catch (e) { if (live) setState(s => ({ ...s, error: errorText(e) })); }
      finally { reading = false; if (again && live) { again = false; void readLive(); } }
    };
    const soon = () => { if (!timer) timer = setTimeout(() => { timer = null; void readLive(); }, COALESCE_MS); };
    const readSavedTurn = async () => {
      try {
        const r = await readSaved({ agentId });
        if (live) setState({ turn: r.turn, source: "saved", at: r.at, running: false, error: null });
      } catch (e) { if (live) setState({ ...NOTHING, error: errorText(e) }); }
    };
    // The snapshot says whether the agent is loaded; only then is its timeline read (reading loads an unloaded agent).
    void handle.refresh().catch(() => null).then(() => {
      if (!live) return;
      const current = handle.current();
      if (!current || !isLoaded(current as unknown as LoadSignals)) { void readSavedTurn(); return; }
      void readLive();
      const timeline = handle.timeline as { subscribe?: AgentHandle["timeline"]["subscribe"] };
      if (timeline.subscribe) {
        const sub = timeline.subscribe(() => soon()) as unknown as (() => void) & { ready?: Promise<unknown> };
        off = () => sub();
        sub.ready?.catch(() => { if (live && !poll) poll = setInterval(soon, POLL_MS); });
      } else poll = setInterval(soon, POLL_MS);
    });
    return () => { live = false; off?.(); if (timer) clearTimeout(timer); if (poll) clearInterval(poll); };
  }, [paseo, readSaved, agentId, enabled]);
  return state;
}

// ---------- rows ----------

const size = { verb: 13, mono: 12, icon: 14, slot: 18, row: 24 };

/** The turn's rows, newest last, at most `maxRows` (older rows fold into one closed run). Header and footer are the caller's. */
export function TurnView({ turn, theme, maxRows, compact = false }: { turn: Turn; theme: Theme; maxRows?: number; compact?: boolean }) {
  const c = theme.colors;
  const shown = maxRows ? fitTurn(turn, maxRows) : turn;
  if (shown.empty) return <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17 }}>Nothing here yet. Its first steps show up as they happen.</Text>;
  return <View style={{ gap: 6 }}>
    {shown.rows.map((r, i) => <RowView key={r.kind === "run" ? r.key : `${r.kind}-${i}`} r={r} c={c} compact={compact} />)}
  </View>;
}

function RowView({ r, c, compact }: { r: TurnRow; c: Colors; compact: boolean }) {
  switch (r.kind) {
    case "you": return <View style={{ alignSelf: "flex-end", maxWidth: "88%", backgroundColor: c.surface2, borderRadius: 14, borderTopRightRadius: 4, paddingHorizontal: 10, paddingVertical: 6 }}>
      <Text numberOfLines={2} style={{ color: c.foreground, fontSize: 13, lineHeight: 18 }}>{r.text}</Text>
    </View>;
    case "message": return <View style={{ alignSelf: "flex-end", maxWidth: "88%", gap: 2, alignItems: "flex-end" }}>
      <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>{`From ${r.from}`}</Text>
      <View style={{ backgroundColor: c.surface2, borderRadius: 14, borderTopRightRadius: 4, paddingHorizontal: 10, paddingVertical: 6 }}>
        <Text numberOfLines={2} style={{ color: c.foreground, fontSize: 13, lineHeight: 18 }}>{r.text}</Text>
      </View>
    </View>;
    case "reply": return <Text numberOfLines={8} style={{ color: c.foreground, fontSize: 13, lineHeight: 19 }}>{r.text}</Text>;
    case "run": return <RunView r={r} c={c} compact={compact} />;
    case "tasks": return <View style={{ gap: 2 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: size.row }}>
        <View style={{ width: size.slot, alignItems: "center" }}><Icon name="ListChecks" size={size.icon} color={c.foregroundMuted} /></View>
        <Text style={{ color: c.foreground, fontSize: size.verb, fontWeight: "500" }}>Tasks</Text>
        <Text style={{ color: c.foregroundMuted, fontSize: size.mono, fontFamily: mono }}>{`${r.done} / ${r.total}`}</Text>
        <View style={{ width: 56, height: 3, borderRadius: 2, backgroundColor: withAlpha(c.foregroundMuted, 0.25), overflow: "hidden" }}>
          <View style={{ width: `${r.total ? Math.round(100 * r.done / r.total) : 0}%`, height: 3, backgroundColor: c.foregroundMuted }} />
        </View>
      </View>
      {!!r.active && <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17, marginLeft: size.slot + 8 }}>{r.active}</Text>}
    </View>;
    case "notice": return <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: size.row }}>
      <View style={{ flex: 1, height: 1, backgroundColor: withAlpha(c.border, 0.8) }} />
      {r.live ? <Spinner color={c.foregroundMuted} size={12} label={r.text} /> : <Icon name="Minimize2" size={12} color={c.foregroundMuted} />}
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{r.text}</Text>
      <View style={{ flex: 1, height: 1, backgroundColor: withAlpha(c.border, 0.8) }} />
    </View>;
    case "error": return <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
      <View style={{ width: size.slot, alignItems: "center", paddingTop: 2 }}><Icon name="CircleAlert" size={size.icon} color={c.statusDanger} /></View>
      <Text numberOfLines={3} style={{ flex: 1, color: c.statusDanger, fontSize: 13, lineHeight: 18 }}>{r.text}</Text>
    </View>;
  }
}

/** A run of steps: Chat Polish's merged row (ListTree, the verb, "N steps", a chevron) over a ruled column. The live run starts open. */
function RunView({ r, c, compact }: { r: Extract<TurnRow, { kind: "run" }>; c: Colors; compact: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const shown = open ?? r.live;
  const n = runSteps(r);
  const label = runLabel(r);
  return <View>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: shown }} accessibilityLabel={`${label}, ${n} ${n === 1 ? "step" : "steps"}`} onPress={() => setOpen(!shown)}
      style={state => ({ ...focusRing((state as { focused?: boolean }).focused, c), flexDirection: "row", alignItems: "center", gap: 8, minHeight: compact ? 44 : size.row, borderRadius: 4 })}>
      <View style={{ width: size.slot, alignItems: "center" }}><Icon name="ListTree" size={size.icon} color={r.failed > 0 ? c.statusDanger : c.foregroundMuted} /></View>
      <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: c.foreground, fontSize: size.verb, fontWeight: "500" }}>{label}</Text>
      {/* One meta slot, Chat Polish's rule: failures first, else the step count. */}
      <Text style={{ flexShrink: 0, color: r.failed > 0 ? c.statusDanger : c.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums"] }}>{r.failed > 0 ? `${r.failed} failed` : `${n} ${n === 1 ? "step" : "steps"}`}</Text>
      <Icon name={shown ? "ChevronDown" : "ChevronRight"} size={13} color={c.foregroundMuted} />
    </Pressable>
    {shown && <View style={{ marginLeft: 8, paddingLeft: 13, borderLeftWidth: 1, borderLeftColor: withAlpha(c.border, 0.6) }}>
      {r.hidden > 0 && <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: size.row }}>{`${r.hidden} earlier ${r.hidden === 1 ? "step" : "steps"}`}</Text>}
      {r.steps.map((s, i) => <StepView key={i} s={s} c={c} />)}
    </View>}
  </View>;
}

function StepView({ s, c }: { s: TurnStep; c: Colors }) {
  const color = s.status === "failed" ? c.statusDanger : c.foregroundMuted;
  const running = s.status === "running";
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: size.row }}>
    <View style={{ width: size.slot, alignItems: "center" }}>
      <Icon name={s.icon} size={size.icon} color={running ? runningColor(c) : color} />
    </View>
    {/* The running step keeps its icon; its label carries Chat Polish's sweep (its CSS keys on data-cp-running-label). */}
    <View {...(running ? { dataSet: { cpRunningLabel: "" } } as object : {})} accessibilityLabel={running ? `${s.verb} ${s.target ?? ""}, running` : undefined} style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Text style={{ flexShrink: 0, color: s.status === "failed" ? c.statusDanger : c.foreground, fontSize: size.verb, fontWeight: "500" }}>{s.verb}</Text>
      {!!s.target && <Text numberOfLines={1} ellipsizeMode="middle" style={{ flex: 1, minWidth: 0, color: running ? c.foreground : c.foregroundMuted, fontSize: s.mono ? size.mono : size.verb, fontFamily: s.mono ? mono : undefined }}>{s.target}</Text>}
    </View>
  </View>;
}

// ---------- the peek ----------

/** A peek's rows: enough for the live run and the reply, short enough that the permission and Open chat stay in view. */
const PEEK_ROWS = 8;

type Permission = Parameters<typeof PermissionBlock>[0]["p"];

/** What a peek shows: the turn, a waiting permission (Allow / Deny at equal weight), and the footer the caller asks for. */
function PeekBody({ agentId, theme, compact, onAsking, footer }: { agentId: string; theme: Theme; compact: boolean; onAsking?: (asking: boolean) => void; footer: (s: TurnState, startedAt: string | null, asking: boolean) => ReactNode }) {
  const c = theme.colors;
  // The agent's own handle, refreshed and followed (Home's), for its waiting permissions and its turn's start.
  const { handle: live, permissions } = useAgentLive(agentId);
  const handle = live!;
  const s = useTurn(agentId);
  useEffect(() => { onAsking?.(permissions.length > 0); }, [permissions.length, onAsking]);
  const [busy, setBusy] = useState<string | null>(null);
  const respond = async (p: Permission, response: { behavior: "allow" | "deny"; selectedActionId?: string }) => {
    setBusy(p.id);
    try { await handle.respondToPermission({ requestId: p.id, response: response as never }); } catch { /* the card stays; the chat has the error */ } finally { setBusy(null); }
  };
  const startedAt = (handle.activeTurn as { startedAt?: string | null } | null)?.startedAt ?? null;
  return <View style={{ gap: 10 }}>
    {s.turn ? <TurnView turn={s.turn} theme={theme} maxRows={PEEK_ROWS} compact={compact} />
      : s.error ? <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{"Couldn't load this turn. Open chat to see it."}</Text>
      : s.source === "saved" ? <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>No saved turn for this agent.</Text>
      : <Spinner color={c.foregroundMuted} size={12} label="Reading the agent's turn" />}
    {permissions.map(p => <PermissionBlock key={p.id} p={p} theme={theme} compact={compact} busy={busy === p.id} primary={false} note={null} flat onRespond={r => void respond(p, r)} />)}
    {footer(s, startedAt, permissions.length > 0)}
  </View>;
}

/** The footer's one line: the state the agent is in now (waiting on you outranks working). Shared by desktop and the sheet. */
function peekCaption(s: TurnState, startedAt: string | null, asking: boolean): string {
  const took = s.running ? since(startedAt, Date.now()) : null;
  if (asking) return took ? `Waiting for you · ${took}` : "Waiting for you";
  if (s.running) return took ? `Working · ${took}` : "Working";
  return turnSource(s) ?? (s.turn ? "Idle" : "");
}

function DesktopFooter({ s, startedAt, asking, theme, onOpen }: { s: TurnState; startedAt: string | null; asking: boolean; theme: Theme; onOpen?: () => void }) {
  const c = theme.colors;
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: size.row, paddingTop: 6, borderTopWidth: 1, borderTopColor: withAlpha(c.border, 0.6) }}>
    {s.running && !asking && <Spinner color={runningColor(c)} size={12} label="Working" />}
    {asking && <Icon name="ShieldQuestion" size={12} color={c.statusWarning} />}
    <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: asking ? c.statusWarning : c.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums"] }}>{peekCaption(s, startedAt, asking)}</Text>
    {/* A quiet exit: the eye should end on the live step, not the button. */}
    {onOpen && <Pressable accessibilityRole="button" accessibilityLabel="Open chat" onPress={onOpen}
      style={state => ({ ...focusRing((state as { focused?: boolean }).focused, c), flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 4, paddingVertical: 2, borderRadius: 4 })}>
      {state => { const hot = (state as { hovered?: boolean; focused?: boolean }).hovered || (state as { focused?: boolean }).focused;
        return <><Text style={{ color: hot ? c.foreground : c.foregroundMuted, fontSize: 12, fontWeight: "500" }}>Open chat</Text><Icon name="ArrowUpRight" size={12} color={hot ? c.foreground : c.foregroundMuted} /></>; }}
    </Pressable>}
  </View>;
}

/** How often an open peek re-checks a pointer at rest (the layout can move the line or the peek away from it). */
const POINTER_LOOK_MS = 400;
/** The peek's timers run on a monotonic clock: wall time can jump (or, in the harness, be frozen). */
const clock = () => (globalThis as { performance?: { now(): number } }).performance?.now() ?? Date.now();

type Api = { event(e: PeekEvent): void; node(id: string, get: () => unknown): void; sheet(id: string): void; enter(id: string): boolean };
type Host = { api: Api; compact: boolean; chatBeside: string | null };
const PeekContext = createContext<Host | null>(null);
type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
const rectOf = (node: unknown): Rect | null => (node as { getBoundingClientRect?(): Rect } | null)?.getBoundingClientRect?.() ?? null;

export type PeekLineProps = { onHoverIn?: () => void; onHoverOut?: () => void; onFocus?: () => void; onBlur?: () => void; onPress?: () => void; onKeyDown?: (e: { key: string; altKey?: boolean; preventDefault?(): void }) => void };

/**
 * A line's peek handlers, or null where it doesn't peek: no host above it, no agent, or the agent's turn already on
 * screen (shared/peek.ts `timelineOnScreen`). `node` returns the line's element, for placing the peek. Desktop lines
 * get hover and focus intent; phone lines get a tap that opens the sheet (spread it over the line's own onPress).
 */
export function usePeekLine(agentId: string | null | undefined, node: () => unknown): PeekLineProps | null {
  const host = useContext(PeekContext);
  const on = useMarked(agentId);
  const ref = useRef(node); ref.current = node;
  return useMemo(() => {
    if (!host || !agentId || timelineOnScreen(agentId, { marked: on ? new Set([agentId]) : new Set(), chatBeside: host.chatBeside })) return null;
    const { api } = host;
    if (host.compact) return { onPress: () => api.sheet(agentId) };
    return {
      onHoverIn: () => { api.node(agentId, () => ref.current()); api.event({ type: "enter", id: agentId, t: clock() }); },
      onHoverOut: () => api.event({ type: "leave", t: clock() }),
      onFocus: () => { api.node(agentId, () => ref.current()); api.event({ type: "focus", id: agentId, t: clock() }); },
      onBlur: () => api.event({ type: "blur", t: clock() }),
      // The keyboard way in: → (or Alt+↓) moves focus into this line's open peek; Esc there closes it and returns here.
      onKeyDown: e => { if ((e.key === "ArrowRight" || (e.altKey && e.key === "ArrowDown")) && api.enter(agentId)) e.preventDefault?.(); },
    };
  }, [host, agentId, on]);
}

/**
 * Where lines peek: one peek at a time per surface, drawn in FloatingSurface's nonmodal mode inside this host's box.
 * `where`: "panel" opens under the line, the panel's width; "main" (Home) opens beside the row, 440 wide.
 * Not a portal: React Native Web's Modal traps focus (it moves focus into itself when it opens and pulls any outside
 * focus back), so a peek opened by hovering would take the cursor out of whatever the developer is typing in.
 * `names`: the line's title, for the phone sheet's header.
 */
export function PeekHost({ where, theme, compact, openAgent, names, chatBeside = null, enabled = true, children }: {
  where: "panel" | "main"; theme: Theme; compact: boolean; openAgent?: (agentId: string) => void; names?: (agentId: string) => string;
  chatBeside?: string | null; enabled?: boolean; children: ReactNode;
}) {
  const c = theme.colors;
  const [state, dispatch] = useReducer(peekStep, PEEK_CLOSED);
  const nodes = useRef(new Map<string, () => unknown>());
  const hostRef = useRef<View>(null);
  const peekRef = useRef<unknown>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const [line, setLine] = useState<{ top: number; bottom: number; right: number; boxLeft: number; boxWidth: number; room: number } | null>(null);
  const [height, setHeight] = useState(0);
  const openRef = useRef<string | null>(null);
  const api = useMemo<Api>(() => ({
    event: dispatch, node: (id, get) => { nodes.current.set(id, get); }, sheet: setSheet,
    enter: id => {
      if (openRef.current !== id) return false;
      const root = peekRef.current as { querySelector?(q: string): { focus?(): void } | null } | null;
      const target = root?.querySelector?.('button, [role="button"], [tabindex]:not([tabindex="-1"])');
      if (!target?.focus) return false;
      dispatch({ type: "peekEnter", t: clock() }); target.focus(); return true;
    },
  }), []);
  const value = useMemo<Host>(() => ({ api, compact, chatBeside }), [api, compact, chatBeside]);
  const close = useCallback(() => dispatch({ type: "close" }), []);
  // Esc (or a click outside) from inside the peek hands focus back to the line it came from.
  const closeAndReturn = useCallback(() => {
    const id = openRef.current;
    const doc = (globalThis as { document?: { activeElement?: unknown } }).document;
    const within = !!(peekRef.current as { contains?(n: unknown): boolean } | null)?.contains?.(doc?.activeElement);
    dispatch({ type: "close" });
    if (within && id) (nodes.current.get(id)?.() as { focus?(): void } | null)?.focus?.();
  }, []);
  // One timer: the next pending open or grace close. It ticks only once the deadline has passed on the clock: a timer
  // that fires early (browsers do, by up to ~1 ms) waits again for what is left, since an early tick would change
  // nothing and leave nothing armed (invariant 151).
  useEffect(() => {
    const first = peekWait(state, clock());
    if (first === null) return;
    let id: ReturnType<typeof setTimeout>;
    const fire = () => {
      const now = clock();
      const wait = peekWait(state, now);
      if (wait === null) return;
      if (wait > 0) { id = setTimeout(fire, wait); return; }
      dispatch({ type: "tick", t: now });
    };
    id = setTimeout(fire, first);
    return () => clearTimeout(id);
  }, [state]);
  // Place it when it opens (or another line takes over).
  useEffect(() => {
    if (!state.open) { setLine(null); setHeight(0); return; }
    const r = rectOf(nodes.current.get(state.open)?.());
    const box = rectOf(hostRef.current);
    if (!r || !box) { dispatch({ type: "close" }); return; }
    const vh = (globalThis as { innerHeight?: number }).innerHeight ?? box.bottom;
    setLine({ top: r.top, bottom: r.bottom, right: r.right, boxLeft: box.left, boxWidth: box.width, room: Math.min(box.bottom, vh) - r.bottom });
  }, [state.open, where]);
  // A click elsewhere or a scroll closes it (the line it hangs from moved).
  useEffect(() => {
    if (!state.open || Platform.OS !== "web") return;
    const doc = (globalThis as { document?: { addEventListener(t: string, f: (e: { target: unknown }) => void, o?: boolean): void; removeEventListener(t: string, f: (e: { target: unknown }) => void, o?: boolean): void } }).document;
    const inside = (t: unknown) => !!(peekRef.current as { contains?(n: unknown): boolean } | null)?.contains?.(t);
    const down = (e: { target: unknown }) => { if (!inside(e.target)) dispatch({ type: "close" }); };
    // Only a scroll that moves the line it hangs from: live lists and chats fire scroll events without moving it.
    const line = nodes.current.get(state.open)?.();
    const at = rectOf(line)?.top ?? null;
    const scroll = (e: { target: unknown }) => { const top = rectOf(line)?.top ?? null; if (!inside(e.target) && at !== null && (top === null || Math.abs(top - at) > 4)) dispatch({ type: "close" }); };
    doc?.addEventListener("pointerdown", down, true); doc?.addEventListener("scroll", scroll, true);
    return () => { doc?.removeEventListener("pointerdown", down, true); doc?.removeEventListener("scroll", scroll, true); };
  }, [state.open]);
  // Where the pointer is, read from the document while a peek is open or arming (invariant 151,
  // an-open-peek-closes-when-the-pointer-is-away): a hover event the line or the peek misses (a node replaced under
  // the pointer, React Native Web's nested-Pressable hover lock) must not keep it open, so the peek never waits on one
  // leave event. Each move is hit-tested against the open line, the arming line and the peek (at most once a
  // frame), and again every POINTER_LOOK_MS for a pointer at rest while the layout moves. Focus on the line or in the
  // peek holds it (keyboard entry): there the pointer decides nothing.
  const pendingId = state.pending?.id ?? null;
  useEffect(() => {
    if ((!state.open && !pendingId) || Platform.OS !== "web") return;
    type Listen = { addEventListener(t: string, f: (e: PointerLike) => void, o?: object): void; removeEventListener(t: string, f: (e: PointerLike) => void, o?: object): void };
    type PointerLike = { clientX: number; clientY: number; pointerType?: string; relatedTarget?: unknown; type: string };
    const g = globalThis as unknown as { document?: Listen & { activeElement?: unknown }; requestAnimationFrame?(f: () => void): number; cancelAnimationFrame?(id: number): void };
    const doc = g.document;
    if (!doc) return;
    const open = state.open;
    let at: { x: number; y: number } | null = null;
    let frame: number | null = null;
    const held = () => {
      const active = doc.activeElement;
      const line = open ? nodes.current.get(open)?.() as { contains?(n: unknown): boolean } | null : null;
      return !!active && (!!(peekRef.current as { contains?(n: unknown): boolean } | null)?.contains?.(active) || !!line?.contains?.(active));
    };
    const box = (node: unknown) => { const r = rectOf(node); return r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null; };
    const look = () => {
      frame = null;
      if (!at || held()) return;
      dispatch({ type: "pointer", where: pointerWhere(at, { line: open ? box(nodes.current.get(open)?.()) : null, pending: pendingId ? box(nodes.current.get(pendingId)?.()) : null, peek: open ? box(peekRef.current) : null }), t: clock() });
    };
    const move = (e: PointerLike) => {
      if (e.pointerType === "touch") return;
      at = { x: e.clientX, y: e.clientY };
      if (frame === null) frame = g.requestAnimationFrame ? g.requestAnimationFrame(look) : (look(), null);
    };
    // The pointer left the window: away, wherever it was last seen.
    const out = (e: PointerLike) => { if (e.relatedTarget == null && e.pointerType !== "touch" && !held()) { at = null; dispatch({ type: "pointer", where: "away", t: clock() }); } };
    const opts = { capture: true, passive: true };
    doc.addEventListener("pointermove", move, opts); doc.addEventListener("pointerout", out, opts);
    const timer = open ? setInterval(look, POINTER_LOOK_MS) : null;
    return () => {
      doc.removeEventListener("pointermove", move, opts); doc.removeEventListener("pointerout", out, opts);
      if (timer) clearInterval(timer);
      if (frame !== null) g.cancelAnimationFrame?.(frame);
    };
  }, [state.open, pendingId]);
  // An agent whose turn comes on screen (its row was selected, say) loses its peek: one predicate, also for an open one.
  const marked = useMarkedOnScreen();
  const shown = state.open && !timelineOnScreen(state.open, { marked, chatBeside }) ? state.open : null;
  useEffect(() => { if (state.open && !shown) dispatch({ type: "close" }); }, [state.open, shown]);
  const onAsking = useCallback((on: boolean) => dispatch({ type: "asking", on, t: clock() }), []);
  if (!enabled) return <>{children}</>;
  const open = shown;
  openRef.current = open;
  // Panel: under the line (above it when there's little room). Main: beside the row, level with it when it fits, else
  // ending at the row's bottom edge (never flipped a whole peek-height away from it).
  const vh = (globalThis as { innerHeight?: number }).innerHeight ?? 0;
  // Panel: below the line when the measured peek fits there, else wholly above it (never on top of the line).
  const below = (l: NonNullable<typeof line>) => ({ x: l.boxLeft + 8, y: !height || l.room >= height + 8 ? l.bottom + 4 : Math.max(8, l.top - 4 - height), width: where === "main" ? Math.min(440, l.boxWidth - 16) : Math.max(240, l.boxWidth - 16) });
  // Main with no room beside the row (a narrow pane): the panel's placement instead of covering the row.
  const beside = !!line && line.right + 8 + 440 <= line.boxLeft + line.boxWidth;
  const anchor = !line ? null : where === "main" && beside
    ? { x: line.right + 8, y: !height || line.top + height <= vh - 8 ? line.top : line.bottom, width: 440 }
    : below(line);
  const openChat = (id: string) => openAgent ? () => { dispatch({ type: "close" }); setSheet(null); openAgent(id); } : undefined;
  return <PeekContext.Provider value={value}>
    <View ref={hostRef} style={{ flex: 1, minHeight: 0 }}>
      {children}
      {open && anchor && <FloatingSurface modal={false} anchor={{ x: anchor.x, y: anchor.y }} width={anchor.width} onClose={closeAndReturn} role="region" label={`${names?.(open) ?? "Agent"}: current turn`} contentRef={peekRef} onSize={sz => setHeight(h => Math.abs(h - sz.height) > 1 ? sz.height : h)}
        dataSet={{ followPeek: open }}
        style={{ backgroundColor: isLight(c) ? c.surface0 : c.surface1, borderRadius: 10, maxHeight: 520, ...raised(c), ...(Platform.OS === "web" ? { boxShadow: `${(raised(c) as { boxShadow: string }).boxShadow}, 0px 8px 24px rgba(0, 0, 0, ${isLight(c) ? 0.12 : 0.4})` } as object : {}) }}>
        <Pressable accessible={false} focusable={false} onHoverIn={() => dispatch({ type: "peekEnter", t: clock() })} onHoverOut={() => dispatch({ type: "peekLeave", t: clock() })}
          onFocus={() => dispatch({ type: "peekEnter", t: clock() })} onBlur={() => dispatch({ type: "peekLeave", t: clock() })} style={{ padding: 12 }}>
          <PeekBody key={open} agentId={open} theme={theme} compact={false} onAsking={onAsking} footer={(s, startedAt, asking) => <DesktopFooter s={s} startedAt={startedAt} asking={asking} theme={theme} onOpen={openChat(open)} />} />
        </Pressable>
      </FloatingSurface>}
      {compact && sheet && <Modal title={names?.(sheet) ?? "Agent"} open onOpenChange={o => { if (!o) setSheet(null); }}>
        <Modal.Content>
          <PeekBody key={sheet} agentId={sheet} theme={theme} compact footer={(s, startedAt, asking) => <>
            {!!peekCaption(s, startedAt, asking) && <Text style={{ color: asking ? c.statusWarning : c.foregroundMuted, fontSize: 13 }}>{peekCaption(s, startedAt, asking)}</Text>}
            {openChat(sheet) && <Button theme={theme} compact grow kind="primary" icon="ArrowUpRight" title="Open chat" onPress={openChat(sheet)!} />}
          </>} />
        </Modal.Content>
      </Modal>}
    </View>
  </PeekContext.Provider>;
}
