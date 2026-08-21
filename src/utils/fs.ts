// ─── CRBRO File System Utilities ─────────────────────────────────
// Safe JSON read/write with error handling and atomic writes

import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Safely read and parse a JSON file. Returns null if file doesn't exist.
 * Never throws on missing file — only on corrupted JSON.
 */
export async function readJSON<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw new Error(`CRBRO: Corrupted JSON at ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Write JSON to file atomically (write to temp, then rename).
 * Creates parent directories if they don't exist.
 */
export async function writeJSON<T>(
  filePath: string,
  data: T,
  options?: { pretty?: boolean }
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const tempPath = `${filePath}.tmp`;
  // Pretty by default: these files are meant to be read and diffed by humans.
  // The search index opts out — it reaches tens of MB and nobody reads it.
  const content = options?.pretty === false
    ? JSON.stringify(data)
    : JSON.stringify(data, null, 2);

  await fs.writeFile(tempPath, content, 'utf-8');
  await fs.rename(tempPath, filePath);
}

/**
 * Check if a file exists.
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * List all JSON files in a directory. Returns filenames without extension.
 */
export async function listJSONFiles(dirPath: string): Promise<string[]> {
  try {
    const files = await fs.readdir(dirPath);
    return files
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''));
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }
}

/**
 * Delete a JSON file. Returns true if deleted, false if didn't exist.
 */
export async function deleteJSON(filePath: string): Promise<boolean> {
  try {
    await fs.unlink(filePath);
    return true;
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

/**
 * Move a file from one location to another.
 */
export async function moveFile(from: string, to: string): Promise<void> {
  const dir = path.dirname(to);
  await fs.mkdir(dir, { recursive: true });
  await fs.rename(from, to);
}

/**
 * Get the current date as ISO string (date only).
 */
export function today(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * Get the current datetime as ISO string.
 */
export function now(): string {
  return new Date().toISOString();
}
