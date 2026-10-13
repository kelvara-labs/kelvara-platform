const FIELDS = ['fingerprint','network','protocol','wallet','action','lifecycle','readiness','createdAt','updatedAt'];
const MAX_PAGE = 100; const MAX_ENTRIES = 1000; const MAX_BYTES = 1_000_000; const MAX_IDENTITY = 256; const MAX_PAGES = 10;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LIFECYCLE = new Set(['active']);
const READINESS = new Set(['VALID_PENDING','VALIDATED','INVALID','UNKNOWN']);
function fail() { throw new Error('permit vault response invalid'); }
function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.entries) || Object.keys(body).some(k => !['entries','nextCursor'].includes(k))) fail();
  if (body.entries.length > MAX_PAGE) fail();
  return body.entries.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).length !== FIELDS.length || FIELDS.some(k => typeof entry[k] !== 'string' || entry[k].trim()==='')) fail();
    if (!FINGERPRINT.test(entry.fingerprint) || !LIFECYCLE.has(entry.lifecycle) || !READINESS.has(entry.readiness)) fail();
    for (const key of ['network','protocol','wallet','action']) if (entry[key].length > MAX_IDENTITY) fail();
    for (const key of ['createdAt','updatedAt']) { if (!UTC.test(entry[key]) || Number.isNaN(Date.parse(entry[key])) || new Date(entry[key]).toISOString() !== entry[key]) fail(); }
    return Object.freeze({ ...entry });
  });
}
export function createPermitVaultClient({ baseUrl, readToken, fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  if (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl) || typeof readToken !== 'string' || readToken.length < 32) throw new TypeError('permit vault configuration invalid');
  const root = baseUrl.replace(/\/$/, '');
  return { async listEnrollments() {
    const all=[]; const seenCursors=new Set(); const byFingerprint=new Map(); let cursor; let pages=0;
    for (;;) {
      if (cursor !== undefined) { if (seenCursors.has(cursor)) throw new Error('permit vault cursor loop'); seenCursors.add(cursor); }
      if (++pages > MAX_PAGES) throw new Error('permit vault page limit');
      const url = `${root}/permits/enrollments?pageSize=${MAX_PAGE}${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
      const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(), timeoutMs);
      let response;
      try { response=await fetchImpl(url,{method:'GET',headers:{authorization:`Bearer ${readToken}`,accept:'application/json'},signal:controller.signal}); }
      catch { throw new Error('permit vault unavailable'); } finally { clearTimeout(timer); }
      if (!response?.ok) throw new Error('permit vault unavailable');
      const text=await response.text(); if (Buffer.byteLength(text)>MAX_BYTES) fail();
      let body; try { body=JSON.parse(text); } catch { fail(); }
      for (const entry of validate(body)) {
        const prior=byFingerprint.get(entry.fingerprint);
        if (prior && JSON.stringify(prior) !== JSON.stringify(entry)) fail();
        if (!prior) { byFingerprint.set(entry.fingerprint, entry); all.push(entry); }
      }
      if (all.length > MAX_ENTRIES) fail();
      cursor=body.nextCursor;
      if (cursor === undefined) return all;
      if (typeof cursor !== 'string' || cursor.length===0 || cursor.length>512) fail();
    }
  }};
}
