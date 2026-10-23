import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,chmod,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {DaemonClient} from '@getpaseo/client/internal/daemon-client';
import {createPaseoApi} from '@getpaseo/client';
const preview=JSON.parse(await readFile('.preview-isolated.json','utf8'));
assert.ok(preview.root.startsWith('/tmp/follow-install-')&&preview.home===preview.root+'/home');
const gh=`#!/usr/bin/env node
if(!process.argv.includes('graphql')){console.log('[]');process.exit(0)}
const query=process.argv.find(a=>a.startsWith('query='));const repository={defaultBranchRef:{name:'main'}};
for(const m of query.matchAll(/(p\\d+):pullRequest\\(number:(\\d+)\\)/g)){
 const number=Number(m[2]);repository[m[1]]={number,title:number===1?'Keep generated PR descriptions consistent':'Preserve the submitted branch title',url:'https://github.com/example/app/pull/'+number,state:'OPEN',headRefOid:'fixture-head-'+number,headRefName:'fixture-branch-'+number,baseRefName:'main',isDraft:false,mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',reviewDecision:'REVIEW_REQUIRED',author:{login:'fixture-author'},reviewRequests:{pageInfo:{hasNextPage:false},nodes:[{requestedReviewer:{__typename:'User',login:'fixture-reviewer'}}]},latestReviews:{pageInfo:{hasNextPage:false},nodes:[]},reviewThreads:{pageInfo:{hasNextPage:false},nodes:number===1?[{id:'review-thread',isResolved:false,comments:{nodes:[{updatedAt:'2026-01-01T00:00:00Z'}]}}]:[]},commits:{nodes:[]},baseRef:null};
}
console.log(JSON.stringify({data:{repository}}));
`;
await writeFile(join(preview.root,'bin/gh'),gh);await chmod(join(preview.root,'bin/gh'),0o700);
const client=new DaemonClient({url:`ws://127.0.0.1:${preview.port}/ws`,clientId:'task-trigger-ui-test',clientType:'cli',reconnect:{enabled:false}});
await client.connect();const api=createPaseoApi(client);
const call=(method,input={})=>client.invokePluginRpc('follow-through',method,input);
const directory=join(preview.root,'trigger-workspace');await mkdir(directory,{recursive:true});
const title='Task trigger test '+Date.now().toString(36);
const workspace=await api.workspaces.create({title,source:{kind:'directory',path:directory}});
const agent=await workspace.agents.create({config:{provider:'followthrough-fixture/fixture',model:'fixture'},title:'Synthetic trigger main'});
await call('follow.activate',{workspaceId:workspace.id});
for(const number of [1,2])await call('follow.register-pr',{agentId:agent.id,repo:'example/app',number,stack:'PR descriptions',parentNumber:number===2?1:null});
const taskTitle='Recheck transcript titles';
let record=await call('follow.obligation',{agentId:agent.id,title:taskTitle,status:'waiting',afterPrs:[],evidence:'Synthetic baseline retained. Run the transcript sweep after the configured delay.'});
const task=record.obligations.find(o=>o.title===taskTitle);
await call('follow.refresh');
const {chromium}=createRequire(join(process.env.SEND_TO_PASEO_SOURCE,'extension/package.json'))('playwright-core');
const profile=await mkdtemp(join(tmpdir(),'follow-trigger-browser-'));
const context=await chromium.launchPersistentContext(profile,{executablePath:process.env.STP_CHROMIUM,headless:true,viewport:{width:1440,height:1050},args:['--disable-extensions','--no-first-run']});
const errors=[];context.on('weberror',error=>errors.push(String(error.error())));
try{
 const page=await context.newPage();await fetch(`http://127.0.0.1:${preview.port}/llms.txt`);await page.goto(`http://127.0.0.1:${preview.port}/`);
 await page.getByRole('button',{name:new RegExp('^'+title)}).click();await page.getByRole('button',{name:'Open workspace follow-through',exact:true}).click();
 const details=page.getByRole('button',{name:'Show task details: '+taskTitle,exact:true});await details.waitFor();
 assert.equal(await page.getByText('Manual',{exact:true}).count(),1);
 assert.equal(await page.getByRole('radiogroup').count(),0);
 const initial=(await call('follow.get',{workspaceId:workspace.id})).workspace;
 assert.ok(initial.batches.filter(b=>b.state==='pending').every(b=>b.tasks.every(t=>t.kind!=='obligation')));
 await details.click();
 const group=page.getByRole('radiogroup',{name:'Send trigger for '+taskTitle});
 assert.equal(await group.getByRole('radio',{name:'Manual',exact:true}).getAttribute('aria-checked'),'true');
 await group.getByRole('radio',{name:'After deploy',exact:true}).click();
 const save=page.getByRole('button',{name:'Save trigger for '+taskTitle,exact:true});assert.equal(await save.isEnabled(),false);
 await page.getByRole('checkbox',{name:'Use PR 1 for task trigger',exact:true}).click();
 const delay=page.getByRole('textbox',{name:'Delay in days',exact:true});await delay.fill('-1');assert.equal(await save.isEnabled(),false);await delay.fill('14');assert.equal(await save.isEnabled(),true);
 await mkdir('docs/screenshots',{recursive:true});await page.getByRole('button',{name:'Collapse Tasks',exact:true}).scrollIntoViewIfNeeded();
 await page.getByTestId('workspace-explorer-sidebar').screenshot({path:'docs/screenshots/task-triggers-desktop.png'});
 await save.click();await page.getByText('14d after deploy · #1',{exact:true}).waitFor();
 let current=(await call('follow.get',{workspaceId:workspace.id})).workspace;
 let saved=current.obligations.find(o=>o.id===task.id);assert.deepEqual(saved.trigger,{event:'deploy',delayDays:14});assert.deepEqual(saved.afterPrs,['example/app#1']);
 assert.equal(saved.evidence,task.evidence);assert.equal(current.enable_auto_sends,false);assert.equal(current.mainAgentId,agent.id);
 assert.ok(current.batches.filter(b=>b.state==='pending').every(b=>b.tasks.every(t=>t.kind!=='obligation')));
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Open workspace follow-through',exact:true}).click();
 await page.getByRole('button',{name:'Show task details: '+taskTitle,exact:true}).click();
 await page.getByRole('button',{name:'Collapse Tasks',exact:true}).scrollIntoViewIfNeeded();
 assert.equal(await delay.inputValue(),'14');
 for(const radio of await group.getByRole('radio').all())assert.ok((await radio.boundingBox()).height>=44);
 assert.ok((await save.boundingBox()).height>=44);assert.ok((await page.getByRole('checkbox',{name:'Use PR 1 for task trigger',exact:true}).boundingBox()).height>=44);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
 await page.screenshot({path:'docs/screenshots/task-triggers-mobile.png'});
 await group.getByRole('radio',{name:'After merge',exact:true}).click();await save.click();await page.getByText('14d after merge · #1',{exact:true}).waitFor();
 current=(await call('follow.get',{workspaceId:workspace.id})).workspace;saved=current.obligations.find(o=>o.id===task.id);assert.equal(saved.dependencyStage,'merged');
 await group.getByRole('radio',{name:'Manual',exact:true}).click();await save.click();
 current=(await call('follow.get',{workspaceId:workspace.id})).workspace;
 for(let i=0;current.obligations.find(o=>o.id===task.id).trigger!==null&&i<40;i++){await page.waitForTimeout(100);current=(await call('follow.get',{workspaceId:workspace.id})).workspace;}
 saved=current.obligations.find(o=>o.id===task.id);assert.equal(saved.trigger,null);assert.equal(saved.enable_follow_up,false);assert.deepEqual(saved.afterPrs,['example/app#1']);
 await page.reload();await page.getByRole('button',{name:'Open workspace follow-through',exact:true}).click();await page.getByText('Manual · #1',{exact:true}).waitFor();
 assert.deepEqual(errors,[]);console.log('PASS: actual native desktop/mobile task disclosure, manual default, disabled/invalid trigger validation, fourteen-day deploy/merge controls, persistence, manual reset preserving dependencies/evidence/Auto/owner, future-task exclusion, 44px targets and no overflow/browser errors. Synthetic workspace only; no real messages.');
}finally{await context.close();await client.close();await rm(profile,{recursive:true,force:true});}
