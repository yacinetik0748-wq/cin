import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { STORAGE_DIR, db, getAppSetting, setAppSetting } from '../db.ts';

const ENCRYPTED_FISH_KEY_SETTING = 'encrypted_fish_api_key';
const FISH_CONNECTION_META_SETTING = 'fish_connection_meta';
const MASTER_KEY_PATH = path.join(STORAGE_DIR, '.master.key');

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
  version: 1;
  ciphertext: string;
  last4: string;
  updatedAt: string;
}

interface FishConnectionMeta {
  connectionStatus: FishConnectionStatus;
  lastCheckedAt?: string | null;
  lastError?: string | null;
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

function getEnvMasterSecret(): string | null {
  const candidate =
    process.env.SECRETS_ENCRYPTION_KEY?.trim() ||
    process.env.APP_SECRET?.trim() ||
    '';
  if (candidate.length >= 8) {
    return candidate;
  }
  return null;
}

function resolveMasterKeyBytes(): {
  key: Buffer | null;
  status: SecureStorageStatus;
} {
  const envSecret = getEnvMasterSecret();
  if (envSecret) {
    return {
      key: crypto.createHash('sha256').update(envSecret, 'utf8').digest(),
      status: {
        available: true,
        mode: 'env_master_key',
        detail: 'AES-256-GCM encryption enabled via SECRETS_ENCRYPTION_KEY.',
      },
    };
  }

  try {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
    if (fs.existsSync(MASTER_KEY_PATH)) {
      const hex = fs.readFileSync(MASTER_KEY_PATH, 'utf8').trim();
      const buf = Buffer.from(hex, 'hex');
      if (buf.length === 32) {
        return {
          key: buf,
          status: {
            available: true,
            mode: 'server_key_file',
            detail: 'AES-256-GCM encrypted backend secret store active.',
          },
        };
      }
    }

    const generated = crypto.randomBytes(32);
    fs.writeFileSync(MASTER_KEY_PATH, generated.toString('hex'), {
      encoding: 'utf8',
      mode: 0o600,
    });
    try {
      fs.chmodSync(MASTER_KEY_PATH, 0o600);
    } catch {
      // ignore chmod failures on filesystems without POSIX permissions
    }

    return {
      key: generated,
      status: {
        available: true,
        mode: 'server_key_file',
        detail: 'AES-256-GCM encrypted backend secret store active.',
      },
    };
  } catch {
    return {
      key: null,
      status: {
        available: false,
        mode: 'unavailable',
        detail:
          'Backend encrypted secret storage is unavailable. Set SECRETS_ENCRYPTION_KEY (8+ chars) or FISH_API_KEY in server environment secrets, or ensure STORAGE_DIR is writable.',
      },
    };
  }
}

export function getSecureStorageStatus(): SecureStorageStatus {
  return resolveMasterKeyBytes().status;
}

function encryptSecretValue(plaintext: string): EncryptedSecretRecord {
  const { key, status } = resolveMasterKeyBytes();
  if (!key || !status.available) {
    const err = new Error(status.detail) as Error & { statusCode?: number };
    err.statusCode = 503;
    throw err;
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;

  return {
    version: 1,
    ciphertext: payload,
    last4: plaintext.slice(-4),
    updatedAt: new Date().toISOString(),
  };
}

function decryptSecretValue(record: EncryptedSecretRecord): string | null {
  const { key } = resolveMasterKeyBytes();
  if (!key) return null;

  const parts = record.ciphertext.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;

  try {
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const encrypted = Buffer.from(parts[3], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8').trim() || null;
  } catch {
    return null;
  }
}

function readEncryptedFishRecord(): EncryptedSecretRecord | null {
  const raw = getAppSetting(ENCRYPTED_FISH_KEY_SETTING, '');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as EncryptedSecretRecord;
    if (parsed && parsed.version === 1 && typeof parsed.ciphertext === 'string') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function readEnvFishApiKey(): string | null {
  const envKey = process.env.FISH_API_KEY?.trim() || '';
  if (!envKey || envKey === 'MY_FISH_API_KEY') return null;
  return envKey;
}

export function resolveFishApiKey(): {
  apiKey: string | null;
  source: 'encrypted_store' | 'env' | 'none';
} {
  const record = readEncryptedFishRecord();
  if (record) {
    const decrypted = decryptSecretValue(record);
    if (decrypted) {
      return { apiKey: decrypted, source: 'encrypted_store' };
    }
  }
  const envKey = readEnvFishApiKey();
  if (envKey) {
    return { apiKey: envKey, source: 'env' };
  }
  return { apiKey: null, source: 'none' };
}

export function saveFishApiKey(rawKey: string): FishAudioSettingsSummary {
  const cleaned = rawKey.trim();
  if (!cleaned || cleaned === 'MY_FISH_API_KEY') {
    const err = new Error('Please enter a valid Fish Audio API key.') as Error & {
      statusCode?: number;
    };
    err.statusCode = 400;
    throw err;
  }

  const encryptedRecord = encryptSecretValue(cleaned);
  setAppSetting(ENCRYPTED_FISH_KEY_SETTING, JSON.stringify(encryptedRecord));

  // Clear previous error status until connection test runs or succeeds
  setFishConnectionMeta({
    connectionStatus: 'not_connected',
    lastCheckedAt: null,
    lastError: null,
  });

  return getFishSettingsSummary();
}

export function deleteSavedFishApiKey(): FishAudioSettingsSummary {
  db.prepare('DELETE FROM app_settings WHERE key = ?').run(ENCRYPTED_FISH_KEY_SETTING);
  setFishConnectionMeta({
    connectionStatus: 'not_connected',
    lastCheckedAt: null,
    lastError: null,
  });
  return getFishSettingsSummary();
}

export function setFishConnectionMeta(meta: FishConnectionMeta): void {
  setAppSetting(FISH_CONNECTION_META_SETTING, JSON.stringify(meta));
}

function getFishConnectionMeta(): FishConnectionMeta {
  const raw = getAppSetting(FISH_CONNECTION_META_SETTING, '');
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

export function getFishSettingsSummary(): FishAudioSettingsSummary {
  const storage = getSecureStorageStatus();
  const resolved = resolveFishApiKey();
  const record = readEncryptedFishRecord();
  const meta = getFishConnectionMeta();

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
