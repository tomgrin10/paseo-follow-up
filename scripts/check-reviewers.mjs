import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,chmod,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DaemonClient} from '@getpaseo/client/internal/daemon-client';
import {createPaseoApi} from '@getpaseo/client';
const preview=JSON.parse(await readFile('.preview-isolated.json','utf8'));
assert.ok(preview.root.startsWith('/tmp/follow-install-')&&preview.home===preview.root+'/home');
const exec=promisify(execFile);
const packed=JSON.parse((await exec('npm',['pack','--json','--pack-destination',preview.root],{timeout:30000})).stdout)[0];
await exec('tar',['-xzf',join(preview.root,packed.filename),'--strip-components=1','-C',join(preview.root,'plugin')]);
const previewEnv={...process.env,HOME:preview.home,PASEO_HOME:preview.home,PASEO_DAEMON_URL:`ws://127.0.0.1:${preview.port}/ws`};
for(const key of ['PASEO_PASSWORD','PASEO_PASSWORD_FILE','PASEO_AGENT_ID','CLAUDE_CONFIG_DIR','CODEX_HOME'])delete previewEnv[key];
await exec('paseo',['--home',preview.home,'plugin','reload','follow-through','--json'],{env:previewEnv,timeout:120000});
const fixturePath=join(preview.home,'reviewers-fixture.json');
await writeFile(fixturePath,JSON.stringify({requested:[],deny:false,attempts:[],delay:500}));
const gh=`#!/usr/bin/env node
const fs=require('node:fs');
const path=${JSON.stringify(fixturePath)};
const data=JSON.parse(fs.readFileSync(path,'utf8'));
const args=process.argv.slice(2);
if(args.includes('POST')){
 const reviewers=args.filter(a=>a.startsWith('reviewers[]=')).map(a=>a.slice('reviewers[]='.length));
 data.attempts.push({reviewers,denied:data.deny,endpoint:args.find(a=>a.startsWith('repos/'))});
 if(data.deny){fs.writeFileSync(path,JSON.stringify(data));console.error('HTTP 403');process.exit(1)}
 data.requested=[...new Set([...data.requested,...reviewers])];fs.writeFileSync(path,JSON.stringify(data));
 setTimeout(()=>console.log(JSON.stringify({number:1,requested_reviewers:data.requested.map(login=>({login,type:'User'}))})),data.delay);return;
}
if(!args.includes('graphql')){console.log('[]');return}
const query=args.find(a=>a.startsWith('query='));const repository={defaultBranchRef:{name:'main'}};
for(const m of query.matchAll(/(p\\d+):pullRequest\\(number:(\\d+)\\)/g)){
 const number=Number(m[2]);const requested=number===1?data.requested:number===2?['existing-reviewer']:[];
 repository[m[1]]={number,title:({1:'Keep vendor matching consistent across the fleet',2:'Preserve the mail rollup fallback',3:'Share the provider budget across workers',4:'Add the optional browser connection',5:'Show an incomplete reviewer observation'})[number]??'Synthetic change',url:'https://github.com/example/app/pull/'+number,state:'OPEN',headRefOid:'fixture-head-'+number,headRefName:'fixture-branch-'+number,baseRefName:'main',isDraft:number===4,mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',reviewDecision:number===3?'APPROVED':'REVIEW_REQUIRED',author:{login:'fixture-author'},reviewRequests:{pageInfo:{hasNextPage:number===5},nodes:requested.map(login=>({requestedReviewer:{__typename:'User',login}}))},latestReviews:{pageInfo:{hasNextPage:false},nodes:number===3?[{state:'APPROVED',author:{__typename:'User',login:'existing-reviewer'}}]:[{state:'COMMENTED',author:{__typename:'Bot',login:'review-bot'}}]},reviewThreads:{pageInfo:{hasNextPage:false},nodes:[]},commits:{nodes:[]},baseRef:null};
}
console.log(JSON.stringify({data:{repository}}));
`;
await writeFile(join(preview.root,'bin/gh'),gh);await chmod(join(preview.root,'bin/gh'),0o700);
const client=new DaemonClient({url:`ws://127.0.0.1:${preview.port}/ws`,clientId:'reviewers-ui-test',clientType:'cli',reconnect:{enabled:false}});
await client.connect();const api=createPaseoApi(client);
const call=(method,input={})=>client.invokePluginRpc('follow-through',method,input);
const directory=join(preview.root,'reviewer-workspace');await mkdir(directory,{recursive:true});
const title='Reviewer controls test '+Date.now().toString(36);
const workspace=await api.workspaces.create({title,source:{kind:'directory',path:directory}});
const agent=await workspace.agents.create({config:{provider:'followthrough-fixture/fixture',model:'fixture'},title:'Synthetic reviewer main'});
await call('follow.activate',{workspaceId:workspace.id});
for(const number of [1,2,3,4,5])await call('follow.register-pr',{agentId:agent.id,repo:'herosecurity/hero-poc',number,stack:'Vendor behavior',parentNumber:null});
await call('follow.refresh');
const {chromium}=createRequire(join(process.env.SEND_TO_PASEO_SOURCE,'extension/package.json'))('playwright-core');
const profile=await mkdtemp(join(tmpdir(),'follow-reviewer-browser-'));
const context=await chromium.launchPersistentContext(profile,{executablePath:process.env.STP_CHROMIUM,headless:true,viewport:{width:1440,height:1050},args:['--disable-extensions','--no-first-run']});
const errors=[];context.on('weberror',error=>errors.push(String(error.error())));
try{
 const page=await context.newPage();await fetch(`http://127.0.0.1:${preview.port}/llms.txt`);await page.goto(`http://127.0.0.1:${preview.port}/`);
 await page.getByRole('button',{name:new RegExp('^'+title)}).click();await page.getByRole('button',{name:'Open workspace follow-through',exact:true}).click();
 const add=page.getByRole('button',{name:'Add reviewers: Uri and Yuval for herosecurity/hero-poc pull request 1',exact:true});
 await add.waitFor();await page.getByText('Draft',{exact:true}).waitFor();assert.equal(await page.getByText('No reviewers',{exact:true}).count(),2);
 assert.equal(await page.getByRole('button',{name:/^Add reviewers:/}).count(),1);
 await mkdir('docs/screenshots',{recursive:true});await page.screenshot({path:'docs/screenshots/reviewers-desktop.png'});
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Open workspace follow-through',exact:true}).click();await add.waitFor();
 assert.ok((await add.boundingBox()).height>=44);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
 await page.screenshot({path:'docs/screenshots/reviewers-mobile.png'});
 const mutate=async patch=>{const data=JSON.parse(await readFile(fixturePath,'utf8'));await writeFile(fixturePath,JSON.stringify({...data,...patch}));};
 await mutate({deny:true});await add.click();await page.getByText('GitHub refused the review request. Check repository write access and reviewer eligibility.',{exact:true}).waitFor();
 assert.equal(await add.isEnabled(),true);await page.screenshot({path:'docs/screenshots/reviewers-error-mobile.png'});
 await mutate({deny:false});await add.click();await page.getByText('Requesting…',{exact:true}).waitFor();await page.getByText('Requested Uri and Yuval.',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:/^Add reviewers:/}).count(),0);assert.equal(await page.getByText('No reviewers',{exact:true}).count(),1);
 await page.getByRole('link',{name:/pull request 1 in Graphite:/}).scrollIntoViewIfNeeded();
 await page.screenshot({path:'docs/screenshots/reviewers-requested-mobile.png'});
 await page.setViewportSize({width:1440,height:1050});const sidebar=page.getByTestId('workspace-explorer-sidebar');await sidebar.getByRole('button',{name:'Show details for PR 1',exact:true}).click();await sidebar.getByText('Reviewers: uyy-hero-security, yuvalgoder-star',{exact:true}).waitFor();
 await sidebar.screenshot({path:'docs/screenshots/reviewers-requested-desktop.png'});
 await call('follow.request-reviewers',{workspaceId:workspace.id,prKey:'herosecurity/hero-poc#1'});
 const result=JSON.parse(await readFile(fixturePath,'utf8'));assert.equal(result.attempts.length,2);assert.deepEqual(result.requested,['uyy-hero-security','yuvalgoder-star']);
 assert.ok(result.attempts.every(a=>a.endpoint==='repos/herosecurity/hero-poc/pulls/1/requested_reviewers'));
 const record=(await call('follow.get',{workspaceId:workspace.id})).workspace;assert.equal(record.enable_auto_sends,false);assert.equal(record.mainAgentId,agent.id);assert.equal(record.completion,null);
 assert.deepEqual(errors,[]);console.log('PASS: native no-reviewer distinction, pending/approved/draft/unknown states, real click -> isolated gh argv, failure/retry, loading/success, deduplication, desktop/mobile controls and no overflow/browser errors. No real review request sent.');
}finally{await context.close();await client.close();await rm(profile,{recursive:true,force:true});}
