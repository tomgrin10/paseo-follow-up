import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { workspace } from "./fixtures";

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "follow-mcp-usage-")); t.after(()=>rm(root,{recursive:true,force:true}));
  const directory = join(root,"plugin-data/follow-through"); await mkdir(directory,{recursive:true});
  const w = workspace({obligations:[{id:"old",title:"Historical result",status:"done",afterPrs:[],evidence:"old evidence",enable_follow_up:false,revision:0},{id:"current",title:"Verify current behavior",status:"waiting",afterPrs:["example/app#1"],evidence:"Current evidence",enable_follow_up:true,trigger:{event:"deploy",delayDays:14},revision:0}]});
  const statePath=join(directory,"state.json"); const save=()=>writeFile(statePath,JSON.stringify({workspaces:[w]})); await save();
  await writeFile(join(directory,"hooks-enabled.json"),JSON.stringify({expiresAt:Date.now()+60_000})); await writeFile(join(root,"config.json"),JSON.stringify({daemon:{listen:"127.0.0.1:1"}}));
  const client=join(root,"client.mjs"),calls=join(root,"calls.jsonl");
  await writeFile(client,`import{appendFileSync}from'node:fs';const w=${JSON.stringify(w)};export class DaemonClient{async connect(){}async close(){}async invokePluginRpc(plugin,method,input){appendFileSync(${JSON.stringify(calls)},JSON.stringify({method,input})+'\\n');if(method==='follow.obligation')return{...w,updatedObligationId:'current'};if(method==='follow.done')return{workspace:w,blockers:['Still open']};return w;}}`);
  const env={...process.env,PASEO_HOME:root,PASEO_AGENT_ID:w.mainAgentId,FOLLOW_THROUGH_CLIENT_ENTRY:client,FOLLOW_THROUGH_RECOVERY:""};
  const rpc=async(requests:any[],override:Record<string,string>={})=>{
    const child=spawn(process.execPath,[resolve("server/mcp.mjs")],{env:{...env,...override},stdio:["pipe","pipe","pipe"]});let output="",error="";
    child.stdout.on("data",c=>output+=c);child.stderr.on("data",c=>error+=c);
    const done=new Promise<void>((ok,bad)=>{child.once("error",bad);child.once("exit",code=>code===0?ok():bad(new Error(error)));});
    child.stdin.end(requests.map((request,i)=>JSON.stringify({jsonrpc:"2.0",id:i+1,...request})).join("\n")+"\n");await done;assert.equal(error,"");return output.trim().split("\n").map(l=>JSON.parse(l));
  };
  return{root,w,env,rpc,save,calls};
}
test("native tools return compact current work and exact mutation receipts, with full history on request",async t=>{
  const f=await fixture(t);const results=await f.rpc([
    {method:"tools/call",params:{name:"workspace_status",arguments:{}}},
    {method:"tools/call",params:{name:"workspace_status",arguments:{detail:"full"}}},
    {method:"tools/call",params:{name:"update_obligation",arguments:{id:"current",title:"Verify current behavior",status:"waiting"}}},
    {method:"tools/call",params:{name:"declare_done",arguments:{summary:"Checked"}}}
  ]);
  const values=results.map(r=>JSON.parse(r.result.content[0].text));
  assert.equal(values[0].detail,"summary");assert.equal(values[0].obligations.length,1);assert.equal(values[0].completedObligations,1);assert.equal(values[0].prs[0].snapshot,undefined);
  assert.equal(values[1].obligations.length,2);assert.ok(values[1].prs[0].snapshot);
  assert.equal(values[2].obligation.id,"current");assert.deepEqual(values[2].obligation.trigger,{event:"deploy",delayDays:14});assert.equal(values[2].prs,undefined);
  assert.deepEqual(values[3].blockers,["Still open"]);assert.equal(values[3].workspace,undefined);
});
test("both transports reject misspelled dependencies and nested timing before making any RPC",async t=>{
  const f=await fixture(t);
  const input={title:"Recheck in two weeks",status:"waiting",dependsOnPrs:[1]};
  const result=await f.rpc([{method:"tools/call",params:{name:"update_obligation",arguments:input}},{method:"tools/call",params:{name:"update_obligation",arguments:{title:input.title,status:input.status,trigger:{event:"deploy",delayWeeks:2}}}}]);
  assert.equal(result[0].result.isError,true);assert.match(result[0].result.content[0].text,/Use afterPrs/);assert.equal(result[1].result.isError,true);assert.match(result[1].result.content[0].text,/delayWeeks/);
  await assert.rejects(promisify(execFile)(process.execPath,[resolve("server/mcp.mjs"),"call","update_obligation",JSON.stringify(input)],{env:f.env}),/Use afterPrs/);
  assert.equal(await readFile(f.calls,"utf8").catch(()=>""),"");
});
test("CLI retains full replies for existing scripts and offers compact calls plus real schema discovery",async t=>{
  const f=await fixture(t);const exec=promisify(execFile);
  const run=async(args:string[])=>JSON.parse((await exec(process.execPath,[resolve("server/mcp.mjs"),...args],{env:f.env})).stdout);
  assert.equal((await run(["call","workspace_status","{}"])) .obligations.length,2);
  assert.equal((await run(["call","workspace_status","{}","--compact"])).obligations.length,1);
  assert.equal((await run(["list"])).tools.length,8);
  assert.ok((await exec(process.execPath,[resolve("server/mcp.mjs"),"--help"],{env:f.env})).stdout.includes("--compact"));
});
test("native discovery is silent outside tracked scope and recovery never gains main-only tools",async t=>{
  const f=await fixture(t);const list=[{method:"tools/list"}];
  for(const PASEO_AGENT_ID of ["","untracked","provider-child"])assert.deepEqual((await f.rpc(list,{PASEO_AGENT_ID}))[0].result.tools,[]);
  f.w.enable_tracking=false;await f.save();assert.deepEqual((await f.rpc(list))[0].result.tools,[]);
  f.w.enable_tracking=true;f.w.archived=true;await f.save();assert.deepEqual((await f.rpc(list))[0].result.tools,[]);
  f.w.archived=false;f.w.batches=[{id:"recovery",state:"sent",settledAt:null,recipientAgentId:"helper",tasks:[{kind:"inventory"}]}] as any;await f.save();
  const tools=(await f.rpc(list,{PASEO_AGENT_ID:"helper"}))[0].result.tools;assert.equal(tools.length,6);assert.ok(tools.every((t:any)=>!["declare_done","sync_workspace"].includes(t.name)));
  f.w.batches[0].settledAt=new Date().toISOString();await f.save();assert.deepEqual((await f.rpc(list,{PASEO_AGENT_ID:"helper"}))[0].result.tools,[]);
});
test("an already-open MCP connection announces activation changes without messaging the agent",async t=>{
  const f=await fixture(t);f.w.enable_tracking=false;await f.save();
  const child=spawn(process.execPath,[resolve("server/mcp.mjs")],{env:f.env,stdio:["pipe","pipe","pipe"]});let output="",error="";
  child.stdout.on("data",c=>output+=c);child.stderr.on("data",c=>error+=c);
  const done=new Promise<void>((ok,bad)=>{child.once("error",bad);child.once("exit",code=>code===0?ok():bad(new Error(error)));});
  child.stdin.write(JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{}})+"\n");
  for(let i=0;!output.includes('"id":1')&&i<100;i++)await new Promise(r=>setTimeout(r,20));
  assert.ok(output.includes('"listChanged":true'));f.w.enable_tracking=true;await f.save();
  for(let i=0;!output.includes("notifications/tools/list_changed")&&i<150;i++)await new Promise(r=>setTimeout(r,20));
  assert.ok(output.includes("notifications/tools/list_changed"));child.stdin.end(JSON.stringify({jsonrpc:"2.0",id:2,method:"tools/list"})+"\n");await done;
  const result=output.trim().split("\n").map(l=>JSON.parse(l)).find(r=>r.id===2);assert.equal(result.result.tools.length,8);assert.equal(error,"");
});
test("replacement recovery discovery can ask the authoritative status handler to validate a handoff",async t=>{
  const f=await fixture(t);
  f.w.batches=[{id:"recovery",state:"sent",settledAt:null,recipientAgentId:"old-helper",tasks:[{kind:"inventory"}]}] as any;await f.save();
  await writeFile(join(f.root,"client.mjs"),`import{readFileSync,writeFileSync}from'node:fs';export class DaemonClient{async connect(){}async close(){}async invokePluginRpc(plugin,method,input){if(method!=='follow.agent-status')throw new Error('Only authoritative status lookup expected');const path=${JSON.stringify(join(f.root,"plugin-data/follow-through/state.json"))};const state=JSON.parse(readFileSync(path,'utf8'));state.workspaces[0].batches[0].recipientAgentId=input.agentId;writeFileSync(path,JSON.stringify(state));return state.workspaces[0];}}`);
  const result=await f.rpc([{method:"tools/list"}],{PASEO_AGENT_ID:"replacement-helper",FOLLOW_THROUGH_RECOVERY:"1"});
  assert.equal(result[0].result.tools.length,6);assert.ok(result[0].result.tools.every((t:any)=>!["declare_done","sync_workspace"].includes(t.name)));
  const saved=JSON.parse(await readFile(join(f.root,"plugin-data/follow-through/state.json"),"utf8"));assert.equal(saved.workspaces[0].mainAgentId,"main-agent");
});
