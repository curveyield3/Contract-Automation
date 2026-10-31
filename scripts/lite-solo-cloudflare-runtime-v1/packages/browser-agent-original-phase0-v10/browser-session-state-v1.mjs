import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const schemaVersion = 'curveyield-chatgpt-session-state-v1';
const cipherName = 'aes-256-gcm';
const aad = Buffer.from(schemaVersion, 'utf8');

function decodeKey(encoded) {
  if (!encoded) return null;
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) {
    throw new Error('CHATGPT_SESSION_STATE_KEY_B64 must decode to exactly 32 bytes');
  }
  return key;
}

export function deriveSessionStateKeyB64({ keyB64 = '', bootstrapStateB64 = '' } = {}) {
  if (keyB64) return keyB64;
  if (!bootstrapStateB64) return '';
  return crypto.createHash('sha256')
    .update('curveyield-chatgpt-session-cache-key-v1\0', 'utf8')
    .update(String(bootstrapStateB64), 'utf8')
    .digest('base64');
}

export function validateStorageState(storage) {
  return !!storage
    && typeof storage === 'object'
    && Array.isArray(storage.cookies)
    && Array.isArray(storage.origins);
}

export async function loadEncryptedSessionState({ encryptedSessionPath, keyB64, logger = console }) {
  let key;
  try {
    key = decodeKey(keyB64);
  } catch {
    logger.warn?.('[github-playwright] Session-state encryption key is invalid; falling back to bootstrap state');
    return null;
  }
  if (!key) return null;

  let envelope;
  try {
    envelope = JSON.parse(await fs.readFile(encryptedSessionPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    logger.warn?.('[github-playwright] Cached session state is unreadable; falling back to bootstrap state');
    return null;
  }

  try {
    if (envelope?.schemaVersion !== schemaVersion) throw new Error('unexpected schema');
    if (envelope?.cipher !== cipherName) throw new Error('unexpected cipher');

    const iv = Buffer.from(envelope.iv || '', 'base64');
    const tag = Buffer.from(envelope.tag || '', 'base64');
    const ciphertext = Buffer.from(envelope.ciphertext || '', 'base64');
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
      throw new Error('invalid envelope');
    }

    const decipher = crypto.createDecipheriv(cipherName, key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const storage = JSON.parse(plaintext.toString('utf8'));
    if (!validateStorageState(storage)) throw new Error('invalid storage state');
    return storage;
  } catch {
    logger.warn?.('[github-playwright] Cached session state failed authenticated decryption; falling back to bootstrap state');
    return null;
  }
}

export async function saveEncryptedSessionState({ encryptedSessionPath, keyB64, storage }) {
  const key = decodeKey(keyB64);
  if (!key) return false;
  if (!validateStorageState(storage)) throw new Error('Playwright returned invalid storage state');

  const plaintext = Buffer.from(JSON.stringify(storage), 'utf8');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(cipherName, key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope = {
    schemaVersion,
    cipher: cipherName,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };

  await fs.mkdir(path.dirname(encryptedSessionPath), { recursive: true });
  const tmp = encryptedSessionPath + '.tmp-' + process.pid;
  await fs.writeFile(tmp, JSON.stringify(envelope) + '\n', { mode: 0o600 });
  await fs.rename(tmp, encryptedSessionPath);
  return true;
}
