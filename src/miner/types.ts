// ─── CRBRO Miner: Shared Types ────────────────────────────────

export interface MineResult {
  scanned: number;
  new_files: number;
  neurons_created: number;
  neurons_updated: number;
  facts_added: number;
  decisions_added: number;
  technologies_found: string[];
  errors: string[];
}
