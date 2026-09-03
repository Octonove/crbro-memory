import { defineConfig } from 'vitest/config';

// The suite tests the keyword contract; the semantic layer, on by default
// wherever its runtime is installed since 1.16, is pinned off here and
// switched on explicitly by the tests that cover it.
export default defineConfig({
  test: { setupFiles: ['tests/setup.env.ts'] },
});
