// ─── Which CRBRO is running ──────────────────────────────────────
//
// The manifest carries its own version, but that one stamps the brain FORMAT
// and has not moved since 1.0.0 — reporting it as "the version" told every
// user the same thing regardless of what they had installed.
//
// The package.json next to the code is the version, but only at the moment
// the code was loaded: npx refreshes its cache in place, so a process started
// on 2.8 can find 2.9's package.json on disk an hour later and, reading it
// on every call, report 2.9 while it runs 2.8's code (seen on 2026-10-04).
// So the running version is read ONCE, when this module loads, and the disk
// is read again only to say that a different version is waiting there.

import { readFileSync } from 'fs';
import { join } from 'path';

/** The package.json that ships with this code (dist/ or src/ under the test runner → the package root). */
export const PACKAGE_JSON = join(__dirname, '..', 'package.json');

/** The version in a package.json, or 'unknown' when it cannot be read. */
export function readPackageVersion(file: string = PACKAGE_JSON): string {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'))?.version;
    return typeof v === 'string' && v ? v : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The version of the code this process runs: read once, at load. */
export const RUNNING_VERSION = readPackageVersion();

export interface VersionStatus {
  /** What this process runs. */
  crbro_version: string;
  /** Present only when the package on disk says another version. */
  installed_version?: string;
  /** Present with installed_version: what to do about it. */
  version_note?: string;
}

/**
 * What view=status says about the version: the running one always; the one
 * on disk, apart and with a note, only when it is known and different.
 */
export function versionStatus(running: string = RUNNING_VERSION, onDisk: string = readPackageVersion()): VersionStatus {
  if (onDisk === 'unknown' || onDisk === running) return { crbro_version: running };
  return {
    crbro_version: running,
    installed_version: onDisk,
    version_note: `CRBRO ${onDisk} is installed but this process still runs ${running}: restart the client (or the CRBRO process) to load it.`,
  };
}
