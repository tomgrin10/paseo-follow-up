// Perf check (local, through harness-slot): an isolated daemon on scale-check's live-sized seed, with the web UI on, held
// open for a Playwright measurer. Same setup as scripts/scale-check.mjs (fixture provider, fake GitHub, scale-seed.ts).
//   node scripts/perf-ui-setup.mjs <info.json> [--workspaces 140] [--awake 5]
// Writes { origin, serverId, home, root, created } to <info.json> once the worker has loaded the seed; holds until SIGTERM.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, readdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { openSync } from "node:fs";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPaseoApi } from "@getpaseo/client";
import { harness, spawnDaemon } from "./harness.mjs";
import { harnessEnv, harnessConfig } from "./harness-env.mjs";
import { fakeGithub } from "./fake-github.mjs";
import { scaleGh } from "./scale-github.mjs";
import { LIVE_MALLOC_ENV } from "./scale-budget.mjs";

const exec = promisify(execFile);
await harness();
const infoPath = process.argv[2];
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const N = Number(arg("workspaces", "140")); const AWAKE = Number(arg("awake", "5"));
const root = await mkdtemp(join(tmpdir(), "follow-perf-"));
const home = join(root, "home"); const fixture = join(root, "fixture");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const free = async () => { const s = createServer(); await new Promise(r => s.listen(0, "127.0.0.1", r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; };
const port = await free(); const url = `ws://127.0.0.1:${port}/ws`;
await mkdir(join(root, "bin"), { recursive: true }); await writeFile(join(root, "bin/gh"), scaleGh()); await chmod(join(root, "bin/gh"), 0o700);
const github = await fakeGithub({ dir: root, gh: join(root, "bin/gh"), owners: ["example"] });
const env = harnessEnv(root, { home, strip: github.strip ?? [], set: { ...LIVE_MALLOC_ENV, ...github.env } });
const cli = async (...args) => JSON.parse((await exec("paseo", ["--home", home, "--json", ...args], { env, timeout: 120_000, maxBuffer: 8 << 20 })).stdout);
let daemon = null; let client = null;
const start = async () => {
  daemon = spawnDaemon(["daemon", "run", "--home", home], { env, stdio: ["ignore", openSync(join(root, "daemon.log"), "a"), openSync(join(root, "daemon.log"), "a")] });
  for (let i = 0; i < 240; i++) { try { await cli("workspace", "ls"); break; } catch { if (daemon.exitCode !== null) throw new Error("daemon exited"); if (i === 239) throw new Error("daemon did not start"); await sleep(250); } }
  client = new DaemonClient({ url, clientId: "follow-perf", clientType: "cli", reconnect: { enabled: false }, suppressSendErrors: true }); await client.connect();
};
const stop = async () => { await client?.close().catch(() => {}); client = null; if (daemon && daemon.exitCode === null) { daemon.kill("SIGTERM"); await new Promise(r => daemon.once("exit", r)); } daemon = null; };

await mkdir(home, { recursive: true }); await mkdir(fixture, { recursive: true });
await writeFile(join(home, "config.json"), JSON.stringify(harnessConfig({ port, webUi: true })));
await writeFile(join(fixture, "paseo-plugin.json"), JSON.stringify({ id: "followup-fixture", requirements: { paseo: ">=0.11.0" } }));
await writeFile(join(fixture, "index.server.ts"), await readFile("scripts/fixture-provider.ts", "utf8"));
const plugin = join(root, "plugin"); await mkdir(plugin);
const packed = JSON.parse((await exec("npm", ["pack", "--json", "--pack-destination", root], { timeout: 60_000 })).stdout)[0];
await exec("tar", ["-xzf", join(root, packed.filename), "--strip-components=1", "-C", plugin]);
await start();
await cli("plugin", "install", fixture);
const api = createPaseoApi(client);
const created = [];
for (let i = 0; i < N; i++) {
  const dir = join(root, "projects", `w${i}`); await mkdir(dir, { recursive: true });
  const w = await api.workspaces.create({ title: `Synthetic workspace ${i}`, source: { kind: "directory", path: dir } });
  const a = await w.agents.create({ config: { provider: "followup-fixture/fixture", model: "fixture", modeId: "default", providerOptions: { fixture_ack: "repairs" } }, title: `Synthetic agent ${i}` });
  await client.sendMessage(a.id, `Synthetic task ${i}: ship https://github.com/example/app/pull/${i + 1}`, { messageId: `scale-${i}` });
  const agentIds = [a.id, (await w.agents.create({ config: { provider: "followup-fixture/fixture", model: "fixture", modeId: "default" }, title: `Synthetic helper ${i}.1` })).id];
  created.push({ workspaceId: w.id, agentId: a.id, agentIds });
}
await sleep(2_000); await stop();
const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
const walk = async dir => { for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) { const p = join(dir, e.name); if (e.isDirectory()) await walk(p); else if (e.name.endsWith(".json")) { const text = await readFile(p, "utf8"); if (!text.includes("lastUserMessageAt")) continue; const j = JSON.parse(text); if (j.lastUserMessageAt) { j.lastUserMessageAt = old; await writeFile(p, JSON.stringify(j)); } } } };
await walk(join(home, "agents"));
await start();
for (const { agentId } of created.slice(0, AWAKE)) await client.sendMessage(agentId, "Synthetic: still working", { messageId: `awake-${agentId}` });
await sleep(2_000);
await mkdir(join(home, "plugin-data/follow-up"), { recursive: true });
await writeFile(join(root, "created.json"), JSON.stringify(created));
await exec("npx", ["tsx", "scripts/scale-seed.ts", join(home, "plugin-data/follow-up/state.json"), join(root, "created.json"), "3", "0", join(home, "plugin-data/follow-up/inbox.json"), "--live-sized"], { timeout: 120_000 });
await cli("plugin", "install", plugin);
for (let i = 0; i < 240; i++) { const r = await client.invokePluginRpc("follow-up", "follow.list", {}).catch(() => null); if (r && (r.workspaces?.length ?? 0) > 0) break; await sleep(500); }
const serverId = (await readFile(join(home, "server-id"), "utf8")).trim();
await writeFile(infoPath, JSON.stringify({ origin: `http://127.0.0.1:${port}`, port, serverId, home, root, created }));
console.log(`ready ${infoPath} http://127.0.0.1:${port}`);
await new Promise(() => {});
