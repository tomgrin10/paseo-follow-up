// Catch up: everything in Needs you, one card at a time (docs/design/catch-up.md).
// Pure: the deck's cards and their order come from Home's model, the inbox rows and the workspaces already on the
// client, so opening Catch up costs no read of its own. The session's order (skips, More context parking a
// workspace, its return) is a pure state machine here, so the client, the agent tool and the tests agree.
import { z } from "zod";
import type { HomeModel, Workstream } from "./home";
import type { InboxRow } from "./inbox";
import type { NeedItem } from "./attention";

export type CardKind = "permission" | "question" | "item" | "brief" | "finished" | "answer";
/**
 * One card: one thing to act on. A workspace with two questions and a merge is three cards, kept together so its
 * context is read once. `key` is stable across refreshes, so the deck can tell a card that went away from a new one.
 */
export type DeckCard = { key: string; kind: CardKind; s: Workstream; questionId?: string; item?: NeedItem;
  /** An `answer` card: the developer's question (Your questions) whose answer they haven't read. */
  requestId?: string };

type Source = {
  model: Pick<HomeModel, "groups">;
  rows: readonly Pick<InboxRow, "agentId" | "needs" | "brief">[];
  /** The workspace's Needs-you items in block order (stopped questions first), from `needsYou`. */
  items: (workspaceId: string) => readonly NeedItem[];
  /** The workspace's unread answers to the developer's questions, newest first: one card each, last in the workstream. */
  answers?: (workspaceId: string) => readonly { id: string }[];
};

const BRIEF_CARD_KINDS = ["decision", "action", "review"];
/** Needs you's lowest tier: an answer to one of the developer's own questions (Your questions), to read. */
export const ANSWER_TIER = 3 as const;

/**
 * The deck, in Home's Needs-you order: the order the developer already sees in the list (blocking asks first, then
 * decisions, then finished turns; inside a tier the chosen sort, AI priority included). Inside a workstream: a pending
 * permission, then each open question, then every other item, then the agent's own ask when nothing above speaks for it.
 */
export function deckCards({ model, rows, items, answers }: Source): DeckCard[] {
  const needs = model.groups.find(g => g.id === "needs")?.items ?? [];
  const out: DeckCard[] = [];
  for (const s of needs) {
    const row = s.agentId ? rows.find(r => r.agentId === s.agentId) ?? null : null;
    const reasons = row?.needs?.reasons.map(r => r.reason) ?? [];
    const before = out.length;
    if (reasons.includes("permission")) out.push({ key: `${s.key}|permission`, kind: "permission", s });
    const asks = s.workspaceId ? items(s.workspaceId) : [];
    for (const item of asks) {
      if (item.kind === "question") out.push({ key: `${s.key}|${item.questionId}`, kind: "question", s, questionId: item.questionId, item });
      else out.push({ key: `${s.key}|${item.key}`, kind: "item", s, item });
    }
    const brief = row?.brief as { kind?: string; questionIds?: string[] } | null | undefined;
    const pointsAtQuestion = !!brief?.questionIds?.length && out.slice(before).some(c => c.kind === "question");
    if (brief && !pointsAtQuestion && BRIEF_CARD_KINDS.includes(brief.kind ?? "")) out.push({ key: `${s.key}|brief`, kind: "brief", s });
    // An answer to read: the lowest tier (Q172 C=a), after everything else the workstream asks.
    const read = s.workspaceId && answers ? answers(s.workspaceId) : [];
    if (out.length === before && s.tier !== ANSWER_TIER) out.push({ key: `${s.key}|finished`, kind: "finished", s });
    for (const a of read) out.push({ key: `${s.key}|${a.id}`, kind: "answer", s, requestId: a.id });
  }
  return out;
}

/** The workstream a card key belongs to (`agent:<id>` or `ws:<id>`): cards of one workstream move together. */
export const groupOf = (key: string) => key.slice(0, key.indexOf("|") < 0 ? key.length : key.indexOf("|"));

/** What happened to a card this session. `gone`: it left Needs you elsewhere (answered on another device, the agent moved on). */
export type Outcome = "done" | "skipped" | "later" | "gone";
export type SessionStats = { done: number; skipped: number; later: number; gone: number; waiting: number };

/**
 * A Catch up session. `order` is every card key seen this session (done ones stay, so Back works); `pos` is the card
 * on screen, `order.length` once nothing is left. `parked` maps a workstream waiting for More context to its request.
 */
export type Session = { order: string[]; pos: number; outcomes: Record<string, Outcome>; parked: Record<string, string>; lapped?: boolean;
  /** Skip workspace jumped from `to` and landed on `from` (undefined: the finished screen): Back from there returns to `to`. */
  back?: { to: string; from: string | undefined } };

export const startSession = (cards: readonly Pick<DeckCard, "key">[]): Session => ({ order: cards.map(c => c.key), pos: 0, outcomes: {}, parked: {} });

/** Still to act on: not done, later or gone. Skipped cards stay open; they come round again after the rest. */
const open = (s: Session, key: string) => { const o = s.outcomes[key]; return !o || o === "skipped"; };
/** A card forward moves may land on: open, and not in a workstream waiting for context. */
const landable = (s: Session, key: string) => open(s, key) && !s.parked[groupOf(key)];

/**
 * The next card after `from`: the next landable one in order, else the first skipped one from the start (one second
 * pass, `lapped`), else `order.length` (finished). On the second pass a skip moves forward only, so skipping everything
 * ends at the finished screen with "Catch up on N skipped" instead of going round for ever.
 */
export function advance(s: Session, from: number): Pick<Session, "pos" | "lapped"> {
  for (let i = from + 1; i < s.order.length; i++) if (landable(s, s.order[i]) && (s.lapped || s.outcomes[s.order[i]] !== "skipped")) return { pos: i, lapped: s.lapped };
  if (!s.lapped) for (let i = 0; i < s.order.length; i++) if (i !== from && landable(s, s.order[i])) return { pos: i, lapped: true };
  return { pos: s.order.length, lapped: s.lapped };
}
export const nextPos = (s: Session, from: number): number => advance(s, from).pos;

/**
 * Back: the card before, whatever happened to it (done cards show what was sent; a parked one shows it is asking).
 * Right after Skip workspace, Back returns to the card it was pressed on, not the last card of the skipped workspace.
 */
export function prevPos(s: Session): number {
  if (s.back && s.order[s.pos] === s.back.from) { const i = s.order.indexOf(s.back.to); if (i >= 0) return i; }
  return Math.max(0, Math.min(s.pos, s.order.length) - 1);
}

/** The cards of the on-screen card's workspace still to act on, the current one included: Skip workspace shows only above one. */
export function openInWorkspace(s: Session, key = s.order[s.pos]): string[] {
  if (key === undefined) return [];
  const g = groupOf(key);
  return s.order.filter(k => groupOf(k) === g && open(s, k));
}

/**
 * Skip workspace: every card of this workspace still to act on is skipped at once (each counts as one skipped card) and
 * the deck moves to the next workspace. They come back on the second pass like any skipped card; on the second pass
 * itself it moves past the rest of them.
 */
export function skipWorkspace(s: Session): Session {
  const key = s.order[s.pos];
  if (key === undefined) return s;
  const g = groupOf(key);
  const outcomes = { ...s.outcomes };
  for (const k of openInWorkspace(s)) outcomes[k] = "skipped";
  const next: Session = { ...s, outcomes };
  let at = advance(next, s.pos);
  while (at.pos < s.order.length && groupOf(s.order[at.pos]) === g) at = advance({ ...next, lapped: at.lapped }, at.pos);
  return { ...next, ...at, back: { to: key, from: s.order[at.pos] } };
}

/** Phone drag: which way a touch is going, decided once it has moved this far, so a vertical scroll stays a scroll. */
export const SWIPE_LOCK_PX = 8;
export function swipeLock(dx: number, dy: number): "x" | "y" | null {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_LOCK_PX) return null;
  return Math.abs(dx) > 1.5 * Math.abs(dy) ? "x" : "y";
}
/**
 * A released drag: past `SWIPE_COMMIT` of the card's width, or flung faster than `SWIPE_FLING` px/ms the same way, left
 * skips the workspace and right goes Back (when there is a card to go back to); anything else springs back. Left is the
 * workspace, not the card (Tom, 2.2.0-beta.4: "it makes more sense for the drag left to skip the whole workspace"); the
 * bar's Skip stays the way to skip one card. With one card left in the workspace the two are the same.
 */
export const SWIPE_COMMIT = 0.35;
export const SWIPE_FLING = 0.5;
export type SwipeOutcome = "skip-workspace" | "back" | "stay";
export function swipeOutcome(g: { dx: number; vx: number; width: number; canBack: boolean }): SwipeOutcome {
  const far = Math.abs(g.dx) > SWIPE_COMMIT * g.width;
  const fling = Math.abs(g.vx) > SWIPE_FLING && Math.sign(g.vx) === Math.sign(g.dx);
  if (!far && !fling) return "stay";
  if (g.dx < 0) return "skip-workspace";
  return g.canBack && g.dx > 0 ? "back" : "stay";
}
/** What a released drag does to the session: the screen and the tests run this one function. */
export function applySwipe(s: Session, out: SwipeOutcome): Session {
  return out === "skip-workspace" ? skipWorkspace(s) : out === "back" ? { ...s, pos: prevPos(s) } : s;
}

/** Records what happened to the card on screen and moves on. */
export function settle(s: Session, outcome: Outcome, key = s.order[s.pos]): Session {
  if (key === undefined) return s;
  const next = { ...s, outcomes: { ...s.outcomes, [key]: outcome } };
  return s.order[s.pos] === key ? { ...next, ...advance(next, s.pos) } : next;
}

/**
 * More context was asked about the card on screen: its workstream waits (every card of it, so its context is read
 * once when it returns) and the deck moves on to the next workstream at once. Tom, 2026-11-17: "Getting more context
 * may take a bit, so make it skip to the next workspace".
 */
export function park(s: Session, requestId: string, key = s.order[s.pos]): Session {
  if (key === undefined) return s;
  const next = { ...s, parked: { ...s.parked, [groupOf(key)]: requestId } };
  return s.order[s.pos] !== undefined && groupOf(s.order[s.pos]) === groupOf(key) ? { ...next, ...advance(next, s.pos) } : next;
}

/**
 * The live deck changed: cards that left Needs you are `gone`, new ones join at the end (never jumping the queue under
 * the developer's thumb), and a parked workstream whose request settled comes back as the very next card: its open
 * cards move to right after the one on screen (or become the current one when the deck had finished). The card on
 * screen never changes under the developer, except to `gone`.
 */
export function sync(s: Session, live: readonly Pick<DeckCard, "key">[], settled: (requestId: string) => boolean): Session {
  const liveKeys = new Set(live.map(c => c.key));
  const known = new Set(s.order);
  let order = [...s.order, ...live.map(c => c.key).filter(k => !known.has(k))];
  const outcomes = { ...s.outcomes };
  for (const k of order) if (!liveKeys.has(k) && open({ ...s, outcomes }, k)) outcomes[k] = "gone";
  let pos = s.pos;
  const parked = { ...s.parked };
  for (const [group, requestId] of Object.entries(s.parked)) {
    if (!settled(requestId)) continue;
    delete parked[group];
    const current = order[pos];
    const back = order.filter(k => groupOf(k) === group && k !== current && open({ ...s, outcomes }, k));
    if (!back.length) continue;
    const rest = order.filter(k => !back.includes(k));
    const at = current === undefined ? rest.length : rest.indexOf(current) + 1;
    order = [...rest.slice(0, at), ...back, ...rest.slice(at)];
    pos = current === undefined ? at : order.indexOf(current);
  }
  return { ...s, order, pos, outcomes, parked };
}

/** The progress line's numbers: the card on screen out of every card this session, and what is waiting for context. */
export function statsOf(s: Session): SessionStats {
  const out: SessionStats = { done: 0, skipped: 0, later: 0, gone: 0, waiting: 0 };
  for (const o of Object.values(s.outcomes)) out[o]++;
  out.waiting = s.order.filter(k => s.parked[groupOf(k)] && open(s, k)).length;
  return out;
}

/** The keys, one place, so the help line, the tooltips and the handler agree. Option letters pick; these never collide with A–H. */
/**
 * Catch up's keys (desktop web): one list that the handler (`catchUpKey`), the S sheet and the hint line read, so
 * they never disagree. `combos` spell each key the way Paseo's bundle does (PASEO_BOUND, shared/search-key.ts):
 * tests/catch-up-keys.test.ts fails if one is a combo Paseo binds, Home's search key, or one of the search-from-
 * anywhere presets. Paseo takes Shift+? (its shortcuts dialog) and Escape (interrupt agent) when focus is outside a
 * field, which is exactly when these fire, so the sheet is S and leaving is X.
 */
export type CatchUpAction = "pick" | "own" | "send" | "skip" | "skip-workspace" | "back" | "more" | "chip" | "ask" | "note" | "later" | "chat" | "rail" | "rail-up" | "rail-down" | "keys" | "leave" | "dictate" | "dismiss";
/**
 * a-move-bar-action-opens-in-view: where each move-bar action opens what it opens, so its result is where the eye
 * already is and never appended below the fold. `sheet`: drawn in the phone's dock, above the bar, kept above the
 * keyboard. `popover`: anchored to its button on desktop. `focus`: a field or row takes focus, and DockedPane (phone)
 * or the browser (desktop) scrolls it into view. `navigates`: leaves Catch up for the chat.
 */
export type MovePlace = "sheet" | "popover" | "focus" | "navigates";
export const MOVE_OPENS: Readonly<Record<"more" | "later" | "note" | "chat" | "rail", { phone: MovePlace | null; desktop: MovePlace }>> = {
  more: { phone: "sheet", desktop: "popover" },
  later: { phone: "sheet", desktop: "popover" },
  note: { phone: "focus", desktop: "focus" },
  chat: { phone: "navigates", desktop: "navigates" },
  // The queue rail is desktop only.
  rail: { phone: null, desktop: "focus" },
};

/** A key as this platform spells it: ⌘ on a Mac, Ctrl elsewhere (as the Send button's own hint reads). */
export const keyLabel = (key: string, mac: boolean) => mac ? key : key.replace("⌘", "Ctrl ");

export const CATCH_UP_KEYS: readonly { key: string; what: string; action: CatchUpAction; combos: readonly string[]; when?: "more" | "rail";
  /** Listed only on a host that has it: V is Paseo's dictation, on a Paseo with usePaseoDictation. */ needs?: "dictation" }[] = [
  { key: "A–H", what: "Pick an option", action: "pick", combos: ["A", "B", "C", "D", "E", "F", "G", "H"] },
  { key: "W", what: "Write your own answer", action: "own", combos: ["W"] },
  { key: "⌘↵", what: "Send", action: "send", combos: ["Cmd+Enter", "Ctrl+Enter"] },
  { key: "J / →", what: "Skip this card (it comes back after the rest)", action: "skip", combos: ["J", "ArrowRight"] },
  { key: "⇧J", what: "Skip workspace (all its cards come back after the rest)", action: "skip-workspace", combos: ["Shift+J"] },
  { key: "K / ←", what: "Back", action: "back", combos: ["K", "ArrowLeft"] },
  { key: "M", what: "More context", action: "more", combos: ["M"] },
  { key: "1–4", what: "Pick a More context ask", action: "chip", combos: ["Digit"], when: "more" },
  { key: "⌘↵", what: "Ask the agent", action: "ask", combos: ["Cmd+Enter", "Ctrl+Enter"], when: "more" },
  { key: "N", what: "Add a note", action: "note", combos: ["N"] },
  // D alone picks option D, so Dismiss takes Shift, as Skip workspace does beside J.
  { key: "⇧D", what: "Remove it (the agent isn't messaged)", action: "dismiss", combos: ["Shift+D"] },
  { key: "V", what: "Dictate your answer, and stop", action: "dictate", combos: ["V"], needs: "dictation" },
  { key: "L", what: "Later", action: "later", combos: ["L"] },
  { key: "O", what: "Open chat", action: "chat", combos: ["O"] },
  { key: "R", what: "Go to the queue, and back", action: "rail", combos: ["R"] },
  { key: "↑ / ↓", what: "Move in the queue (Enter opens)", action: "rail-up", combos: ["ArrowUp", "ArrowDown"], when: "rail" },
  { key: "S", what: "Show the keys", action: "keys", combos: ["S"] },
  { key: "X", what: "Leave Catch up", action: "leave", combos: ["X"] },
];

export type KeyPress = { key: string; meta: boolean; ctrl: boolean; alt: boolean; shift: boolean; composing?: boolean; mac: boolean };
/**
 * What a key press does in Catch up, or null to leave it alone (Paseo's, the field's, the browser's). Pure, so the
 * map is tested without a DOM. `typing`: focus is in a text field, where only the More context box's ⌘↵ and ⌘⇧↵ act
 * (a card field's ⌘↵ is its own SubmitScope's). `inRail`: focus is in the queue.
 */
export function catchUpKey(e: KeyPress, at: { typing: boolean; inMore: boolean; moreOpen: boolean; inRail: boolean }): { action: CatchUpAction; arg?: string } | null {
  if (e.composing || e.alt) return null;
  const mod = e.mac ? e.meta : e.ctrl;
  if (e.key === "Enter" && mod && (e.mac ? !e.ctrl : !e.meta)) {
    if (e.shift) return null;
    if (at.moreOpen && (!at.typing || at.inMore)) return { action: "ask" };
    return at.typing ? null : { action: "send" };
  }
  if (at.typing || e.meta || e.ctrl) return null;
  if (at.inRail && (e.key === "ArrowUp" || e.key === "ArrowDown")) return { action: e.key === "ArrowUp" ? "rail-up" : "rail-down" };
  if (e.key === "ArrowRight") return { action: "skip" };
  if (e.key === "ArrowLeft") return { action: "back" };
  if (at.moreOpen && /^[1-4]$/.test(e.key)) return { action: "chip", arg: e.key };
  if (e.shift && e.key.toLowerCase() === "j") return { action: "skip-workspace" };
  if (e.shift && e.key.toLowerCase() === "d") return { action: "dismiss" };
  if (e.shift || e.key.length !== 1) return null;
  const k = e.key.toLowerCase();
  if (/^[a-h]$/.test(k)) return { action: "pick", arg: k.toUpperCase() };
  const byLetter: Record<string, CatchUpAction> = { w: "own", j: "skip", k: "back", m: "more", n: "note", l: "later", o: "chat", r: "rail", s: "keys", x: "leave", v: "dictate" };
  return byLetter[k] ? { action: byLetter[k] } : null;
}

/**
 * The mode's name in every place it shows, so renaming it is one edit. Tom picked Catch up (2026-11-17: "people know
 * the name"); code identifiers say `catch-up` too. The Home button counts cards, not workspaces, and says so.
 */
export const MODE = {
  name: "Catch up",
  button: (n: number) => `Catch up · ${n}`,
  /** The button's accessible name and tooltip: the number is cards, which can differ from Needs you's workspaces. */
  buttonLabel: (n: number) => `Catch up on ${n} ${n === 1 ? "thing" : "things"} that need you, one at a time`,
  command: "Follow-up: Catch up on what needs you",
  progress: (at: number, of: number) => `Catch up ${at} of ${of}`,
  waiting: (n: number) => `${n} getting context`,
  finished: "All caught up",
  /** The end of a deck with cards still skipped or waiting: not caught up, so it does not say so. */
  endOfDeck: "End of the deck",
  empty: "Nothing needs you",
} as const;

// More context ------------------------------------------------------------------------------------------------------

/**
 * Who answered. Every ask goes to the card's workspace's main agent (`agent`; asking may wake it, because the developer
 * asked). `overseer` is only read from files written by 2.2.0-beta.3, which could route an ask to the Overseer: it never
 * had context_reply, so those settle as `chat` on load (an-ask-goes-only-to-an-agent-that-can-answer-it).
 */
export const CONTEXT_TARGETS = ["overseer", "agent"] as const;
export type ContextTarget = typeof CONTEXT_TARGETS[number];
/**
 * asking → answered (the reply came with context_reply), chat (the agent ended its turn without it: its last message
 * after the ask is the answer, "from its chat", or with no answer when its turn couldn't be read: read its chat),
 * failed, withdrawn (the developer or an agent took the question back while it was asking).
 */
export const CONTEXT_STATES = ["asking", "answered", "chat", "failed", "withdrawn"] as const;
export type ContextState = typeof CONTEXT_STATES[number];

/**
 * The suggestions, first one first. Tom, 2026-11-17: "most of the time, the question is just not understood and needs
 * a simple explaining and more context", so "I don't get it" leads.
 */
export const CONTEXT_ASKS = [
  { id: "explain", label: "I don't get it", text: "I don't get it. Explain this in plain words: what is being asked, why, and what each choice would mean. Add the context I need to decide." },
  { id: "why", label: "Why does it matter?", text: "Why does this matter, and what happens if it waits?" },
  { id: "tried", label: "What did it try?", text: "What has been tried so far, and what happened?" },
  { id: "recommend", label: "What if I take the recommendation?", text: "What happens if I take the recommendation?" },
] as const;

export const CONTEXT_ANSWER_MAX = 4000;
export const CONTEXT_VIA = ["more", "field", "slash", "tool"] as const;
export type ContextVia = typeof CONTEXT_VIA[number];
const iso = z.string().max(40);
export const contextRequestSchema = z.object({
  id: z.string().min(1).max(80),
  workspaceId: z.string().nullable(),
  /** The card's agent (the one that asked); the request's own recipient is `askedOf`. */
  agentId: z.string().nullable(),
  /** The card asked about (More context); null for a free question (Your questions' field, `/ask`, an agent's ask). */
  cardKey: z.string().min(1).max(400).nullable(),
  /** One line naming what the card asks ("Q12: Which retry policy?"), for the prompt and the agent tool; "" when free. */
  card: z.string().max(300).default(""),
  target: z.enum(CONTEXT_TARGETS),
  /** The developer's words, or a suggestion's text. */
  ask: z.string().min(1).max(2000),
  /** The agent that should reply: the workspace's main agent (an Overseer's id on beta.3 files). */
  askedOf: z.string().nullable(),
  state: z.enum(CONTEXT_STATES),
  answer: z.string().max(CONTEXT_ANSWER_MAX).nullable(),
  error: z.string().max(500).nullable(),
  askedAt: iso,
  settledAt: iso.nullable(),
  /**
   * When the ask actually reached `askedOf` (the queue sent it, or the Overseer took it). The first turn end after this
   * without a context_reply settles it as `chat`, so a prompt steered into a running turn counts too. Absent in files
   * from before it existed.
   */
  deliveredAt: iso.nullable().default(null),
  /** Who asked: "developer" or "agent:<id>" (agent parity). */
  by: z.string().max(120),
  /** Where it was asked: Catch up's More context (`more`), Your questions' field, `/ask` in a chat, or an agent tool. */
  via: z.enum(CONTEXT_VIA).default("more"),
  /** The question this one follows up (Reply): the history reads as a thread. */
  parentId: z.string().max(80).nullable().default(null),
  /** When the developer read the answer (Done, Reply, Make a task). Only the developer's acts set it: an agent's never do. */
  readAt: iso.nullable().default(null),
  /** Done: who closed it, and when. An agent's Done closes it without reading it for the developer. */
  done: z.object({ at: iso, by: z.string().max(120) }).nullable().default(null),
  /** Make a task: the obligation it became, owned by the agent that answered. */
  task: z.object({ id: z.string().max(80), at: iso, by: z.string().max(120) }).nullable().default(null),
});
export type ContextRequest = z.infer<typeof contextRequestSchema>;
/** `context.json`. v1 (no `version`) had card-bound asks only; it is migrated on load (`migrateContext`). */
export const CONTEXT_VERSION = 2 as const;
export const contextFileSchema = z.object({ version: z.literal(CONTEXT_VERSION).optional(), requests: z.array(contextRequestSchema) });
export type ContextFile = z.infer<typeof contextFileSchema>;

/** Questions are kept this long (Your questions' history), and at most this many per workspace (Q172 E=a). */
export const CONTEXT_KEEP_MS = 30 * 24 * 3_600_000;
export const CONTEXT_MAX = 200;
export const contextSettled = (r: Pick<ContextRequest, "state">) => r.state !== "asking";

/** The tool an asked agent replies with (native tools carry the follow_ prefix; the stdio bridge doesn't). */
const REPLY_TOOL = "context_reply";

/** The message the card's agent gets. It asks for an explanation, not action, and never counts as the developer's answer. */
export function agentContextPrompt(r: Pick<ContextRequest, "id" | "card" | "ask">): string {
  return [
    `The developer is catching up on what needs them and is looking at your ask: ${r.card}`,
    `They want more context before they answer: "${r.ask}"`,
    `Explain in plain words, short (under ${CONTEXT_ANSWER_MAX} characters), with what they need to decide. This isn't their answer: don't act on the ask yet, and keep it open.`,
    `Reply with ${REPLY_TOOL} (follow_${REPLY_TOOL} as a native tool) and requestId "${r.id}" so the answer shows on their card, then end your turn.`,
  ].join("\n");
}

/**
 * an-ask-goes-only-to-an-agent-that-can-answer-it: the role a More context ask is routed to. context_reply is a tool
 * of this role only (server/mcp-source.ts toolList: contributors, recovery agents and untracked agents such as the
 * Overseer don't get it), so an ask is only ever delivered where its answer can reach the card.
 */
export const CONTEXT_REPLY_ROLE = "main" as const;

/** A request older than CONTEXT_KEEP_MS goes, then each workspace's oldest past CONTEXT_MAX. Order is kept. */
export function pruneContext(requests: readonly ContextRequest[], now: number): ContextRequest[] {
  const young = requests.filter(r => now - Date.parse(r.askedAt) < CONTEXT_KEEP_MS);
  const left = new Map<string | null, number>();
  for (const r of young) left.set(r.workspaceId, (left.get(r.workspaceId) ?? 0) + 1);
  return young.filter(r => { const n = left.get(r.workspaceId)!; left.set(r.workspaceId, n - 1); return n <= CONTEXT_MAX; });
}

/**
 * A context answer as the card shows it: plain words. Agents often answer in Markdown, which the card would show as
 * literal ** and # marks, so emphasis, heading and quote marks go; links and line breaks stay.
 */
export function plainAnswer(text: string): string {
  return text.replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_m, a, b) => a ?? b).replace(/^\s{0,3}(#{1,6}|>)\s+/gm, "").trim();
}

/**
 * more-context-is-the-same-on-every-surface: a question is one card wherever it is answered. Catch up keys its card
 * by workstream (`agent:<id>|Q3` or `ws:<id>|Q3`); the panel, Home's detail pane, the pill and phones ask with
 * `questionCardKey`. Every reader and the worker's one-open-ask rule match through `sameCard`, so an ask made on one
 * surface shows (and dedupes) on all of them.
 */
export const questionCardKey = (workspaceId: string, questionId: string) => `ws:${workspaceId}|${questionId}`;
/** The question a card key is about ("Q3"), or null for any other card (a permission, a merge, a brief). */
export function questionOfCard(cardKey: string): string | null {
  const i = cardKey.indexOf("|");
  const subject = i < 0 ? "" : cardKey.slice(i + 1);
  return /^Q\d+$/.test(subject) ? subject : null;
}
/** One card, whichever surface named it: the same key, or the same question of the same workspace. */
export function sameCard(a: { workspaceId: string | null; cardKey: string | null }, b: { workspaceId: string | null; cardKey: string | null }): boolean {
  if (!a.cardKey || !b.cardKey) return false; // A free question is about no card.
  if (a.cardKey === b.cardKey) return true;
  const q = questionOfCard(a.cardKey);
  return !!q && !!a.workspaceId && a.workspaceId === b.workspaceId && q === questionOfCard(b.cardKey);
}
/** The newest ask about a card, from any surface. */
export function contextFor(requests: readonly ContextRequest[], card: { workspaceId: string | null; cardKey: string }): ContextRequest | null {
  for (let i = requests.length - 1; i >= 0; i--) if (sameCard(requests[i], card)) return requests[i];
  return null;
}

/** The ask as the card's header quotes it: its first sentence ("I don't get it."), not the whole prompt. */
export const askHeadline = (ask: string): string => (ask.match(/^.+?[.?!](?=\s|$)/)?.[0] ?? ask).slice(0, 120);
