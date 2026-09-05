// ─── Where the brain goes when CRBRO_PATH is not a path ──────────
//
// Born from the first field test of the desktop extension: a launcher that
// did not know the MCPB format passed the literal `${user_config.brain_path}`
// as the brain folder, Node resolved it against C:\WINDOWS\system32 and the
// first mkdir died with EPERM. The resolver must never take a template hole
// for a folder, and must never let a relative value land in the host's cwd.

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveBrainDir } from '../src/engine/brain.js';

const HOME = path.resolve(process.platform === 'win32' ? 'C:/Users/prueba' : '/home/prueba');
const env = (extra: Record<string, string> = {}) => ({ HOME, USERPROFILE: HOME, ...extra });
const fallback = path.join(HOME, '.crbro');
const quiet = () => {};

describe('resolveBrainDir', () => {
  it('without CRBRO_PATH uses ~/.crbro', () => {
    expect(resolveBrainDir(env(), quiet)).toBe(fallback);
  });

  it('honours an absolute path as is', () => {
    const abs = path.join(HOME, 'cerebros', 'trabajo');
    expect(resolveBrainDir(env({ CRBRO_PATH: abs }), quiet)).toBe(abs);
  });

  it('ignores an unexpanded MCPB placeholder and says why', () => {
    const avisos: string[] = [];
    const dir = resolveBrainDir(env({ CRBRO_PATH: '${user_config.brain_path}' }), (m) => avisos.push(m));
    expect(dir).toBe(fallback);
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatch(/hueco sin sustituir/);
    expect(avisos[0]).toContain('${user_config.brain_path}');
  });

  it('ignores an unexpanded Windows %VAR% too', () => {
    expect(resolveBrainDir(env({ CRBRO_PATH: '%APPDATA%/crbro' }), quiet)).toBe(fallback);
  });

  it('resolves a relative path against the home folder, never the cwd', () => {
    const avisos: string[] = [];
    const dir = resolveBrainDir(env({ CRBRO_PATH: 'mi-cerebro' }), (m) => avisos.push(m));
    expect(dir).toBe(path.join(HOME, 'mi-cerebro'));
    expect(dir.startsWith(HOME)).toBe(true);
    expect(avisos[0]).toMatch(/relativo/);
  });

  it('expands ~', () => {
    expect(resolveBrainDir(env({ CRBRO_PATH: '~/notas/.crbro' }), quiet)).toBe(path.join(HOME, 'notas', '.crbro'));
    expect(resolveBrainDir(env({ CRBRO_PATH: '~' }), quiet)).toBe(HOME);
  });

  it('treats whitespace as empty', () => {
    expect(resolveBrainDir(env({ CRBRO_PATH: '   ' }), quiet)).toBe(fallback);
  });

  it('falls back to USERPROFILE when HOME is missing', () => {
    expect(resolveBrainDir({ USERPROFILE: HOME, CRBRO_PATH: '${x}' }, quiet)).toBe(fallback);
  });
});
