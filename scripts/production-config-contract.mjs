#!/usr/bin/env node
import {readFile} from 'node:fs/promises';

function nonEmpty(env,name){if(typeof env[name]!=='string'||env[name].trim()==='')throw new Error(`${name} is required and must be non-empty`)}
export function validateProductionEnvironment(env,contract,{scope='all',profiles=[]}={}){
  const cloudflareOnly=new Set(['CLOUDFLARED_TUNNEL_TOKEN']);
  const required=scope==='core'?contract.required.filter(name=>!cloudflareOnly.has(name)):contract.required;
  for(const name of required)nonEmpty(env,name);
  for(const profile of profiles)for(const name of contract.conditional[`profile=${profile}`]||[])nonEmpty(env,name);
  if(!/^[0-9a-f]{40}$/.test(env.KELVARA_RELEASE_SHA))throw new Error('KELVARA_RELEASE_SHA must be a full lowercase Git SHA');
  if(!['disabled','enabled'].includes(env.MAINNET_PROTECTION_MODE))throw new Error('MAINNET_PROTECTION_MODE must be disabled or enabled');
  if(env.MAINNET_PROTECTION_MODE==='enabled')nonEmpty(env,'MAINNET_PROTECTION_GATE_FILE');
  return true;
}

if(process.argv[1]===new URL(import.meta.url).pathname){
  const contract=JSON.parse(await readFile(new URL('../production/environment-contract.json',import.meta.url),'utf8'));
  const scope=process.argv.includes('--core')?'core':'all',profiles=process.argv.filter(value=>value.startsWith('--profile=')).map(value=>value.slice(10));
  try{validateProductionEnvironment(process.env,contract,{scope,profiles});console.log(`production environment contract (${scope}): OK`)}
  catch(error){console.error(`production environment contract: FAIL: ${error.message}`);process.exitCode=1}
}
