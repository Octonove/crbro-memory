// ─── CRBRO File System Utilities ─────────────────────────────────
// Safe JSON read/write with error handling and atomic writes

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { withLock } from './lock.js';

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
 * Read a JSON file, let the caller change it, and write it back — all while
 * holding the file's lock, so a concurrent writer cannot slip in between the
 * read and the write.
 *
 * This is the fix for silent data loss: every mutation used to read the whole
 * neuron, edit it in memory and save it, so with two editors open the later
 * save erased whatever the other one had added. Measured before the lock: 80
 * facts requested across two processes, 42 survived, no errors reported.
 *
 * The mutator returns the value to write, or null to leave the file alone.
 */
export async function updateJSON<T>(
  filePath: string,
  mutate: (current: T | null) => Promise<T | null> | T | null
): Promise<T | null> {
  return withLock(filePath, async () => {
    const current = await readJSON<T>(filePath);
    const next = await mutate(current);
    if (next === null) return current;
    await writeJSON(filePath, next);
    return next;
  });
}

/**
 * Last modification time of a file, in milliseconds. 0 if it does not exist.
 */
export async function fileMtime(filePath: string): Promise<number> {
  try {
    const st = await fs.stat(filePath);
    return st.mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Most recent modification time among the files of a directory, in
 * milliseconds. Used to tell whether a derived file has fallen behind.
 */
export async function newestMtime(dirPath: string): Promise<number> {
  try {
    const files = await fs.readdir(dirPath);
    let newest = 0;
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const st = await fs.stat(path.join(dirPath, f));
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      } catch { /* skip */ }
    }
    return newest;
  } catch {
    return 0;
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
