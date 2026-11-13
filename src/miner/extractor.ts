// ─── CRBRO Miner: Text Extractor ──────────────────────────────
// Simple keyword/fact/decision extraction from markdown files.
// No AI required — uses regex patterns and basic NLP.

export interface ExtractedContent {
  topics: string[];
  facts: string[];
  decisions: string[];
  technologies: string[];
  summary: string;
}

// Common technology keywords to detect
const TECH_KEYWORDS = new Set([
  'react', 'vue', 'angular', 'svelte', 'next.js', 'nextjs', 'nuxt', 'vite',
  'node', 'nodejs', 'deno', 'bun', 'express', 'fastify', 'koa',
  'python', 'django', 'flask', 'fastapi',
  'typescript', 'javascript', 'php', 'ruby', 'go', 'rust', 'java', 'kotlin', 'swift',
  'firebase', 'supabase', 'mongodb', 'postgresql', 'mysql', 'redis', 'sqlite',
  'docker', 'kubernetes', 'terraform', 'ansible',
  'aws', 'gcp', 'azure', 'cloudflare', 'vercel', 'netlify',
  'github', 'gitlab', 'bitbucket',
  'wordpress', 'shopify', 'strapi', 'sanity',
  'tailwind', 'css', 'sass', 'less',
  'graphql', 'rest', 'grpc', 'websocket',
  'stripe', 'paypal', 'openai', 'gemini', 'claude', 'ollama',
  'electron', 'tauri', 'flutter', 'react native',
  'cloud run', 'cloud functions', 'lambda', 'ec2', 's3',
  'firestore', 'realtime database', 'cloud storage',
  'seo', 'rank math', 'yoast', 'schema markup',
  'mcp', 'model context protocol',
]);

// Decision indicator patterns (multilingual)
const DECISION_PATTERNS = [
  // English
  /(?:decided|chose|selected|opted|switched|migrated|moved|changed|replaced|upgraded|downgraded)\s+(?:to|from|for)\s+(.+)/gi,
  /(?:we(?:'ll| will)|going to|plan to|need to)\s+(migrate|switch|move|change|replace|implement|build|create|use)\s+(.+)/gi,
  // Spanish
  /(?:decidimos|elegimos|optamos|migramos|cambiamos|reemplazamos)\s+(.+)/gi,
  /(?:vamos a|hay que|necesitamos)\s+(migrar|cambiar|reemplazar|implementar|crear|usar)\s+(.+)/gi,
  // French
  /(?:décidé|choisi|opté|migré|changé|remplacé)\s+(?:de|pour|à)\s+(.+)/gi,
  // German
  /(?:entschieden|gewählt|migriert|gewechselt|ersetzt)\s+(.+)/gi,
  // Italian
  /(?:deciso|scelto|migrato|cambiato|sostituito)\s+(?:di|per|a)\s+(.+)/gi,
];

// Fact indicator patterns
const FACT_PATTERNS = [
  /(?:uses?|utilizes?|runs? on|built with|powered by|depends? on|requires?)\s+(.+)/gi,
  /(?:usa|utiliza|funciona con|construido con|depende de|requiere)\s+(.+)/gi,
  /(?:deployed?|hosted?|served?)\s+(?:on|at|via|through)\s+(.+)/gi,
  /(?:desplegado|alojado|servido)\s+(?:en|vía|a través de)\s+(.+)/gi,
  /(?:version|v)\s*(\d+\.\d+(?:\.\d+)?)/gi,
  /(?:port|puerto)\s*(\d{2,5})/gi,
];

/**
 * Extract structured content from a markdown file's text.
 */
export function extractContent(text: string, filename: string): ExtractedContent {
  const lines = text.split('\n');
  const topics: Set<string> = new Set();
  const facts: string[] = [];
  const decisions: string[] = [];
  const technologies: Set<string> = new Set();

  // Extract topics from headers
  for (const line of lines) {
    const headerMatch = line.match(/^#{1,3}\s+(.+)/);
    if (headerMatch) {
      const header = headerMatch[1].trim();
      if (header.length > 3 && header.length < 100) {
        topics.add(header);
      }
    }
  }

  // Extract from filename
  const fileBaseName = filename.replace(/\.(md|txt)$/i, '').replace(/[_-]/g, ' ');
  if (fileBaseName.length > 3) {
    topics.add(fileBaseName);
  }

  const textLower = text.toLowerCase();

  // Detect technologies
  for (const tech of TECH_KEYWORDS) {
    // Word boundary check to avoid partial matches
    const regex = new RegExp(`\\b${tech.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (regex.test(textLower)) {
      technologies.add(tech);
    }
  }

  // Extract decisions
  for (const pattern of DECISION_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const decision = match[0].trim();
      if (decision.length > 10 && decision.length < 200 && !isMinerNoise(cleanExtract(decision))) {
        decisions.push(cleanExtract(decision));
      }
    }
  }

  // Extract facts
  for (const pattern of FACT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const fact = match[0].trim();
      if (fact.length > 10 && fact.length < 200 && !isMinerNoise(cleanExtract(fact))) {
        facts.push(cleanExtract(fact));
      }
    }
  }

  // Generate summary from first substantial paragraph
  const summary = generateSummary(lines);

  return {
    topics: [...topics].slice(0, 10),
    facts: deduplicateStrings(facts).slice(0, 15),
    decisions: deduplicateStrings(decisions).slice(0, 10),
    technologies: [...technologies],
    summary,
  };
}

/**
 * Clean an extracted string: remove markdown artifacts, trim whitespace.
 */
function cleanExtract(text: string): string {
  return text
    .replace(/[`*_~\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Lines that are scaffolding, not knowledge: a checklist item ("- [x] Navigate
 * to https://…", or "- x Navigate to …" once the brackets were stripped, which
 * is how ~300 of them reached a real brain as facts), a bare link, a heading,
 * a rule. Exported for crbro_maintenance, which finds the ones already stored
 * (purge_boilerplate, reviewed with dry_run first).
 */
export function isMinerNoise(text: string): boolean {
  const t = (text || '').trim();
  if (!t) return true;
  if (/^#{1,6}\s/.test(t)) return true;                                   // heading
  if (/^[-*+]\s*\[[ xX~-]?\]/.test(t)) return true;                       // - [ ] / - [x] checklist
  if (/^[-*+]\s+[xX]\s+\S/.test(t)) return true;                          // "- x Navigate…": a checklist after cleanup
  if (/^(?:[-*+]\s*)?<?(?:https?|file):\/\/\S+>?\.?$/i.test(t)) return true;   // a bare link
  if (/^[-*_=~]{3,}$/.test(t)) return true;                               // a rule
  return false;
}

/** A sentence somebody wrote, not a list item, a table row, a quote, markup or a link with a few words around it. */
function isProse(line: string): boolean {
  const t = line.trim();
  if (isMinerNoise(t)) return false;
  if (/^(?:[-*+]|\d+[.)])\s/.test(t)) return false;                       // list item
  if (/^[|>]/.test(t) || /^<\/?[a-z]/i.test(t)) return false;            // table, quote, HTML
  const words = t.split(/\s+/).filter(w => /[\p{L}]/u.test(w));
  if (words.length < 5) return false;
  const urls = (t.match(/\S*:\/\/\S+/g) || []).join('').length;
  return urls <= t.length * 0.4;
}

/**
 * A one-line summary from the first real sentence: never a heading, a list or
 * checklist item, a table row, a link, code or frontmatter. Nothing when the
 * file has no prose — an empty summary is better than a checklist line stored
 * as a fact.
 */
function generateSummary(lines: string[]): string {
  let inCode = false;
  let inFrontmatter = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) { inCode = !inCode; continue; }
    if (inCode) continue;
    if (i === 0 && trimmed === '---') { inFrontmatter = true; continue; }
    if (inFrontmatter) { if (trimmed === '---') inFrontmatter = false; continue; }
    if (trimmed.length <= 30 || !isProse(trimmed)) continue;
    const clean = cleanExtract(trimmed);
    if (isMinerNoise(clean)) continue;
    return clean.length > 150 ? clean.substring(0, 150) + '...' : clean;
  }
  return '';
}

/**
 * Simple deduplication by normalized similarity.
 */
function deduplicateStrings(arr: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of arr) {
    const normalized = item.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(item);
    }
  }
  return result;
}
