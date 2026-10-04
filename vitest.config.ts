import { configDefaults, defineConfig } from 'vitest/config';

// The suite tests the keyword contract; the semantic layer, on by default
// wherever its runtime is installed since 1.16, is pinned off here and
// switched on explicitly by the tests that cover it.
//
// mods/ holds Claude Code mods: their tests import `claude-code/testing` and
// run under `claude plugin test`, not under vitest.
export default defineConfig({
  test: {
    setupFiles: ['tests/setup.env.ts'],
    exclude: [...configDefaults.exclude, 'mods/**'],
  },
});
