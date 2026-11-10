import { createHash } from 'node:crypto';

function normalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON numbers must be finite');
    return Object.is(value,-0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value !== 'object') throw new TypeError('canonical JSON supports JSON-compatible values only');
  const out={};
  for (const key of Object.keys(value).sort()) {
    const entry=value[key];
    if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol' || typeof entry === 'bigint') throw new TypeError(`unsupported canonical JSON value at ${key}`);
    out[key]=normalize(entry);
  }
  return out;
}

export function canonicalJsonV1(value){ return JSON.stringify(normalize(value)); }
export function sha256HexV1(value){ return createHash('sha256').update(value).digest('hex'); }
export function digestCanonicalV1(value){ return sha256HexV1(canonicalJsonV1(value)); }
