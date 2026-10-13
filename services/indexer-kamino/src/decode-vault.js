import { createHash } from 'node:crypto';

const ACCOUNT_BYTES = 62_552;
const STRUCT_OFFSET = 8;
const ALLOCATION_OFFSET = STRUCT_OFFSET + 304;
const ALLOCATION_SIZE = 2_160;
const MAX_RESERVES = 25;
const EXPECTED_DISCRIMINATOR = createHash('sha256')
  .update('account:VaultState')
  .digest()
  .subarray(0, 8);
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function encodeBase58(bytes) {
  let value = BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
  let encoded = '';
  while (value > 0n) {
    const remainder = Number(value % 58n);
    encoded = BASE58[remainder] + encoded;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded || '1';
}

function pubkey(data, offset) {
  return encodeBase58(data.subarray(offset, offset + 32));
}

function u64(data, offset) {
  return data.readBigUInt64LE(offset);
}

function u128(data, offset) {
  return u64(data, offset) | (u64(data, offset + 8) << 64n);
}

function text(data, offset, length) {
  const bytes = data.subarray(offset, offset + length);
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? length : end).toString('utf8');
}

export function decodeVaultAccount(account, expectedOwner) {
  if (account.owner !== expectedOwner) {
    throw new Error(`vault owner mismatch: expected ${expectedOwner}, received ${account.owner}`);
  }
  const data = Buffer.from(account.data);
  if (data.length < ACCOUNT_BYTES) {
    throw new RangeError(`expected at least ${ACCOUNT_BYTES} bytes, received ${data.length}`);
  }
  if (!data.subarray(0, 8).equals(EXPECTED_DISCRIMINATOR)) {
    throw new Error('VaultState discriminator mismatch');
  }

  const allocations = [];
  for (let index = 0; index < MAX_RESERVES; index += 1) {
    const offset = ALLOCATION_OFFSET + index * ALLOCATION_SIZE;
    const reserveBytes = data.subarray(offset, offset + 32);
    if (reserveBytes.every((byte) => byte === 0)) continue;
    allocations.push({
      reserve: encodeBase58(reserveBytes),
      ctokenVault: pubkey(data, offset + 32),
      targetAllocationWeight: u64(data, offset + 64),
      tokenAllocationCap: u64(data, offset + 72),
      ctokenVaultBump: u64(data, offset + 80),
      ctokenAllocationCap: u64(data, offset + 88),
      ctokenAllocation: u64(data, offset + 1_104),
      lastInvestSlot: u64(data, offset + 1_112),
      tokenTargetAllocationScaled: u128(data, offset + 1_120)
    });
  }

  return {
    decoderVersion: 'kvault-interface@1d146d7087a76edbbadc14d848ae14295c0745a4',
    vaultAdminAuthority: pubkey(data, STRUCT_OFFSET),
    baseVaultAuthority: pubkey(data, STRUCT_OFFSET + 32),
    tokenMint: pubkey(data, STRUCT_OFFSET + 72),
    tokenMintDecimals: u64(data, STRUCT_OFFSET + 104),
    tokenVault: pubkey(data, STRUCT_OFFSET + 112),
    tokenProgram: pubkey(data, STRUCT_OFFSET + 144),
    sharesMint: pubkey(data, STRUCT_OFFSET + 176),
    sharesMintDecimals: u64(data, STRUCT_OFFSET + 208),
    tokenAvailable: u64(data, STRUCT_OFFSET + 216),
    sharesIssued: u64(data, STRUCT_OFFSET + 224),
    performanceFeeBps: u64(data, STRUCT_OFFSET + 248),
    managementFeeBps: u64(data, STRUCT_OFFSET + 256),
    previousAumScaled: u128(data, STRUCT_OFFSET + 272),
    pendingFeesScaled: u128(data, STRUCT_OFFSET + 288),
    pendingAdmin: pubkey(data, STRUCT_OFFSET + 58_440),
    name: text(data, STRUCT_OFFSET + 58_520, 40),
    allocationAdmin: pubkey(data, STRUCT_OFFSET + 58_640),
    allocations
  };
}
