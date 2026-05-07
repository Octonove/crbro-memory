// ─── CRBRO License Engine ────────────────────────────────────────
// Server-side license validation against Firestore + local cache

import { readJSON, writeJSON } from '../utils/fs.js';
import type { Brain } from './brain.js';
import type { LicenseInfo } from '../types/index.js';
import * as https from 'https';
import * as path from 'path';
import * as fs from 'fs';

// Firestore project for license validation
const FIRESTORE_PROJECT = 'synthetica-decks';
const COLLECTION = 'license-checks';

// Cache duration: 7 days in milliseconds
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Valid license key prefix — Synthetica Zero Deck keys
const LICENSE_PREFIX = 'SYNTH-ZERO-';

interface LicenseCache {
  key: string;
  valid: boolean;
  verifiedAt: number; // timestamp
  status: string;
}

export class LicenseEngine {
  private cacheFile: string;

  constructor(private brain: Brain) {
    this.cacheFile = path.join(brain.paths.root, '.license-cache.json');
  }

  /**
   * Check if the license is valid (server-verified).
   * Uses local cache if verified within 7 days.
   */
  async isPremium(): Promise<boolean> {
    const key = await this.resolveKey();
    if (!key) return false;

    // Quick format check before wasting a network call
    if (!this.validateFormat(key)) return false;

    // Check local cache first
    const cached = await this.readCache();
    if (cached && cached.key === key && cached.valid) {
      const age = Date.now() - cached.verifiedAt;
      if (age < CACHE_TTL_MS) {
        return true; // Cache still valid
      }
    }

    // Cache expired or missing — verify against Firestore
    const serverResult = await this.verifyWithServer(key);
    
    // Save result to cache
    await this.writeCache({
      key,
      valid: serverResult,
      verifiedAt: Date.now(),
      status: serverResult ? 'active' : 'invalid',
    });

    return serverResult;
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
   * Legacy compatibility — canUse now just checks isPremium for everything.
   */
  async canUse(_toolName: string): Promise<boolean> {
    return this.isPremium();
  }

  // ─── Private ─────────────────────────────────────────────────

  /**
   * Resolve the license key — env var takes priority over manifest.
   */
  private async resolveKey(): Promise<string | null> {
    // 1. Check environment variable first (set in mcp_config.json env block)
    const envKey = process.env.CRBRO_LICENSE_KEY || null;
    if (envKey && this.validateFormat(envKey)) return envKey;

    // 2. Fall back to manifest (set via CLI activate)
    const manifest = await this.brain.getManifest();
    return manifest.license_key || null;
  }

  /**
   * Basic format validation — prefix + length + characters.
   * Does NOT verify the key is real. Use verifyWithServer() for that.
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
   * Verify license key against Firestore REST API.
   * Checks if document exists in license-checks/{key} with status 'active'.
   */
  private verifyWithServer(key: string): Promise<boolean> {
    return new Promise((resolve) => {
      const encodedKey = encodeURIComponent(key);
      const url = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT}/databases/(default)/documents/${COLLECTION}/${encodedKey}`;

      const req = https.get(url, { timeout: 10000 }, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            if (res.statusCode === 200) {
              const doc = JSON.parse(data);
              // Check that the document has status = 'active'
              const status = doc?.fields?.status?.stringValue;
              resolve(status === 'active');
            } else if (res.statusCode === 404) {
              // Document doesn't exist — key is not valid
              resolve(false);
            } else {
              // Server error or unexpected response — fail closed
              resolve(false);
            }
          } catch {
            resolve(false);
          }
        });
      });

      req.on('error', () => {
        // Network error — check cache as fallback
        this.readCache().then((cached) => {
          if (cached && cached.key === key && cached.valid) {
            resolve(true); // Trust cache if offline
          } else {
            resolve(false);
          }
        }).catch(() => resolve(false));
      });

      req.on('timeout', () => {
        req.destroy();
        // Timeout — same fallback as network error
        this.readCache().then((cached) => {
          if (cached && cached.key === key && cached.valid) {
            resolve(true);
          } else {
            resolve(false);
          }
        }).catch(() => resolve(false));
      });
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
      // Silent fail — cache is a convenience, not critical
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
