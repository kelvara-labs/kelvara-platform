const MAINNET='mainnet-beta',DEVNET='devnet',DEVNET_DEMO='devnet-demo';
function validContext(value){return[MAINNET,DEVNET,DEVNET_DEMO].includes(value)?value:null}
function modeFrom(record){return record?.mode==='demo'||record?.demoMode===true?'demo':record?.mode==='normal'||record?.demoMode===false?'normal':null}
export function resolveApplicationContext({search='',storedContext=null,handoff=null,session=null}={}){
 const params=new URLSearchParams(search),queryNetwork=params.get('network'),queryMode=params.get('mode'),record=handoff||session,recordNetwork=record?.network;
 let network=queryNetwork==='devnet'||queryNetwork===MAINNET?queryNetwork:recordNetwork==='devnet'||recordNetwork===MAINNET?recordNetwork:validContext(storedContext)===DEVNET_DEMO?DEVNET:validContext(storedContext)||MAINNET;
 const explicitMode=queryMode==='demo'||queryMode==='normal'?queryMode:modeFrom(record)||((storedContext===DEVNET_DEMO)?'demo':'normal');
 const demoMode=network===DEVNET&&explicitMode==='demo',context=demoMode?DEVNET_DEMO:network===DEVNET?DEVNET:MAINNET,wallet=typeof record?.wallet==='string'&&record.wallet?record.wallet:null,authenticated=Boolean(wallet&&record?.token);
 return{context,network,demoMode,authenticated,wallet};
}
