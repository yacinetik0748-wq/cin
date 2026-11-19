import type { Env } from './types.ts';

export type SecureStorageMode = 'env_master_key' | 'server_key_file' | 'unavailable';
export type FishConnectionStatus = 'connected' | 'not_connected' | 'error';

export interface SecureStorageStatus {
  available: boolean;
  mode: SecureStorageMode;
  detail: string;
}

export interface FishAudioSettingsSummary {
  configured: boolean;
  source: 'encrypted_store' | 'env' | 'none';
  maskedKey: string | null;
  secureStorageAvailable: boolean;
  secureStorageMode: SecureStorageMode;
  secureStorageDetail: string;
  connectionStatus: FishConnectionStatus;
  lastCheckedAt: string | null;
  lastError: string | null;
}

interface EncryptedSecretRecord {
  version: 1 | 2;
  ciphertext: string;
  last4: string;
  updatedAt: string;
}

interface FishConnectionMeta {
  connectionStatus: FishConnectionStatus;
  lastCheckedAt?: string | null;
  lastError?: string | null;
}

const ENCRYPTED_FISH_KEY_SETTING = 'encrypted_fish_api_key';
const FISH_CONNECTION_META_SETTING = 'fish_connection_meta';
const DB_MASTER_KEY_SETTING = 'cf_master_secret_hex';

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy.buffer;
}

export function maskSecretTail(last4: string): string {
  const clean = (last4 || '').slice(-4);
  if (!clean) return '••••••••••••';
  return `••••••••••••${clean}`;
}

export function maskApiKey(rawKey: string): string {
  const trimmed = rawKey.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 4) return '••••••••';
  return maskSecretTail(trimmed.slice(-4));
}

async function getSetting(db: D1Database | undefined, key: string): Promise<string | null> {
  if (!db) return null;
  const row = await db
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(key, value, new Date().toISOString())
    .run();
}

async function resolveMasterKey(
  env: Env,
  createIfMissing: boolean
): Promise<{ key: CryptoKey | null; status: SecureStorageStatus }> {
  const envSecret =
    env.SECRETS_ENCRYPTION_KEY?.trim() || env.APP_SECRET?.trim() || '';

  if (envSecret.length >= 8) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(envSecret));
    const key = await crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]);
    return {
      key,
      status: {
        available: true,
        mode: 'env_master_key',
        detail: 'AES-256-GCM encryption enabled via SECRETS_ENCRYPTION_KEY.',
      },
    };
  }

  if (!env.DB) {
    return {
      key: null,
      status: {
        available: false,
        mode: 'unavailable',
        detail:
          'Cloudflare D1 database binding (DB) and SECRETS_ENCRYPTION_KEY are not configured.',
      },
    };
  }

  let hex = await getSetting(env.DB, DB_MASTER_KEY_SETTING);
  if (!hex || hex.length !== 64) {
    if (!createIfMissing) {
      return {
        key: null,
        status: {
          available: true,
          mode: 'server_key_file',
          detail:
            'Cloudflare D1 encrypted secret store ready (set SECRETS_ENCRYPTION_KEY for dedicated key wrapping).',
        },
      };
    }
    const raw = new Uint8Array(32);
    crypto.getRandomValues(raw);
    hex = Array.from(raw)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    await setSetting(env.DB, DB_MASTER_KEY_SETTING, hex);
  }

  const keyBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    keyBytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }

  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
  return {
    key,
    status: {
      available: true,
      mode: 'server_key_file',
      detail: 'AES-256-GCM D1 secret store active (set SECRETS_ENCRYPTION_KEY for extra hardening).',
    },
  };
}

async function encryptSecret(env: Env, plaintext: string): Promise<EncryptedSecretRecord> {
  const { key, status } = await resolveMasterKey(env, true);
  if (!key || !status.available) {
    const err = new Error(status.detail) as Error & { statusCode?: number };
    err.statusCode = 503;
    throw err;
  }

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encryptedBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext)
  );

  return {
    version: 2,
    ciphertext: `v2:${toBase64(iv)}:${toBase64(new Uint8Array(encryptedBuf))}`,
    last4: plaintext.slice(-4),
    updatedAt: new Date().toISOString(),
  };
}

async function decryptSecret(env: Env, record: EncryptedSecretRecord): Promise<string | null> {
  const { key } = await resolveMasterKey(env, false);
  if (!key) return null;

  const parts = record.ciphertext.split(':');
  try {
    if (parts[0] === 'v2' && parts.length === 3) {
      const iv = fromBase64(parts[1]);
      const data = fromBase64(parts[2]);
      const plainBuf = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: toArrayBuffer(iv) },
        key,
        toArrayBuffer(data)
      );
      return new TextDecoder().decode(plainBuf).trim() || null;
    }

    // Legacy v1 format compatibility (v1:iv:tag:ciphertext) -> WebCrypto expects ciphertext + tag concatenated
    if (parts[0] === 'v1' && parts.length === 4) {
      const iv = fromBase64(parts[1]);
      const tag = fromBase64(parts[2]);
      const cipher = fromBase64(parts[3]);
      const combined = new Uint8Array(cipher.length + tag.length);
      combined.set(cipher, 0);
      combined.set(tag, cipher.length);
      const plainBuf = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: toArrayBuffer(iv) },
        key,
        toArrayBuffer(combined)
      );
      return new TextDecoder().decode(plainBuf).trim() || null;
    }
  } catch {
    return null;
  }
  return null;
}

async function readEncryptedFishRecord(env: Env): Promise<EncryptedSecretRecord | null> {
  const raw = await getSetting(env.DB, ENCRYPTED_FISH_KEY_SETTING);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as EncryptedSecretRecord;
    if (parsed && (parsed.version === 1 || parsed.version === 2) && typeof parsed.ciphertext === 'string') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function readEnvFishApiKey(env: Env): string | null {
  const key = env.FISH_API_KEY?.trim() || '';
  if (!key || key === 'MY_FISH_API_KEY') return null;
  return key;
}

export async function resolveFishApiKey(env: Env): Promise<{
  apiKey: string | null;
  source: 'encrypted_store' | 'env' | 'none';
}> {
  const record = await readEncryptedFishRecord(env);
  if (record) {
    const decrypted = await decryptSecret(env, record);
    if (decrypted) {
      return { apiKey: decrypted, source: 'encrypted_store' };
    }
  }
  const envKey = readEnvFishApiKey(env);
  if (envKey) {
    return { apiKey: envKey, source: 'env' };
  }
  return { apiKey: null, source: 'none' };
}

export async function setFishConnectionMeta(env: Env, meta: FishConnectionMeta): Promise<void> {
  if (!env.DB) return;
  await setSetting(env.DB, FISH_CONNECTION_META_SETTING, JSON.stringify(meta));
}

async function getFishConnectionMeta(env: Env): Promise<FishConnectionMeta> {
  const raw = await getSetting(env.DB, FISH_CONNECTION_META_SETTING);
  if (!raw) return { connectionStatus: 'not_connected', lastCheckedAt: null, lastError: null };
  try {
    const parsed = JSON.parse(raw) as FishConnectionMeta;
    return {
      connectionStatus:
        parsed.connectionStatus === 'connected' ||
        parsed.connectionStatus === 'error' ||
        parsed.connectionStatus === 'not_connected'
          ? parsed.connectionStatus
          : 'not_connected',
      lastCheckedAt: parsed.lastCheckedAt || null,
      lastError: parsed.lastError || null,
    };
  } catch {
    return { connectionStatus: 'not_connected', lastCheckedAt: null, lastError: null };
  }
}

export async function getFishSettingsSummary(env: Env): Promise<FishAudioSettingsSummary> {
  const { status: storage } = await resolveMasterKey(env, false);
  const resolved = await resolveFishApiKey(env);
  const record = await readEncryptedFishRecord(env);
  const meta = await getFishConnectionMeta(env);

  let maskedKey: string | null = null;
  if (resolved.source === 'encrypted_store' && record) {
    maskedKey = maskSecretTail(record.last4);
  } else if (resolved.source === 'env' && resolved.apiKey) {
    maskedKey = maskApiKey(resolved.apiKey);
  }

  let connectionStatus: FishConnectionStatus = meta.connectionStatus;
  if (!resolved.apiKey && connectionStatus === 'connected') {
    connectionStatus = 'not_connected';
  }

  return {
    configured: Boolean(resolved.apiKey),
    source: resolved.source,
    maskedKey,
    secureStorageAvailable: storage.available,
    secureStorageMode: storage.mode,
    secureStorageDetail: storage.detail,
    connectionStatus,
    lastCheckedAt: meta.lastCheckedAt || null,
    lastError: meta.lastError || null,
  };
}

export async function saveFishApiKey(
  env: Env,
  rawKey: string
): Promise<FishAudioSettingsSummary> {
  const cleaned = (rawKey || '').trim();
  if (!cleaned || cleaned === 'MY_FISH_API_KEY') {
    const err = new Error('Please enter a valid Fish Audio API key.') as Error & {
      statusCode?: number;
    };
    err.statusCode = 400;
    throw err;
  }
  if (!env.DB) {
    const err = new Error('Cloudflare D1 database binding (DB) is required to save secrets.') as Error & {
      statusCode?: number;
    };
    err.statusCode = 503;
    throw err;
  }

  const encryptedRecord = await encryptSecret(env, cleaned);
  await setSetting(env.DB, ENCRYPTED_FISH_KEY_SETTING, JSON.stringify(encryptedRecord));
  await setFishConnectionMeta(env, {
    connectionStatus: 'not_connected',
    lastCheckedAt: null,
    lastError: null,
  });
  return getFishSettingsSummary(env);
}

export async function deleteSavedFishApiKey(env: Env): Promise<FishAudioSettingsSummary> {
  if (env.DB) {
    await env.DB
      .prepare('DELETE FROM app_settings WHERE key = ?')
      .bind(ENCRYPTED_FISH_KEY_SETTING)
      .run();
    await setFishConnectionMeta(env, {
      connectionStatus: 'not_connected',
      lastCheckedAt: null,
      lastError: null,
    });
  }
  return getFishSettingsSummary(env);
}
