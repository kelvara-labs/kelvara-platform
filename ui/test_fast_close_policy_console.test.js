import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const app=readFileSync(new URL('./app.js',import.meta.url),'utf8');

test('Withdraw now logs the Mainnet protection policy blocker',()=>{
  const start=app.indexOf('async function fastClose(targetId)');
  const end=app.indexOf('async function revokeProtection(targetId)',start);
  assert.ok(start>=0&&end>start,'fastClose function missing');
  const source=app.slice(start,end);
  assert.match(source,/console\.error\("\[Kelvara protection policy blocker\]"/);
  assert.match(source,/error\.message==="mainnet_protection_disabled"/);
  assert.match(source,/Mainnet Protection is enforced off/);
});
