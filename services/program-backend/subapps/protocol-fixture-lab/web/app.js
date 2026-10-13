const scenarios=document.querySelector('#scenarios');
const stateBox=document.querySelector('#state');
const status=document.querySelector('#status');
const rpcActivity=document.querySelector('#rpc-activity');
const transactions=document.querySelector('#transactions');
document.querySelector('#rpc').textContent=`${location.origin}/rpc`;

const labels={"upgrade-authority-transfer":"Transfer upgrade authority","upgrade-authority-remove":"Remove upgrade authority","mint-authority-transfer":"Transfer mint authority","freeze-authority-change":"Change freeze authority","supply-increase":"Increase supply","nav-jump":"Jump NAV","nav-stale":"Stale NAV","vault-outflow":"Vault outflow","first-seen-destination":"First-seen destination","pause":"Pause protocol","redemption-failure":"Fail redemption","multi-condition-incident":"Multi-condition incident"};
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function renderState(data){
  const s=data.state;
  const facts={Slot:s.slot,'Upgrade authority':s.program.upgradeAuthority??'immutable','Mint authority':s.token.mintAuthority,'Freeze authority':s.token.freezeAuthority,'Raw supply':s.token.rawSupply,NAV:s.protocol.nav,'NAV updated':s.protocol.navUpdatedAt,'Vault balance':s.protocol.vaultRawBalance,Paused:s.protocol.paused,'Redemption healthy':s.protocol.redemptionHealthy,Transactions:s.transactions.length};
  stateBox.innerHTML=Object.entries(facts).map(([k,v])=>`<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
}

function renderActivity(data){
  const calls=[...data.rpcCalls].reverse();
  rpcActivity.innerHTML=calls.length?calls.map(call=>`<tr><td>${call.sequence}</td><td>${esc(new Date(call.observedAt).toLocaleTimeString())}</td><td>${esc(call.method)}</td><td>${call.ok?'success':`error: ${esc(call.error)}`}</td></tr>`).join(''):'<tr><td colspan="4" class="empty">No RPC calls yet.</td></tr>';
  const rows=[...data.transactions].reverse();
  transactions.innerHTML=rows.length?rows.map(tx=>`<tr><td>${tx.slot}</td><td>${esc(tx.scenario)}</td><td><code class="signature" title="${esc(tx.signature)}">${esc(tx.signature)}</code></td><td>${tx.err?'failed':esc(tx.confirmationStatus)}</td></tr>`).join(''):'<tr><td colspan="4" class="empty">No fixture transactions yet.</td></tr>';
}

async function refresh(){
  const [stateResponse,activityResponse]=await Promise.all([fetch('/api/state'),fetch('/api/activity')]);
  renderState(await stateResponse.json());
  renderActivity(await activityResponse.json());
}

async function act(path){
  status.textContent='Applying…';
  const response=await fetch(path,{method:'POST'});
  const data=await response.json();
  if(!response.ok){status.textContent=data.error;return}
  await refresh();
  status.textContent=`Applied. Slot ${data.state.slot}`;
}

const list=await (await fetch('/api/scenarios')).json();
for(const name of list.scenarios){const button=document.createElement('button');button.textContent=labels[name]||name;button.onclick=()=>act(`/api/scenarios/${encodeURIComponent(name)}`);scenarios.append(button)}
document.querySelector('#reset').onclick=()=>act('/api/reset');
document.querySelector('#export').onclick=()=>location.assign('/api/export');
document.querySelector('#refresh').onclick=refresh;
await refresh();
setInterval(refresh,3000);
