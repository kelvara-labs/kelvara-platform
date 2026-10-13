import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const migrationUrls = [
  new URL('../migrations/001_indexer_core.sql', import.meta.url),
  new URL('../migrations/002_evacuation_events.sql', import.meta.url)
];
const evacuationIdempotencyMigrationUrl = new URL('../migrations/003_evacuation_event_idempotency.sql', import.meta.url);
const evaluationReceiptsMigrationUrl = new URL('../migrations/004_evaluation_receipts.sql', import.meta.url);
const desiredTargetsMigrationUrl = new URL('../migrations/005_desired_targets.sql', import.meta.url);
const walletSafeguardObservationsMigrationUrl = new URL('../migrations/006_wallet_safeguard_observations.sql', import.meta.url);
const governanceControlMigrationUrl = new URL('../migrations/007_governance_control.sql', import.meta.url);
const velocityObservationsMigrationUrl = new URL('../migrations/008_velocity_observations.sql', import.meta.url);
const velocityActivityMigrationUrl = new URL('../migrations/009_velocity_activity.sql', import.meta.url);
const governanceActionsMigrationUrl = new URL('../migrations/010_governance_actions.sql', import.meta.url);
const governanceDetectionsMigrationUrl = new URL('../migrations/011_governance_detections.sql', import.meta.url);
const scenarioCapsuleObservationsMigrationUrl = new URL('../migrations/012_scenario_capsule_observations.sql', import.meta.url);

function migrateLegacyGovernanceControl(db) {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='governance_control_observations'").get();
  if (!table) return;
  const columns = db.prepare('PRAGMA table_info(governance_control_observations)').all().map(row => [row.name, row.type, row.notnull, row.pk]);
  const legacyColumns = [['observation_id','TEXT',0,1],['idempotency_key','TEXT',1,0],['payload_hash','TEXT',1,0],['subject_address','TEXT',1,0],['provider','TEXT',1,0],['generation','TEXT',1,0],['program_id','TEXT',1,0],['multisig_address','TEXT',1,0],['authority_address','TEXT',1,0],['authority_index','INTEGER',1,0],['threshold','INTEGER',1,0],['time_lock_seconds','INTEGER',1,0],['canonical_json','TEXT',1,0],['finalized_slot','INTEGER',1,0],['observed_at','TEXT',1,0],['decoder_family','TEXT',1,0],['decoder_version','TEXT',1,0],['artifact_hash','TEXT',1,0],['created_at','TEXT',1,0]];
  if (JSON.stringify(columns) === JSON.stringify(legacyColumns)) throw new Error('invalid_governance_control_schema');
  if (!columns.some(([name]) => name === 'batch_hash') || !columns.some(([name]) => name === 'status')) throw new Error('invalid_governance_control_schema');
}

function normalizeSql(sql) { return String(sql ?? '').replace(/\s+/g, '').toLowerCase(); }

function verifyScenarioCapsuleObservationSchema(db) {
  const expectedColumns = [['evidence_ref','TEXT',0,1],['payload_hash','TEXT',1,0],['network','TEXT',1,0],['program_id','TEXT',1,0],['session_address','TEXT',1,0],['authority','TEXT',1,0],['session_id','TEXT',1,0],['flags','INTEGER',1,0],['sequence','TEXT',1,0],['finalized_slot','INTEGER',1,0],['observed_at','TEXT',1,0],['evidence_json','TEXT',1,0],['created_at','TEXT',1,0]];
  const columns = db.prepare('PRAGMA table_info(scenario_capsule_observations)').all().map(row => [row.name,row.type,row.notnull,row.pk]);
  const table = normalizeSql(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='scenario_capsule_observations'").get()?.sql);
  const index = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='scenario_capsule_observations_session_slot'").get();
  const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'scenario_capsule_observations_%' ORDER BY name").all();
  const requiredChecks = ["check(network='devnet')",'check(flagsin(0,4))','check(json_valid(evidence_json))','check(finalized_slot>=0andfinalized_slot<=9007199254740991)'];
  const valid = JSON.stringify(columns)===JSON.stringify(expectedColumns)
    && requiredChecks.every(check=>table.includes(check))
    && normalizeSql(index?.sql)==='createindexscenario_capsule_observations_session_slotonscenario_capsule_observations(session_address,finalized_slot)'
    && triggers.length===2
    && normalizeSql(triggers.find(row=>row.name==='scenario_capsule_observations_no_delete')?.sql).includes("beforedeleteonscenario_capsule_observationsbeginselectraise(abort,'append_only_scenario_capsule_observation');end")
    && normalizeSql(triggers.find(row=>row.name==='scenario_capsule_observations_no_update')?.sql).includes("beforeupdateonscenario_capsule_observationsbeginselectraise(abort,'append_only_scenario_capsule_observation');end");
  if (!valid) throw new Error('invalid_scenario_capsule_observation_schema');
}

function verifyWalletSafeguardObservationSchema(db) {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='wallet_safeguard_observations'").get();
  const expectedColumns = [
    ['evidence_ref', 'TEXT', 0, 1], ['producer_id', 'TEXT', 1, 0], ['target_id', 'TEXT', 1, 0],
    ['observed_at', 'TEXT', 1, 0], ['evidence_json', 'TEXT', 1, 0], ['payload_hash', 'TEXT', 1, 0], ['created_at', 'TEXT', 1, 0]
  ];
  const columns = db.prepare('PRAGMA table_info(wallet_safeguard_observations)').all().map(row => [row.name, row.type, row.notnull, row.pk]);
  const indexes = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND name LIKE 'wallet_safeguard_observations_%' ORDER BY name").all();
  const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'wallet_safeguard_observations_%' ORDER BY name").all();
  const expectedTable = 'createtablewallet_safeguard_observations(evidence_reftextprimarykeycheck(length(evidence_ref)between1and256),producer_idtextnotnullcheck(length(producer_id)between1and128),target_idtextnotnullcheck(length(target_id)between1and128),observed_attextnotnull,evidence_jsontextnotnullcheck(json_valid(evidence_json)),payload_hashtextnotnullcheck(length(payload_hash)=64andpayload_hashnotglob*[^0-9a-f]*),created_attextnotnull)';
  const expectedIndex = 'createuniqueindexwallet_safeguard_observations_identityonwallet_safeguard_observations(producer_id,target_id,evidence_ref)';
  const expectedTriggers = new Map([
    ['wallet_safeguard_observations_no_delete', 'createtriggerwallet_safeguard_observations_no_deletebeforedeleteonwallet_safeguard_observationsbeginselectraise(abort,\'append_only_wallet_safeguard_observation\');end'],
    ['wallet_safeguard_observations_no_update', 'createtriggerwallet_safeguard_observations_no_updatebeforeupdateonwallet_safeguard_observationsbeginselectraise(abort,\'append_only_wallet_safeguard_observation\');end']
  ]);
  const indexColumns = db.prepare('PRAGMA index_info(wallet_safeguard_observations_identity)').all().map(row => row.name);
  const indexUnique = db.prepare('PRAGMA index_list(wallet_safeguard_observations)').all().find(row => row.name === 'wallet_safeguard_observations_identity')?.unique;
  const objects = db.prepare("SELECT name FROM sqlite_master WHERE (type='index' OR type='trigger') AND name LIKE 'wallet_safeguard_observations_%' ORDER BY name").all().map(row => row.name);
  const tableNormalized = normalizeSql(table?.sql);
  const requiredChecks = [
    'check(length(evidence_ref)between1and256)', 'check(length(producer_id)between1and128)',
    'check(length(target_id)between1and128)', 'check(json_valid(evidence_json))',
    "check(length(payload_hash)=64andpayload_hashnotglob'*[^0-9a-f]*')"
  ];
  const valid = tableNormalized.startsWith('createtablewallet_safeguard_observations(')
    && requiredChecks.every(check => tableNormalized.includes(check)) && JSON.stringify(columns) === JSON.stringify(expectedColumns)
    && indexes.length === 1 && normalizeSql(indexes[0]?.sql) === expectedIndex && indexUnique === 1
    && JSON.stringify(indexColumns) === JSON.stringify(['producer_id', 'target_id', 'evidence_ref'])
    && JSON.stringify(objects) === JSON.stringify(['wallet_safeguard_observations_identity', ...expectedTriggers.keys()].sort())
    && triggers.length === 2 && triggers.every(row => normalizeSql(row.sql) === expectedTriggers.get(row.name));
  if (!valid) throw new Error('invalid_wallet_safeguard_observation_schema');
}

function verifyGovernanceControlSchema(db) {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='governance_control_observations'").get();
  const expectedColumns = [['observation_id','TEXT',0,1],['idempotency_key','TEXT',1,0],['payload_hash','TEXT',1,0],['batch_hash','TEXT',1,0],['subject_address','TEXT',1,0],['network','TEXT',1,0],['provider','TEXT',1,0],['generation','TEXT',1,0],['status','TEXT',1,0],['program_id','TEXT',0,0],['multisig_address','TEXT',0,0],['authority_address','TEXT',0,0],['authority_index','INTEGER',0,0],['threshold','INTEGER',0,0],['time_lock_seconds','INTEGER',0,0],['canonical_json','TEXT',1,0],['finalized_slot','INTEGER',1,0],['observed_at','TEXT',1,0],['decoder_family','TEXT',1,0],['decoder_version','TEXT',1,0],['artifact_hash','TEXT',1,0],['created_at','TEXT',1,0]];
  const columns = db.prepare('PRAGMA table_info(governance_control_observations)').all().map(row => [row.name, row.type, row.notnull, row.pk]);
  const indexes = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND name LIKE 'governance_control_%' ORDER BY name").all();
  const identityColumns = db.prepare('PRAGMA index_info(governance_control_identity)').all().map(row => row.name);
  const indexUnique = db.prepare('PRAGMA index_list(governance_control_observations)').all().find(row => row.name === 'governance_control_identity')?.unique;
  const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'governance_control_%' ORDER BY name").all();
  const expectedTable = 'createtablegovernance_control_observations(observation_idtextprimarykey,idempotency_keytextnotnullunique,payload_hashtextnotnullcheck(length(payload_hash)=64andpayload_hashnotglob\'*[^0-9a-f]*\'),batch_hashtextnotnullcheck(length(batch_hash)=64andbatch_hashnotglob\'*[^0-9a-f]*\'),subject_addresstextnotnull,networktextnotnullcheck(networkin(\'mainnet-beta\',\'devnet\',\'testnet\',\'localnet\')),providertextnotnullcheck(provider=\'squads\'),generationtextnotnull,statustextnotnullcheck(statusin(\'verified\',\'unsupported\',\'invalid\')),program_idtext,multisig_addresstext,authority_addresstext,authority_indexintegercheck(authority_indexisnullor(authority_index>=0andauthority_index<=255)),thresholdintegercheck(thresholdisnullor(threshold>0andthreshold<=64)),time_lock_secondsintegercheck(time_lock_secondsisnullor(time_lock_seconds>=0andtime_lock_seconds<=31536000)),canonical_jsontextnotnullcheck(json_valid(canonical_json)),finalized_slotintegernotnullcheck(finalized_slot>=0andfinalized_slot<=9007199254740991),observed_attextnotnull,decoder_familytextnotnull,decoder_versiontextnotnull,artifact_hashtextnotnull,created_attextnotnull)';
  const expectedTriggers = new Map([
    ['governance_control_no_delete', "createtriggergovernance_control_no_deletebeforedeleteongovernance_control_observationsbeginselectraise(abort,'append_only_governance_control');end"],
    ['governance_control_no_update', "createtriggergovernance_control_no_updatebeforeupdateongovernance_control_observationsbeginselectraise(abort,'append_only_governance_control');end"]
  ]);
  const objects = db.prepare("SELECT name FROM sqlite_master WHERE (type='index' OR type='trigger') AND name LIKE 'governance_control_%' ORDER BY name").all().map(row => row.name);
  const valid = normalizeSql(table?.sql) === expectedTable
    && JSON.stringify(columns) === JSON.stringify(expectedColumns)
    && indexes.length === 1
    && normalizeSql(indexes[0]?.sql) === 'createuniqueindexgovernance_control_identityongovernance_control_observations(subject_address,network,program_id,provider,generation,finalized_slot,payload_hash)'
    && indexUnique === 1
    && JSON.stringify(identityColumns) === JSON.stringify(['subject_address','network','program_id','provider','generation','finalized_slot','payload_hash'])
    && JSON.stringify(objects) === JSON.stringify([...expectedTriggers.keys(), 'governance_control_identity'].sort())
    && triggers.length === 2
    && triggers.every(row => normalizeSql(row.sql) === expectedTriggers.get(row.name));
  if (!valid) throw new Error('invalid_governance_control_schema');
}

function verifyVelocityObservationSchema(db) {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='velocity_observations'").get();
  const columns = db.prepare('PRAGMA table_info(velocity_observations)').all().map(row => [row.name, row.type, row.notnull, row.pk]);
  const expected = [['observation_id','TEXT',0,1],['kind','TEXT',1,0],['network','TEXT',1,0],['program_id','TEXT',1,0],['address','TEXT',1,0],['slot','INTEGER',1,0],['owner','TEXT',0,0],['executable','INTEGER',0,0],['data_length','INTEGER',0,0],['data_hash','TEXT',0,0],['observed_at','TEXT',1,0],['provenance','TEXT',1,0],['status','TEXT',1,0],['unknown_reason','TEXT',0,0],['payload_json','TEXT',1,0],['payload_digest','TEXT',1,0]];
  const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'velocity_observations_%' ORDER BY name").all();
  const objects = db.prepare("SELECT name FROM sqlite_master WHERE (type='index' OR type='trigger') AND name LIKE 'velocity_observations_%' ORDER BY name").all().map(row => row.name);
  const sql = normalizeSql(table?.sql);
  const checks = ['check(length(observation_id)between1and128)','check(networkin(\'mainnet-beta\',\'devnet\',\'testnet\',\'localnet\'))','check(slot>=0andslot<=9007199254740991)','check(json_valid(provenance))','check(json_valid(payload_json))','check(length(payload_digest)=64'];
  const triggerSql = new Map([['velocity_observations_no_delete', "createtriggervelocity_observations_no_deletebeforedeleteonvelocity_observationsbeginselectraise(abort,'append_only_velocity_observation');end"],['velocity_observations_no_update', "createtriggervelocity_observations_no_updatebeforeupdateonvelocity_observationsbeginselectraise(abort,'append_only_velocity_observation');end"]]);
  if (!sql.startsWith('createtablevelocity_observations(') || JSON.stringify(columns)!==JSON.stringify(expected) || !checks.every(x=>sql.includes(x)) || JSON.stringify(objects)!==JSON.stringify(['velocity_observations_address_slot','velocity_observations_no_delete','velocity_observations_no_update']) || triggers.length!==2 || triggers.some(x=>normalizeSql(x.sql)!==triggerSql.get(x.name))) throw new Error('invalid_velocity_observation_schema');
}

function verifyVelocityActivitySchema(db) {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='velocity_transactions'").get();
  const columns = db.prepare('PRAGMA table_info(velocity_transactions)').all().map(row => [row.name, row.type, row.notnull, row.pk]);
  const expected = [['transaction_id','TEXT',0,1],['network','TEXT',1,0],['program_id','TEXT',1,0],['signature','TEXT',1,0],['slot','INTEGER',1,0],['block_time','TEXT',0,0],['status','TEXT',1,0],['error_json','TEXT',0,0],['account_keys_json','TEXT',1,0],['instructions_json','TEXT',1,0],['token_deltas_json','TEXT',1,0],['decoder_provenance_json','TEXT',1,0],['payload_json','TEXT',1,0],['payload_digest','TEXT',1,0]];
  const index = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND name='velocity_transactions_slot'").get();
  const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'velocity_transactions_%' ORDER BY name").all();
  const sql = normalizeSql(table?.sql);
  const valid = sql.startsWith('createtablevelocity_transactions(') && JSON.stringify(columns) === JSON.stringify(expected)
    && sql.includes('check(length(transaction_id)between1and128)') && sql.includes('check(slot>=0)')
    && sql.includes('check(json_valid(account_keys_json))') && sql.includes('check(json_valid(instructions_json))')
    && sql.includes('check(json_valid(token_deltas_json))') && sql.includes('check(json_valid(decoder_provenance_json))')
    && sql.includes('check(json_valid(payload_json))') && sql.includes('check(length(payload_digest)=64)')
    && normalizeSql(index?.sql) === 'createindexvelocity_transactions_slotonvelocity_transactions(slotdesc,transaction_iddesc)'
    && triggers.length === 2 && normalizeSql(triggers[0].sql).includes('beforedeleteonvelocity_transactions') && normalizeSql(triggers[0].sql).includes('append_only_velocity_transaction')
    && normalizeSql(triggers[1].sql).includes('beforeupdateonvelocity_transactions') && normalizeSql(triggers[1].sql).includes('append_only_velocity_transaction');
  if (!valid) throw new Error('invalid_velocity_activity_schema');
}

function verifyEvaluationReceiptSchema(db) {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='evaluation_receipts'").get();
  if (!table?.sql?.includes('CHECK(result IN (\'pass\',\'fail\',\'unknown\',\'stale\'))')) throw new Error('invalid_evaluation_receipt_schema');
  const columns = db.prepare('PRAGMA table_info(evaluation_receipts)').all().map(row => row.name);
  const expectedNames = ['receipt_id', 'idempotency_key', 'payload_hash', 'policy_revision', 'rule_id', 'rule_version', 'binding_id', 'target_id', 'evidence_refs_json', 'evaluator_version', 'result', 'evaluated_at', 'observed_at', 'provenance_json', 'created_at'];
  if (JSON.stringify(columns) !== JSON.stringify(expectedNames)) throw new Error('invalid_evaluation_receipt_columns');
  const indexes = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND name LIKE 'evaluation_receipts_%' ORDER BY name").all();
  const expectedIndexes = new Map([
    ['evaluation_receipts_payload_identity', 'createuniqueindexevaluation_receipts_payload_identityonevaluation_receipts(idempotency_key,payload_hash)'],
    ['evaluation_receipts_target_time', 'createindexevaluation_receipts_target_timeonevaluation_receipts(target_id,evaluated_at)']
  ]);
  const indexList = db.prepare('PRAGMA index_list(evaluation_receipts)').all();
  const indexColumns = name => db.prepare(`PRAGMA index_info(${name})`).all().map(row => row.name);
  if (JSON.stringify(indexes.map(row => row.name)) !== JSON.stringify([...expectedIndexes.keys()])
    || indexes.some(row => normalizeSql(row.sql) !== expectedIndexes.get(row.name))
    || indexList.find(row => row.name === 'evaluation_receipts_payload_identity')?.unique !== 1
    || JSON.stringify(indexColumns('evaluation_receipts_payload_identity')) !== JSON.stringify(['idempotency_key', 'payload_hash'])
    || JSON.stringify(indexColumns('evaluation_receipts_target_time')) !== JSON.stringify(['target_id', 'evaluated_at'])) throw new Error('invalid_evaluation_receipt_indexes');
  const scopedObjects = db.prepare("SELECT name FROM sqlite_master WHERE (type='index' OR type='trigger') AND name LIKE 'evaluation_receipts_%' ORDER BY name").all().map(row => row.name);
  if (JSON.stringify(scopedObjects) !== JSON.stringify([...expectedIndexes.keys(), 'evaluation_receipts_no_delete', 'evaluation_receipts_no_update'].sort())) throw new Error('invalid_evaluation_receipt_objects');
  const tableColumns = db.prepare('PRAGMA table_info(evaluation_receipts)').all().map(row => [row.name, row.type, row.notnull, row.pk]);
  const expectedColumns = [['receipt_id','TEXT',0,1],['idempotency_key','TEXT',1,0],['payload_hash','TEXT',1,0],['policy_revision','INTEGER',1,0],['rule_id','TEXT',1,0],['rule_version','INTEGER',1,0],['binding_id','TEXT',1,0],['target_id','TEXT',1,0],['evidence_refs_json','TEXT',1,0],['evaluator_version','TEXT',1,0],['result','TEXT',1,0],['evaluated_at','TEXT',1,0],['observed_at','TEXT',1,0],['provenance_json','TEXT',1,0],['created_at','TEXT',1,0]];
  if (JSON.stringify(tableColumns) !== JSON.stringify(expectedColumns)) throw new Error('invalid_evaluation_receipt_columns');
  const tableSql = normalizeSql(table.sql);
  for (const check of ['check(length(payload_hash)=64andpayload_hashnotglob\'*[^0-9a-f]*\')','check(policy_revision>0andpolicy_revision<=9007199254740991)','check(rule_version>0andrule_version<=9007199254740991)','check(json_valid(evidence_refs_json))','check(json_valid(provenance_json))']) if (!tableSql.includes(check)) throw new Error('invalid_evaluation_receipt_checks');
  const uniqueIdempotency = db.prepare("SELECT 1 FROM pragma_index_list('evaluation_receipts') WHERE name='sqlite_autoindex_evaluation_receipts_1' AND [unique]=1").get();
  if (!uniqueIdempotency) throw new Error('invalid_evaluation_receipt_uniqueness');
  const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'evaluation_receipts_%' ORDER BY name").all();
  const expectedTriggers = {
    evaluation_receipts_no_delete: /BEFORE DELETE ON evaluation_receipts[\s\S]*RAISE\(ABORT[\s\S]*append_only_evaluation_receipt/i,
        evaluation_receipts_no_update: /BEFORE UPDATE ON evaluation_receipts[\s\S]*RAISE\(ABORT[\s\S]*append_only_evaluation_receipt/i,
  };
  if (JSON.stringify(triggers.map(row => row.name)) !== JSON.stringify(['evaluation_receipts_no_delete', 'evaluation_receipts_no_update'])
    || triggers.some(row => !expectedTriggers[row.name]?.test(row.sql))) throw new Error('invalid_evaluation_receipt_triggers');
  if (!table.sql.includes('CHECK(length(payload_hash)=64')) throw new Error('invalid_evaluation_receipt_digest_check');
  if (!table.sql.includes('CHECK(json_valid(evidence_refs_json))') || !table.sql.includes('CHECK(json_valid(provenance_json))')) throw new Error('invalid_evaluation_receipt_json_checks');
}

export function createOperationsDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  for (const migrationUrl of migrationUrls) db.exec(readFileSync(migrationUrl, 'utf8'));
  const evacuationColumns = db.prepare('PRAGMA table_info(evacuation_events)').all();
  if (!evacuationColumns.some((column) => column.name === 'event_id')) {
    db.exec(readFileSync(evacuationIdempotencyMigrationUrl, 'utf8'));
  }
  const receiptTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='evaluation_receipts'").get();
  if (!receiptTable) db.exec(readFileSync(evaluationReceiptsMigrationUrl, 'utf8'));
  const observationsTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wallet_safeguard_observations'").get();
  if (!observationsTable) db.exec(readFileSync(walletSafeguardObservationsMigrationUrl, 'utf8'));
  const governanceControlTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='governance_control_observations'").get();
  if (!governanceControlTable) db.exec(readFileSync(governanceControlMigrationUrl, 'utf8'));
  else migrateLegacyGovernanceControl(db);
  const desiredTargetsTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='desired_targets'").get();
  if (!desiredTargetsTable) db.exec(readFileSync(desiredTargetsMigrationUrl, 'utf8'));
  else {
    for (const [name, type] of [['decoder_family','TEXT'],['decoder_version','TEXT'],['expected_owner','TEXT'],['expected_data_length','INTEGER']]) {
      if (!db.prepare('PRAGMA table_info(desired_targets)').all().some((column) => column.name === name)) db.exec(`ALTER TABLE desired_targets ADD COLUMN ${name} ${type}`);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS reconciliation_history (id INTEGER PRIMARY KEY,indexer_id TEXT NOT NULL,target_id TEXT NOT NULL,status TEXT NOT NULL,cursor_json TEXT,error_json TEXT,observed_at TEXT NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS reconciliation_latest (indexer_id TEXT NOT NULL,target_id TEXT NOT NULL,status TEXT NOT NULL,cursor_json TEXT,error_json TEXT,observed_at TEXT NOT NULL,PRIMARY KEY(indexer_id,target_id))`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS reconciliation_latest (indexer_id TEXT NOT NULL,target_id TEXT NOT NULL,status TEXT NOT NULL,cursor_json TEXT,error_json TEXT,observed_at TEXT NOT NULL,PRIMARY KEY(indexer_id,target_id))`);
  const velocityObservationsTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='velocity_observations'").get();
  if (!velocityObservationsTable) db.exec(readFileSync(velocityObservationsMigrationUrl, 'utf8'));
  const velocityActivityTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='velocity_transactions'").get();
  if (!velocityActivityTable) db.exec(readFileSync(velocityActivityMigrationUrl, 'utf8'));
  const governanceActionsTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='governance_actions'").get();
  if (!governanceActionsTable) db.exec(readFileSync(governanceActionsMigrationUrl, 'utf8'));
  const governanceDetectionsTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='governance_detections'").get();
  if (!governanceDetectionsTable) db.exec(readFileSync(governanceDetectionsMigrationUrl, 'utf8'));
  const scenarioCapsuleObservationsTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scenario_capsule_observations'").get();
  if (!scenarioCapsuleObservationsTable) db.exec(readFileSync(scenarioCapsuleObservationsMigrationUrl, 'utf8'));
  try {
    verifyScenarioCapsuleObservationSchema(db);
    verifyWalletSafeguardObservationSchema(db);
    verifyGovernanceControlSchema(db);
    verifyVelocityObservationSchema(db);
    verifyVelocityActivitySchema(db);
    verifyEvaluationReceiptSchema(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
