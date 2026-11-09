import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testEnvironment } from './run-bun.ts';

const launcher=fileURLToPath(new URL('./run-bun.ts',import.meta.url));
const blocked=['DOTENV_MARKER','INHERITED_MARKER','OMNIROUTE_API_KEY','OMNIROUTE_BASE_URL','OPENAI_API_KEY',
  'NODE_AUTH_TOKEN','GITHUB_TOKEN','HTTPS_PROXY','http_proxy','BUN_OPTIONS','NODE_OPTIONS'];

for(const mode of ['script','failure','test'] as const){
  test(`Bun launcher isolates startup and preserves ${mode} mode`,{timeout:40000},async()=>{
    const root=await mkdtemp(join(tmpdir(),'omp-bun-launcher-test-'));
    try{
      const env=await testEnvironment(root);
      const override=join(root,'explicit CLI');
      Object.assign(env,{INHERITED_MARKER:'synthetic-inherited',OMNIROUTE_API_KEY:'synthetic-key',
        OMNIROUTE_BASE_URL:'https://invalid.example',OPENAI_API_KEY:'synthetic-key',NODE_AUTH_TOKEN:'synthetic-token',
        GITHUB_TOKEN:'synthetic-token',HTTPS_PROXY:'https://invalid.example',http_proxy:'https://invalid.example',
        BUN_OPTIONS:'--preload=./forbidden-preload.ts',NODE_OPTIONS:'--no-warnings',
        DO_NOT_TRACK:'0',BUN_RUNTIME_TRANSPILER_CACHE_PATH:join(root,'forbidden-cache'),OMNIROUTE_SMOKE_CLI:override});
      await writeFile(join(root,'forbidden-preload.ts'),'throw new Error("Inherited BUN_OPTIONS executed");');
      await writeFile(join(root,'.env'),'DOTENV_MARKER=synthetic-dotenv\nOMNIROUTE_API_KEY=synthetic-dotenv-key\nOMNIROUTE_SMOKE_CLI=dotenv-cli\n');
      await writeFile(join(root,'.env.test'),'DOTENV_MARKER=synthetic-test-dotenv\n');
      const probe=join(root,mode==='test'?'probe.test.ts':'probe with spaces.ts');
      const args=['argument with spaces','--literal-option','unicode-é'];
      const checks=`
        import assert from 'node:assert/strict';
        import { existsSync } from 'node:fs';
        import { join } from 'node:path';
        function check(){
          assert.equal(typeof Bun.version,'string');
          for(const key of ${JSON.stringify(blocked)})assert.equal(process.env[key],undefined,key);
          assert.equal(process.env.DO_NOT_TRACK,'1');
          assert.equal(process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH,'0');
          assert.equal(process.env.OMNIROUTE_SMOKE_CLI,${JSON.stringify(override)});
          const home=process.env.HOME;
          assert.ok(home && home!==${JSON.stringify(root)});
          assert.equal(process.env.USERPROFILE,home);
          assert.equal(process.env.PI_CODING_AGENT_DIR,join(home,'agent'));
          for(const key of ['TMPDIR','TEMP','TMP'])assert.equal(process.env[key],join(home,'tmp'));
          for(const [key,dir] of [['XDG_CACHE_HOME','cache'],['LOCALAPPDATA','cache'],['XDG_CONFIG_HOME','config'],['APPDATA','config'],['XDG_DATA_HOME','data']]){
            assert.equal(process.env[key],join(home,dir));assert.ok(existsSync(process.env[key]));
          }
          assert.equal(process.env.BUN_INSTALL_CACHE_DIR,join(home,'cache','bun'));
          console.log('ISOLATED_HOME='+JSON.stringify(home));
        }
      `;
      await writeFile(probe,checks+(mode==='test'
        ?"import { test } from 'bun:test';test('real startup isolation',check);"
        :`check();assert.deepEqual(process.argv.slice(2),${JSON.stringify(args)});process.exit(${mode==='failure'?23:0});`));
      const {promise,resolve,reject}=Promise.withResolvers<{code:number|null;signal:NodeJS.Signals|null;stdout:string;stderr:string}>();
      const child=spawn(process.execPath,[launcher,...(mode==='test'?['test',probe]:[probe,...args])],
        {cwd:root,env,stdio:['ignore','pipe','pipe'],timeout:30000,killSignal:'SIGTERM'});
      let stdout='',stderr='';
      child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{stdout+=chunk;});
      child.stderr.setEncoding('utf8');child.stderr.on('data',chunk=>{stderr+=chunk;});
      child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal,stdout,stderr}));
      const result=await promise;
      assert.equal(result.signal,null,result.stderr);
      assert.equal(result.code,mode==='failure'?23:0,result.stderr+'\n'+result.stdout);
      const match=/^ISOLATED_HOME=(.+)$/m.exec(result.stdout);assert.ok(match,result.stdout);
      const isolatedHome=JSON.parse(match[1]);
      assert.equal(typeof isolatedHome,'string');
      assert.ok(isolatedHome.startsWith(join(root,'tmp','omp-omniroute-bun-')));
      await assert.rejects(access(isolatedHome),{code:'ENOENT'});
      await assert.rejects(access(join(root,'forbidden-cache')),{code:'ENOENT'});
    }finally{await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
  });
}
