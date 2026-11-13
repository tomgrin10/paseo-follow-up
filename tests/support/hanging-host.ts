import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
// @ts-expect-error: plain ESM helper without types.
import { harnessEnv } from "../../scripts/harness-env.mjs";

/**
 * A host where everything slow hangs, for the RPC acknowledgement invariant (tests/rpc-ack.test.ts):
 * - the handler context's `paseo` API (agents.ref(id).send, refresh, timeline…) never settles;
 * - `withDaemon` connects to a socket that accepts and never answers (the client gives up after its connect timeout);
 * - `gh` and `gt` on PATH block until the test process exits; the GitHub API (FOLLOW_UP_GITHUB_API) is the black hole.
 * The worker itself is the real one: `contribute()` from index.server.ts with its real stores, in a temp PASEO_HOME.
 *
 * Hanging is not forever: the worker gives up on some of these (the daemon client's 10 s connect timeout, a CLI it
 * kills, a fetch it aborts), and anything waiting on that wait then settles. `giveUps()` counts those moments (sockets
 * the worker closed on the black hole, hung CLIs that are gone), so a reply that only came because one fired can be
 * told apart from one that never waited (tests/support/ack-ratchet.ts).
 *
 * Call `hangingHost()` before anything imports index.server.ts or server/daemon.ts: both read PASEO_HOME at import.
 */
export const HUNG_TOOLS = ["gh", "gt", "mcpproxy", "claude", "codex", "paseo", "npm", "npx"];
export type Registered = { name: string; input: { parseAsync(value: unknown): Promise<unknown> }; run: (input: unknown, context: { paseo: unknown }) => unknown };

/** A value that is every API at once and never settles: any property is it, any call returns it, awaiting it hangs. */
export function hanging(): unknown {
  const calls: string[] = [];
  const make = (path: string): unknown => new Proxy(function () {}, {
    get: (_t, key) => {
      if (key === "then") return (_resolve: unknown, _reject: unknown) => { calls.push(path); };
      if (typeof key === "symbol") return undefined;
      return make(`${path}.${key}`);
    },
    apply: (_t, _this, _args) => make(`${path}()`),
  });
  return make("paseo");
}

export type HangingHost = { root: string; directory: string; giveUps(): number; close(): Promise<void> };

export async function hangingHost(): Promise<HangingHost> {
  const root = await mkdtemp(join(tmpdir(), "fu-rpc-ack-"));
  const sockets = new Set<Socket>();
  let closed = 0;
  const blackhole: Server = createServer(socket => { sockets.add(socket); socket.on("error", () => undefined); socket.on("close", () => { closed++; }); });
  await new Promise<void>(resolve => blackhole.listen(0, "127.0.0.1", resolve));
  const port = (blackhole.address() as { port: number }).port;
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  // Every outside CLI the worker spawns reads stdin until the parent goes away: a call that never returns, never reaches
  // a real account or service, and leaves no orphan. PATH holds only these, node's own dir and the system dirs (git and node stay real; the fakes come first).
  // Each records its pid (exec keeps it), so a CLI the worker killed or abandoned counts as a give-up.
  const pids = join(root, "tool-pids");
  for (const tool of HUNG_TOOLS) { await writeFile(join(bin, tool), `#!/bin/sh\necho $$ >> '${pids}'\nexec cat >/dev/null\n`); await chmod(join(bin, tool), 0o755); }
  const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
  const env = harnessEnv(root, { set: { PASEO_DAEMON_URL: `ws://127.0.0.1:${port}/ws`, PASEO_PASSWORD: "test", PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    // GitHub reads are in-process HTTPS (server/github-api.ts): the API is the same black hole, and token lookups run
    // the hung gh instead of /usr/bin/gh.
    FOLLOW_UP_GITHUB_API: `http://127.0.0.1:${port}`, FOLLOW_UP_GH_BIN: join(bin, "gh") } }) as Record<string, string>;
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  // The worker runs as CommonJS in Paseo, where server/daemon.ts's require() exists; under tsx's ESM it doesn't, and
  // every daemon call would fail at once instead of hanging on the socket.
  (globalThis as { require?: NodeJS.Require }).require ??= createRequire(import.meta.url);
  const paseo = env.PASEO_HOME;
  await mkdir(join(paseo, "plugin-data", "follow-up"), { recursive: true, mode: 0o700 });
  await writeFile(join(paseo, "config.json"), JSON.stringify({ daemon: { listen: `127.0.0.1:${port}` } }));
  return {
    root, directory: join(paseo, "plugin-data", "follow-up"),
    giveUps() {
      let started: number[] = [];
      try { started = readFileSync(pids, "utf8").split("\n").filter(Boolean).map(Number); } catch { /* none spawned yet */ }
      return closed + started.filter(gone).length;
    },
    async close() { for (const s of sockets) s.destroy(); await new Promise(resolve => blackhole.close(resolve)); },
  };
}

/** A fake PluginServerContext: collects handlers; hooks and events are accepted and never fire. */
export function fakeServer() {
  const handlers = new Map<string, Registered>();
  const server = {
    handle(contract: { name: string; input: Registered["input"] }, run: Registered["run"]) { handlers.set(contract.name, { name: contract.name, input: contract.input, run }); },
    on: () => () => undefined,
    before: () => () => undefined,
    registerProvider: () => undefined,
    registerUsageSource: () => undefined,
    registerSettings(definition: { schema: { parse(v: unknown): unknown } }) {
      const values = definition.schema.parse({});
      return { read: async () => ({ status: "ready" as const, revision: "1", values }), subscribe: () => () => undefined };
    },
  };
  return { server, handlers };
}

/** How long a call takes to settle (resolve or reject), capped at `cap` ms. `null` when it didn't settle. */
export async function settleTime(call: () => unknown, cap: number): Promise<{ ms: number | null; error: string | null }> {
  const start = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const capped = new Promise<"cap">(resolve => { timer = setTimeout(() => resolve("cap"), cap); });
  try {
    const outcome = await Promise.race([Promise.resolve().then(call).then(() => "ok" as const, (e: unknown) => e instanceof Error ? e : new Error(String(e))), capped]);
    if (outcome === "cap") return { ms: null, error: null };
    return { ms: performance.now() - start, error: outcome === "ok" ? null : outcome.message };
  } finally { clearTimeout(timer); }
}
