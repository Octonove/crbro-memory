// ─── Words with á, í, ú, ñ, ü and compounds (2.11) ───────────────
//
// Until 2.10 the index used Orama's English splitter: á, í, ú, ñ and ü were
// separators, so "página" was stored as "p" + "gina" while the query asked
// for "pagina" — nothing met. Reproduced on a copy of a real brain with ten
// invented words: zero results with and without the accent, while é and ó
// (kept by that splitter) were found. And "zorglub-quasar" was one token at
// index time while the query split it, so "quasar" found nothing.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Brain } from '../src/engine/brain.js';
import { Cortex } from '../src/engine/cortex.js';
import { SearchEngine } from '../src/search/index.js';
import { indexTokens, tokenize, createIndexTokenizer } from '../src/search/tokenize.js';

const INVENTED = ['zarpáldo', 'frintíco', 'mubúrga', 'trañuelo', 'pingüiro', 'cálvorin', 'dorníbal', 'suñarte', 'glübento', 'tremúsco'];
const CONTROLS = ['plontéro', 'grisóndal'];
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

let root: string; let engine: SearchEngine; let cortex: Cortex;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-tok-'));
  const brain = new Brain(root); await brain.initialize();
  cortex = new Cortex(brain); engine = new SearchEngine(brain); await engine.init();
  cortex.setIndexer(n => engine.indexNeuron(n));
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }); });

describe('one normalisation on both sides', () => {
  it('folds accents and splits compounds exactly like a query', () => {
    expect(indexTokens('Página de diseño — crbro-memory')).toEqual(['pagina', 'de', 'diseno', 'crbro', 'memory']);
    expect(indexTokens('tabla wp_wppc_entries')).toEqual(['tabla', 'wp_wppc_entries', 'wp', 'wppc', 'entries']);
    // A query keeps an identifier whole: asking for it means that one.
    expect(tokenize('wp_wppc_entries')).toEqual(['wp_wppc_entries']);
    const tk = createIndexTokenizer();
    expect(tk.tokenize('ocultar_de_lista', 'english')).toEqual(['ocultar_de_lista']);
    expect(tk.tokenize('ocultar_de_lista lista', 'english', 'text')).toEqual(['ocultar_de_lista', 'ocultar', 'de', 'lista']);
  });
});

describe('words with á, í, ú, ñ, ü are found', () => {
  it('stored with the accent: found with and without it (10 invented words)', async () => {
    for (const [i, w] of INVENTED.entries()) await cortex.learn(`Tema ${i}`, 'fact', `El ${w} del cliente quedó revisado ayer.`);
    for (const w of INVENTED) {
      const con = await engine.search(w);
      const sin = await engine.search(fold(w));
      expect(con[0]?.matching_content, w).toContain(w);
      expect(sin[0]?.matching_content, fold(w)).toContain(w);
    }
  });

  it('stored without the accent: found with and without it', async () => {
    for (const [i, w] of INVENTED.entries()) await cortex.learn(`Tema ${i}`, 'fact', `El ${fold(w)} del cliente quedó revisado ayer.`);
    for (const w of INVENTED) {
      expect((await engine.search(w))[0]?.matching_content, w).toContain(fold(w));
      expect((await engine.search(fold(w)))[0]?.matching_content, fold(w)).toContain(fold(w));
    }
  });

  it('é and ó still work, as they did', async () => {
    for (const [i, w] of CONTROLS.entries()) await cortex.learn(`Control ${i}`, 'fact', `El ${w} se apagó.`);
    for (const w of CONTROLS) {
      expect((await engine.search(w))[0]?.matching_content).toContain(w);
      expect((await engine.search(fold(w)))[0]?.matching_content).toContain(w);
    }
  });

  it('survives a reload from disk', async () => {
    await cortex.learn('Diseño', 'fact', 'El diseño de la página de categoría se aprobó en España.');
    await engine.persist();
    const again = new SearchEngine(new Brain(root));
    await again.init();
    for (const q of ['diseño', 'diseno', 'pagina', 'categoría', 'espana']) {
      expect((await again.search(q))[0]?.matching_content, q).toContain('diseño de la página');
    }
  });
});

describe('compounds are indexed as their parts', () => {
  it('"quasar" finds "zorglub-quasar", "memory" finds "crbro-memory"', async () => {
    await cortex.learn('Astro', 'fact', 'El telescopio zorglub-quasar se calibra cada lunes.');
    await cortex.learn('Paquetes', 'fact', 'El paquete crbro-memory se publica desde CI.');
    expect((await engine.search('quasar'))[0]?.matching_content).toContain('zorglub-quasar');
    expect((await engine.search('zorglub'))[0]?.matching_content).toContain('zorglub-quasar');
    expect((await engine.search('memory'))[0]?.matching_content).toContain('crbro-memory');
    expect((await engine.search('crbro-memory'))[0]?.matching_content).toContain('crbro-memory');
  });

  it('a slash or a dot splits too', async () => {
    await cortex.learn('Rutas', 'fact', 'La ruta api/v2/facturación y el fichero informe.final.pdf.');
    expect((await engine.search('facturacion'))[0]?.matching_content).toContain('api/v2');
    expect((await engine.search('final'))[0]?.matching_content).toContain('informe.final');
  });
});
