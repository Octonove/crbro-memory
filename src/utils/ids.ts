// ─── CRBRO ID Utilities ──────────────────────────────────────────
// Generate and validate neuron/synapse IDs

import type { NeuronType } from '../types/index.js';

const TYPE_PREFIXES: Record<NeuronType, string> = {
  project: 'project_',
  tech: 'tech_',
  lang: 'lang_',
  person: 'person_',
  domain: 'domain_',
  process: 'process_',
};

/**
 * Convert a string to a valid snake_case ID.
 * "OctoChat Plugin" → "octochat_plugin"
 */
export function toSnakeCase(str: string): string {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s_-]/g, '')   // Remove special chars
    .replace(/[\s-]+/g, '_')          // Spaces/hyphens to underscores
    .replace(/_+/g, '_')              // Collapse multiple underscores
    .replace(/^_|_$/g, '');           // Trim leading/trailing underscores
}

/**
 * Generate a neuron ID from name and type.
 * ("OctoChat", "project") → "project_octochat"
 */
export function neuronId(name: string, type: NeuronType): string {
  const prefix = TYPE_PREFIXES[type];
  const slug = toSnakeCase(name);
  return `${prefix}${slug}`;
}

/**
 * Generate a synapse ID from two neuron IDs.
 * ("project_octochat", "tech_firebase") → "syn_octochat__firebase"
 * Always sorted alphabetically for consistency.
 */
export function synapseId(nodeA: string, nodeB: string): string {
  const stripPrefix = (id: string) => id.replace(/^(project_|tech_|lang_|person_|domain_|process_)/, '');
  const parts = [stripPrefix(nodeA), stripPrefix(nodeB)].sort();
  return `syn_${parts[0]}__${parts[1]}`;
}

/**
 * Generate a session ID for today.
 * → "session_2026-05-06"
 */
export function sessionId(date?: string): string {
  const d = date || new Date().toISOString().split('T')[0];
  return `session_${d}`;
}

/**
 * Validate that a string is a valid neuron ID.
 */
export function isValidNeuronId(id: string): boolean {
  return /^(project|tech|lang|person|domain|process)_[a-z0-9_]+$/.test(id);
}

/**
 * Infer neuron type from topic name using simple heuristics.
 * Falls back to 'project' if unsure.
 */
export function inferNeuronType(topic: string): NeuronType {
  const lower = topic.toLowerCase();

  // Tech keywords
  const techKeywords = ['firebase', 'react', 'node', 'docker', 'kubernetes', 'aws', 'gcp', 'cloud', 'api', 'rest',
    'graphql', 'mongodb', 'postgres', 'redis', 'nginx', 'webpack', 'vite', 'git', 'npm', 'supabase', 'stripe',
    'vercel', 'netlify', 'cloudflare', 'orama', 'chromadb', 'openai', 'gemini', 'claude'];
  if (techKeywords.some(kw => lower.includes(kw))) return 'tech';

  // Language keywords
  const langKeywords = ['python', 'javascript', 'typescript', 'php', 'rust', 'go', 'java', 'swift', 'kotlin', 'css', 'html', 'sql'];
  if (langKeywords.some(kw => lower === kw || lower.includes(` ${kw}`) || lower.includes(`${kw} `))) return 'lang';

  // Process keywords
  const processKeywords = ['deploy', 'migration', 'workflow', 'pipeline', 'ci/cd', 'backup', 'setup', 'install'];
  if (processKeywords.some(kw => lower.includes(kw))) return 'process';

  // Domain keywords
  const domainKeywords = ['seo', 'marketing', 'trading', 'crypto', 'design', 'security', 'devops', 'data', 'analytics'];
  if (domainKeywords.some(kw => lower === kw)) return 'domain';

  // Default to project
  return 'project';
}
