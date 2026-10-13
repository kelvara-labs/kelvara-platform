export const ANIMAL_IDENTICON_VERSION=1;

const BASE58=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const REFERENCE_KEY="11111111111111111111111111111111";
const ANIMALS=Object.freeze(["fox","owl","cat","bear","rabbit","wolf","panda","raccoon","deer","koala","tiger","axolotl"]);
const PALETTES=Object.freeze([
 {name:"moss",bg:"#d5fb42",body:"#315c3a",detail:"#f7f7ef",ink:"#15251a"},
 {name:"coral",bg:"#ffb59f",body:"#a43f39",detail:"#fff4df",ink:"#351815"},
 {name:"ocean",bg:"#9de4ef",body:"#17677a",detail:"#eaffff",ink:"#102f36"},
 {name:"violet",bg:"#d8c3ff",body:"#6546a4",detail:"#fbf7ff",ink:"#24183d"},
 {name:"amber",bg:"#ffd370",body:"#9b5a18",detail:"#fff5d8",ink:"#3b260f"},
 {name:"rose",bg:"#f6bed8",body:"#9b4168",detail:"#fff3f8",ink:"#3a1828"},
 {name:"slate",bg:"#c9d2d8",body:"#445862",detail:"#f8fbfc",ink:"#172126"},
 {name:"mint",bg:"#aee8cd",body:"#26705b",detail:"#effff7",ink:"#14382e"},
 {name:"sky",bg:"#bdd9ff",body:"#3566a5",detail:"#f5f9ff",ink:"#172b48"},
 {name:"sand",bg:"#ead0a4",body:"#7c5537",detail:"#fff7e9",ink:"#302116"},
 {name:"plum",bg:"#ddb6d9",body:"#73416e",detail:"#fff4fe",ink:"#311b2e"},
 {name:"lime",bg:"#dff790",body:"#526b20",detail:"#fbffe8",ink:"#202b0d"}
]);
const BACKGROUNDS=Object.freeze(["halo","split","sun","stripes","corners","orbit","checker","plain"]);
const ACCENTS=Object.freeze(["brow","freckles","diamond","cheeks"]);
const SEEDS=Object.freeze([0x811c9dc5,0x9e3779b9,0x85ebca6b,0xc2b2ae35]);

function hashLane(value,seed){let hash=seed>>>0;for(let index=0;index<value.length;index++){hash^=value.charCodeAt(index);hash=Math.imul(hash,0x01000193);hash^=hash>>>13;hash=Math.imul(hash,0x5bd1e995)}return (hash^(hash>>>16))>>>0}
function lanesFor(value){return SEEDS.map(seed=>(hashLane(value,seed)^hashLane(REFERENCE_KEY,seed))>>>0)}
function decodedLength(value){const alphabet="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";let number=0n;for(const character of value)number=number*58n+BigInt(alphabet.indexOf(character));let bytes=0;while(number>0n){number>>=8n;bytes++}let leadingZeroes=0;while(value[leadingZeroes]==="1")leadingZeroes++;return bytes+leadingZeroes}
function validKey(value){return typeof value==="string"&&BASE58.test(value)&&decodedLength(value)===32}

export function animalIdenticonTraits(publicKey){
 if(!validKey(publicKey))return null;
 const lanes=lanesFor(publicKey);
 return Object.freeze({version:ANIMAL_IDENTICON_VERSION,animal:ANIMALS[lanes[0]%ANIMALS.length],palette:PALETTES[lanes[1]%PALETTES.length].name,background:BACKGROUNDS[lanes[2]%BACKGROUNDS.length],accent:ACCENTS[lanes[3]%ACCENTS.length],mirror:Boolean((lanes[0]>>>8)&1)});
}

const ANIMAL_PARTS=Object.freeze({
 fox:{ears:'<path d="M13 25 15 7l15 13M51 25 49 7 34 20"/>',head:'<path d="M12 29c0-13 9-20 20-20s20 7 20 20c0 16-9 25-20 25S12 45 12 29Z"/>',patch:'<path d="M17 31c7 0 11 4 15 12 4-8 8-12 15-12-2 13-7 19-15 19s-13-6-15-19Z"/>'},
 owl:{ears:'<path d="m15 20-2-12 12 8M49 20l2-12-12 8"/>',head:'<path d="M12 29c0-13 8-21 20-21s20 8 20 21c0 15-8 25-20 25S12 44 12 29Z"/>',patch:'<circle cx="23" cy="32" r="10"/><circle cx="41" cy="32" r="10"/>'},
 cat:{ears:'<path d="M14 24 12 7l15 11M50 24 52 7 37 18"/>',head:'<path d="M12 30c0-13 8-21 20-21s20 8 20 21c0 15-8 24-20 24s-20-9-20-24Z"/>',patch:'<path d="M20 40c7 5 17 5 24 0-2 9-7 13-12 13s-10-4-12-13Z"/>'},
 bear:{ears:'<circle cx="16" cy="17" r="8"/><circle cx="48" cy="17" r="8"/>',head:'<path d="M11 31c0-15 9-23 21-23s21 8 21 23c0 14-9 23-21 23s-21-9-21-23Z"/>',patch:'<ellipse cx="32" cy="40" rx="12" ry="10"/>'},
 rabbit:{ears:'<ellipse cx="21" cy="14" rx="7" ry="15" transform="rotate(-12 21 14)"/><ellipse cx="43" cy="14" rx="7" ry="15" transform="rotate(12 43 14)"/>',head:'<path d="M13 33c0-14 8-23 19-23s19 9 19 23c0 13-8 21-19 21s-19-8-19-21Z"/>',patch:'<ellipse cx="32" cy="42" rx="10" ry="9"/>'},
 wolf:{ears:'<path d="M11 25 17 5l13 15M53 25 47 5 34 20"/>',head:'<path d="M11 30c0-13 9-21 21-21s21 8 21 21c0 14-9 24-21 24S11 44 11 30Z"/>',patch:'<path d="m17 31 9-9 6 21 6-21 9 9-4 18-11 5-11-5Z"/>'},
 panda:{ears:'<circle cx="15" cy="17" r="9"/><circle cx="49" cy="17" r="9"/>',head:'<path d="M11 31c0-15 9-23 21-23s21 8 21 23c0 14-9 23-21 23s-21-9-21-23Z"/>',patch:'<ellipse cx="22" cy="31" rx="8" ry="10" transform="rotate(20 22 31)"/><ellipse cx="42" cy="31" rx="8" ry="10" transform="rotate(-20 42 31)"/>'},
 raccoon:{ears:'<circle cx="16" cy="18" r="8"/><circle cx="48" cy="18" r="8"/>',head:'<path d="M11 31c0-14 9-22 21-22s21 8 21 22c0 14-9 23-21 23s-21-9-21-23Z"/>',patch:'<path d="M14 29c10-9 26-9 36 0l-5 12c-9-6-17-6-26 0Z"/>'},
 deer:{ears:'<path d="M15 21 7 12c9-3 15 1 18 8M49 21l8-9c-9-3-15 1-18 8M21 15l-5-9m27 9 5-9"/>',head:'<path d="M13 28c0-12 8-19 19-19s19 7 19 19c0 17-8 26-19 26s-19-9-19-26Z"/>',patch:'<path d="M22 38c5 4 15 4 20 0-1 10-5 15-10 15s-9-5-10-15Z"/>'},
 koala:{ears:'<circle cx="13" cy="27" r="11"/><circle cx="51" cy="27" r="11"/>',head:'<path d="M11 30c0-14 9-22 21-22s21 8 21 22c0 15-9 24-21 24s-21-9-21-24Z"/>',patch:'<ellipse cx="32" cy="39" rx="9" ry="13"/>'},
 tiger:{ears:'<path d="M13 23 13 8l14 11M51 23 51 8 37 19"/>',head:'<path d="M11 30c0-14 9-22 21-22s21 8 21 22c0 15-9 24-21 24s-21-9-21-24Z"/>',patch:'<path d="m25 11 7 13 7-13M14 26l11 4-10 5m35-9-11 4 10 5"/>'},
 axolotl:{ears:'<path d="M15 30 5 20m11 4L9 12m40 18 10-10m-11 4 7-12"/>',head:'<path d="M10 33c0-13 9-21 22-21s22 8 22 21c0 13-9 21-22 21s-22-8-22-21Z"/>',patch:'<path d="M20 41c7 7 17 7 24 0-3 9-8 12-12 12s-9-3-12-12Z"/>'}
});

function backgroundMarkup(kind,color,ink){
 if(kind==="split")return `<path fill="${ink}" opacity=".12" d="M0 64 64 0v64Z"/>`;
 if(kind==="sun")return `<circle fill="${ink}" opacity=".11" cx="32" cy="31" r="23"/>`;
 if(kind==="stripes")return `<path stroke="${ink}" stroke-width="5" opacity=".09" d="m-8 18 30-30M-5 43 43-5M14 64l50-50M40 70l30-30"/>`;
 if(kind==="corners")return `<path fill="${ink}" opacity=".1" d="M0 0h22L0 22Zm64 64H42l22-22Z"/>`;
 if(kind==="orbit")return `<ellipse fill="none" stroke="${ink}" stroke-width="4" opacity=".12" cx="32" cy="32" rx="27" ry="14" transform="rotate(-25 32 32)"/>`;
 if(kind==="checker")return `<path fill="${ink}" opacity=".08" d="M0 0h16v16H0Zm32 0h16v16H32ZM16 16h16v16H16Zm32 0h16v16H48ZM0 32h16v16H0Zm32 0h16v16H32ZM16 48h16v16H16Zm32 0h16v16H48Z"/>`;
 if(kind==="halo")return `<circle fill="${color}" opacity=".5" cx="32" cy="31" r="25"/><circle fill="none" stroke="${ink}" stroke-width="2" opacity=".09" cx="32" cy="31" r="21"/>`;
 return "";
}
function accentMarkup(kind,ink,detail){
 if(kind==="freckles")return `<g fill="${ink}" opacity=".65"><circle cx="19" cy="39" r="1.2"/><circle cx="23" cy="41" r="1"/><circle cx="45" cy="39" r="1.2"/><circle cx="41" cy="41" r="1"/></g>`;
 if(kind==="diamond")return `<path fill="${detail}" stroke="${ink}" stroke-width="1" d="m32 18 4 5-4 5-4-5Z"/>`;
 if(kind==="cheeks")return `<g fill="${detail}" opacity=".72"><ellipse cx="19" cy="40" rx="4" ry="2"/><ellipse cx="45" cy="40" rx="4" ry="2"/></g>`;
 return `<path fill="none" stroke="${ink}" stroke-width="2" stroke-linecap="round" d="m19 27 7-2m19 2-7-2"/>`;
}

export function animalIdenticonSvg(publicKey){
 const traits=animalIdenticonTraits(publicKey);if(!traits)return null;
 const palette=PALETTES.find(item=>item.name===traits.palette),animal=ANIMAL_PARTS[traits.animal],flip=traits.mirror?' transform="translate(64 0) scale(-1 1)"':"";
 return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-hidden="true" focusable="false" data-version="${traits.version}" data-animal="${traits.animal}" data-palette="${traits.palette}"><rect width="64" height="64" rx="15" fill="${palette.bg}"/>${backgroundMarkup(traits.background,palette.detail,palette.ink)}<g${flip}><g fill="${palette.body}" stroke="${palette.ink}" stroke-width="2" stroke-linejoin="round">${animal.ears}${animal.head}</g><g fill="${palette.detail}" opacity=".9">${animal.patch}</g><g fill="${palette.ink}"><ellipse cx="24" cy="33" rx="2.4" ry="3"/><ellipse cx="40" cy="33" rx="2.4" ry="3"/><path d="m28 41 4-3 4 3-4 4Z"/></g>${accentMarkup(traits.accent,palette.ink,palette.detail)}</g><rect x="1" y="1" width="62" height="62" rx="14" fill="none" stroke="${palette.ink}" stroke-opacity=".18" stroke-width="2"/></svg>`;
}

export const animalIdenticonOptions=Object.freeze({animals:ANIMALS,palettes:PALETTES.map(item=>item.name),backgrounds:BACKGROUNDS,accents:ACCENTS});
