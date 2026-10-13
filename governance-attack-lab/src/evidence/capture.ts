import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
const json=(value:unknown)=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n';
export async function writeImmutableJson(file:string,value:unknown):Promise<void>{
 await mkdir(path.dirname(file),{recursive:true}); const h=await open(file,'wx',0o600); try{await h.writeFile(json(value));await h.sync()}finally{await h.close()}
}
export async function updateJsonAtomic(file:string,value:unknown):Promise<void>{
 await mkdir(path.dirname(file),{recursive:true}); const temp=`${file}.${process.pid}.${Date.now()}.tmp`; try{await writeFile(temp,json(value),{mode:0o600,flag:'wx'});await rename(temp,file)}finally{await rm(temp,{force:true})}
}
