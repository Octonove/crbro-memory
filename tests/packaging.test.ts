import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Guards the release plumbing that no other test looks at: the two workflows
// that publish must agree on the pinned mcp-publisher, `engines` must not
// promise a Node the dependencies refuse, and the npm package must not ship
// sourcemaps or declaration files again.

const root = path.resolve(__dirname, '..');
const read = (f: string) => readFileSync(path.join(root, f), 'utf8');
const pkg = JSON.parse(read('package.json'));

describe('packaging', () => {
  it('engines does not promise a Node older than the oldest dependency supports', () => {
    const lock = JSON.parse(read('package-lock.json'));
    const orama = lock.packages['node_modules/@orama/orama'];
    const floor = (spec: string) => Number((/>=\s*(\d+)/.exec(spec) || [])[1] || 0);
    expect(floor(pkg.engines.node)).toBeGreaterThanOrEqual(floor(orama.engines?.node || '>=0'));
    expect(floor(pkg.engines.node)).toBeGreaterThanOrEqual(20);
  });

  it('prepublishOnly runs the tests', () => {
    expect(pkg.scripts.prepublishOnly).toMatch(/npm test|vitest/);
  });

  it('release.yml and publish-mcp.yml pin the same mcp-publisher, with a checksum', () => {
    const pin = (f: string) => ({
      version: /MCP_PUBLISHER_VERSION:\s*(v\d+\.\d+\.\d+)/.exec(read(f))?.[1],
      sha: /MCP_PUBLISHER_SHA256:\s*([0-9a-f]{64})/.exec(read(f))?.[1],
    });
    const a = pin('.github/workflows/release.yml');
    const b = pin('.github/workflows/publish-mcp.yml');
    expect(a.version).toBeTruthy();
    expect(a.sha).toBeTruthy();
    expect(b).toEqual(a);
    expect(read('.github/workflows/publish-mcp.yml')).not.toMatch(/tags:\s*\[/);
    expect(read('.github/workflows/release.yml')).not.toMatch(/releases\/latest/);
  });

  it('the changelog helper extracts one version and fails on a missing one', () => {
    const run = (v: string) => execFileSync(process.execPath, ['scripts/changelog-section.mjs', v], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const current = pkg.version as string;
    const changelog = read('CHANGELOG.md');
    if (changelog.includes(`## [${current}]`)) expect(run(current).trim().length).toBeGreaterThan(0);
    expect(() => run('0.0.1')).toThrow();
  });

  it('the npm package ships no sourcemaps or declaration files from dist/', () => {
    const out = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'],
      { cwd: root, encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'ignore'] });
    const files: string[] = JSON.parse(out)[0].files.map((f: { path: string }) => f.path);
    expect(files.filter(f => /^dist\/.*(\.map|\.d\.ts)$/.test(f))).toEqual([]);
  }, 60_000);
});
