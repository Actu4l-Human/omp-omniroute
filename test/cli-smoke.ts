import { mkdtemp, rm, mkdir, copyFile, cp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const root=await mkdtemp(join(tmpdir(),'omp-omniroute-smoke-'));
const calls:string[]=[];const requestHeaders:Headers[]=[];let failModels=false;
const fixturePath=join(root,'tool-fixture.txt');const marker='OMNIROUTE_TOOL_FIXTURE_7b42';
let toolScenario:{requests:number;followUp:boolean;failure?:unknown}|undefined;
const frame=(data:unknown)=>`data: ${JSON.stringify(data)}\n\n`;
function record(value:unknown):Record<string,unknown>{
  assert.ok(value!==null && typeof value==='object' && !Array.isArray(value),'Expected a JSON object');
  return value as Record<string,unknown>;
}
function records(value:unknown):Record<string,unknown>[]{
  assert.ok(Array.isArray(value),'Expected a JSON array');return value.map(record);
}
const server=Bun.serve({port:0,hostname:'127.0.0.1',fetch:async(request)=>{
  const path=new URL(request.url).pathname;calls.push(path);
  if(request.headers.get('authorization')!=='Bearer fixture-key'){
    if(toolScenario)toolScenario.failure=new Error('Missing fixture bearer');
    return new Response('Unauthorized',{status:401});
  }
  if(path==='/v1/models' && failModels)return new Response('Fixture outage',{status:503});
  if(path==='/v1/models')return Response.json({data:[
    {id:'fixture-chat',type:'chat',context_length:8192,max_output_tokens:1024,capabilities:{tool_calling:true},pricing:{input:1,output:2}},
    {id:'fixture-embedding',type:'embedding',context_length:8192},
    {id:'fixture-image',type:'image'},
  ]});
  if(path==='/v1/models/health')return Response.json({data:[{id:'fixture-chat',state:'ok'}]});
  if(path==='/api/usage/om-usage')return Response.json({allowed:true,personal:{dailySpentUsd:1.25,dailyLimitUsd:5}});
  if(path==='/v1/chat/completions')requestHeaders.push(request.headers);
  if(path==='/v1/chat/completions' && toolScenario){
    try{
      assert.equal(request.method,'POST');
      const body=record(await request.json());assert.equal(body.model,'fixture-chat');
      assert.deepEqual(records(body.tools).map(tool=>record(tool.function).name),['read']);
      toolScenario.requests++;
      const messages=records(body.messages);const results=messages.filter(message=>message.role==='tool');
      if(toolScenario.requests===1){
        assert.equal(results.length,0);
        const args=JSON.stringify({path:fixturePath});const split=Math.floor(args.length/2);
        return new Response(
          frame({id:'tool-r',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'call_read_1',type:'function',function:{name:'read',arguments:args.slice(0,split)}}]},finish_reason:null}]})+
          frame({id:'tool-r',object:'chat.completion.chunk',choices:[{index:0,delta:{tool_calls:[{index:0,function:{arguments:args.slice(split)}}]},finish_reason:null}]})+
          frame({id:'tool-r',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})+'data: [DONE]\n\n',
          {headers:{'content-type':'text/event-stream'}});
      }
      assert.equal(toolScenario.requests,2,'Unexpected extra chat request');
      assert.equal(results.length,1);assert.equal(results[0].tool_call_id,'call_read_1');
      assert.ok(JSON.stringify(results[0].content).includes(marker),'Read tool did not return the file marker');
      const toolCalls=messages.flatMap(message=>message.tool_calls===undefined?[]:records(message.tool_calls));
      assert.equal(toolCalls.length,1);const call=record(toolCalls[0].function);assert.equal(call.name,'read');
      assert.equal(typeof call.arguments,'string');assert.deepEqual(JSON.parse(String(call.arguments)),{path:fixturePath});
      toolScenario.followUp=true;
      return new Response(
        frame({id:'tool-final',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:'File contents verified.'},finish_reason:null}]})+
        frame({id:'tool-final',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}]})+
        frame({id:'tool-final',object:'chat.completion.chunk',choices:[],usage:{prompt_tokens:100,completion_tokens:10,total_tokens:110,cost:0.0123}})+'data: [DONE]\n\n',
        {headers:{'content-type':'text/event-stream'}});
    }catch(error){toolScenario.failure=error;return new Response('Invalid tool scenario request',{status:400});}
  }
  if(path==='/v1/chat/completions')return new Response(frame({id:'r',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:'OmniRoute smoke passed.'},finish_reason:null}]})+
    frame({id:'r',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}]})+
    frame({id:'r',object:'chat.completion.chunk',choices:[],usage:{prompt_tokens:100,completion_tokens:10,total_tokens:110,cost:0.0123}})+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  return new Response('Not found',{status:404});
}});
async function run(args:string[], reported:boolean,extraEnv:Record<string,string>={}) {
  const proc=Bun.spawn([process.execPath,resolve('node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js'),...args],{
    cwd:root,env:{PATH:process.env.PATH??'',HOME:root,PI_CODING_AGENT_DIR:join(root,'agent'),
      OMNIROUTE_BASE_URL:`http://127.0.0.1:${server.port}/v1`,OMNIROUTE_API_KEY:'fixture-key',OMNIROUTE_REPORTED_COST:String(reported),OMNIROUTE_INSPECT_REQUESTS:String(reported),...extraEnv,NO_COLOR:'1',TERM:'dumb',CI:'1'},
    stdout:'pipe',stderr:'pipe',timeout:45000,
  });
  const [stdout,stderr,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
  assert.equal(code,0,stderr+'\n'+stdout);return stdout;
}
try {
  const extensionDir=join(root,'agent','extensions','omniroute');await mkdir(extensionDir,{recursive:true});
  for(const file of ['index.ts','package.json'])await copyFile(resolve(file),join(extensionDir,file));
  await cp(resolve('src'),join(extensionDir,'src'),{recursive:true});
  const extension=join(extensionDir,'index.ts');
  const discovered=JSON.parse(await run(['models','omniroute','--kind','all','--json'],false));
  assert.deepEqual(records(record(discovered).models).map(m=>({id:m.id,kind:m.kind})).sort((a,b)=>String(a.id).localeCompare(String(b.id))),[
    {id:'fixture-chat',kind:'chat'},{id:'fixture-embedding',kind:'embedding'},{id:'fixture-image',kind:'image'},
  ]);
  console.log('Automatic directory discovery in a fresh profile:',JSON.stringify(discovered));
  await writeFile(fixturePath,marker,'utf8');
  for(const reported of [false,true]) {
    const models=JSON.parse(await run(['models','omniroute','--kind','all','--json','--no-extensions','-e',extension],reported));
    console.log(`Model-list mode reported-cost=${reported}:`,JSON.stringify(models));
    const text=JSON.stringify(models);
    for(const name of ['fixture-chat','fixture-embedding','fixture-image'])assert.ok(text.includes(name));
    assert.deepEqual(models.models.map((m:any)=>m.kind).sort(),['chat','embedding','image']);
    const response=await run(['--no-extensions','-e',extension,'--no-tools','--no-lsp','--no-skills','--no-rules','--no-context-files','--no-session','--no-title','--model','omniroute/fixture-chat','--mode','json','-p','Say hello.'],reported);
    assert.ok(response.includes('OmniRoute smoke passed.'),response);
    if(reported)assert.ok(response.includes('0.0123'),response);
    console.log(`CLI chat mode reported-cost=${reported}: passed`);
    toolScenario={requests:0,followUp:false};
    const toolResponse=await run(['--no-extensions','-e',extension,'--tools','read','--no-lsp','--no-skills','--no-rules','--no-context-files','--no-session','--no-title','--model','omniroute/fixture-chat','--mode','json','-p','Read the fixture file and confirm its contents.'],reported);
    assert.equal(toolScenario.failure,undefined);assert.equal(toolScenario.requests,2);assert.equal(toolScenario.followUp,true);
    assert.ok(toolResponse.includes('File contents verified.'),toolResponse);
    console.log(`CLI read-tool round trip reported-cost=${reported}: two requests, file marker received, final text delivered`);
    toolScenario=undefined;
  }
  const overridesPath=join(root,'overrides.json');await writeFile(overridesPath,JSON.stringify({'fixture-chat':{context_length:16384,capabilities:{vision:true},pricing:{input:3,output:4}}}));
  const controlled=await run(['--no-extensions','-e',extension,'--no-tools','--no-lsp','--no-skills','--no-rules','--no-context-files','--no-session','--no-title','--model','omniroute/fixture-chat','--mode','json','-p','Say hello.'],true,{OMNIROUTE_OVERRIDES_FILE:overridesPath,OMNIROUTE_STICKY_SESSIONS:'true',OMNIROUTE_BYPASS_CACHE:'true',OMNIROUTE_BYPASS_MEMORY:'true'});
  assert.ok(controlled.includes('OmniRoute smoke passed.'));
  assert.equal(requestHeaders.at(-1)?.get('x-omniroute-no-cache'),'true');assert.equal(requestHeaders.at(-1)?.get('x-omniroute-no-memory'),'true');assert.match(requestHeaders.at(-1)?.get('x-session-id')??'',/^omp-[a-f0-9]{32}$/);
  const overridden=JSON.parse(await run(['models','omniroute','--kind','all','--json','--no-extensions','-e',extension],true));
  assert.equal(overridden.models.find((m:any)=>m.id==='fixture-chat').contextWindow,16384);
  console.log('Actual CLI request controls and persisted override mapping: passed');
  // Reuse the persisted custom-API catalog with cost mode now disabled and discovery down.
  failModels=true;
  const cached=await run(['--no-extensions','-e',extension,'--no-tools','--no-lsp','--no-skills','--no-rules','--no-context-files','--no-session','--no-title','--model','omniroute/fixture-chat','--mode','json','-p','Say hello.'],false);
  assert.ok(cached.includes('OmniRoute smoke passed.'));assert.ok(!cached.includes('0.0123'));
  console.log('Cached custom-API fallback after disabling reported-cost mode: passed');
  assert.ok(calls.includes('/v1/models'));assert.ok(calls.includes('/v1/chat/completions'));
  console.log('CLI smoke test passed: automatic/explicit loading, three model kinds, chat, read-tool round trips, controls, reported cost and cached fallback.');
} finally {server.stop(true);await rm(root,{recursive:true,force:true});}
