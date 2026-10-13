import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { mkdirSync, statSync } from "node:fs";

export const STANDARD_COVERAGE_MS = 30 * 24 * 60 * 60 * 1000;

function mapped(row, sessions=[]) { return row ? { wallet:row.wallet_id, enrolledAt:row.enrolled_at, lastLoginAt:row.last_login_at, sessions } : null }
export function createAccountStore({ path = "var/accounts.sqlite" } = {}) {
  mkdirSync(dirname(path), { recursive: true }); const db = new DatabaseSync(path); db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS wallet_accounts(wallet_id TEXT PRIMARY KEY,enrolled_at INTEGER NOT NULL,last_login_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS wallet_sessions(session_id TEXT PRIMARY KEY,wallet_id TEXT NOT NULL REFERENCES wallet_accounts(wallet_id),started_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,ended_at INTEGER,end_reason TEXT);
    CREATE INDEX IF NOT EXISTS wallet_sessions_wallet_started ON wallet_sessions(wallet_id,started_at DESC);`);
  const enroll=db.prepare(`INSERT INTO wallet_accounts(wallet_id,enrolled_at,last_login_at) VALUES(?,?,?) ON CONFLICT(wallet_id) DO UPDATE SET last_login_at=max(last_login_at,excluded.last_login_at)`),get=db.prepare("SELECT * FROM wallet_accounts WHERE wallet_id=?"),sessions=db.prepare("SELECT session_id,started_at,expires_at,ended_at,end_reason FROM wallet_sessions WHERE wallet_id=? ORDER BY started_at DESC LIMIT 100");
  const mapSessions=wallet=>sessions.all(wallet).map(row=>({sessionId:row.session_id,startedAt:row.started_at,expiresAt:row.expires_at,endedAt:row.ended_at,endReason:row.end_reason}));
  return {
    enroll(wallet,at){enroll.run(wallet,at,at)},
    startSession(id,wallet,startedAt,expiresAt){db.prepare("INSERT OR IGNORE INTO wallet_sessions(session_id,wallet_id,started_at,expires_at) VALUES(?,?,?,?)").run(id,wallet,startedAt,expiresAt)},
    endSession(id,endedAt,reason="ended"){db.prepare("UPDATE wallet_sessions SET ended_at=?,end_reason=? WHERE session_id=? AND ended_at IS NULL").run(endedAt,reason,id)},
    endLatestSession(wallet,endedAt,reason="logout"){db.prepare("UPDATE wallet_sessions SET ended_at=?,end_reason=? WHERE session_id=(SELECT session_id FROM wallet_sessions WHERE wallet_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1)").run(endedAt,reason,wallet)},
    get(wallet){return mapped(get.get(wallet),mapSessions(wallet))},
    list(){return db.prepare("SELECT * FROM wallet_accounts ORDER BY last_login_at DESC").all().map(row=>mapped(row))},
    query({page=1,pageSize=50,search="",coverage="all",expiry=null,sort="lastLogin",direction="desc",now=Date.now()}={}){page=Math.max(1,page);pageSize=Math.min(100,Math.max(1,pageSize));const where=[],args=[];if(search){where.push("wallet_id LIKE ?");args.push(`%${search}%`)}const end="enrolled_at+?",remaining=`(${end}-?)`;if(coverage==="active"){where.push(`${end}>?`);args.push(STANDARD_COVERAGE_MS,now)}if(coverage==="expired"){where.push(`${end}<=?`);args.push(STANDARD_COVERAGE_MS,now)}if(expiry!=null){where.push(`${remaining}>0 AND ${remaining}<=?`);args.push(STANDARD_COVERAGE_MS,now,STANDARD_COVERAGE_MS,now,Number(expiry)*86400000)}const clause=where.length?` WHERE ${where.join(" AND ")}`:"",columns={lastLogin:"last_login_at",enrollment:"enrolled_at",expiry:"enrolled_at"},order=columns[sort]||columns.lastLogin,dir=direction==="asc"?"ASC":"DESC",total=Number(db.prepare(`SELECT count(*) n FROM wallet_accounts${clause}`).get(...args).n),rows=db.prepare(`SELECT * FROM wallet_accounts${clause} ORDER BY ${order} ${dir},wallet_id ASC LIMIT ? OFFSET ?`).all(...args,pageSize,(page-1)*pageSize);return{accounts:rows.map(row=>mapped(row)),total}},
    databaseSize(){let bytes=0;for(const suffix of ["","-wal","-shm"]){try{bytes+=statSync(path+suffix).size}catch{}}return{bytes,path:"/data/kamino-monitor/accounts.sqlite"}},
    close(){db.close()}
  }
}
export function standardCoverage(account,now=Date.now()){if(!account)return null;const coverageEnds=account.enrolledAt+STANDARD_COVERAGE_MS,remaining=Math.max(0,coverageEnds-now);return{plan:"standard",coverageStartedAt:new Date(account.enrolledAt).toISOString(),coverageEndsAt:new Date(coverageEnds).toISOString(),coverageDaysRemaining:Math.ceil(remaining/86400000),coverageStatus:remaining>0?"active":"expired"}}
