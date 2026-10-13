import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const app=readFileSync(new URL('./app.js',import.meta.url),'utf8');
test('Devnet Demo Withdraw now prepares, signs, submits, and finalizes the scoped evacuation',()=>{
 const start=app.indexOf('async function fastClose(targetId)');
 const end=app.indexOf('async function revokeProtection(targetId)',start);
 assert.ok(start>=0&&end>start);
 const source=app.slice(start,end);
 for(const contract of ['/api/protection/evacuation/prepare?network=devnet','p.signTransaction','/api/demo/evacuation/submit?network=devnet','/api/demo/evacuation/finalize?network=devnet'])assert.ok(source.includes(contract),`missing ${contract}`);
 assert.match(source,/targetId:mutationTargetId/);
 assert.match(source,/prepared\.targetId!==mutationTargetId/);
});
