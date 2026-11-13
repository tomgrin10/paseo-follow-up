import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

/**
 * The real client stores (the live list, Needs you, Home's extras, the Display preferences), bundled for Node with
 * React Native and the host's UI kit stubbed, plus a fake host that counts RPCs and serves subscriptions the test can
 * close, refuse or push into. Used by tests/idle-rpc.test.ts and tests/feed-recovery.test.ts.
 */
const root = join(import.meta.dirname, "..");

export type Stores = {
  createLiveStore(client: never): { stop(): void; all(): { id: string; title: string }[] };
  createInboxStore(client: never): { stop(): void };
  createHomeExtras(client: never): { stop(): Promise<void>; priorities(): { id: string }[]; usage(): { accounts: unknown[] } };
  contributeDisplay(client: never, context: never): () => void;
};

let bundled: Promise<Stores> | null = null;
export function bundleStores(): Promise<Stores> {
  return bundled ??= (async () => {
    const dir = join(root, "node_modules", ".cache", "follow-client-stores");
    await mkdir(dir, { recursive: true });
    const stub = join(dir, "stub.cjs");
    // Anything the UI modules import from React Native or the host's UI kit: inert components and an always-active app.
    // Named exports are listed (esbuild's CommonJS interop copies own keys), read from the client's own imports.
    const names = new Set<string>();
    for (const f of (await readdir(join(root, "client"))).filter(f => /\.tsx?$/.test(f))) {
      const src = await readFile(join(root, "client", f), "utf8");
      for (const m of src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"(react-native|@getpaseo\/plugin\/client(?:\/ui)?)"/g)) for (const n of m[1].split(",")) { const name = n.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]; if (name) names.add(name); }
    }
    await writeFile(stub, `const app = { currentState: "active", addEventListener: () => ({ remove() {} }) };
const special = { AppState: app, Platform: { OS: "web", select: o => o.web ?? o.default }, StyleSheet: { create: s => s, hairlineWidth: 1 } };
const deep = new Proxy(function Stub() { return null; }, { get: (_t, k) => k === "then" || k === Symbol.toPrimitive ? undefined : deep, apply: () => deep, construct: () => deep });
for (const name of ${JSON.stringify([...names])}) exports[name] = special[name] ?? deep;`);
    const out = join(dir, "stores.mjs");
    await build({
      stdin: { contents: `export { createLiveStore } from "./client/live"; export { createInboxStore } from "./client/inbox-store"; export { createHomeExtras } from "./client/home-view"; export { contributeDisplay } from "./client/display";`, resolveDir: root, loader: "ts" },
      bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent", jsx: "automatic",
      alias: { "react-native": stub, "@getpaseo/plugin/client/ui": stub, "@getpaseo/plugin/client": stub },
      external: ["react", "react/*", "zod", "@tanstack/*", "@getpaseo/plugin", "lucide-react-native"],
    });
    return import(`${pathToFileURL(out).href}?t=${Date.now()}`) as Promise<Stores>;
  })();
}

/** Minimal answers per RPC; the stores tolerate anything else, and every call counts. */
const ANSWERS: Record<string, unknown> = {
  "follow.list": { workspaces: [], error: null, revision: 1, full: true, removed: [] },
  "follow.inbox-list": { etag: "e1", enabled: true, rows: [], unsorted: null, firstRun: false, batchUndo: null, signOffs: 0, error: null, overseer: null },
  "follow.priorities": { items: [] },
  "follow.usage": { available: false, source: null, accounts: [] },
};

/** What the worker does with a subscribe: serve it, refuse it (`ready` rejects), the call throws, or it accepts and drops it at once (a flapping host). */
export type SubscribeMode = "serve" | "refuse" | "throw" | "flap";
type Sub = { name: string; push(event: unknown): void; close(error?: Error): void; open: boolean };

export function fakeHost(withFeeds: boolean) {
  const calls: { at: number; name: string }[] = [];
  const subscriptions: string[] = [];
  const subscribed: { at: number; name: string }[] = [];
  const open: Sub[] = [];
  let mode: (name: string) => SubscribeMode = () => "serve";
  const client: Record<string, unknown> = {
    rpc: async (contract: { name: string }) => { calls.push({ at: Date.now(), name: contract.name }); return ANSWERS[contract.name] ?? (contract.name.endsWith(".read") ? { status: "ready", revision: "r1", values: {} } : {}); },
    paseo: { agents: { subscribe: () => () => undefined, list: async () => ({ entries: [], pageInfo: { nextCursor: null }, subscription: { release: async () => undefined } }) } },
    addSidebarHeaderItem: () => () => undefined,
  };
  if (withFeeds) client.subscribe = (contract: { name: string }, _input: unknown, onEvent: (e: unknown) => void, options?: { onClosed?: (c: { error?: Error }) => void }) => {
    subscriptions.push(contract.name); subscribed.push({ at: Date.now(), name: contract.name });
    const m = mode(contract.name);
    if (m === "throw") throw new Error(`no subscription ${contract.name}`);
    let released = false;
    const sub: Sub = {
      name: contract.name, open: m === "serve" || m === "flap",
      push: event => { if (sub.open && !released) onEvent(event); },
      close: error => { if (!sub.open || released) return; sub.open = false; options?.onClosed?.({ error }); },
    };
    if (m === "serve") open.push(sub);
    const release = () => { released = true; sub.open = false; };
    const ready = m === "refuse" ? Promise.reject(new Error(`Unknown plugin subscription ${contract.name}`)) : Promise.resolve();
    // Two hops, so the subscriber sees `ready` before the drop.
    if (m === "flap") void ready.then(() => undefined).then(() => sub.close(new Error("subscription dropped")));
    return Object.assign(release, {
      ready,
      release: async () => release(),
    });
  };
  return {
    client, calls, subscriptions, subscribed,
    /** How the worker answers the next subscribes (a stopped worker, or an older one that doesn't know a topic). */
    setMode(next: (name: string) => SubscribeMode) { mode = next; },
    /** The worker exited: Paseo closes every open subscription with the reason. */
    closeAll() { for (const s of open.splice(0)) s.close(new Error("Plugin process exited: follow-up")); },
    /** Push an event to every open subscription to `name`. */
    push(name: string, event: unknown) { for (const s of open) if (s.name === name) s.push(event); },
    live: (name: string) => open.filter(s => s.name === name && s.open).length,
  };
}

/** Lets a resolved promise chain run (fake timers don't). */
export const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };
