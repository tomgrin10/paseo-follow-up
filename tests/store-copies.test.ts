import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store";
import { InboxStore } from "../server/inbox";
import { LinkedStore } from "../server/linked";
import { AboutStore } from "../server/about";
import { RenameStore } from "../server/rename";
import { newEntry } from "../shared/inbox";
import { emptyWorkspaceLinks } from "../shared/linked";
import { workspace } from "./fixtures";

// Invariant a-mutation-copies-only-what-it-changes (it generalises a-send-never-clones-the-whole-state, #139). A store's
// mutation copies only the items it touches, keeps every unchanged item's saved (frozen) object, validates only what
// changed, and serialises the file once per real write; a mutation that changed nothing copies and writes nothing.
// 2026-11-13: InboxStore still copied, validated and stringified the whole inbox per mutation (live RSS 315 → 405 MB under
// agent turns), the second store with #139's bug. This file WALKS every writer of JSON in server/: a new one must either
// keep its collection on server/cow.ts (and get a row below that checks it) or carry an exemption with its reason.

type Item = Record<string, unknown>;
type Collected = {
  make(dir: string): Promise<{ mutate<T>(fn: (v: any) => T): Promise<T>; read(): Promise<any> }>;
  /** Puts `n` items into the collection. */
  seed(v: any, n: number): void;
  items(v: any): Record<string, Item>;
  /** Changes item `id` in place. */
  touch(v: any, id: string): void;
};
const rec = (v: any, field: string) => v[field] as Record<string, Item>;
const COPY_ON_ACCESS: Record<string, Collected> = {
  "server/store.ts": {
    make: async dir => { const s = new Store(dir, 0, 0); return { mutate: fn => s.mutate(fn), read: () => s.snapshot() }; },
    seed: (v, n) => { for (let i = 0; i < n; i++) v.workspaces.push(workspace({ id: `w${i}`, title: `Synthetic ${i}` } as never)); },
    items: v => Object.fromEntries(v.workspaces.map((w: Item) => [w.id, w])),
    touch: (v, id) => { v.workspaces.find((w: Item) => w.id === id).goal = "Changed"; },
  },
  "server/inbox.ts": {
    make: async dir => { const s = new InboxStore(dir); return { mutate: fn => s.mutate(fn), read: () => s.snapshot() }; },
    seed: (v, n) => { for (let i = 0; i < n; i++) v.entries[`a${i}`] = { ...newEntry(`a${i}`), seenKeys: Array.from({ length: 50 }, (_, k) => `k${k}`) }; },
    items: v => rec(v, "entries"),
    touch: (v, id) => { v.entries[id].seq = 9; },
  },
  "server/json-file-store.ts (linked.json)": {
    make: async dir => new LinkedStore(dir) as never,
    seed: (v, n) => { for (let i = 0; i < n; i++) v.workspaces[`w${i}`] = emptyWorkspaceLinks(); },
    items: v => rec(v, "workspaces"),
    touch: (v, id) => { v.workspaces[id].candidates.push({ key: "ACME-1", seen: 1, firstSeen: "2026-11-13T00:00:00.000Z", retryAt: null, failures: 0, strong: true }); },
  },
  "server/json-file-store.ts (about.json)": {
    make: async dir => new AboutStore(dir) as never,
    seed: (v, n) => { for (let i = 0; i < n; i++) v.entries[`w${i}`] = { workspaceId: `w${i}`, inputsHash: `h${i}`, generatedAt: "2026-11-13T00:00:00.000Z", gist: `Synthetic summary ${i}.`, overview: "", links: [], basis: { chat: true, source: "live", prs: 1, issues: [] }, failed: [], costUsd: null }; },
    items: v => rec(v, "entries"),
    touch: (v, id) => { v.entries[id].inputsHash = "changed"; },
  },
};

/**
 * Writers that keep JSON on disk but aren't a store of items: each is small, derived or rare, with why. A new writer
 * not listed here or above fails the walk.
 */
const EXEMPT: Record<string, string> = {
  "server/agent-hooks.ts": "the provider's settings.json/hooks.json, written on install and lease renewals only",
  "server/agent-settings.ts": "Settings → Agents (a few hundred bytes), written on the developer's change",
  "server/background-agents.ts": "a list of background agent ids, written when one appears",
  "server/daemon.ts": "a recovery context file, written once per recovery batch",
  "server/history-cache.ts": "one write per discovery pass that found new history (tens of KB), not per mutation",
  "server/job-agent.ts": "an AI job's prompt file, once per job",
  "server/onboarding.ts": "onboarding flags (bytes), on the developer's click",
  "server/overseer.ts": "overseer.json (bytes) on lifecycle changes; the digest is derived output written on change",
  "server/plugin-move.ts": "the one-time 1.x move record",
  "server/pr-workflow.ts": "Settings → PR workflow (bytes), on the developer's change",
  "server/priorities.ts": "the ranker's output (≈12 KB), once per ranking run",
  "server/ranker.ts": "the ranker's own state (bytes), once per run",
  "server/release-notes.ts": "What's new seen markers, on the developer's click",
  "server/reviewer-config.ts": "Settings → Reviewers (bytes), on the developer's change",
  "server/scopes.ts": "derived per-agent scopes for hooks (≈14 KB), rewritten only when they change",
  "server/trust-bypass.ts": "a JSONL audit line per decision",
  "server/updates.ts": "update records, on an install",
  "server/wait-jobs.ts": "one Wait job's record, per job",
  "server/write-through.ts": "the user-config writer the files above call (no JSON of its own)",
};

async function writers(): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir("server", { recursive: true })) {
    const path = join("server", String(entry));
    if (!path.endsWith(".ts") || path.endsWith("-source.ts")) continue;
    const text = await readFile(path, "utf8");
    if (/writeFile\(|atomic\(/.test(text)) out.push(path);
  }
  return out.sort();
}

test("a-mutation-copies-only-what-it-changes: every JSON writer in server/ is a copy-on-access store or a listed exemption", async () => {
  const covered = new Set([...Object.keys(COPY_ON_ACCESS).map(k => k.split(" ")[0]), ...Object.keys(EXEMPT)]);
  const unknown = (await writers()).filter(f => !covered.has(f));
  assert.deepEqual(unknown, [], "a new store must use server/cow.ts (and get a COPY_ON_ACCESS row here) or be exempted with a reason");
  for (const f of ["server/linked.ts", "server/about.ts", "server/rename.ts"]) assert.match(await readFile(f, "utf8"), /extends JsonFileStore</, `${f} keeps its file on the shared store`);
});

for (const [name, s] of Object.entries(COPY_ON_ACCESS)) {
  test(`a-mutation-copies-only-what-it-changes: ${name}`, async t => {
    const dir = await mkdtemp(join(tmpdir(), "follow-store-copies-")); t.after(() => rm(dir, { recursive: true, force: true }));
    const store = await s.make(dir);
    await store.mutate(v => s.seed(v, 40));
    const before = await store.read();
    await store.mutate(v => s.touch(v, Object.keys(s.items(v))[7]));
    const after = await store.read();
    const ids = Object.keys(s.items(before));
    const touched = ids[7];
    assert.notEqual(s.items(after)[touched], s.items(before)[touched], "the touched item is new");
    assert.deepEqual(ids.filter(id => id !== touched && s.items(after)[id] !== s.items(before)[id]), [], "every other item is the saved object");
    assert.ok(Object.isFrozen(s.items(after)[touched]), "the saved item is frozen");
    // Reading every item without changing one: the same saved value comes back.
    const reread = await store.read();
    await store.mutate(v => { for (const item of Object.values(s.items(v))) void JSON.stringify(item).length; });
    assert.equal(await store.read(), reread, "a mutation that changed nothing keeps the saved value");
  });
}
