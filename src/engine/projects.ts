// Identidad local explícita: un nombre de carpeta no identifica un proyecto.
import path from 'node:path';
import { contentHash } from '../utils/hash.js';
import { readJSON, updateJSON, now } from '../utils/fs.js';
import { secretKinds } from './secrets.js';
import type { Brain } from './brain.js';

export interface ProjectProfile {
  id: string;
  aliases: string[];
  neurons: string[];
  updated: string;
}
interface Registry { version: 1; projects: Record<string, ProjectProfile> }

export function projectReference(value: string): string {
  let ref = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!ref || ref.length > 2048 || /[\x00-\x1f]/.test(ref)) throw new Error('Invalid project reference.');
  if (secretKinds(ref).length) throw new Error('Project references must not contain credentials.');
  if (/^git@[^:]+:/.test(ref)) ref = ref.replace(/^git@([^:]+):/, 'https://$1/');
  if (/^https?:\/\//i.test(ref)) {
    const url = new URL(ref);
    if (url.username || url.password || url.search || url.hash) {
      throw new Error('Project URLs must not contain credentials, query parameters or fragments.');
    }
    ref = `${url.host.toLowerCase()}${url.pathname}`;
  }
  ref = ref.replace(/\.git$/, '').replace(/\/+$/, '');
  if (/^[a-z]:\//i.test(ref)) ref = path.posix.normalize(ref).toLowerCase();
  return ref;
}

export class ProjectRegistry {
  private readonly file: string;
  constructor(brain: Brain) { this.file = path.join(brain.paths.root, 'projects.json'); }

  async find(reference: string): Promise<ProjectProfile | null> {
    const ref = projectReference(reference);
    const data = await readJSON<Registry>(this.file);
    return Object.values(data?.projects || {}).find(p => p.id === ref || p.aliases.includes(ref)) || null;
  }

  async boundNeurons(): Promise<string[]> {
    const data = await readJSON<Registry>(this.file);
    return [...new Set(Object.values(data?.projects || {}).flatMap(p => p.neurons))];
  }

  async bind(reference: string, options: { id?: string; aliases?: string[]; neurons?: string[] }): Promise<ProjectProfile> {
    const ref = projectReference(reference);
    const aliases = [...new Set([ref, ...(options.aliases || []).map(projectReference)])];
    if (aliases.length > 32) throw new Error('At most 32 project aliases.');
    if (options.id && !/^[a-zA-Z0-9_-]{1,100}$/.test(options.id)) throw new Error('Invalid project id.');
    if (options.neurons?.some(id => !/^[a-zA-Z0-9_-]{1,200}$/.test(id))) throw new Error('Invalid neuron id.');
    let result!: ProjectProfile;
    await updateJSON<Registry>(this.file, current => {
      const data = current || { version: 1 as const, projects: {} };
      const existing = Object.values(data.projects).find(p => p.id === ref || p.aliases.includes(ref));
      const id = options.id || existing?.id || `project_${contentHash(ref, 16)}`;
      for (const p of Object.values(data.projects)) {
        if (p.id !== id && (aliases.includes(p.id) || p.aliases.includes(id) || p.aliases.some(a => aliases.includes(a)))) {
          throw new Error('Project alias already belongs to another project; no assignment changed.');
        }
      }
      const previous = data.projects[id];
      const mergedAliases = [...new Set([...(previous?.aliases || []), ...aliases])];
      if (mergedAliases.length > 32) throw new Error('At most 32 project aliases.');
      result = {
        id, aliases: mergedAliases,
        neurons: options.neurons === undefined ? previous?.neurons || [] : [...new Set(options.neurons)],
        updated: now(),
      };
      data.projects[id] = result;
      return data;
    });
    return result;
  }
}
