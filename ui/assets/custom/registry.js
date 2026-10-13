export const CUSTOM_ICON_FALLBACK=new URL('./fallback.svg',import.meta.url).href;
export const KELVARA_GOVERNANCE_LAB_ICON=new URL('./kelvara-governance-lab.svg',import.meta.url).href;
export function customIconFor(key='fallback'){return String(key).toLowerCase()==='kelvara-governance-lab'?KELVARA_GOVERNANCE_LAB_ICON:CUSTOM_ICON_FALLBACK}
