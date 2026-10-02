// ─── crbro_context: open items go through the secret filter ──────
//
// An open item is read back by crbro_boot at the start of every session and
// copied into the compaction checkpoints. Before 2.7 it was the one free-text
// field of the brain written without redact(): the same credential came out
// filtered through the checkpoint and in clear through boot.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Brain } from '../src/engine/brain.js';
import { Prefrontal } from '../src/engine/prefrontal.js';

// Assembled at run time so no token-shaped literal sits in the repo.
const FAKE_GH = 'ghp_' + 'Rt56'.repeat(9);

let root: string;
let brain: Brain;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-ctx-redact-'));
  brain = new Brain(root);
  await brain.initialize();
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('crbro_context add_pending', () => {
  it('never writes a credential to active_context.json, and says what it redacted', async () => {
    const pf = new Prefrontal(brain);
    const r = await pf.updateContext({ add_pending: `Rotar el token ${FAKE_GH} del bot de despliegue` });
    expect(r.written).toBe(true);
    expect(r.redacted).toEqual(['GitHub token']);
    const item = r.pending_tasks.find(t => typeof t !== 'string' && t.text.startsWith('Rotar'));
    expect(item && typeof item !== 'string' ? item.text : '').toBe('Rotar el token [REDACTED: GitHub token] del bot de despliegue');

    const enDisco = await fs.readFile(path.join(root, 'prefrontal', 'active_context.json'), 'utf8');
    expect(enDisco).not.toContain(FAKE_GH);
    expect(enDisco).toContain('[REDACTED: GitHub token]');
  });

  it('leaves an item without secrets as it was, with no redacted field', async () => {
    const r = await new Prefrontal(brain).updateContext({ add_pending: 'Decidir el nombre del dominio' });
    expect(r).not.toHaveProperty('redacted');
    expect(r.pending_tasks.some(t => typeof t !== 'string' && t.text === 'Decidir el nombre del dominio')).toBe(true);
  });
});
