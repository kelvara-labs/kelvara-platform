const NETWORK_ICONS=Object.freeze({solana:new URL('./solana.svg',import.meta.url).href});
export function networkIconFor(id=''){return NETWORK_ICONS[String(id).toLowerCase().includes('solana')?'solana':'solana']}
export function networkLabelFor(id=''){return String(id).includes('devnet')?'Solana Devnet':'Solana Mainnet'}
