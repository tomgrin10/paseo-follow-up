import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { sniffImageType } from "../shared/images";
import {
  CARD_LIMITS, MEDIA_EXTENSIONS, cardsFileSchema, changedRows, capRefusal, emptyCardsFile, isVideo, mediaPaths, recommendColumn, showInputSchema, workspaceCardsSchema,
  type Block, type BlockInput, type Card, type CardsFile, type MediaRef, type MediaSource, type MediaType, type ShowInput, type WorkspaceCards,
} from "../shared/cards";
import { JsonFileStore } from "./json-file-store";

/**
 * Cards an agent shows the developer (docs/cards.md): `cards.json` beside state.json, one entry per workspace, and the
 * images and videos they show copied into `cards-media/<sha256>.<ext>` (files 0600, the folder 0700) when the card is
 * shown, so a card is a snapshot that survives `git clean` and the worktree's removal. Same content is stored once.
 * A worker start (and every removal) sweeps media no card references.
 */
export const CARDS_MEDIA_DIR = "cards-media";

export class CardsStore extends JsonFileStore<CardsFile> {
  constructor(directory: string) {
    super({ path: join(directory, "cards.json"), schema: cardsFileSchema as never, empty: emptyCardsFile, collections: { workspaces: { kind: "record", item: workspaceCardsSchema } } });
  }
}

const empty = (): WorkspaceCards => ({ cards: [], removed: [] });
const mediaBytes = (cards: readonly Card[]) => {
  const seen = new Map<string, number>();
  for (const c of cards) for (const r of cardMedia(c)) seen.set(r.hash, r.bytes);
  return [...seen.values()].reduce((a, b) => a + b, 0);
};
/** Every copied file a card references. */
export function cardMedia(card: Pick<Card, "blocks">): MediaRef[] {
  const out: MediaRef[] = [];
  const add = (s?: MediaSource) => { if (s && "hash" in s) out.push(s); };
  for (const b of card.blocks) {
    if (b.type === "media") for (const i of b.items) { add(i.src); add(i.before); }
    if (b.type === "files") for (const i of b.items) add(i.media);
  }
  return out;
}

/** The first bytes say what a media file is; its name never does. */
export function sniffMedia(head: Uint8Array): MediaType | null {
  const image = sniffImageType(head);
  if (image) return image;
  if (head.length >= 12 && String.fromCharCode(...head.subarray(4, 8)) === "ftyp") return "video/mp4";
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return "video/webm";
  return null;
}

type Read = { ok: true; abs: string; bytes: number } | { ok: false; reason: string };
/** A workspace-relative path, resolved through symlinks, that must stay inside the workspace. */
export async function resolveInside(root: string, path: string): Promise<Read> {
  let base: string;
  try { base = await realpath(root); } catch { return { ok: false, reason: "the workspace's folder can't be read" }; }
  const target = resolve(base, path);
  let real: string;
  try { real = await realpath(target); } catch { return { ok: false, reason: `${path}: no such file` }; }
  const rel = relative(base, real);
  if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) return { ok: false, reason: `${path} is outside the workspace` };
  const info = await stat(real).catch(() => null);
  if (!info?.isFile()) return { ok: false, reason: `${path} isn't a file` };
  return { ok: true, abs: real, bytes: info.size };
}

export type ShowResult = { id: string; shown: boolean; removed?: boolean; blocks: number; bytes: number; notes: string[] };
export type Author = { agentId: string; title: string | null; root: string };

export class Cards {
  readonly mediaDir: string;
  constructor(private store: CardsStore, directory: string, private now: () => number = Date.now) { this.mediaDir = join(directory, CARDS_MEDIA_DIR); }

  async list(workspaceId: string): Promise<WorkspaceCards> { return (await this.store.read()).workspaces[workspaceId] ?? empty(); }

  /** A copied file, read for the client (only a hash some card references). */
  async media(workspaceId: string, hash: string): Promise<{ mime: MediaType; data: string; bytes: number }> {
    const ref = (await this.list(workspaceId)).cards.flatMap(cardMedia).find(r => r.hash === hash);
    if (!ref) throw new Error("That image isn't on any card here any more.");
    const handle = await open(join(this.mediaDir, `${ref.hash}.${MEDIA_EXTENSIONS[ref.mime]}`), "r").catch(() => null);
    if (!handle) throw new Error("That image's copy is gone; ask the agent to show the card again.");
    try { const bytes = await handle.readFile(); return { mime: ref.mime, data: bytes.toString("base64"), bytes: bytes.length }; } finally { await handle.close(); }
  }

  /** Copies one media source into the data folder by its hash; a failure becomes the reason the card draws in its place. */
  private async copy(root: string, path: string): Promise<MediaSource> {
    const name = path.split(/[\\/]/).pop() || path;
    const found = await resolveInside(root, path);
    if (!found.ok) return { missing: found.reason, name };
    const handle = await open(found.abs, "r").catch(() => null);
    if (!handle) return { missing: `${path} can't be read`, name };
    try {
      const head = new Uint8Array(16); await handle.read(head, 0, 16, 0);
      const mime = sniffMedia(head);
      if (!mime) throw new Error(`${path}: images are PNG, JPEG, GIF or WebP, videos MP4 or WebM (read from the file, not its name)`);
      const cap = isVideo(mime) ? CARD_LIMITS.videoBytes : CARD_LIMITS.imageBytes;
      if (found.bytes > cap) throw new Error(`${isVideo(mime) ? "video" : "image"} over ${cap / 1024 / 1024} MB: ${path}`);
      const bytes = await handle.readFile();
      const hash = createHash("sha256").update(bytes).digest("hex");
      await mkdir(this.mediaDir, { recursive: true, mode: 0o700 });
      await writeFile(join(this.mediaDir, `${hash}.${MEDIA_EXTENSIONS[mime]}`), bytes, { mode: 0o600, flag: "wx" }).catch((e: NodeJS.ErrnoException) => { if (e.code !== "EEXIST") throw e; });
      return { hash, mime, bytes: bytes.length, name };
    } finally { await handle.close(); }
  }

  /** The agent's blocks with every path read: media copied, file rows checked. Refuses on a cap; a missing file is drawn as missing. */
  private async resolveBlocks(root: string, blocks: readonly BlockInput[], previous: Card | undefined, notes: string[]): Promise<Block[]> {
    const out: Block[] = [];
    const used = new Set<string>();
    for (const [index, b] of blocks.entries()) {
      let id = b.id ?? `b${index + 1}`;
      if (used.has(id)) throw new Error(`Two blocks have the id ${id}.`);
      used.add(id);
      if (b.type === "media") {
        const items = [];
        for (const i of b.items) {
          const src = await this.copy(root, i.src);
          const before = i.before ? await this.copy(root, i.before) : undefined;
          for (const s of [src, before]) if (s && "missing" in s) notes.push(`Shown as missing: ${s.missing}.`);
          items.push({ src, ...(before ? { before } : {}), ...(i.label ? { label: i.label } : {}), ...(i.caption ? { caption: i.caption } : {}) });
        }
        out.push({ type: "media", id, items, ...(b.layout ? { layout: b.layout } : {}) });
      } else if (b.type === "files") {
        const items = [];
        for (const i of b.items) {
          if (i.url) { items.push({ url: i.url, ...(i.label ? { label: i.label } : {}), ...(i.note ? { note: i.note } : {}) }); continue; }
          const found = await resolveInside(root, i.path!);
          if (!found.ok) notes.push(`File row marked gone: ${found.reason}.`);
          // An image or video in a files row is copied too, so Follow-up's viewer can open it after the worktree goes.
          let media: MediaRef | undefined;
          if (found.ok) { const head = await readHead(found.abs); if (head && sniffMedia(head)) { const s = await this.copy(root, i.path!); if ("hash" in s) media = s; } }
          items.push({ path: i.path!, ...(i.label ? { label: i.label } : {}), ...(i.note ? { note: i.note } : {}), ...(found.ok ? { bytes: found.bytes } : { gone: true }), ...(media ? { media } : {}) });
        }
        out.push({ type: "files", id, items });
      } else if (b.type === "table" && b.recommend !== undefined) out.push({ ...b, id, recommend: recommendColumn(b.columns, b.recommend)! } as Block);
      else out.push({ ...b, id } as Block);
    }
    void previous;
    return out;
  }

  /**
   * `show`: create a card, replace it by id, replace only the blocks whose id is given, or remove it. Refusals (a cap, a
   * bad schema) throw with the limit named and leave the previous version as it was.
   */
  async show(workspaceId: string, author: Author, raw: unknown): Promise<ShowResult> {
    const parsed = showInputSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`show_card: ${parsed.error.issues.slice(0, 3).map(i => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`);
    const input: ShowInput = parsed.data;
    const current = await this.list(workspaceId);
    const previous = current.cards.find(c => c.id === input.id);
    if (input.remove) {
      if (!previous) return { id: input.id, shown: false, removed: false, blocks: 0, bytes: 0, notes: [`No card ${input.id} to remove.`] };
      await this.remove(workspaceId, input.id);
      return { id: input.id, shown: false, removed: true, blocks: 0, bytes: 0, notes: [] };
    }
    if (!previous && !input.title) throw new Error("show_card: a new card needs a title.");
    if (!previous && !input.blocks?.length) throw new Error("show_card: a new card needs at least one block.");
    if (!previous && current.cards.length >= CARD_LIMITS.cards) throw new Error(capRefusal());
    const notes: string[] = [];
    const resolved = input.blocks ? await this.resolveBlocks(author.root, input.blocks, previous, notes) : [];
    // Blocks with an id replace that block in place; a new id is added at the end. Without ids the card is replaced whole.
    const partial = !!previous && !!input.blocks?.length && input.blocks.every(b => b.id && b.id !== "") && input.blocks.some(b => previous.blocks.some(p => p.id === b.id));
    let blocks: Block[] = previous && !input.blocks ? previous.blocks : resolved;
    if (partial) {
      blocks = previous!.blocks.map(p => resolved.find(r => r.id === p.id) ?? p);
      for (const r of resolved) if (!previous!.blocks.some(p => p.id === r.id)) blocks.push(r);
      if (blocks.length > CARD_LIMITS.blocks) throw new Error(`show_card: a card holds ${CARD_LIMITS.blocks} blocks.`);
    }
    const changed: Record<string, number[]> = {};
    if (previous) for (const b of blocks) { const rows = changedRows(previous.blocks.find(p => p.id === b.id), b); if (rows.length) changed[b.id] = rows; }
    const at = new Date(this.now()).toISOString();
    const card: Card = {
      id: input.id, title: input.title ?? previous!.title, blocks, by: author.agentId, byTitle: author.title,
      createdAt: previous?.createdAt ?? at, updatedAt: at, changed, keep: previous?.keep ?? false,
    };
    const json = JSON.stringify(card).length;
    if (json > CARD_LIMITS.cardJson) throw new Error(`show_card: the card is ${Math.round(json / 1024)} KB; the most is ${CARD_LIMITS.cardJson / 1024} KB. Put long content in a files row.`);
    const others = current.cards.filter(c => c.id !== card.id);
    const own = mediaBytes([card]);
    if (own > CARD_LIMITS.cardMediaBytes) throw new Error(`show_card: the card's images and videos are ${Math.round(own / 1024 / 1024)} MB; the most is ${CARD_LIMITS.cardMediaBytes / 1024 / 1024} MB.`);
    if (mediaBytes([...others, card]) > CARD_LIMITS.workspaceMediaBytes) throw new Error(`show_card: this workspace's cards would hold over ${CARD_LIMITS.workspaceMediaBytes / 1024 / 1024} MB of images and videos. Remove a card first.`);
    await this.store.mutate(file => {
      const w = file.workspaces[workspaceId] ?? (file.workspaces[workspaceId] = empty());
      const i = w.cards.findIndex(c => c.id === card.id);
      if (i < 0 && w.cards.length >= CARD_LIMITS.cards) throw new Error(capRefusal());
      // A card keeps its place in its section; a new one goes first (newest update first applies on the next open).
      if (i >= 0) w.cards[i] = card; else w.cards.unshift(card);
    });
    if (previous) await this.sweep();
    return { id: card.id, shown: true, blocks: card.blocks.length, bytes: own, notes };
  }

  /** Removes a card (the agent's `remove`, the developer's ⋯ Remove). It stays restorable for `undoMs`. */
  async remove(workspaceId: string, id: string): Promise<boolean> {
    const at = new Date(this.now());
    const gone = await this.store.mutate(file => {
      const w = file.workspaces[workspaceId];
      const card = w?.cards.find(c => c.id === id);
      if (!w || !card) return false;
      w.cards = w.cards.filter(c => c.id !== id);
      w.removed = [{ ...card, removedAt: at.toISOString() }, ...w.removed.filter(r => r.id !== id && at.getTime() - Date.parse(r.removedAt) < CARD_LIMITS.undoMs)].slice(0, CARD_LIMITS.cards);
      return true;
    });
    return gone;
  }

  /** Undo of a removal, within `undoMs`, unless the agent showed a card with the same id since or the cap is full. */
  async undo(workspaceId: string, id: string): Promise<{ ok: boolean; message: string }> {
    const now = this.now();
    return this.store.mutate(file => {
      const w = file.workspaces[workspaceId];
      const r = w?.removed.find(r => r.id === id);
      if (!w || !r || now - Date.parse(r.removedAt) > CARD_LIMITS.undoMs) return { ok: false, message: "Nothing to undo." };
      if (w.cards.some(c => c.id === id)) return { ok: false, message: "The agent has shown it again since." };
      if (w.cards.length >= CARD_LIMITS.cards) return { ok: false, message: capRefusal() };
      const { removedAt: _, ...card } = r;
      w.cards.unshift(card);
      w.removed = w.removed.filter(x => x.id !== id);
      return { ok: true, message: "Back." };
    });
  }

  /** Keep: never folds as old. */
  async keep(workspaceId: string, id: string, keep: boolean): Promise<boolean> {
    return this.store.mutate(file => {
      const c = file.workspaces[workspaceId]?.cards.find(c => c.id === id);
      if (!c) return false;
      if (c.keep !== keep) c.keep = keep;
      return true;
    });
  }

  /** A workspace's cards go with it (archived and past the usual retention, or gone from state). */
  async forget(keepWorkspaces: ReadonlySet<string>): Promise<number> {
    const n = await this.store.mutate(file => {
      let n = 0;
      for (const id of Object.keys(file.workspaces)) if (!keepWorkspaces.has(id)) { delete file.workspaces[id]; n++; }
      return n;
    });
    if (n) await this.sweep();
    return n;
  }

  /** Removes every copied file no card (or restorable removal) references. */
  async sweep(): Promise<number> {
    const file = await this.store.read();
    const keep = new Set<string>();
    for (const w of Object.values(file.workspaces)) for (const c of [...w.cards, ...w.removed]) for (const r of cardMedia(c)) keep.add(r.hash);
    let names: string[];
    try { names = await readdir(this.mediaDir); } catch { return 0; }
    let removed = 0;
    for (const name of names) if (!keep.has(name.replace(/\.[^.]+$/, ""))) await rm(join(this.mediaDir, name), { force: true }).then(() => { removed++; }, () => undefined);
    return removed;
  }

  /** One-time: an agent's spec link (set_spec, retired) becomes a `spec` card with a files row, so nothing it set is lost. */
  async migrateSpecs(specs: readonly { workspaceId: string; url: string; title: string | null; by: string | null; at: string }[]): Promise<number> {
    const MIGRATION = "spec-card-1";
    return this.store.mutate(file => {
      if (file.migrations.includes(MIGRATION)) return 0;
      let n = 0;
      for (const s of specs) {
        const w = file.workspaces[s.workspaceId] ?? (file.workspaces[s.workspaceId] = empty());
        if (w.cards.some(c => c.id === "spec") || w.cards.length >= CARD_LIMITS.cards) continue;
        w.cards.push({ id: "spec", title: (s.title || "Spec").slice(0, CARD_LIMITS.title), blocks: [{ type: "files", id: "b1", items: [{ url: s.url, label: s.title || "Spec" }] }], by: s.by ?? "", byTitle: null, createdAt: s.at, updatedAt: s.at, changed: {}, keep: false });
        n++;
      }
      file.migrations.push(MIGRATION);
      return n;
    });
  }
}

async function readHead(path: string): Promise<Uint8Array | null> {
  const info = await lstat(path).catch(() => null);
  if (!info) return null;
  const handle = await open(path, "r").catch(() => null);
  if (!handle) return null;
  try { const head = new Uint8Array(16); await handle.read(head, 0, 16, 0); return head; } finally { await handle.close(); }
}
