import { readFile, writeFile, chmod, rename } from "node:fs/promises";
import { join } from "node:path";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPaseoApi } from "@getpaseo/client";
const fixture = JSON.parse(await readFile(".preview-isolated.json", "utf8"));
if (!fixture.root.startsWith("/tmp/follow-install-")) throw new Error("Demo seeding only supports an isolated test daemon.");
const client = new DaemonClient({ url: `ws://127.0.0.1:${fixture.port}/ws`, clientId: "follow-demo-seed", clientType: "cli", reconnect: { enabled: false } });
await client.connect(); const api = createPaseoApi(client);
const call = (method, input) => client.invokePluginRpc("follow-through", method, input);
try {
  const definitions = {
    1: { title: "Record migration versions", state: "MERGED" },
    2: { title: "Keep automatic rollout explicit", state: "OPEN", conflict: true, threads: 2 },
    3: { title: "Show ETA and stalled runs", state: "OPEN", pending: true },
    4: { title: "Add migration status to the CLI", state: "OPEN", approved: true },
    6: { title: "Ship migration ledger", state: "MERGED" },
    5: { title: "Expose workspace-scoped commands", state: "OPEN", approved: false },
  };
  const script = `#!/usr/bin/env node\nconst d=${JSON.stringify(definitions)};if(process.argv[3]!=='graphql'){console.log('[]');process.exit(0)}const query=process.argv.find(a=>a.startsWith('query='));const r={defaultBranchRef:{name:'main'}};for(const m of query.matchAll(/(p\\d+):pullRequest\\(number:(\\d+)\\)/g)){const n=Number(m[2]);const p=d[n]??{title:'Demo pull request',state:'OPEN'};r[m[1]]={number:n,title:p.title,url:'https://github.com/example/app/pull/'+n,state:p.state,headRefOid:'fixture-head-'+n,baseRefName:'main',isDraft:false,mergeable:p.conflict?'CONFLICTING':'MERGEABLE',mergeStateStatus:p.conflict?'DIRTY':'CLEAN',reviewDecision:p.approved?'APPROVED':'REVIEW_REQUIRED',baseRef:null,reviewThreads:{nodes:Array.from({length:p.threads??0},(_,i)=>({id:'thread-'+n+'-'+i,isResolved:false,comments:{nodes:[{updatedAt:'2026-01-01T10:00:00Z'}]}})),pageInfo:{hasNextPage:false}},commits:{nodes:[]}}}console.log(JSON.stringify({data:{repository:r}}));\n`;
  await writeFile(join(fixture.root, "bin/gh"), script); await chmod(join(fixture.root, "bin/gh"), 0o700);
  await api.workspaces.ref(fixture.workspaceId).setTitle("Migration autopilot · demo");
  await call("follow.enroll", { agentId: fixture.agentId, goal: "Ship automatic migrations and verify the production rollout" });
  await call("follow.register-pr", { agentId: fixture.agentId, repo: "example/app", number: 6, stack: "Settled ledger", parentNumber: null });
  for (const [number, stack, parentNumber] of [[1, "Migration autopilot", null], [2, "Migration autopilot", 1], [3, "Migration autopilot", 2], [4, "CLI access", null], [5, "CLI access", 4]])
    await call("follow.register-pr", { agentId: fixture.agentId, repo: "example/app", number, stack, parentNumber });
  const primary = (await call("follow.get", { workspaceId: fixture.workspaceId })).workspace;
  const pending = primary.obligations.find(o => o.status === "pending");
  if (pending) await call("follow.obligation", { agentId: fixture.agentId, id: pending.id, title: "Verify the deployed hotfix revision", status: "waiting", evidence: "", afterPrs: ["example/app#2"], enable_follow_up: true });
  await call("follow.obligation", { agentId: fixture.agentId, title: "Check which migrations Resume would launch", status: "waiting", evidence: "", afterPrs: ["example/app#2"], enable_follow_up: false });
  await call("follow.obligation", { agentId: fixture.agentId, title: "Complete the production backfill", status: "pending", evidence: "", afterPrs: ["example/app#4"], enable_follow_up: false });
  const done = await api.workspaces.create({ title: "Session recovery · demo", source: { kind: "directory", path: join(fixture.root, "fixture") } });
  const doneAgent = await done.agents.create({ config: { provider: "followthrough-fixture/fixture", providerOptions: { fixture_mode: "done", fixture_goal: "Verify session recovery after a daemon restart" } }, title: "Completed demo agent" });

  const blockedPath = join(fixture.root, "blocked-demo"); await import("node:fs/promises").then(fs => fs.mkdir(blockedPath));
  const blocked = await api.workspaces.create({ title: "Migration provenance · demo", source: { kind: "directory", path: blockedPath } });
  const blockedAgent = await blocked.agents.create({ config: { provider: "followthrough-fixture/fixture", providerOptions: { fixture_mode: "blocked", fixture_goal: "Show the author and source of each migration" } }, title: "Design demo agent" });
  for (let i = 0; i < 100; i++) {
    if (i === 0) { await call("follow.activate", { workspaceId: done.id }); await call("follow.activate", { workspaceId: blocked.id }); await call("follow.recover", { workspaceId: done.id }); await call("follow.recover", { workspaceId: blocked.id }); }
    await call("follow.refresh", {});
    const queued = (await call("follow.list", {})).workspaces.filter(w => [done.id, blocked.id].includes(w.id));
    for (const w of queued) { const batch = w.batches.find(b => b.state === "pending" && b.tasks.every(t => t.kind !== "inventory")); if (batch) await call("follow.send", { workspaceId: w.id, batchId: batch.id }); }
    const records = (await call("follow.list", {})).workspaces;
    if (records.find(w => w.id === done.id)?.completion && records.find(w => w.id === blocked.id)?.obligations.some(o => o.status === "blocked")) break;
    if (i === 99) throw new Error("Demo agents did not finish clicked inventory");
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (process.argv.includes("--freeze-pr-display")) {
    await call("follow.refresh", {});
    const path = join(fixture.home, "plugin-data/follow-through/state.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    const workspace = state.workspaces.find(w => w.id === fixture.workspaceId);
    workspace.archived = true;
    for (const pr of workspace.prs) if (pr.snapshot) pr.snapshot.mergeWhenReady = pr.number === 4 ? "on" : pr.number === 3 ? "unknown" : "off";
    await writeFile(`${path}.demo.tmp`, JSON.stringify(state), { mode: 0o600 });
    await rename(`${path}.demo.tmp`, path);
    console.log("Synthetic Graphite display states frozen; polling is paused for this isolated demo record.");
  }
  console.log("Synthetic demo seeded with multiple stacks, remaining deploy work, a decision, and a Done workspace.");
} finally { await api.dispose(); await client.close(); }
