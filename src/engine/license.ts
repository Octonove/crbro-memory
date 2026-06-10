// ─── CRBRO License Engine ────────────────────────────────────────
// Server-side license validation against Firestore + device limit + local cache

import type { Brain } from './brain.js';
import type { LicenseInfo } from '../types/index.js';
import * as https from 'https';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';

// Firestore project for license validation
const FIRESTORE_PROJECT = 'synthetica-decks';
const COLLECTION = 'license-checks';
const MAX_DEVICES = 3;

// Cache duration: 7 days in milliseconds
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Valid license key prefix — Synthetica Zero Deck keys
const LICENSE_PREFIX = 'SYNTH-ZERO-';

interface LicenseCache {
  key: string;
  valid: boolean;
  verifiedAt: number;
  deviceId: string;
  status: string;
}

interface FirestoreDoc {
  fields?: {
    status?: { stringValue?: string };
    devices?: { arrayValue?: { values?: Array<{ stringValue?: string }> } };
    maxDevices?: { integerValue?: string };
    [key: string]: any;
  };
}

export class LicenseEngine {
  private cacheFile: string;
  private deviceId: string;

  constructor(private brain: Brain) {
    this.cacheFile = path.join(brain.paths.root, '.license-cache.json');
    this.deviceId = this.generateDeviceFingerprint();
  }

  /**
   * Check if the license is valid (server-verified + device limit).
   * Uses local cache if verified within 7 days.
   */
  async isPremium(): Promise<boolean> {
    const key = await this.resolveKey();
    if (!key) return false;

    // Quick format check before wasting a network call
    if (!this.validateFormat(key)) return false;

    // Check local cache first
    const cached = await this.readCache();
    if (cached && cached.key === key && cached.valid && cached.deviceId === this.deviceId) {
      const age = Date.now() - cached.verifiedAt;
      if (age < CACHE_TTL_MS) {
        return true;
      }
    }

    // Cache expired or missing — verify against Firestore
    const result = await this.verifyAndRegisterDevice(key);

    // Save result to cache
    await this.writeCache({
      key,
      valid: result.valid,
      verifiedAt: Date.now(),
      deviceId: this.deviceId,
      status: result.status,
    });

    return result.valid;
  }

  /**
   * Get the rejection reason (for error messages).
   */
  async getRejectionReason(): Promise<string | null> {
    const key = await this.resolveKey();
    if (!key) return 'no_key';
    if (!this.validateFormat(key)) return 'invalid_format';

    const cached = await this.readCache();
    if (cached && cached.key === key && !cached.valid) {
      return cached.status;
    }
    return null;
  }

  /**
   * Get current license info.
   */
  async getLicenseInfo(): Promise<LicenseInfo> {
    const key = await this.resolveKey();
    const valid = await this.isPremium();
    return this.getInfo(valid ? key : null);
  }

  /**
   * Legacy compatibility.
   */
  async canUse(_toolName: string): Promise<boolean> {
    return this.isPremium();
  }

  // ─── Private ─────────────────────────────────────────────────

  /**
   * Generate a unique device fingerprint.
   * Prefers a persistent UUID token stored on disk to withstand OS/hardware updates.
   * Falls back to a hardware-based fingerprint in case of filesystem restrictions.
   */
  private generateDeviceFingerprint(): string {
    const tokenFile = path.join(this.brain.paths.root, '.device-token');

    // 1. Try to read existing UUID token from local file
    try {
      if (fs.existsSync(tokenFile)) {
        const token = fs.readFileSync(tokenFile, 'utf-8').trim();
        if (token.length >= 10) {
          return token;
        }
      }
    } catch {
      // Fail silently and proceed to fallback/generation
    }

    // 2. Generate hardware fallback fingerprint in case of filesystem issues
    const raw = [
      os.hostname(),
      os.userInfo().username,
      os.platform(),
      os.arch(),
      os.cpus()[0]?.model || 'unknown',
    ].join('|');
    const hardwareFallback = crypto.createHash('sha256').update(raw).digest('hex').substring(0, 16);

    // 3. Try to generate a fresh persistent UUID token and save it to disk
    try {
      const uuid = crypto.randomUUID().replace(/-/g, '').substring(0, 16);

      // Ensure brain root directory exists before writing
      if (!fs.existsSync(this.brain.paths.root)) {
        fs.mkdirSync(this.brain.paths.root, { recursive: true });
      }

      fs.writeFileSync(tokenFile, uuid, 'utf-8');
      return uuid;
    } catch {
      // If writing to disk fails, gracefully fallback to the hardware fingerprint
      return hardwareFallback;
    }
  }

  /**
   * Resolve the license key — env var takes priority over manifest.
   */
  private async resolveKey(): Promise<string | null> {
    const envKey = process.env.CRBRO_LICENSE_KEY || null;
    if (envKey && this.validateFormat(envKey)) return envKey;

    try {
      const manifest = await this.brain.getManifest();
      return manifest.license_key || null;
    } catch {
      return null;
    }
  }

  /**
   * Basic format validation — prefix + length + characters.
   */
  private validateFormat(key: string | null): boolean {
    if (!key) return false;
    if (!key.startsWith(LICENSE_PREFIX)) return false;
    if (key.length < 20) return false;
    const payload = key.substring(LICENSE_PREFIX.length);
    if (!/^[A-Z0-9-]+$/.test(payload)) return false;
    return true;
  }

  /**
   * Verify license AND register this device.
   * Returns { valid, status } where status explains why if invalid.
   */
  private async verifyAndRegisterDevice(key: string): Promise<{ valid: boolean; status: string }> {
    // Step 1: Fetch the license document
    const doc = await this.fetchLicenseDoc(key);
    if (!doc) {
      return { valid: false, status: 'key_not_found' };
    }

    const status = doc.fields?.status?.stringValue;
    if (status !== 'active') {
      return { valid: false, status: 'license_revoked' };
    }

    // Step 2: Check device limit
    const devicesArray = doc.fields?.devices?.arrayValue?.values || [];
    const registeredDevices = devicesArray.map(v => v.stringValue || '');

    // This device is already registered — all good
    if (registeredDevices.includes(this.deviceId)) {
      return { valid: true, status: 'active' };
    }

    // Check if there's room for another device
    if (registeredDevices.length >= MAX_DEVICES) {
      return { valid: false, status: 'device_limit_exceeded' };
    }

    // Step 3: Register this device
    const newDevices = [...registeredDevices, this.deviceId];
    const registered = await this.updateDevices(key, newDevices);

    if (registered) {
      return { valid: true, status: 'active' };
    } else {
      // Registration failed (possibly race condition or rule violation)
      return { valid: false, status: 'device_registration_failed' };
    }
  }

  /**
   * Fetch license document from Firestore REST API.
   */
  private fetchLicenseDoc(key: string): Promise<FirestoreDoc | null> {
    return new Promise((resolve) => {
      const encodedKey = encodeURIComponent(key);
      const url = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT}/databases/(default)/documents/${COLLECTION}/${encodedKey}`;

      const req = https.get(url, { timeout: 10000 }, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            if (res.statusCode === 200) {
              resolve(JSON.parse(data) as FirestoreDoc);
            } else {
              resolve(null);
            }
          } catch {
            resolve(null);
          }
        });
      });

      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
  }

  /**
   * Update the devices array in Firestore via REST API PATCH.
   */
  private updateDevices(key: string, devices: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      const encodedKey = encodeURIComponent(key);
      const url = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT}/databases/(default)/documents/${COLLECTION}/${encodedKey}?updateMask.fieldPaths=devices`;

      const body = JSON.stringify({
        fields: {
          devices: {
            arrayValue: {
              values: devices.map(d => ({ stringValue: d })),
            },
          },
        },
      });

      const parsed = new URL(url);
      const options = {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'PATCH',
        timeout: 10000,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          // 200 = success, 403 = device limit exceeded (security rule violation)
          resolve(res.statusCode === 200);
        });
      });

      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.write(body);
      req.end();
    });
  }

  // ─── Cache management ──────────────────────────────────────────

  private async readCache(): Promise<LicenseCache | null> {
    try {
      if (!fs.existsSync(this.cacheFile)) return null;
      const raw = fs.readFileSync(this.cacheFile, 'utf-8');
      return JSON.parse(raw) as LicenseCache;
    } catch {
      return null;
    }
  }

  private async writeCache(cache: LicenseCache): Promise<void> {
    try {
      fs.writeFileSync(this.cacheFile, JSON.stringify(cache, null, 2), 'utf-8');
    } catch {
      // Silent fail
    }
  }

  private getInfo(key: string | null): LicenseInfo {
    const valid = !!key;
    return {
      valid,
      tier: valid ? 'premium' : 'free',
      features: valid
        ? ['global_map', 'maintenance', 'export', 'import', 'advanced_search']
        : [],
    };
  }
}
