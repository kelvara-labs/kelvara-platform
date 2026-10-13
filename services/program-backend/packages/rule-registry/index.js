import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { validateRule } from "../rule-engine/index.js";

function parse(row){return row?{id:row.id,version:row.version,activation:row.activation,publishedAt:row.published_at,activatedAt:row.activated_at,rule:JSON.parse(row.rule_json)}:null}
export function createRuleRegistry({path="var/alert-console.sqlite",clock=()=>new Date().toISOString()}={}){
 mkdirSync(dirname(path),{recursive:true});const db=new DatabaseSync(path);db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS rule_versions(id TEXT NOT NULL,version INTEGER NOT NULL,cluster TEXT NOT NULL,rule_json TEXT NOT NULL,activation TEXT NOT NULL DEFAULT 'paused',published_at TEXT NOT NULL,activated_at TEXT,PRIMARY KEY(id,version)); CREATE TABLE IF NOT EXISTS rule_audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL,version INTEGER NOT NULL,action TEXT NOT NULL,actor TEXT NOT NULL,at TEXT NOT NULL);");
 const select=db.prepare("SELECT * FROM rule_versions WHERE id=? AND version=?");const auditInsert=db.prepare("INSERT INTO rule_audit(id,version,action,actor,at) VALUES(?,?,?,?,?)");
 function change(items,activation,{actor="unknown"}={}){db.exec("BEGIN IMMEDIATE");try{for(const item of items){const row=select.get(item.id,item.version);if(!row)throw new TypeError("rule_version_not_found");if(activation==="active")db.prepare("UPDATE rule_versions SET activation='paused',activated_at=NULL WHERE id=? AND version<>?").run(item.id,item.version);db.prepare("UPDATE rule_versions SET activation=?,activated_at=? WHERE id=? AND version=?").run(activation,activation==="active"?clock():null,item.id,item.version);auditInsert.run(item.id,item.version,activation==="active"?"activated":"paused",actor,clock())}db.exec("COMMIT")}catch(error){db.exec("ROLLBACK");throw error}return items.map(item=>parse(select.get(item.id,item.version)))}
 return {
  publish(rule,{actor="unknown"}={}){const validation=validateRule(rule);if(!validation.valid)throw new TypeError(`invalid_rule: ${validation.errors.join("; ")}`);const existing=select.get(rule.id,rule.version);if(existing){if(existing.rule_json!==JSON.stringify(rule))throw new TypeError("immutable_rule_version");return parse(existing)}const at=clock();db.prepare("INSERT INTO rule_versions(id,version,cluster,rule_json,activation,published_at) VALUES(?,?,?,?,?,?)").run(rule.id,rule.version,rule.cluster,JSON.stringify(rule),"paused",at);auditInsert.run(rule.id,rule.version,"published",actor,at);return parse(select.get(rule.id,rule.version))},
  get(id,version){return parse(select.get(id,version))},
  list(){return db.prepare("SELECT * FROM rule_versions ORDER BY id,version DESC").all().map(parse)},
  active({cluster}={}){return (cluster?db.prepare("SELECT * FROM rule_versions WHERE activation='active' AND cluster=? ORDER BY id,version").all(cluster):db.prepare("SELECT * FROM rule_versions WHERE activation='active' ORDER BY id,version").all()).map(parse)},
  activate(items,options){return change(items,"active",options)},pause(items,options){return change(items,"paused",options)},
  audit(){return db.prepare("SELECT id,version,action,actor,at FROM rule_audit ORDER BY seq").all()},close(){db.close()},
 };
}
