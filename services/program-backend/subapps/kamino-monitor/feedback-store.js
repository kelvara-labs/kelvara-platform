import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

const categories=new Set(["bug","idea","question","other"]),pages=new Set(["home","overview","positions","governance","safeguards","protection","account"]);
function normalize(input){if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).sort().join("|")!=="category|message|page")throw new TypeError("invalid_feedback");const category=String(input.category||""),message=String(input.message||"").trim(),page=String(input.page||"");if(!categories.has(category)||!pages.has(page)||message.length<3||message.length>2000||/[\u0000-\u001f\u007f]/.test(message))throw new TypeError("invalid_feedback");return{category,message,page}}
function walletId(value){const wallet=String(value||"").trim();if(!wallet||wallet.length>128||/[\u0000-\u0020\u007f]/.test(wallet))throw new TypeError("invalid_wallet");return wallet}
const map=row=>({id:row.id,...(row.wallet_id?{wallet:row.wallet_id}:{}),category:row.category,message:row.message,page:row.page,receivedAt:row.received_at});
export function createFeedbackStore({path="var/feedback.sqlite",now=Date.now}={}){
 mkdirSync(dirname(path),{recursive:true});const db=new DatabaseSync(path);db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS user_feedback(id TEXT PRIMARY KEY,category TEXT NOT NULL CHECK(category IN ('bug','idea','question','other')),message TEXT NOT NULL CHECK(length(message) BETWEEN 3 AND 2000),page TEXT NOT NULL CHECK(page IN ('home','overview','positions','governance','safeguards','protection','account')),received_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS user_feedback_received ON user_feedback(received_at DESC);`);
 const columns=db.prepare("PRAGMA table_info(user_feedback)").all();if(!columns.some(column=>column.name==="wallet_id"))db.exec("ALTER TABLE user_feedback ADD COLUMN wallet_id TEXT");db.exec("CREATE INDEX IF NOT EXISTS user_feedback_wallet_received ON user_feedback(wallet_id,received_at DESC,id DESC)");
 const insert=db.prepare("INSERT INTO user_feedback(id,wallet_id,category,message,page,received_at) VALUES(?,?,?,?,?,?)"),list=db.prepare("SELECT id,wallet_id,category,message,page,received_at FROM user_feedback WHERE wallet_id IS NOT NULL ORDER BY received_at DESC,rowid DESC LIMIT 100"),byWallet=db.prepare("SELECT id,category,message,page,received_at FROM user_feedback WHERE wallet_id=? ORDER BY received_at DESC,rowid DESC LIMIT 100");
 return{submit(wallet,input){const owner=walletId(wallet),value=normalize(input),id=randomUUID(),receivedAt=new Date(now()).toISOString();insert.run(id,owner,value.category,value.message,value.page,receivedAt);return{id,receivedAt}},list(){return list.all().map(map)},listByWallet(wallet){return byWallet.all(walletId(wallet)).map(map)},close(){db.close()}}
}
