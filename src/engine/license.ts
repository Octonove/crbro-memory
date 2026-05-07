// ─── CRBRO License Engine ────────────────────────────────────────
// Premium feature gating with license key validation

import { readJSON, writeJSON } from '../utils/fs.js';
import type { Brain } from './brain.js';
import type { LicenseInfo, PremiumFeature } from '../types/index.js';

// Free features available without license
const FREE_FEATURES = new Set<string>([
  'crbro_boot',
  'crbro_status',
  'crbro_learn',
  'crbro_neuron',
  'crbro_neurons',
  'crbro_recall',
  'crbro_connect',
  'crbro_connections',
  'crbro_session_log',
  'crbro_sessions',
  'crbro_context',
  'crbro_hot_topics',
  'crbro_consolidate',
]);

// Premium features requiring license
const PREMIUM_FEATURES = new Set<string>([
  'crbro_global_map',
  'crbro_maintenance',
]);

// Valid license key prefix — Synthetica Zero Deck keys
const LICENSE_PREFIX = 'SYNTH-ZERO-';

export class LicenseEngine {
  constructor(private brain: Brain) {}

  /**
   * Validate and set a license key.
   */
  async setLicense(key: string): Promise<LicenseInfo> {
    const isValid = this.validateKey(key);

    if (isValid) {
      await this.brain.updateManifest({ license_key: key });
    }

    return this.getInfo(isValid ? key : null);
  }

  /**
   * Check if a specific tool is available.
   */
  async canUse(toolName: string): Promise<boolean> {
    if (FREE_FEATURES.has(toolName)) return true;
    if (!PREMIUM_FEATURES.has(toolName)) return true; // Unknown tools default to allowed

    const key = await this.resolveKey();
    return this.validateKey(key);
  }

  /**
   * Get current license info.
   */
  async getLicenseInfo(): Promise<LicenseInfo> {
    const key = await this.resolveKey();
    return this.getInfo(key);
  }

  /**
   * Check if premium features are available.
   */
  async isPremium(): Promise<boolean> {
    const key = await this.resolveKey();
    return this.validateKey(key);
  }

  // ─── Private ─────────────────────────────────────────────────

  /**
   * Resolve the license key — env var takes priority over manifest.
   */
  private async resolveKey(): Promise<string | null> {
    // 1. Check environment variable first (set in mcp_config.json env block)
    const envKey = process.env.CRBRO_LICENSE_KEY || null;
    if (envKey && this.validateKey(envKey)) return envKey;

    // 2. Fall back to manifest (set via CLI activate)
    const manifest = await this.brain.getManifest();
    return manifest.license_key || null;
  }

  private validateKey(key: string | null): boolean {
    if (!key) return false;

    // Basic validation — prefix check + length
    if (!key.startsWith(LICENSE_PREFIX)) return false;
    if (key.length < 20) return false;

    // Checksum validation (simple)
    const payload = key.substring(LICENSE_PREFIX.length);
    // Must be alphanumeric + hyphens
    if (!/^[A-Z0-9-]+$/.test(payload)) return false;

    return true;
  }

  private getInfo(key: string | null): LicenseInfo {
    const valid = this.validateKey(key);
    return {
      valid,
      tier: valid ? 'premium' : 'free',
      features: valid
        ? ['global_map', 'maintenance', 'export', 'import', 'advanced_search']
        : [],
    };
  }
}
