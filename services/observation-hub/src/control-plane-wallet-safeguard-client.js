const IDENTITY_FIELDS = ['policy', 'enrollmentId', 'bindingId', 'ruleId', 'ruleVersion'];

function validIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.keys(value).sort().join('\0') !== IDENTITY_FIELDS.slice().sort().join('\0')) return false;
  if (!value.policy || typeof value.policy !== 'object' || Array.isArray(value.policy)) return false;
  return [value.enrollmentId, value.bindingId, value.ruleId].every(item => typeof item === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item))
    && Number.isSafeInteger(value.ruleVersion) && value.ruleVersion >= 1;
}

export function createControlPlaneWalletSafeguardResolver({ url, token, timeoutMs = 1000 }) {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new TypeError('url must be an HTTP URL');
  if (typeof token !== 'string' || token.length < 32) throw new TypeError('token must contain at least 32 characters');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be positive');
  return async function resolveWalletSafeguardIdentity(identityRef) {
    if (typeof identityRef !== 'string' || identityRef.length < 1 || identityRef.length > 256 || /[\u0000-\u001f\u007f]/.test(identityRef)) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ identityRef }), signal: controller.signal });
      if (response.status !== 200 || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return null;
      let body; try { body = await response.json(); } catch { return null; }
      return validIdentity(body) ? body : null;
    } catch { return null; } finally { clearTimeout(timer); }
  };
}
