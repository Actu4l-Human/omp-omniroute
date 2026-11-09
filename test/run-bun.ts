import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { constants, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function testEnvironment(root:string,source:NodeJS.ProcessEnv=process.env):Promise<NodeJS.ProcessEnv>{
  const env:NodeJS.ProcessEnv={};
  for(const [key,value] of Object.entries(source)){
    if(/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT)$/i.test(key))env[key]=value;
  }
  const temp=join(root,'tmp'),cache=join(root,'cache'),config=join(root,'config'),data=join(root,'data');
  await Promise.all([temp,cache,config,data,join(root,'agent')].map(path=>mkdir(path,{recursive:true})));
  return {...env,HOME:root,USERPROFILE:root,PI_CODING_AGENT_DIR:join(root,'agent'),
    TMPDIR:temp,TEMP:temp,TMP:temp,XDG_CACHE_HOME:cache,XDG_CONFIG_HOME:config,XDG_DATA_HOME:data,
    LOCALAPPDATA:cache,APPDATA:config,BUN_INSTALL_CACHE_DIR:join(cache,'bun'),
    DO_NOT_TRACK:'1',BUN_RUNTIME_TRANSPILER_CACHE_PATH:'0',CI:'1',NO_COLOR:'1',TERM:'dumb'};
}

async function main(){
  const root=await mkdtemp(join(tmpdir(),'omp-omniroute-bun-'));
  try{
    const env=await testEnvironment(root);
    if(process.env.OMNIROUTE_SMOKE_CLI!==undefined)env.OMNIROUTE_SMOKE_CLI=process.env.OMNIROUTE_SMOKE_CLI;
    // Bun's npm installer uses bin/bun.exe on every supported platform, including POSIX.
    const bun=fileURLToPath(new URL('../node_modules/bun/bin/bun.exe',import.meta.url));
    const args=process.argv.slice(2);
    const bunArgs=args[0]==='test'?['test','--no-env-file',...args.slice(1)]:['--no-env-file',...args];
    const {promise,resolve:complete,reject}=Promise.withResolvers<number>();
    const child=spawn(bun,bunArgs,{env,stdio:'inherit',timeout:600000,killSignal:'SIGKILL'});
    let interrupted=0;
    const interrupt=()=>{interrupted=130;child.kill('SIGKILL');};
    const terminate=()=>{interrupted=143;child.kill('SIGKILL');};
    process.once('SIGINT',interrupt);process.once('SIGTERM',terminate);
    const cleanup=()=>{process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);};
    child.once('error',error=>{cleanup();reject(error);});
    child.once('close',(code,signal)=>{cleanup();complete(interrupted || (code ?? (signal?128+constants.signals[signal]:1)));});
    process.exitCode=await promise;
  }finally{await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main();
