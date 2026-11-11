import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, chmod, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { harness } from "./harness.mjs";
import { harnessEnv } from "./harness-env.mjs";
await harness();
const exec = promisify(execFile);
const preview = JSON.parse(await readFile('.preview-isolated.json','utf8'));
if(!preview.root.startsWith('/tmp/follow-install-'))throw new Error('Requires the isolated preview.');
const standalone = process.argv.includes('--standalone');
const source = process.env.SEND_TO_PASEO_SOURCE;
if(!source)throw new Error('SEND_TO_PASEO_SOURCE must point to the companion source checkout.');
const fixtureUrl=process.env.FOLLOW_TEST_GRAPHITE_URL;
if(!fixtureUrl?.startsWith('http://127.0.0.1:'))throw new Error('An isolated Graphite fixture is required.');
const net=createServer();await new Promise(r=>net.listen(0,'127.0.0.1',r));const bridgePort=net.address().port;await new Promise(r=>net.close(r));
const env=harnessEnv(preview.root,{home:preview.home,set:{PASEO_DAEMON_URL:`ws://127.0.0.1:${preview.port}/ws`},strip:['NODE_OPTIONS']});
const cli=async(...args)=>JSON.parse((await exec('paseo',['--home',preview.home,'--json',...args],{env,timeout:120_000})).stdout);
if (!standalone) {
const dir=join(preview.home,'plugin-data/send-to-paseo');await mkdir(dir,{recursive:true});
await writeFile(join(dir,'settings.json'),JSON.stringify({version:1,token:'isolated-browser-fixture-token',port:bridgePort,defaultProvider:null,paired:false,recentSends:[],allowedExtensionIds:[],agentDispatch:'main'}),{mode:0o600});
const packed = JSON.parse((await exec('npm', ['pack', '--json', '--pack-destination', preview.root])).stdout)[0];
await exec('tar', ['-xzf', join(preview.root, packed.filename), '--strip-components=1', '-C', join(preview.root, 'plugin')]);
await cli('plugin', 'reload', 'follow-up');
const plugins=await cli('plugin','ls'); if(plugins.some(p=>p.id==='send-to-paseo')) await cli('plugin','reload','send-to-paseo'); else await cli('plugin','install',join(source,'plugin'));
} else { assert.ok(!(await cli('plugin','ls')).some(p=>p.id==='send-to-paseo')); }
const client=new DaemonClient({url:env.PASEO_DAEMON_URL,clientId:'browser-control-test',clientType:'cli',reconnect:{enabled:false}});await client.connect();
const call=(name,input={})=>client.invokePluginRpc('follow-up',name,input);
await call('follow.activate',{workspaceId:preview.workspaceId});
await call('follow.control',{workspaceId:preview.workspaceId,enable_auto_sends:false});
const gh=`#!/usr/bin/env node
if(process.argv[3]!=='graphql'){console.log('[]');process.exit(0)}
const query=process.argv.find(a=>a.startsWith('query='));const r={defaultBranchRef:{name:'main'}};
for(const m of query.matchAll(/(p\\d+):pullRequest\\(number:(\\d+)\\)/g)){const n=Number(m[2]);r[m[1]]={number:n,title:n===2?'Show automatic migration status':'Record migration rollout versions',url:'https://github.com/example/app/pull/'+n,state:'OPEN',headRefName:'fixture-branch-'+n,headRefOid:'fixture-head-'+n,baseRefName:n===2?'fixture-branch-1':'main',isDraft:false,mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',reviewDecision:'APPROVED',baseRef:null,reviewThreads:{nodes:[],pageInfo:{hasNextPage:false}},commits:{nodes:[]}}}
console.log(JSON.stringify({data:{repository:r}}));
`;
await writeFile(join(preview.root,'bin/gh'),gh);await chmod(join(preview.root,'bin/gh'),0o700);
await call('follow.register-pr',{agentId:preview.agentId,repo:'example/app',number:1,stack:'Migration rollout',parentNumber:null});
await call('follow.register-pr',{agentId:preview.agentId,repo:'example/app',number:2,stack:'Migration rollout',parentNumber:1});
await call('follow.register-pr',{agentId:preview.agentId,repo:'example/app',number:1,stack:'Migration rollout',parentNumber:null});
await call('follow.refresh');
if (!standalone) await exec('node',['build.mjs','--test','--port',new URL(fixtureUrl).port,'--bridge-port',String(bridgePort)],{cwd:join(source,'extension')});
const {chromium}=createRequire(join(source,'extension/package.json'))('playwright-core');
const profile=await mkdtemp(join(tmpdir(),'follow-browser-'));
const context=await chromium.launchPersistentContext(profile,{executablePath:process.env.STP_CHROMIUM,headless:true,viewport:{width:1440,height:1050},args:standalone ? ['--disable-extensions','--no-first-run'] : [`--disable-extensions-except=${source}/extension/dist-test`,`--load-extension=${source}/extension/dist-test`,'--no-first-run','--no-default-browser-check']});
const wait=async(fn,label)=>{for(let i=0;i<80;i++){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,500));}throw new Error('Timed out: '+label)};
context.on('weberror',e=>console.log('Browser error: '+String(e.error()).slice(0,250)));
let graphitePage; let optionsPage; let worker;
const approveBrowser = async (remember = false) => {
  await optionsPage.bringToFront();
  if (remember) await optionsPage.getByRole("checkbox", { name: /Allow future toggle changes/ }).check();
  await optionsPage.getByRole("button", { name: /^(Enable|Disable) for these PRs$/ }).click({ timeout: 15000 });
};
try{
if (!standalone) {
worker=await wait(()=>context.serviceWorkers().find(w=>w.url().startsWith('chrome-extension://')),'extension worker');
await worker.evaluate(async(bridgeUrl)=>{await chrome.storage.local.set({settings:{version:2,connectionMode:'advanced',defaultProvider:'',hosts:[{id:'fixture',label:'Isolated',bridgeUrl,token:'isolated-browser-fixture-token',enabled:true,machineName:'Fixture'}]}})},`http://127.0.0.1:${bridgePort}`);
const graphite=await context.newPage();graphitePage=graphite;await fetch(fixtureUrl+'/llms.txt');await graphite.goto(fixtureUrl+'/');
optionsPage = await context.newPage(); await optionsPage.goto(worker.url().replace(/background\.js$/, 'options.html'));
assert.equal(await optionsPage.locator('#graphiteRepo, #graphiteMachine, #graphiteGrant').count(), 0, 'no separate machine/repository setup');
await wait(async()=> (await call('follow.browser-status')).ready,'automatic existing Send connection');
assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('graphiteBrowserGrants')).graphiteBrowserGrants?.length ?? 0), 0, 'reads need no second pairing or manual grant');
for (const action of (await call('follow.get',{workspaceId:preview.workspaceId})).workspace.prActions.filter(a=>a.state==='uncertain')) assert.equal((await call('follow.check-pr-action',{workspaceId:preview.workspaceId,actionId:action.id})).state,'submitted');
await wait(async () => (await call('follow.get', { workspaceId: preview.workspaceId })).workspace.prs.find(p => p.key === 'example/app#2')?.snapshot?.complete, 'background PR observation');
const status=await call('follow.pr-control-status',{workspaceId:preview.workspaceId,prKey:'example/app#2'});
assert.ok(status.pr, JSON.stringify(status));
assert.equal(status.pr.mergeWhenReady, (await (await fetch(fixtureUrl+"/__test/state")).json()).enabled.includes(2));assert.equal(status.pr.head,'fixture-head-2');
console.log('PASS: actual MV3 worker -> paired HTTP bridge -> installed Follow-up RPC -> first-party Graphite read.');
} else { const status=await call('follow.pr-control-status',{workspaceId:preview.workspaceId,prKey:'example/app#2'}); assert.equal(status.browser.ready,false);assert.equal(status.pr,null);assert.equal(status.error,null); }
const page=await context.newPage();await fetch(`http://127.0.0.1:${preview.port}/llms.txt`);const serverId=(await readFile(join(preview.home,'server-id'),'utf8')).trim(); await page.goto(`http://127.0.0.1:${preview.port}/`); await page.getByRole("button",{name:/^Follow-up POC test/}).click();
await mkdir('docs/screenshots',{recursive:true});
console.log('BROWSER_TEST_READY '+JSON.stringify({port:preview.port,workspaceId:preview.workspaceId,agentId:preview.agentId,bridgePort,fixtureUrl}));
await page.getByRole('button',{name:'Open workspace follow-up',exact:true}).click();
const toggle=n=>page.getByRole('switch',{name:`Merge when ready for example/app pull request ${n}`,exact:true});
if (!standalone) await wait(async()=>await toggle(2).getAttribute('aria-checked') !== 'mixed','verified toggle');
else { await page.getByRole('button',{name:'Expand Optional merge when ready',exact:true}).waitFor(); assert.equal(await page.getByRole('switch',{name:/Merge when ready for/}).count(),0);assert.equal(await page.getByRole('button',{name:'Connect Graphite',exact:true}).isVisible(),false); }
const state=async()=>(await fetch(fixtureUrl+'/__test/state')).json();
const before=(await state()).writes.length;
const previousMerges=(await state()).writes.filter(w=>w.path==='/v1/graphite/merge').length;
await page.getByRole('button',{name:'Merge',exact:true}).nth(1).click();
await page.getByText('Merge the PRs underneath too?',{exact:true}).waitFor();
await page.screenshot({path:standalone?'docs/screenshots/standalone-merge-desktop.png':'docs/screenshots/merge-confirmation-desktop.png'});
await page.getByRole('button',{name:'Cancel',exact:true}).click();
assert.equal((await state()).writes.length,before,'cancelling sends no mutation');
// An upper toggle offers target-only scope; use the current boolean to test both directions.
if (!standalone) {
const wasOn=await toggle(2).getAttribute('aria-checked')==='true';
await toggle(2).click();await page.getByRole('button',{name:'Just this PR',exact:true}).waitFor();
await page.screenshot({path:'docs/screenshots/toggle-confirmation-desktop.png'});
await page.getByRole('button',{name:'Just this PR',exact:true}).click();
await approveBrowser(true);
const targetResult=await wait(async()=>{const actions=(await call('follow.get',{workspaceId:preview.workspaceId})).workspace.prActions;const last=actions.at(-1);return last && last.kind!=="merge" && last.state!=="sending" ? last : null;},'target toggle result');
assert.equal(targetResult.state,'submitted',targetResult.result);
await page.getByText(`Merge when ready ${wasOn?'disabled':'enabled'} for #2.`,{exact:true}).waitFor({timeout:10000});
await wait(async()=>await toggle(2).getAttribute('aria-checked')===String(!wasOn),'confirmed switch state');
const scoped=(await state()).writes.slice(before);
assert.equal(scoped.length,1);assert.equal(scoped[0].body.number,2);
// Only the checkbox on the real confirmation permits future direct changes.
await optionsPage.getByRole('button', { name: 'Require confirmation', exact: true }).waitFor();
await toggle(2).click();await page.getByRole('button',{name:/for all 2 PRs/}).click();
await page.getByText(`Merge when ready ${wasOn?'enabled':'disabled'} for #1, #2.`,{exact:true}).waitFor({timeout:30000});
}
// Browser-owned permissions must remain operable in both themes and compact windows.
if (!standalone) {
  await mkdir('/tmp/follow-up-integration-screenshots', { recursive: true });
  for (const colorScheme of ['light', 'dark']) for (const width of [1440, 390]) {
    await optionsPage.emulateMedia({ colorScheme }); await optionsPage.setViewportSize({ width, height: 900 });
    assert.equal(await optionsPage.evaluate(() => document.documentElement.scrollWidth), width);
    await optionsPage.screenshot({ path: `/tmp/follow-up-integration-screenshots/access-${colorScheme}-${width}.png`, fullPage: true });
  }
}
// Only the synthetic CLI endpoint can receive this test merge.
const plan=await call('follow.prepare-pr-action',{workspaceId:preview.workspaceId,prKey:'example/app#2',kind:'merge'});
assert.deepEqual(plan.prs.map(p=>p.number),[1,2]);assert.ok(!plan.blockers.length && plan.prs.every(p=>!p.blockers.length));
assert.equal((await call('follow.confirm-pr-action',{planId:plan.id,scope:'downstack'})).state,'submitted');
const merges=(await state()).writes.filter(w=>w.path==='/v1/graphite/merge');
assert.equal(merges.length,previousMerges+1);assert.deepEqual(merges.at(-1).body.prNumbers,[1,2]);
const w=(await call('follow.get',{workspaceId:preview.workspaceId})).workspace;
assert.equal(w.mainAgentId,preview.agentId);assert.equal(w.enable_auto_sends,false);
assert.ok(w.prActions.every(a=>a.state==='submitted'));
console.log('PASS: native desktop controls and cancellation; target-only and direct all-downstack toggles; extension permissions in light/dark, wide/compact; one ordered synthetic merge.');
if (!standalone) {
  await optionsPage.getByRole('button', { name: 'Require confirmation', exact: true }).click();
  assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('graphiteBrowserGrants')).graphiteBrowserGrants?.length ?? 0), 0);
  await optionsPage.getByRole('checkbox', { name: 'Use Graphite with Follow Up', exact: true }).uncheck();
  await wait(async () => !(await call('follow.browser-status')).ready, 'revoked browser access');
  assert.equal((await call('follow.pr-control-status', { workspaceId: preview.workspaceId, prKey: 'example/app#2' })).pr, null);
  await graphitePage.close();
  console.log('PASS: automatic existing connection, browser confirmation, explicitly remembered direct toggles, and revocation.');
}
if(process.argv.includes('--keep'))await new Promise(r=>{process.once('SIGINT',r);process.once('SIGTERM',r)});
}finally{await context.close();await client.close();await rm(profile,{recursive:true,force:true});}
