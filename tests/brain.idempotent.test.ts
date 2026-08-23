// ─── initialize() must never zero a living brain ─────────────────
//
// Fired live on the reference brain (23-08-2026): two maintenance scripts
// called brain.initialize() before using the Cortex — the documented way to
// get one — and the second call overwrote the manifest of a brain holding
// 1,186 neurons with fresh zeros, plus its active context and hot topics.
// Nothing was lost (the cortex is the truth), but boot reported an empty
// brain. initialize() is public API: it has to be safe to call twice.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Brain } from '../src/engine/brain.js';
import { Cortex } from '../src/engine/cortex.js';
import { readJSON, writeJSON } from '../src/utils/fs.js';
import type { Manifest, ActiveContext } from '../src/types/index.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-idem-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('initialize is idempotent', () => {
  it('a second initialize keeps the manifest counters', async () => {
    const brain = new Brain(root);
    await brain.initialize();
    const cortex = new Cortex(brain);
    await cortex.learn('Tema', 'fact', 'Un hecho cualquiera.');
    const antes = await readJSON<Manifest>(brain.paths.manifest());
    expect(antes!.total_neurons).toBe(1);

    // A script starting fresh against the same brain — the live scenario.
    const brain2 = new Brain(root);
    await brain2.initialize();

    const despues = await readJSON<Manifest>(brain2.paths.manifest());
    expect(despues!.total_neurons).toBe(1);
    expect(despues!.created).toBe(antes!.created);
  });

  it('a second initialize keeps active context and hot topics', async () => {
    const brain = new Brain(root);
    await brain.initialize();
    const ctx: ActiveContext = {
      last_session: 'sess_42',
      active_topics: ['facturas'],
      pending_tasks: ['revisar el cron'],
      last_updated: '2026-08-20T10:00:00Z',
    };
    await writeJSON(brain.paths.activeContext(), ctx);

    const brain2 = new Brain(root);
    await brain2.initialize();

    const leido = await readJSON<ActiveContext>(brain2.paths.activeContext());
    expect(leido!.last_session).toBe('sess_42');
    expect(leido!.pending_tasks).toContain('revisar el cron');
  });
});

describe('boot self-heals the counters', () => {
  it('a zeroed manifest over a populated cortex comes back honest', async () => {
    const brain = new Brain(root);
    await brain.initialize();
    const cortex = new Cortex(brain);
    await cortex.learn('Tema A', 'fact', 'Hecho uno.');
    await cortex.learn('Tema B', 'fact', 'Hecho dos.');

    // The damage: a fresh-zeroed manifest, as the old initialize left it.
    const roto = await readJSON<Manifest>(brain.paths.manifest());
    roto!.total_neurons = 0;
    roto!.total_synapses = 0;
    roto!.total_sessions = 0;
    await writeJSON(brain.paths.manifest(), roto);

    const brain2 = new Brain(root);
    const arranque = await brain2.boot();
    expect(arranque.total_neurons).toBe(2);

    const sanado = await readJSON<Manifest>(brain2.paths.manifest());
    expect(sanado!.total_neurons).toBe(2);
  });
});
