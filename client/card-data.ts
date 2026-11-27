import { createContext, useEffect, useState } from "react";
import { Image, Platform } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc } from "@getpaseo/plugin/client";
import { cardActRpc, cardMediaRpc, cardsRpc } from "../shared/contracts";
import type { Card } from "../shared/cards";

/**
 * What the view reads for the cards agents show (docs/cards.md): `follow.cards` once per change of the workspace's own
 * list of them (`shownCards`, which moves its updatedAt), never a poll; media bytes by hash through `follow.card-media`,
 * kept in memory for this session (the newest `MEDIA_KEPT`), so a scroll or a re-render never asks again.
 */
export type ViewCard = Card & { freshness: { kind: "live" | "updated" | "stale" | "old"; label: string }; summary: string; contents: string; question: string | null };
export type ShownStamp = readonly { id: string; updatedAt: string; keep?: boolean }[] | undefined;

export const cardsKey = (workspaceId: string) => ["follow-up", "cards", workspaceId] as const;
const stampOf = (shown: ShownStamp) => (shown ?? []).map(s => `${s.id}@${s.updatedAt}${s.keep ? "+" : ""}`).join(",");

/** The workspace's cards. `shown` is the workspace's list of them: no list, no read. */
export function useCards(workspaceId: string, shown: ShownStamp, enabled = true) {
  const read = useRpc(cardsRpc);
  const stamp = stampOf(shown);
  const query = useQuery({
    queryKey: [...cardsKey(workspaceId), stamp], queryFn: () => read({ workspaceId }) as Promise<{ cards: ViewCard[]; removed: { id: string; title: string; removedAt: string }[] }>,
    enabled: enabled && !!workspaceId && !!shown?.length, staleTime: 60_000, refetchOnWindowFocus: false, placeholderData: prev => prev,
  });
  return { cards: shown?.length ? query.data?.cards ?? [] : [], pending: !!shown?.length && query.isPending, error: query.error as Error | null, refetch: query.refetch };
}

/** The ⋯ menu's actions: remove, undo, keep, unkeep. Re-reads the cards after. */
export function useCardAct(workspaceId: string) {
  const act = useRpc(cardActRpc);
  const cache = useQueryClient();
  return async (id: string, action: "remove" | "undo" | "keep" | "unkeep") => {
    const out = await act({ workspaceId, id, action });
    if (!out.ok) throw new Error(out.message);
    void cache.invalidateQueries({ queryKey: cardsKey(workspaceId) });
    return out;
  };
}

// ---------- media ----------

/** Data URIs by hash, oldest first; a video is held only while it plays (never cached). */
const MEDIA_KEPT = 48;
const media = new Map<string, Promise<string>>();
const sizes = new Map<string, { width: number; height: number }>();
function remember(hash: string, p: Promise<string>) {
  media.set(hash, p);
  while (media.size > MEDIA_KEPT) media.delete(media.keys().next().value as string);
  p.catch(() => media.delete(hash));
}

/** One image's bytes as a data URI (and its natural size), or why not. `hash` null: nothing to read. */
export function useMediaData(workspaceId: string, hash: string | null, enabled = true): { uri: string | null; size: { width: number; height: number } | null; error: string | null } {
  const read = useRpc(cardMediaRpc);
  const [state, setState] = useState<{ uri: string | null; size: { width: number; height: number } | null; error: string | null }>(() => ({ uri: null, size: hash ? sizes.get(hash) ?? null : null, error: null }));
  useEffect(() => {
    if (!hash || !enabled) return;
    let live = true;
    let p = media.get(hash);
    if (!p) { p = read({ workspaceId, hash }).then(r => `data:${r.mime};base64,${r.data}`); remember(hash, p); }
    p.then(uri => {
      if (!live) return;
      const known = sizes.get(hash);
      setState({ uri, size: known ?? null, error: null });
      if (!known) Image.getSize(uri, (width, height) => { sizes.set(hash, { width, height }); if (live) setState(s => ({ ...s, size: { width, height } })); }, () => undefined);
    }, e => { if (live) setState({ uri: null, size: null, error: e instanceof Error ? e.message : String(e) }); });
    return () => { live = false; };
  }, [workspaceId, hash, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

/** A video's bytes, read when it is played (never ahead), as an object URL on the web. */
export async function readVideo(read: (input: { workspaceId: string; hash: string }) => Promise<{ mime: string; data: string }>, workspaceId: string, hash: string): Promise<string> {
  const r = await read({ workspaceId, hash });
  const g = globalThis as unknown as { atob?: (s: string) => string; Blob?: new (parts: unknown[], o: { type: string }) => unknown; URL?: { createObjectURL(b: unknown): string } };
  if (Platform.OS === "web" && g.atob && g.Blob && g.URL?.createObjectURL) {
    const bin = g.atob(r.data); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return g.URL.createObjectURL(new g.Blob([bytes], { type: r.mime }));
  }
  return `data:${r.mime};base64,${r.data}`;
}

// ---------- going to a card ----------

/**
 * Where a card is on screen, so a question's "below" row, the header's spec link and Needs you's line can take the
 * developer to it: scrolled into view on desktop, opened full screen (the card's own screen) on a phone or when it
 * isn't on screen.
 */
type Mounted = { node: unknown; open: () => void };
const mounted = new Map<string, Mounted[]>();
const key = (workspaceId: string, cardId: string) => `${workspaceId}:${cardId}`;
export function registerCard(workspaceId: string, cardId: string, entry: Mounted): () => void {
  const k = key(workspaceId, cardId);
  mounted.set(k, [...(mounted.get(k) ?? []), entry]);
  return () => { const left = (mounted.get(k) ?? []).filter(e => e !== entry); if (left.length) mounted.set(k, left); else mounted.delete(k); };
}
let openLarge: ((workspaceId: string, cardId: string) => void) | null = null;
/** index.client.tsx: opens the card's own screen (Open large, and a phone's tap). */
export function bindOpenLarge(open: ((workspaceId: string, cardId: string) => void) | null) { openLarge = open; }
export const canOpenLarge = () => !!openLarge;
export function openCardLarge(workspaceId: string, cardId: string): void { openLarge?.(workspaceId, cardId); }

type DomEl = { getClientRects?(): { length: number }; scrollIntoView?(o: object): void; checkVisibility?(): boolean };
/** Takes the developer to a card: scrolls to a copy on screen (desktop web), else opens it large. */
export function goToCard(workspaceId: string, cardId: string, compact: boolean): void {
  if (!compact && Platform.OS === "web") {
    const on = (mounted.get(key(workspaceId, cardId)) ?? []).map(e => e.node as DomEl | null).find(n => n?.getClientRects?.().length && (n.checkVisibility?.() ?? true));
    if (on?.scrollIntoView) { on.scrollIntoView({ block: "start", behavior: "smooth" }); return; }
  }
  openCardLarge(workspaceId, cardId);
}

/** The card a screen is showing (Open large): its question's "below" row would point at the card it is docked under, so it skips it. */
export const CardHere = createContext<string | null>(null);
