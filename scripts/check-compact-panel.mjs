import assert from 'node:assert/strict';
import {readFile,writeFile,rename,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const preview=JSON.parse(await readFile('.preview-isolated.json','utf8'));
assert.ok(preview.root.startsWith('/tmp/follow-install-')&&preview.home===preview.root+'/home');
const path=join(preview.home,'plugin-data/follow-through/state.json');
const state=JSON.parse(await readFile(path,'utf8'));
const w=state.workspaces.find(w=>w.id===preview.workspaceId);
const now=new Date().toISOString();
w.archived=true;w.enable_auto_sends=false;w.runtimeBusy=false;w.runtimeReason=null;w.backgroundBusy=false;w.hold=null;w.batches=[];w.prActions=[];w.completion=null;
w.goal='Ship the vendor fix and verify production behavior';
const entry=(number,title,prState,deployState=null,patch={})=>({key:`example/app#${number}`,repo:'example/app',number,stack:prState==='MERGED'?'Production rollout':'Current work',parent:null,disposition:null,error:null,snapshot:{title,url:'https://github.com/example/app/pull/'+number,state:prState,head:'fixture-head-'+number,base:'main',trunk:'main',draft:false,headBranch:'fixture-'+number,graphiteMergeStatus:null,conflict:false,reviewDecision:'APPROVED',mergeWhenReady:'unknown',threads:[],failedChecks:[],checksPending:false,complete:true,observedAt:now,deployment:deployState?{state:deployState,environment:'production',commits:['synthetic-serving-commit'],evidence:'Synthetic serving revision contains the merge commit; no real production observation.',observedAt:now}:null,...patch}});
w.prs=[entry(7,'Add optional Follow-through Graphite browser connection','OPEN',null,{draft:true}),entry(11,'Match suffixed vendor names locally','OPEN'),entry(8,'Share the provider budget across the fleet','MERGED','pending'),entry(9,'Preserve mail rollup coverage','MERGED','partial'),entry(10,'Give classifiers room to finish','MERGED','deployed')];
w.prs.find(p=>p.number===10).stack='Shipped classifier';
w.obligations=[
{id:'old-merge',title:'Merge the approved PR',status:'waiting',afterPrs:['example/app#11'],evidence:'Historical lifecycle bookkeeping',enable_follow_up:false,revision:0},
{id:'budget',title:'Verify the provider budget is shared across the fleet',status:'waiting',afterPrs:['example/app#8'],dependencyStage:'deployed',evidence:'Synthetic task evidence: inspect Redis counters across all processes.',enable_follow_up:true,revision:0},
{id:'names',title:'Verify vendor resolution after both fixes deploy',status:'waiting',afterPrs:['example/app#8','example/app#9'],dependencyStage:'deployed',evidence:'Synthetic before/after counts are retained for verification.',enable_follow_up:true,revision:0},
{id:'decision',title:'Choose the mail-key migration or read fallback',status:'blocked',afterPrs:[],evidence:'Synthetic pending developer decision.',enable_follow_up:false,revision:0}];
await writeFile(path+'.compact.tmp',JSON.stringify(state),{mode:0o600});await rename(path+'.compact.tmp',path);
const env={...process.env,HOME:preview.home,XDG_CONFIG_HOME:preview.home+'/.config',PASEO_HOME:preview.home,PASEO_DAEMON_URL:`ws://127.0.0.1:${preview.port}/ws`};delete env.PASEO_PASSWORD;delete env.PASEO_PASSWORD_FILE;
await promisify(execFile)('paseo',['--home',preview.home,'plugin','reload','follow-through','--json'],{env,timeout:120000});
const {chromium}=createRequire(process.env.SEND_TO_PASEO_SOURCE+'/extension/package.json')('playwright-core');
const profile=await mkdtemp(join(tmpdir(),'follow-compact-browser-'));
const context=await chromium.launchPersistentContext(profile,{executablePath:process.env.STP_CHROMIUM,headless:true,viewport:{width:1440,height:1050},args:['--disable-extensions','--no-first-run']});
const errors=[];context.on('weberror',e=>errors.push(String(e.error())));
try{
const page=await context.newPage();await fetch(`http://127.0.0.1:${preview.port}/llms.txt`);await page.goto(`http://127.0.0.1:${preview.port}/`);
await page.getByRole('button',{name:/^Follow-through POC test/}).click();await page.getByRole('button',{name:'Open workspace follow-through',exact:true}).click();
await page.getByText('Draft',{exact:true}).waitFor();
assert.equal(await page.getByText('Merge the approved PR',{exact:true}).count(),0);
assert.equal(await page.getByText('Synthetic task evidence: inspect Redis counters across all processes.',{exact:true}).isVisible(),false);
const prs=page.getByRole('button',{name:'Collapse Pull requests',exact:true});const tasks=page.getByRole('button',{name:'Collapse Tasks',exact:true});
assert.ok((await prs.boundingBox()).y<(await tasks.boundingBox()).y);
const draft=page.getByRole('link',{name:/pull request 7 in Graphite/});assert.ok((await draft.boundingBox()).height<=44);
await page.getByText('Merged',{exact:true}).first().waitFor();assert.equal(await page.getByText('Merged',{exact:true}).count(),2);assert.equal(await page.getByText('Deployed',{exact:true}).isVisible(),false);
await page.mouse.move(0,0);await page.waitForTimeout(400);await page.screenshot({path:'docs/screenshots/compact-follow-through-desktop.png'});
await page.getByRole('button',{name:'Show task details: Verify the provider budget is shared across the fleet',exact:true}).click();await page.getByText('Synthetic task evidence: inspect Redis counters across all processes.',{exact:true}).waitFor();
await prs.click();await page.getByRole('button',{name:'Expand Pull requests',exact:true}).click();assert.ok(await page.getByText('Synthetic task evidence: inspect Redis counters across all processes.',{exact:true}).isVisible());
await page.getByRole('button',{name:'Hide task details: Verify the provider budget is shared across the fleet',exact:true}).click();
await page.getByRole('button',{name:'Expand Settled',exact:true}).click();await page.getByText('Deployed',{exact:true}).waitFor();await page.getByRole('button',{name:'Show details for PR 10',exact:true}).click();await page.getByText('Synthetic serving revision contains the merge commit; no real production observation.',{exact:true}).waitFor();
await page.screenshot({path:'docs/screenshots/merged-deployed-desktop.png'});
await page.getByRole('button',{name:'Collapse Settled',exact:true}).click();
await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Open workspace follow-through',exact:true}).click();await page.getByText('Draft',{exact:true}).waitFor();
assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
assert.ok((await page.getByRole('button',{name:'Show details for PR 7',exact:true}).boundingBox()).height>=44);
assert.ok((await page.getByRole('link',{name:/pull request 7 in Graphite/}).boundingBox()).height<=44);
await page.screenshot({path:'docs/screenshots/compact-follow-through-mobile.png'});
await page.getByRole('button',{name:'Expand Settled',exact:true}).click();await page.getByText('Deployed',{exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:'docs/screenshots/merged-deployed-mobile.png'});await page.getByRole('button',{name:'Collapse Settled',exact:true}).click();
await page.getByRole('button',{name:'Collapse Pull requests',exact:true}).click();await page.getByRole('button',{name:'Show task details: Verify the provider budget is shared across the fleet',exact:true}).click();await page.getByText('Synthetic task evidence: inspect Redis counters across all processes.',{exact:true}).waitFor();
await page.screenshot({path:'docs/screenshots/compact-follow-through-task-details.png'});
assert.deepEqual(errors,[]);console.log('PASS: PR-first hierarchy, two-line draft, hidden lifecycle tasks/evidence, task/PR disclosures, settled deployment history, desktop/mobile layout, 44px controls and no overflow or browser errors.');
}finally{await context.close();await rm(profile,{recursive:true,force:true});}
