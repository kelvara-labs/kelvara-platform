const TOKEN_ICONS=Object.freeze({usdg:new URL('./usdg.svg',import.meta.url).href,usdc:new URL('./usdc.svg',import.meta.url).href,usdt:new URL('./usdt.svg',import.meta.url).href});
const TOKEN_ALIASES=Object.freeze({'usd-coin':'usdc','usd coin':'usdc',tether:'usdt','tether usd':'usdt'});
export function tokenIconFor(id=''){const key=String(id).trim().toLowerCase();return TOKEN_ICONS[key]||TOKEN_ICONS[TOKEN_ALIASES[key]]||TOKEN_ICONS.usdg}
export function tokenLabelFor(id=''){const key=String(id).trim().toLowerCase();return key==='usdc'?'USDC':key==='usdt'?'USDT':key==='usdg'?'USDG':String(id||'Token')}
