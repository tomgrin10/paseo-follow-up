import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

/**
 * Invariant idle-client-makes-at-most-one-rpc-a-minute (Paseo 0.16, plan item 6): an open Follow-up client that the
 * developer isn't touching makes at most one plugin RPC a minute. Before, every open client polled the workspace list,
 * Needs you, the Overseer (each every 15 s), priorities, the ranker, usage and the Display setting (each every 60 s):
 * about 17 a minute for an idle Home, before any panel. Now the worker pushes them (client/feeds.ts, server/feeds.ts).
 *
 * The real client stores (the live list, Needs you, Home's extras, the Display preferences) run against a fake host
 * for ten simulated minutes. React Native and the host UI are stubbed; the stores are what polls. On a 0.15 host
 * (no `client.subscribe`) the same stores must still poll, or nothing would ever update there.
 */
const root = join(import.meta.dirname, "..");
const MINUTES = 10;
const OPEN_MS = 5_000;

async function bundle(): Promise<Record<string, (...args: never[]) => unknown>> {
  const dir = join(root, "node_modules", ".cache", "follow-idle-rpc");
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
  return import(`${pathToFileURL(out).href}?t=${Date.now()}`);
}

/** Minimal answers per RPC; the stores tolerate anything else, and every call counts. */
const ANSWERS: Record<string, unknown> = {
  "follow.list": { workspaces: [], error: null, revision: 1, full: true, removed: [] },
  "follow.inbox-list": { etag: "e1", enabled: true, rows: [], unsorted: null, firstRun: false, batchUndo: null, signOffs: 0, error: null, overseer: null },
  "follow.priorities": { items: [] },
  "follow.usage": { available: false, source: null, accounts: [] },
};

function fakeHost(withFeeds: boolean) {
  const calls: { at: number; name: string }[] = [];
  const subscriptions: string[] = [];
  const client: Record<string, unknown> = {
    rpc: async (contract: { name: string }) => { calls.push({ at: Date.now(), name: contract.name }); return ANSWERS[contract.name] ?? (contract.name.endsWith(".read") ? { status: "ready", revision: "r1", values: {} } : {}); },
    paseo: { agents: { subscribe: () => () => undefined, list: async () => ({ entries: [], pageInfo: { nextCursor: null }, subscription: { release: async () => undefined } }) } },
    addSidebarHeaderItem: () => () => undefined,
  };
  if (withFeeds) client.subscribe = (contract: { name: string }) => {
    subscriptions.push(contract.name);
    const handle = Object.assign(() => undefined, { ready: Promise.resolve(), release: async () => undefined });
    return handle;
  };
  return { client, calls, subscriptions };
}

async function idleRpcsPerMinute(withFeeds: boolean) {
  const stores = await bundle();
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.parse("2026-11-12T12:00:00Z") });
  const host = fakeHost(withFeeds);
  const started = Date.now();
  const live = stores.createLiveStore(host.client as never) as { stop(): void };
  const inbox = stores.createInboxStore(host.client as never) as { stop(): void };
  const extras = stores.createHomeExtras(host.client as never) as { stop(): Promise<void> };
  const display = stores.contributeDisplay(host.client as never, {} as never) as () => void;
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };
  try {
    for (let ms = 0; ms < MINUTES * 60_000; ms += 1_000) { mock.timers.tick(1_000); await settle(); }
  } finally {
    live.stop(); inbox.stop(); await extras.stop(); display();
    mock.timers.reset();
  }
  const idle = host.calls.filter(c => c.at - started >= OPEN_MS);
  const byName = new Map<string, number>(); for (const c of idle) byName.set(c.name, (byName.get(c.name) ?? 0) + 1);
  return { perMinute: idle.length / MINUTES, byName: [...byName].map(([n, k]) => `${n} ${k}`).join(", "), subscriptions: host.subscriptions };
}

test("invariant idle-client-makes-at-most-one-rpc-a-minute: an idle open client on Paseo 0.16 is pushed to, not polling", { timeout: 120_000 }, async () => {
  const r = await idleRpcsPerMinute(true);
  assert.ok(r.perMinute <= 1, `an idle open client made ${r.perMinute} RPCs a minute (${r.byName}); subscribe to a feed (client/feeds.ts) instead of polling`);
  for (const feed of ["follow.workspaces-feed", "follow.inbox-feed", "follow.home-feed", "follow.display-feed"]) assert.ok(r.subscriptions.includes(feed), `subscribed to ${feed}: ${r.subscriptions.join(", ")}`);
});

test("on Paseo 0.15 (no client.subscribe) the same stores still poll, so the client keeps updating", { timeout: 120_000 }, async () => {
  const r = await idleRpcsPerMinute(false);
  assert.ok(r.perMinute >= 8, `a 0.15 client polled only ${r.perMinute} times a minute (${r.byName})`);
  for (const name of ["follow.list", "follow.inbox-list", "follow.overseer-status"]) assert.match(r.byName, new RegExp(`${name.replace(".", "\\.")} \\d+`), `${name} still polls on 0.15`);
});
