const $=selector=>document.querySelector(selector);
const businessNames={evacuation:'Protected Exit Readiness',indexers:'Protocol Data Coverage',invariants:'Invariant Safeguards'};
const statusLabels={operational:'Operational',degraded:'Degraded',incident:'Incident',no_data:'No data'};

function pct(value,digits=2){return value==null?'—':`${Number(value).toFixed(digits).replace(/\.00$/,'')}%`}
function dateLabel(value){return new Date(value).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}

function summaryCard(label,value,modifier=''){
 const card=document.createElement('div');card.className=`summary-item ${modifier}`;
 card.innerHTML=`<strong>${value}</strong><span>${label}</span>`;return card;
}

function renderSummary(summary={}){
 const host=$('#summary');host.replaceChildren(
  summaryCard('Systems',summary.systems??0),
  summaryCard('Operational',summary.operational??0,'positive'),
  summaryCard('Incidents',summary.incidents??0,summary.incidents?'negative':''),
  summaryCard('Overall uptime',pct(summary.overallUptime24h),'accent')
 );
}

function serviceRow(service){
 const row=document.createElement('article');row.className='service-card';
 const header=document.createElement('div');header.className='service-header';
 const identity=document.createElement('div');identity.className='service-identity';
 identity.innerHTML=`<h3>${service.name}</h3><p>${service.description||''}</p>`;
 const badge=document.createElement('span');badge.className=`status-badge ${service.currentStatus}`;
 badge.innerHTML=`<i></i>${statusLabels[service.currentStatus]||'Unknown'}`;
 header.append(identity,badge);

 const timeline=document.createElement('div');timeline.className='timeline';timeline.setAttribute('aria-label',`${service.name} 24-hour uptime timeline`);
 for(const point of service.timeline||[]){
  const bar=document.createElement('span');bar.className=`segment ${point.status}`;bar.tabIndex=point.status==='operational'?-1:0;
  const detail=point.description?` · ${point.description}`:'';bar.title=`${dateLabel(point.timestamp)} · ${statusLabels[point.status]}${detail}`;
  bar.setAttribute('aria-label',bar.title);timeline.append(bar);
 }

 const footer=document.createElement('div');footer.className='service-footer';
 const metric=service.uptime24h==null?`${pct(service.dataCoverage24h,1)} data coverage`:`${pct(service.uptime24h)} uptime`;
 const coverage=service.dataCoverage24h<99?`<span class="coverage">${pct(service.dataCoverage24h,1)} data coverage</span>`:'';
 footer.innerHTML=`<span>24 hours ago</span><strong>${metric}</strong>${coverage}<span>Now</span>`;
 row.append(header,timeline,footer);return row;
}

function renderList(host,items,detail=false){
 host.replaceChildren();for(const service of items||[])host.append(serviceRow(detail?{...service,name:businessNames[service.id]||service.name}:service));
}

async function refresh(){
 try{
  const response=await fetch('/api/status',{cache:'no-store'});if(!response.ok)throw Error('status unavailable');
  const data=await response.json();const overall=$('#overall');overall.className=`overall ${data.overall}`;
  overall.querySelector('strong').textContent=data.overall==='operational'?'All systems operational':data.overall==='major_outage'?'Service incident detected':'Some systems degraded';
  $('#updated').textContent=`Last updated ${new Date(data.generatedAt).toLocaleString()}`;
  renderSummary(data.summary);renderList($('#services'),data.services);renderList($('#detail-services'),data.details,true);
 }catch{
  $('#updated').textContent='Status data temporarily unavailable';$('#overall').className='overall unknown';$('#overall strong').textContent='Status unknown';
 }
}

$('#toggle-details').addEventListener('click',()=>{const hidden=$('#details').classList.toggle('hidden');$('#toggle-details').textContent=hidden?'Show system details':'Hide system details';$('#toggle-details').setAttribute('aria-expanded',String(!hidden))});
refresh();setInterval(refresh,60000);
