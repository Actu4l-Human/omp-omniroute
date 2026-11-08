import {beforeAll,afterAll,test,expect} from 'bun:test';
import assert from 'node:assert/strict';
import {embed,generateImage,type Model,type Api} from '@oh-my-pi/pi-ai';
import {readConfig,mapCatalog} from '../src/catalog.ts';

const pngBase64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
let server:Bun.Server<undefined>;
let embeddingModel:Model<Api>,imageModel:Model<Api>;
const requests:string[]=[];
const failures:unknown[]=[];
beforeAll(()=>{
  server=Bun.serve({port:0,hostname:'127.0.0.1',fetch:async request=>{
    if(request.headers.get('authorization')!=='Bearer fixture-key')return new Response('Unauthorized',{status:401});
    const path=new URL(request.url).pathname;
    if(!['/v1/embeddings','/v1/images/generations'].includes(path))return new Response('Not found',{status:404});
    try{
      assert.equal(request.method,'POST');
      const body:unknown=await request.json();
      assert.ok(body!==null && typeof body==='object' && !Array.isArray(body));
      const payload=body as Record<string,unknown>;
      requests.push(path);
      if(path==='/v1/embeddings'){
        assert.equal(payload.model,'fixture-embedding');assert.equal(payload.input,'test text');assert.equal(payload.encoding_format,'float');
        return Response.json({object:'list',model:'fixture-embedding',data:[{object:'embedding',index:0,embedding:[0.0123,-0.0456,0.0789]}],usage:{prompt_tokens:4,total_tokens:4}});
      }
      assert.equal(payload.model,'fixture-image');assert.equal(payload.prompt,'a red cube');assert.equal(payload.n,1);assert.equal(payload.size,'1024x1024');
      return Response.json({created:1731000000,data:[{b64_json:pngBase64}]});
    }catch(error){failures.push(error);return new Response('Malformed specialty request',{status:400});}
  }});
  const config=readConfig({OMNIROUTE_BASE_URL:`http://127.0.0.1:${server.port}/v1`});
  const catalog=mapCatalog({data:[{id:'fixture-embedding',type:'embedding',context_length:8192},{id:'fixture-image',type:'image'}]},config);
  const materialize=(id:string):Model<Api>=>{
    const mapped=catalog.models.find(model=>model.id===id);assert.ok(mapped);
    return {...mapped,provider:'omniroute',baseUrl:config.baseUrl};
  };
  embeddingModel=materialize('fixture-embedding');imageModel=materialize('fixture-image');
});
afterAll(()=>{server?.stop(true);});

test('mapped embedding model invokes the native HTTP transport and returns indexed vectors and usage',async()=>{
  const result=await embed(embeddingModel,{input:'test text',encodingFormat:'float'},{apiKey:'fixture-key',signal:AbortSignal.timeout(5000)});
  expect(failures).toEqual([]);expect(requests.filter(path=>path==='/v1/embeddings')).toEqual(['/v1/embeddings']);
  expect(result.embeddings).toEqual([{index:0,embedding:[0.0123,-0.0456,0.0789]}]);
  expect(result.usage.input).toBe(4);expect(result.usage.totalTokens).toBe(4);
});
test('mapped image model invokes text-to-image HTTP transport and returns PNG data',async()=>{
  const result=await generateImage(imageModel,{prompt:'a red cube',count:1,imageSize:'1024x1024'},{apiKey:'fixture-key',signal:AbortSignal.timeout(5000)});
  expect(failures).toEqual([]);expect(requests.filter(path=>path==='/v1/images/generations')).toEqual(['/v1/images/generations']);
  expect(result.images).toEqual([{data:pngBase64,mimeType:'image/png'}]);
});
