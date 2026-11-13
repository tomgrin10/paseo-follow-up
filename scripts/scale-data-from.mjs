// scale-check --data-from <dir>: start the harness worker on a COPY of a real plugin-data/follow-up directory, to
// reproduce a live install's memory or CPU at its exact size. Local only: the copy holds real names, so it never goes
// into the repo, CI, a PR or a screenshot (the committed seed, scripts/scale-seed.ts, is synthetic and matches the
// live SIZE instead).
//
// The harness daemon has its own workspace and agent ids, so the copy is remapped: workspace i of the copied
// state.json becomes harness workspace i, its main agent the harness workspace's main agent and every other agent it
// names (PR registrations, contributors, batch recipients) one helper agent each. Inbox entries for agents no
// workspace names get helpers in workspace 0. Every copied JSON file goes through the same id map, so the inbox,
// scopes, priorities and caches still point at the same (now harness) agents. GitHub answers come from the fixture
// `gh` (scripts/scale-github.mjs) with each PR in the state the copy last saw (SCALE_GH_STATES).
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Files the worker writes about its own process or the live daemon: never copied. */
const SKIP = new Set(["worker.lock", "tools-instance.json", "heartbeat.json"]);

/** What the harness must create: per copied workspace, the live agent ids (main first). */
export async function liveShape(dir) {
  const state = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
  const inbox = JSON.parse(await readFile(join(dir, "inbox.json"), "utf8").catch(() => "{}"));
  const named = new Set();
  const workspaces = state.workspaces.map(w => {
    const agents = [...new Set([w.mainAgentId, ...(w.contributorAgentIds ?? []), ...w.prs.map(p => p.registeredAgentId), ...w.batches.map(b => b.recipientAgentId)].filter(Boolean))];
    for (const a of agents) named.add(a);
    return { id: w.id, agents };
  });
  const loose = Object.keys(inbox.entries ?? {}).filter(a => !named.has(a));
  if (workspaces.length) workspaces[0].agents.push(...loose);
  const owners = [...new Set(state.workspaces.flatMap(w => w.prs.map(p => p.repo.split("/")[0])))];
  const prStates = Object.fromEntries(state.workspaces.flatMap(w => w.prs.filter(p => p.snapshot?.state).map(p => [p.key, p.snapshot.state])));
  return { workspaces, owners, prStates, prs: state.workspaces.reduce((n, w) => n + w.prs.length, 0) };
}

/** Copies every JSON file of `dir` into `out` with live ids replaced by the harness's (created[i] = { workspaceId, agentIds }). */
export async function copyLive(dir, out, shape, created) {
  const map = new Map();
  shape.workspaces.forEach((w, i) => { map.set(w.id, created[i].workspaceId); w.agents.forEach((a, k) => { if (created[i].agentIds[k]) map.set(a, created[i].agentIds[k]); }); });
  const pattern = new RegExp([...map.keys()].map(k => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  let files = 0;
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".json") || SKIP.has(name)) continue;
    await writeFile(join(out, name), (await readFile(join(dir, name), "utf8")).replace(pattern, id => map.get(id)));
    files++;
  }
  return { files, ids: map.size };
}
