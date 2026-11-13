// ─── CRBRO Miner: Cross-Platform Scheduler ───────────────────
// Sets up automatic mining as a scheduled task on any OS.

import { writeFile, unlink, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir, platform } from 'os';
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';

// ─── Running commands: never through a shell ─────────────────────
//
// Until 2.10 the crontab went through `echo "${crontab}" | crontab -` in a
// shell: every $(…), `…` and "…" in the user's own cron lines was expanded or
// broke the quoting, and the rewritten crontab replaced theirs (I1). Every
// command here is an argument array, and text goes through stdin.

export interface SchedRun { status: number | null; stdout: string; stderr: string; error?: Error }
type Runner = (cmd: string, args: string[], input?: string) => SchedRun;

const realRunner: Runner = (cmd, args, input) => {
  const r = spawnSync(cmd, args, { encoding: 'utf-8', input, windowsHide: true, timeout: 30_000 });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
};
let run: Runner = realRunner;
let platformOverride: NodeJS.Platform | null = null;
const currentPlatform = (): NodeJS.Platform => platformOverride ?? platform();

/** Tests only: replace the command runner and, optionally, the platform. */
export function _setSchedulerRunnerForTests(r: Runner | null, os: NodeJS.Platform | null = null): void {
  run = r ?? realRunner;
  platformOverride = r ? os : null;
}

function must(r: SchedRun, what: string): SchedRun {
  if (r.error || r.status !== 0) {
    throw new Error(`${what} failed: ${(r.stderr || r.error?.message || `exit ${r.status}`).trim()}`);
  }
  return r;
}

/** Where the miner logs and where a copy of the previous crontab goes. */
function brainRoot(): string {
  return process.env['CRBRO_PATH'] || join(homedir(), '.crbro');
}

/** The current crontab, or '' when the user has none. Any other failure throws. */
function readCrontab(): string {
  const r = run('crontab', ['-l']);
  if (r.status === 0) return r.stdout;
  if (/no crontab/i.test(r.stderr)) return '';
  throw new Error(`Could not read the crontab: ${(r.stderr || r.error?.message || '').trim() || `exit ${r.status}`}`);
}

/** Keep the previous crontab next to the brain, then install the new one through stdin. */
async function writeCrontab(previous: string, next: string): Promise<void> {
  if (previous.trim()) {
    await mkdir(brainRoot(), { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
    await writeFile(join(brainRoot(), `crontab.before-crbro-${stamp}.txt`), previous, 'utf-8');
  }
  must(run('crontab', ['-'], next), 'crontab');
}

/** The cron file without our line, the user's lines byte for byte. */
export function cronWithout(current: string): string[] {
  return current.split('\n').filter(l => !l.includes('crbro-memory mine'));
}

/**
 * The /TR value for schtasks: the quoted absolute path of npx.cmd and its
 * arguments, as one argument. Passed as an array element, not through a
 * shell, so the quotes reach schtasks intact (I11).
 */
export function windowsTaskCommand(npxPath: string): string {
  return `"${npxPath}" -y crbro-memory mine`;
}

export function windowsCreateArgs(npxPath: string): string[] {
  return ['/Create', '/TN', TASK_NAME, '/TR', windowsTaskCommand(npxPath),
    '/SC', 'HOURLY', '/MO', String(FREQUENCY_HOURS), '/F', '/RL', 'LIMITED'];
}

export interface SchedulerResult {
  success: boolean;
  platform: string;
  method: string;
  frequency: string;
  message: string;
  uninstall_command?: string;
}

const TASK_NAME = 'CRBRO-AutoMiner';
const FREQUENCY_HOURS = 2;

/**
 * Detect the platform and set up the appropriate scheduler.
 */
export async function setupScheduler(): Promise<SchedulerResult> {
  const os = currentPlatform();

  switch (os) {
    case 'win32':
      return setupWindows();
    case 'darwin':
      return setupMacOS();
    case 'linux':
      return await setupLinux();
    default:
      return {
        success: false,
        platform: os,
        method: 'unsupported',
        frequency: `${FREQUENCY_HOURS}h`,
        message: `Unsupported platform: ${os}. Please set up a cron job manually to run: npx crbro-memory mine`,
      };
  }
}

/**
 * Check if the scheduler is already installed.
 */
export async function getSchedulerStatus(): Promise<{
  installed: boolean;
  platform: string;
  last_run: string | null;
  next_run: string | null;
  details: string;
}> {
  const os = currentPlatform();

  switch (os) {
    case 'win32':
      return getWindowsStatus();
    case 'darwin':
      return getMacOSStatus();
    case 'linux':
      return getLinuxStatus();
    default:
      return {
        installed: false,
        platform: os,
        last_run: null,
        next_run: null,
        details: 'Unsupported platform',
      };
  }
}

/**
 * Remove the scheduled task.
 */
export async function removeScheduler(): Promise<{ success: boolean; message: string }> {
  const os = currentPlatform();

  try {
    switch (os) {
      case 'win32':
        must(run('schtasks', ['/Delete', '/TN', TASK_NAME, '/F']), 'schtasks /Delete');
        return { success: true, message: `Removed Windows Task Scheduler entry: ${TASK_NAME}` };
      case 'darwin': {
        const plistPath = join(homedir(), 'Library', 'LaunchAgents', `com.crbro.miner.plist`);
        must(run('launchctl', ['unload', plistPath]), 'launchctl unload');
        await unlink(plistPath);
        return { success: true, message: `Removed macOS LaunchAgent: ${plistPath}` };
      }
      case 'linux': {
        const currentCron = readCrontab();
        const filtered = cronWithout(currentCron);
        if (filtered.length === currentCron.split('\n').length) {
          return { success: true, message: 'No crontab entry for the CRBRO miner. Nothing changed.' };
        }
        const next = filtered.join('\n').replace(/\n*$/, '\n');
        await writeCrontab(currentCron, next.trim() ? next : '');
        return { success: true, message: 'Removed crontab entry for CRBRO miner' };
      }
      default:
        return { success: false, message: `Unsupported platform: ${os}` };
    }
  } catch (err) {
    return { success: false, message: `Error removing scheduler: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ─── Windows: Task Scheduler ──────────────────────────────────

function setupWindows(): SchedulerResult {
  try {
    // Remove existing task if present
    // Remove an existing task if present (a failure here only means there was none).
    run('schtasks', ['/Delete', '/TN', TASK_NAME, '/F']);

    // npx.cmd, absolute: Task Scheduler cannot run the extensionless `npx`
    // shell script that `where npx` lists first.
    const npxPath = findNpxPath();

    must(run('schtasks', windowsCreateArgs(npxPath)), 'schtasks /Create');

    // Check what was registered rather than trusting the exit code alone.
    const q = run('schtasks', ['/Query', '/TN', TASK_NAME, '/XML']);
    if (q.status === 0 && !q.stdout.includes('crbro-memory mine')) {
      throw new Error('the task was created but its command does not run the miner');
    }

    return {
      success: true,
      platform: 'windows',
      method: 'Task Scheduler (schtasks)',
      frequency: `Every ${FREQUENCY_HOURS} hours`,
      message: `✅ CRBRO Auto-Miner scheduled!\n\n` +
        `  Task Name:  ${TASK_NAME}\n` +
        `  Frequency:  Every ${FREQUENCY_HOURS} hours\n` +
        `  Command:    ${windowsTaskCommand(npxPath)}\n\n` +
        `  To check status:  npx crbro-memory miner-status\n` +
        `  To remove:        npx crbro-memory remove-miner`,
      uninstall_command: `schtasks /Delete /TN "${TASK_NAME}" /F`,
    };
  } catch (err) {
    return {
      success: false,
      platform: 'windows',
      method: 'Task Scheduler (schtasks)',
      frequency: `${FREQUENCY_HOURS}h`,
      message: `Failed to create scheduled task: ${err instanceof Error ? err.message : String(err)}.\n\nTry running as Administrator, or create the task manually:\n  schtasks /Create /TN "${TASK_NAME}" /TR "\\"<path to npx.cmd>\\" -y crbro-memory mine" /SC HOURLY /MO ${FREQUENCY_HOURS}`,
    };
  }
}

function getWindowsStatus() {
  try {
    const output = must(run('schtasks', ['/Query', '/TN', TASK_NAME, '/FO', 'CSV', '/NH']), 'schtasks /Query').stdout;
    const parts = output.trim().split(',').map(s => s.replace(/"/g, ''));
    return {
      installed: true,
      platform: 'windows',
      last_run: null, // schtasks CSV doesn't give this easily
      next_run: parts[2] || null,
      details: `Task "${TASK_NAME}" is ${parts[3] || 'Ready'}`,
    };
  } catch {
    return {
      installed: false,
      platform: 'windows',
      last_run: null,
      next_run: null,
      details: `Task "${TASK_NAME}" not found. Run: npx crbro-memory setup-miner`,
    };
  }
}

// ─── macOS: LaunchAgent ───────────────────────────────────────

async function setupMacOS(): Promise<SchedulerResult> {
  const plistPath = join(homedir(), 'Library', 'LaunchAgents', 'com.crbro.miner.plist');
  const npxPath = findNpxPath();

  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.crbro.miner</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(npxPath)}</string>
    <string>-y</string>
    <string>crbro-memory</string>
    <string>mine</string>
  </array>
  <key>StartInterval</key>
  <integer>${FREQUENCY_HOURS * 3600}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(brainRoot(), 'miner.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(brainRoot(), 'miner_error.log'))}</string>
</dict>
</plist>`;

  try {
    await writeFile(plistPath, plistContent, 'utf-8');
    must(run('launchctl', ['load', plistPath]), 'launchctl load');

    return {
      success: true,
      platform: 'macos',
      method: 'LaunchAgent (launchd)',
      frequency: `Every ${FREQUENCY_HOURS} hours`,
      message: `✅ CRBRO Auto-Miner scheduled!\n\n` +
        `  Plist:      ${plistPath}\n` +
        `  Frequency:  Every ${FREQUENCY_HOURS} hours\n` +
        `  Log:        ~/.crbro/miner.log\n\n` +
        `  To check:   npx crbro-memory miner-status\n` +
        `  To remove:  npx crbro-memory remove-miner`,
      uninstall_command: `launchctl unload "${plistPath}" && rm "${plistPath}"`,
    };
  } catch (err) {
    return {
      success: false,
      platform: 'macos',
      method: 'LaunchAgent (launchd)',
      frequency: `${FREQUENCY_HOURS}h`,
      message: `Failed to create LaunchAgent: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function getMacOSStatus() {
  const plistPath = join(homedir(), 'Library', 'LaunchAgents', 'com.crbro.miner.plist');
  const installed = existsSync(plistPath);
  return {
    installed,
    platform: 'macos',
    last_run: null,
    next_run: null,
    details: installed
      ? `LaunchAgent installed at ${plistPath}`
      : 'LaunchAgent not found. Run: npx crbro-memory setup-miner',
  };
}

// ─── Linux: Crontab ───────────────────────────────────────────

/** cron runs the line through /bin/sh: paths are single-quoted for it. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function linuxCronLine(npxPath: string, logPath: string): string {
  return `0 */${FREQUENCY_HOURS} * * * ${shQuote(npxPath)} -y crbro-memory mine >> ${shQuote(logPath)} 2>&1`;
}

async function setupLinux(): Promise<SchedulerResult> {
  try {
    const npxPath = findNpxPath();
    const cronLine = linuxCronLine(npxPath, join(brainRoot(), 'miner.log'));

    // Current crontab, our old line out, the new one in. The user's own lines
    // are kept byte for byte, blank lines and comments included.
    const currentCron = readCrontab();
    const filtered = cronWithout(currentCron);
    while (filtered.length && !filtered[filtered.length - 1].trim()) filtered.pop();
    filtered.push(cronLine);
    const newCron = filtered.join('\n') + '\n';

    await writeCrontab(currentCron, newCron);

    return {
      success: true,
      platform: 'linux',
      method: 'Crontab',
      frequency: `Every ${FREQUENCY_HOURS} hours`,
      message: `✅ CRBRO Auto-Miner scheduled!\n\n` +
        `  Cron:       ${cronLine}\n` +
        `  Frequency:  Every ${FREQUENCY_HOURS} hours\n` +
        `  Log:        ${join(brainRoot(), 'miner.log')}\n` +
        `  The previous crontab was saved next to the brain as crontab.before-crbro-*.txt.\n\n` +
        `  To check:   npx crbro-memory miner-status\n` +
        `  To remove:  npx crbro-memory remove-miner`,
      uninstall_command: 'npx crbro-memory remove-miner',
    };
  } catch (err) {
    return {
      success: false,
      platform: 'linux',
      method: 'Crontab',
      frequency: `${FREQUENCY_HOURS}h`,
      message: `Failed to create crontab entry: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function getLinuxStatus() {
  try {
    const cron = readCrontab();
    const hasCrbro = cron.includes('crbro-memory mine');
    return {
      installed: hasCrbro,
      platform: 'linux',
      last_run: null,
      next_run: null,
      details: hasCrbro
        ? `Crontab entry found for CRBRO miner`
        : 'No crontab entry found. Run: npx crbro-memory setup-miner',
    };
  } catch {
    return {
      installed: false,
      platform: 'linux',
      last_run: null,
      next_run: null,
      details: 'Could not read crontab. Run: npx crbro-memory setup-miner',
    };
  }
}

// ─── Utilities ────────────────────────────────────────────────

export function findNpxPath(): string {
  const os = currentPlatform();
  if (os === 'win32') {
    // `where npx` lists the extensionless sh script first; Task Scheduler
    // needs the .cmd shim.
    const r = run('where', ['npx.cmd']);
    const first = r.status === 0 ? r.stdout.split(/\r?\n/).map(l => l.trim()).find(l => /\.cmd$/i.test(l)) : undefined;
    return first || 'npx.cmd';
  }
  const r = run('which', ['npx']);
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim().split('\n')[0] : 'npx';
}
