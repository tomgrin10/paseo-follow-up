import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
const enabled = new Set(); const writes = [];
const server = createServer(async(req,res)=>{
 let raw='';for await(const chunk of req)raw+=chunk;
 let body={};try{body=JSON.parse(raw||'{}')}catch{}
 let out={}; const path=new URL(req.url,'http://fixture').pathname;
 if(path==='/api/v1/auth-check')out={githubHandle:'isolated-fixture'};
 else if(path.startsWith('/api/v1/graphite/github-pr/')){const n=Number(path.split('/').at(-1));out={root:{repo:{owner:'example',name:'app',forgeSource:'github'},number:n,headSHA:'fixture-head-'+n,state:'OPEN',mergeWhenReady:enabled.has(n)}};}
 else if(path.startsWith('/api/v1/graphite/mutation/')){writes.push({path,body});if(path.endsWith('enable-mwr'))enabled.add(body.number);else enabled.delete(body.number);out={optimisticCreates:[]};}
 else if(path==='/v1/graphite/mergeability-status')out={mergeabilityStatuses:body.prNumbers.map(n=>({prNumber:n,mergeabilityStatus:n===2?'READY_TO_MERGE_AS_STACK':'READY_TO_MERGE'}))};
 else if(path==='/v1/graphite/merge'){writes.push({path,body});out={};}
 else if(path==='/__test/state')out={writes,enabled:[...enabled]};
 else{res.setHeader('content-type','text/html');res.end('<html><body><h1>Isolated Graphite browser fixture</h1></body></html>');return;}
 res.setHeader('content-type','application/json');res.end(JSON.stringify(out));
});
server.listen(Number(process.env.FOLLOW_TEST_GRAPHITE_PORT ?? 0),'127.0.0.1',async()=>{await writeFile('/tmp/follow-graphite-fixture.json',JSON.stringify({port:server.address().port}));console.log('fixture port '+server.address().port)});
