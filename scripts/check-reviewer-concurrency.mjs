import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPaseoApi } from "@getpaseo/client";
import { harness } from "./harness.mjs";
await harness();

const preview = JSON.parse(await readFile(".preview-isolated.json", "utf8"));
assert.ok(preview.root.startsWith("/tmp/follow-install-") && preview.home === join(preview.root, "home"), "Only the synthetic preview daemon is allowed");
assert.ok(process.env.SEND_TO_PASEO_SOURCE, "Set SEND_TO_PASEO_SOURCE to the extension checkout");
const fixture = join(preview.home, "reviewer-concurrency.json");
await writeFile(fixture, JSON.stringify({ requests: [], requested: {} }));
const gh = `#!/usr/bin/env node
const fs = require('node:fs');
const file = ${JSON.stringify(fixture)};
const args = process.argv.slice(2);
if (args.includes('POST')) {
  const number = Number(/pulls\\/(\\d+)/.exec(args.find(a => a.startsWith('repos/')))[1]);
  const reviewers = args.filter(a => a.startsWith('reviewers[]=')).map(a => a.slice(12));
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.requests.push({number, started:Date.now(), finished:null});
  const index = data.requests.length - 1;
  fs.writeFileSync(file, JSON.stringify(data));
  setTimeout(() => {
    const latest = JSON.parse(fs.readFileSync(file, 'utf8'));
    latest.requested[number] = reviewers; latest.requests[index].finished = Date.now();
    fs.writeFileSync(file, JSON.stringify(latest)); console.log('{}');
  }, 3000);
} else if (args.includes('graphql')) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const repository = {defaultBranchRef:{name:'main'}};
  const query = args.find(a => a.startsWith('query='));
  for (const m of query.matchAll(/(p\\d+):pullRequest\\(number:(\\d+)\\)/g)) {
    const number = Number(m[2]);
    repository[m[1]] = {number,title:'Synthetic reviewer PR '+number,url:'https://github.com/example/app/pull/'+number,state:'OPEN',headRefOid:'fixture-head-'+number,headRefName:'fixture-'+number,baseRefName:'main',isDraft:false,mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',reviewDecision:'REVIEW_REQUIRED',author:{login:'fixture-author'},reviewRequests:{pageInfo:{hasNextPage:false},nodes:(data.requested[number]??[]).map(login=>({requestedReviewer:{__typename:'User',login}}))},latestReviews:{pageInfo:{hasNextPage:false},nodes:[]},reviewThreads:{pageInfo:{hasNextPage:false},nodes:[]},commits:{nodes:[]},baseRef:null};
  }
  console.log(JSON.stringify({data:{repository}}));
} else console.log('[]');
`;
await writeFile(join(preview.root, "bin/gh"), gh); await chmod(join(preview.root, "bin/gh"), 0o700);
const client = new DaemonClient({ url: `ws://127.0.0.1:${preview.port}/ws`, clientId: "reviewer-concurrency", clientType: "cli", reconnect: { enabled: false } });
await client.connect(); const api = createPaseoApi(client);
const call = (method, input) => client.invokePluginRpc("follow-up", method, input);
const directory = join(preview.root, "concurrent-reviewer-workspace"); await mkdir(directory, { recursive: true });
const title = `Reviewer concurrency fixture ${Date.now()}`;
const w = await api.workspaces.create({ title, source: { kind: "directory", path: directory } });
const agent = await w.agents.create({ config: { provider: "followup-fixture/fixture", model: "fixture" }, title: "Synthetic main" });
await call("follow.activate", { workspaceId: w.id });
await call("follow.save-reviewers", { repo: "herosecurity/hero-poc", reviewers: [{ login: "uyy-hero-security", name: "Uri" }, { login: "yuvalgoder-star", name: "Yuval" }] });
for (const number of [1, 2]) await call("follow.register-pr", { agentId: agent.id, repo: "herosecurity/hero-poc", number, stack: "Synthetic reviewer stack" });
await call("follow.refresh", { workspaceId: w.id });
const { chromium } = createRequire(join(process.env.SEND_TO_PASEO_SOURCE, "extension/package.json"))("playwright-core");
const profile = await mkdtemp(join(tmpdir(), "reviewer-concurrency-browser-"));
let context;
try {
  context = await chromium.launchPersistentContext(profile, { executablePath: process.env.STP_CHROMIUM, headless: true, viewport: { width: 1440, height: 1050 }, args: ["--disable-extensions", "--no-first-run"] });
  const page = await context.newPage(); await fetch(`http://127.0.0.1:${preview.port}/llms.txt`);
  await page.goto(`http://127.0.0.1:${preview.port}/`);
  await page.getByRole("button", { name: new RegExp(`^${title}`) }).click();
  await page.getByRole("button", { name: "Open workspace follow-up", exact: true }).click();
  const add = number => page.getByRole("button", { name: `Add reviewers: Uri and Yuval for herosecurity/hero-poc pull request ${number}`, exact: true });
  await add(1).click();
  for (let attempt = 0; ; attempt++) {
    if (JSON.parse(await readFile(fixture, "utf8")).requests.length === 1) break;
    assert.ok(attempt < 50, "the first reviewer request must reach the synthetic GitHub fixture");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(await add(2).isEnabled(), true, "the second PR stays actionable during the first request");
  await add(2).click();
  await page.getByText("Requested Uri and Yuval.", { exact: true }).nth(1).waitFor();
  const observed = JSON.parse(await readFile(fixture, "utf8"));
  assert.equal(observed.requests.length, 2);
  assert.ok(observed.requests[1].started < observed.requests[0].finished, "GitHub receives the second request while the first is in flight");
  const saved = (await call("follow.get", { workspaceId: w.id })).workspace;
  assert.deepEqual(saved.prActions.map(a => a.state), ["submitted", "submitted"]);
  assert.equal(await page.getByText(/Check the previous PR action/).count(), 0);
  await page.screenshot({ path: "/tmp/follow-up-reviewer-concurrency.png" });
  console.log("PASS: two real Add reviewers clicks overlap, each sends once to the synthetic GitHub fixture, and both complete without a workspace-lock error.");
} finally { await context?.close(); await api.dispose(); await client.close(); await rm(profile, { recursive: true, force: true }); }
