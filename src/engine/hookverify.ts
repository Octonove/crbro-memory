// ─── Are the installed hooks the ones this package ships? ───────
//
// `install-hooks` copies hooks/*.mjs into ~/.claude/crbro-hooks/ and points
// settings.json at the copies, so they survive an npx cache wipe. That makes
// them ordinary files in the user's home: anything that can write there can
// change what runs at the start of every session and before every shell
// command, and nobody would notice. `install-hooks --verify` compares each
// copy, by SHA-256, with the file of the same name in this package, checks
// that every CRBRO hook settings.json runs actually exists, and reports. It
// reads and hashes; it never writes, fixes or deletes anything.
//
// A difference is not proof of tampering: a copy installed by an older release
// differs from this one's. The report says so, and re-running the install
// command refreshes the copy.

import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import os from 'os';

export type HookStatus =
  /** Byte for byte the packaged file. */
  | 'same'
  /** Same text once CRLF is read as LF: a checkout or an editor, not a change. */
  | 'line_endings_only'
  | 'different'
  /** Shipped by the package, not installed. */
  | 'not_installed'
  /** In crbro-hooks/ but not a file this package ships. */
  | 'unknown';

export interface HookCheck {
  name: string;
  status: HookStatus;
  installed_sha256?: string;
  package_sha256?: string;
  /** settings.json runs it. */
  in_settings: boolean;
}

export interface VerifyReport {
  package_dir: string;
  installed_dir: string;
  settings_path: string;
  hooks: HookCheck[];
  /** Scripts a CRBRO hook in settings.json runs that are not on disk. */
  missing_scripts: string[];
  /** settings.json exists but is not valid JSON. */
  settings_unreadable: boolean;
  /** Nothing differs and nothing referenced is missing. */
  ok: boolean;
}

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function lfSha(buf: Buffer): string {
  return sha256(Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'));
}

function mjsIn(dir: string): string[] {
  try {
    return readdirSync(dir).filter(f => f.endsWith('.mjs') && statSync(path.join(dir, f)).isFile()).sort();
  } catch {
    return [];
  }
}

/** Every hook command string in a settings object, whatever the event. */
function hookCommands(settings: any): string[] {
  const out: string[] = [];
  const hooks = settings && typeof settings === 'object' ? settings.hooks : null;
  if (!hooks || typeof hooks !== 'object') return out;
  for (const list of Object.values(hooks)) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      for (const h of Array.isArray((entry as any)?.hooks) ? (entry as any).hooks : []) {
        if (h && typeof h.command === 'string') out.push(h.command);
      }
    }
  }
  return out;
}

/** "~/x", "$HOME/x", "${HOME}/x" and "%USERPROFILE%\x", expanded as a shell would. */
function expandHome(p: string): string {
  return p.replace(/^(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%)(?=[\\/])/i, () => os.homedir());
}

/** The .mjs paths a command runs, quoted or not. */
function scriptsIn(command: string): string[] {
  const out: string[] = [];
  const re = /"([^"]+\.mjs)"|'([^']+\.mjs)'|(\S+\.mjs)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) out.push(expandHome(m[1] ?? m[2] ?? m[3]));
  return out;
}

export interface VerifyOptions {
  /** hooks/ of this package. */
  packageDir: string;
  /** ~/.claude/crbro-hooks */
  installedDir: string;
  /** ~/.claude/settings.json */
  settingsPath: string;
}

/** Read-only: hashes files and parses settings.json, writes nothing. */
export function verifyHooks(opts: VerifyOptions): VerifyReport {
  const shipped = mjsIn(opts.packageDir);
  const installed = mjsIn(opts.installedDir);

  let settings: any = null;
  let settingsUnreadable = false;
  if (existsSync(opts.settingsPath)) {
    try {
      const raw = readFileSync(opts.settingsPath, 'utf8');
      settings = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    } catch {
      settingsUnreadable = true;
    }
  }
  const crbroScripts = hookCommands(settings)
    .filter(c => /crbro/i.test(c))
    .flatMap(scriptsIn);
  const referenced = new Set(crbroScripts.map(p => path.basename(p)));

  const hooks: HookCheck[] = [];
  for (const name of shipped) {
    const pkg = readFileSync(path.join(opts.packageDir, name));
    const check: HookCheck = { name, status: 'not_installed', package_sha256: sha256(pkg), in_settings: referenced.has(name) };
    const target = path.join(opts.installedDir, name);
    if (installed.includes(name)) {
      const mine = readFileSync(target);
      check.installed_sha256 = sha256(mine);
      if (check.installed_sha256 === check.package_sha256) check.status = 'same';
      else if (lfSha(mine) === lfSha(pkg)) check.status = 'line_endings_only';
      else check.status = 'different';
    }
    hooks.push(check);
  }
  for (const name of installed) {
    if (shipped.includes(name)) continue;
    const mine = readFileSync(path.join(opts.installedDir, name));
    hooks.push({ name, status: 'unknown', installed_sha256: sha256(mine), in_settings: referenced.has(name) });
  }

  const missing = [...new Set(crbroScripts)].filter(p => !existsSync(p));
  const ok = !settingsUnreadable && missing.length === 0 &&
    hooks.every(h => h.status === 'same' || h.status === 'line_endings_only' || h.status === 'not_installed');

  return {
    package_dir: opts.packageDir,
    installed_dir: opts.installedDir,
    settings_path: opts.settingsPath,
    hooks,
    missing_scripts: missing,
    settings_unreadable: settingsUnreadable,
    ok,
  };
}

const STATUS_TEXT: Record<HookStatus, string> = {
  same: '✅ same as the package',
  line_endings_only: '✅ same except line endings (CRLF/LF)',
  different: '⚠️  DIFFERENT from the package',
  not_installed: '⚪ not installed',
  unknown: '⚠️  not a hook of this package',
};

export function formatVerify(r: VerifyReport): string {
  const L: string[] = [''];
  L.push('  Hook verification (read-only: nothing is changed)');
  L.push(`  Package:    ${r.package_dir}`);
  L.push(`  Installed:  ${r.installed_dir}`);
  L.push('');
  for (const h of r.hooks) {
    L.push(`  ${h.name.padEnd(22)} ${STATUS_TEXT[h.status]}${h.in_settings ? ' · run by settings.json' : ''}`);
    if (h.status === 'different' || h.status === 'unknown') {
      if (h.package_sha256) L.push(`      package    sha256 ${h.package_sha256}`);
      if (h.installed_sha256) L.push(`      installed  sha256 ${h.installed_sha256}`);
    }
  }
  if (r.settings_unreadable) {
    L.push('');
    L.push(`  ⚠️  ${r.settings_path} cannot be read as JSON: what it runs could not be checked.`);
  }
  for (const m of r.missing_scripts) {
    L.push('');
    L.push(`  ⚠️  settings.json runs ${m}, which does not exist: that hook fails in every session.`);
  }
  L.push('');
  if (r.ok) {
    L.push('  Everything matches this package.');
  } else {
    L.push('  There are differences. If you just updated CRBRO that is expected: run again the');
    L.push('  install-hooks you installed with (--guard, --compact or no option) and the copy is');
    L.push('  refreshed. If you did not update, find out who changed that file before using it again.');
  }
  L.push('');
  return L.join('\n');
}
