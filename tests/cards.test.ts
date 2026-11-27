import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cards, CardsStore, resolveInside, sniffMedia } from "../server/cards";
import { CARD_LIMITS, cardContents, cardSummary, changedRows, freshness, showInputSchema, type Card } from "../shared/cards";
import { trackPersistence, rm } from "./support/store-temp-dir";

// Cards an agent shows the developer (docs/cards.md): show_card creates, replaces and removes; media is copied into
// Follow-up's data folder by hash; every limit refuses with what to do; paths stay inside the workspace.

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a2b3e3bd0000000049454e44ae426082", "hex");
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(16)]);
const T0 = Date.parse("2026-11-27T10:00:00Z");

async function setup(t: { after: (f: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "cards-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, "data"), ws = join(root, "ws");
  await mkdir(join(ws, "ui"), { recursive: true }); await mkdir(data, { recursive: true });
  await writeFile(join(ws, "ui/before.png"), PNG);
  await writeFile(join(ws, "ui/after.png"), Buffer.concat([PNG, Buffer.from("x")]));
  await writeFile(join(ws, "demo.mp4"), MP4);
  await writeFile(join(ws, "report.md"), "# Report\n");
  await writeFile(join(ws, "fake.png"), "not an image");
  let now = T0;
  const store = trackPersistence(data, new CardsStore(data));
  const cards = new Cards(store, data, () => now);
  return { cards, data, ws, author: { agentId: "main", title: "Main", root: ws }, tick: (ms: number) => { now += ms; } };
}

test("a card is created, replaced by id, and a block with an id replaces only that block", async t => {
  const { cards, author, tick } = await setup(t);
  const first = await cards.show("w1", author, { id: "matrix", title: "Browser matrix", blocks: [
    { type: "text", md: "Runs on every push." },
    { type: "table", id: "grid", columns: ["Browser", "Linux"], rows: [["Chrome", { state: "done" }], ["Edge", { state: "running" }]] },
  ] });
  assert.deepEqual({ shown: first.shown, blocks: first.blocks }, { shown: true, blocks: 2 });
  tick(20_000);
  await cards.show("w1", author, { id: "matrix", blocks: [{ type: "table", id: "grid", columns: ["Browser", "Linux"], rows: [["Chrome", { state: "done" }], ["Edge", { state: "failed" }]] }] });
  const [card] = (await cards.list("w1")).cards;
  assert.equal(card!.title, "Browser matrix", "the title stays when only a block changes");
  assert.equal(card!.blocks.length, 2, "the text block stays");
  assert.deepEqual(card!.changed, { grid: [1] }, "only the changed row is marked");
  assert.equal(cardSummary(card!), "1 of 2 done · 1 failed");
  assert.notEqual(card!.createdAt, card!.updatedAt);
});

test("media is copied by content hash, stored once, and survives the worktree", async t => {
  const { cards, data, ws, author } = await setup(t);
  const out = await cards.show("w1", author, { id: "renders", title: "README slides, dark look", blocks: [
    { type: "media", layout: "pairs", items: [{ src: "ui/after.png", before: "ui/before.png", label: "Slide 1" }, { src: "ui/after.png", before: "ui/before.png", label: "Slide 2" }] },
    { type: "media", items: [{ src: "demo.mp4" }] },
  ] });
  assert.equal(out.notes.length, 0);
  assert.equal((await readdir(join(data, "cards-media"))).length, 3, "two images and a video, each stored once");
  const card = (await cards.list("w1")).cards[0]!;
  assert.equal(cardContents(card), "2 before/after pairs · a video");
  const src = (card.blocks[0] as { items: { src: { hash: string } }[] }).items[0]!.src;
  await rm(ws, { recursive: true, force: true });
  const media = await cards.media("w1", src.hash);
  assert.equal(media.mime, "image/png");
  await assert.rejects(cards.media("w2", src.hash), /isn't on any card/, "only a hash a card of that workspace references is served");
});

test("a missing file is drawn as missing; a wrong type or an oversized file refuses the call", async t => {
  const { cards, author } = await setup(t);
  const out = await cards.show("w1", author, { id: "r", title: "Renders", blocks: [{ type: "media", items: [{ src: "ui/gone.png" }] }, { type: "files", items: [{ path: "nope.md" }, { path: "report.md" }] }] });
  assert.equal(out.shown, true);
  assert.match(out.notes.join(" "), /ui\/gone\.png: no such file/);
  const files = (await cards.list("w1")).cards[0]!.blocks[1] as { items: { gone?: boolean; bytes?: number }[] };
  assert.deepEqual(files.items.map(i => !!i.gone), [true, false]);
  await assert.rejects(cards.show("w1", author, { id: "x", title: "X", blocks: [{ type: "media", items: [{ src: "fake.png" }] }] }), /read from the file, not its name/);
  assert.equal((await cards.list("w1")).cards.length, 1, "a refused show changes nothing");
});

test("paths stay inside the workspace, after symlinks too; links are http(s) only", async t => {
  const { ws } = await setup(t);
  await symlink("/etc/hostname", join(ws, "escape.png")).catch(() => undefined);
  const out = await resolveInside(ws, "escape.png");
  assert.equal(out.ok, false);
  assert.equal(showInputSchema.safeParse({ id: "a", title: "A", blocks: [{ type: "media", items: [{ src: "../x.png" }] }] }).success, false);
  assert.equal(showInputSchema.safeParse({ id: "a", title: "A", blocks: [{ type: "media", items: [{ src: "/etc/x.png" }] }] }).success, false);
  assert.equal(showInputSchema.safeParse({ id: "a", title: "A", blocks: [{ type: "files", items: [{ url: "javascript:alert(1)" }] }] }).success, false);
  assert.equal(showInputSchema.safeParse({ id: "a", title: "A", blocks: [{ type: "files", items: [{ url: "data:text/html,x" }] }] }).success, false);
  assert.equal(showInputSchema.safeParse({ id: "a", title: "A", blocks: [{ type: "text", md: "x", html: "<b>" }] }).success, false, "no extra fields, no HTML");
});

test("12 cards a workspace: the 13th is refused with how to make room", async t => {
  const { cards, author } = await setup(t);
  for (let i = 0; i < CARD_LIMITS.cards; i++) await cards.show("w1", author, { id: `c${i}`, title: `Card ${i}`, blocks: [{ type: "text", md: "x" }] });
  await assert.rejects(cards.show("w1", author, { id: "c12", title: "One more", blocks: [{ type: "text", md: "x" }] }), /12 cards\. Remove one to add another/);
  await cards.show("w1", author, { id: "c3", title: "Replacing is fine", blocks: [{ type: "text", md: "y" }] });
  await cards.show("w1", author, { id: "c0", remove: true });
  await cards.show("w1", author, { id: "c12", title: "Now it fits", blocks: [{ type: "text", md: "x" }] });
  assert.equal((await cards.list("w1")).cards.length, 12);
});

test("limits refuse with the limit named", () => {
  const rows = Array.from({ length: 51 }, () => ["a"]);
  const parse = (blocks: unknown[]) => showInputSchema.safeParse({ id: "a", title: "A", blocks });
  assert.equal(parse([{ type: "table", columns: ["a"], rows }]).success, false, "50 rows");
  assert.equal(parse([{ type: "table", columns: Array.from({ length: 9 }, (_, i) => `c${i}`), rows: [] }]).success, false, "8 columns");
  assert.equal(parse(Array.from({ length: 13 }, () => ({ type: "text", md: "x" }))).success, false, "12 blocks");
  assert.equal(parse([{ type: "text", md: "x".repeat(4001) }]).success, false, "4,000 characters");
  assert.equal(parse([{ type: "chart", kind: "line", labels: ["a", "b"], series: [{ name: "s", values: [1] }] }]).success, false, "a value per label");
  assert.equal(showInputSchema.safeParse({ id: "a", title: "x".repeat(81), blocks: [] }).success, false, "80-char title");
  assert.equal(parse([{ type: "table", columns: ["a"], rows: Array.from({ length: 50 }, () => ["a"]) }]).success, true);
});

test("removal is undoable for a while; a removed card's media stays until then", async t => {
  const { cards, author, tick } = await setup(t);
  await cards.show("w1", author, { id: "r", title: "Renders", blocks: [{ type: "media", items: [{ src: "ui/after.png" }] }] });
  assert.equal(await cards.remove("w1", "r"), true);
  assert.equal(await cards.sweep(), 0, "kept for Undo");
  assert.deepEqual(await cards.undo("w1", "r"), { ok: true, message: "Back." });
  await cards.remove("w1", "r");
  tick(CARD_LIMITS.undoMs + 1);
  assert.equal((await cards.undo("w1", "r")).ok, false);
});

test("freshness follows the agent's turn and never pretends to be live", () => {
  const card = (updatedAt: string, state = "done"): Pick<Card, "updatedAt" | "blocks" | "keep"> => ({ updatedAt, keep: false, blocks: [{ type: "list", id: "s", items: [{ text: "a", state }] } as never] });
  const now = Date.parse("2026-11-27T12:00:00Z");
  assert.equal(freshness(card("2026-11-27T11:59:40Z"), { running: true, since: Date.parse("2026-11-27T11:50:00Z") }, now).label, "live · 20 s ago");
  assert.equal(freshness(card("2026-11-27T11:35:00Z"), { running: false, since: null }, now).label, "Updated 25 m ago");
  assert.deepEqual(freshness(card("2026-11-27T09:00:00Z", "running"), { running: false, since: Date.parse("2026-11-27T09:00:00Z") }, now), { kind: "stale", label: "agent idle · 3 h" });
  assert.equal(freshness(card("2026-11-19T12:00:00Z"), null, now).kind, "old");
  assert.equal(freshness({ ...card("2026-11-19T12:00:00Z"), keep: true }, null, now).kind, "updated", "Keep never folds as old");
  assert.equal(freshness(card("2026-11-27T11:40:00Z"), { running: true, since: Date.parse("2026-11-27T11:50:00Z") }, now).kind, "updated", "updated before this turn isn't live");
});

test("changed rows, media sniffing", () => {
  const a = { type: "list", id: "s", items: [{ text: "a" }, { text: "b" }] } as never;
  const b = { type: "list", id: "s", items: [{ text: "a" }, { text: "b", state: "done" }, { text: "c" }] } as never;
  assert.deepEqual(changedRows(a, b), [1, 2]);
  assert.equal(sniffMedia(new Uint8Array(PNG.subarray(0, 16))), "image/png");
  assert.equal(sniffMedia(new Uint8Array(MP4.subarray(0, 16))), "video/mp4");
  assert.equal(sniffMedia(new Uint8Array(Buffer.from("<html><script>"))), null);
});

test("an agent's spec link moves into a spec card once", async t => {
  const { cards } = await setup(t);
  const spec = { workspaceId: "w1", url: "https://claude.ai/artifact/abc", title: "Retry spec", by: "main", at: "2026-11-20T10:00:00Z" };
  assert.equal(await cards.migrateSpecs([spec]), 1);
  assert.equal(await cards.migrateSpecs([spec]), 0, "once");
  const card = (await cards.list("w1")).cards[0]!;
  assert.deepEqual({ id: card.id, title: card.title, url: (card.blocks[0] as { items: { url?: string }[] }).items[0]!.url }, { id: "spec", title: "Retry spec", url: spec.url });
});
