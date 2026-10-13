const INPUT_FIELDS = new Set(['policyRevision', 'positions', 'bindings', 'receipts']);
const POSITION_FIELDS = new Set(['protocol', 'adapterVersion', 'wallet', 'targetId', 'kind', 'asset', 'amount', 'valueUsd', 'source']);
const BINDING_FIELDS = new Set(['bindingId', 'targetId', 'ruleId', 'ruleVersion', 'display']);
const DISPLAY_FIELDS = new Set(['name', 'description']);
const RECEIPT_FIELDS = new Set(['receiptId', 'idempotencyKey', 'policyRevision', 'ruleId', 'ruleVersion', 'bindingId', 'targetId', 'evidenceRefs', 'evaluatorVersion', 'result', 'evaluatedAt', 'observedAt', 'provenance']);
const RESULTS = new Set(['pass', 'fail', 'unknown', 'stale']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function object(value, name) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`); return value; }
function fields(value, allowed, name) { for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`unknown field: ${name}.${key}`); }
function id(value, name) { if (typeof value !== 'string' || !ID.test(value)) throw new TypeError(`${name} is invalid`); return value; }
function positive(value, name) { if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`); return value; }
function timestamp(value, name) { if (typeof value !== 'string' || !ISO.test(value) || new Date(value).toISOString() !== value) throw new TypeError(`${name} must be canonical ISO date`); return value; }
function boundedText(value, name, max = 256) { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError(`${name} is invalid`); return value; }

function validatePosition(position, index) {
  object(position, `positions[${index}]`); fields(position, POSITION_FIELDS, `positions[${index}]`);
  for (const key of ['protocol', 'wallet', 'targetId', 'kind', 'asset', 'source']) boundedText(position[key], `positions[${index}].${key}`);
  positive(position.adapterVersion, `positions[${index}].adapterVersion`);
  boundedText(position.amount, `positions[${index}].amount`); boundedText(position.valueUsd, `positions[${index}].valueUsd`);
  return Object.freeze({ ...position });
}
function validateBinding(binding, index, seen) {
  object(binding, `bindings[${index}]`); fields(binding, BINDING_FIELDS, `bindings[${index}]`);
  const bindingId = id(binding.bindingId, `bindings[${index}].bindingId`); if (seen.has(bindingId)) throw new RangeError(`duplicate bindingId: ${bindingId}`); seen.add(bindingId);
  const display = object(binding.display, `bindings[${index}].display`); fields(display, DISPLAY_FIELDS, `bindings[${index}].display`);
  const cleanDisplay = { name: boundedText(display.name, 'display.name') }; if (display.description !== undefined) cleanDisplay.description = boundedText(display.description, 'display.description');
  return Object.freeze({ bindingId, targetId: id(binding.targetId, 'binding.targetId'), ruleId: id(binding.ruleId, 'binding.ruleId'), ruleVersion: positive(binding.ruleVersion, 'binding.ruleVersion'), display: Object.freeze(cleanDisplay) });
}
function validateReceipt(receipt, index) {
  object(receipt, `receipts[${index}]`); fields(receipt, RECEIPT_FIELDS, `receipts[${index}]`);
  for (const key of ['receiptId', 'idempotencyKey', 'ruleId', 'bindingId', 'targetId', 'evaluatorVersion']) id(receipt[key], `receipts[${index}].${key}`);
  positive(receipt.policyRevision, `receipts[${index}].policyRevision`); positive(receipt.ruleVersion, `receipts[${index}].ruleVersion`);
  if (!Array.isArray(receipt.evidenceRefs) || receipt.evidenceRefs.length < 1) throw new TypeError('evidenceRefs must be a non-empty array');
  receipt.evidenceRefs.forEach((item, i) => id(item, `evidenceRefs[${i}]`));
  if (!RESULTS.has(receipt.result)) throw new TypeError('receipt.result is unsupported'); timestamp(receipt.evaluatedAt, 'evaluatedAt'); timestamp(receipt.observedAt, 'observedAt'); object(receipt.provenance, 'provenance');
  return receipt;
}

export function projectExpectedSafeguards(input) {
  object(input, 'input'); fields(input, INPUT_FIELDS, 'input'); positive(input.policyRevision, 'policyRevision');
  if (!Array.isArray(input.positions) || !Array.isArray(input.bindings) || !Array.isArray(input.receipts)) throw new TypeError('positions, bindings, and receipts must be arrays');
  const positions = input.positions.map(validatePosition); const bindings = input.bindings.map((b, i, all) => validateBinding(b, i, new Set(all.slice(0, i).map(x => x.bindingId))));
  const receipts = input.receipts.map(validateReceipt);
  const grouped = new Map();
  for (const receipt of receipts) {
    if (receipt.policyRevision !== input.policyRevision) continue;
    const key = `${receipt.policyRevision}\u0000${receipt.bindingId}\u0000${receipt.targetId}\u0000${receipt.ruleId}\u0000${receipt.ruleVersion}`;
    const matches = grouped.get(key) ?? []; matches.push(receipt); grouped.set(key, matches);
  }
  const chosen = new Map();
  for (const [key, matches] of grouped) {
    matches.sort((a, b) => Date.parse(b.evaluatedAt) - Date.parse(a.evaluatedAt) || a.receiptId.localeCompare(b.receiptId));
    if (matches.length > 1 && matches[0].evaluatedAt === matches[1].evaluatedAt && matches[0].receiptId === matches[1].receiptId) throw new RangeError('ambiguous matching receipts');
    chosen.set(key, matches[0]);
  }
  const output = positions.map(position => Object.freeze({ ...position, safeguards: Object.freeze(bindings.filter(binding => binding.targetId === position.targetId).map(binding => {
    const receipt = chosen.get(`${input.policyRevision}\u0000${binding.bindingId}\u0000${binding.targetId}\u0000${binding.ruleId}\u0000${binding.ruleVersion}`);
    if (!receipt) return { ...binding, result: 'unknown', reason: 'missing_receipt' };
    return { ...binding, result: receipt.result, evidenceRefs: [...receipt.evidenceRefs], observedAt: receipt.observedAt, evaluatedAt: receipt.evaluatedAt, provenance: structuredClone(receipt.provenance) };
  })) }));
  return Object.freeze({ policyRevision: input.policyRevision, positions: Object.freeze(output) });
}
