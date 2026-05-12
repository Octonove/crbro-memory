// ─── CRBRO Miner: Cross-Platform Scheduler ───────────────────
// Sets up automatic mining as a scheduled task on any OS.

import { writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir, platform, tmpdir } from 'os';
import { execSync } from 'child_process';
import { existsSync } from 'fs';

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
  const os = platform();

  switch (os) {
    case 'win32':
      return setupWindows();
    case 'darwin':
      return setupMacOS();
    case 'linux':
      return setupLinux();
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
  const os = platform();

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
  const os = platform();

  try {
    switch (os) {
      case 'win32':
        execSync(`schtasks /Delete /TN "${TASK_NAME}" /F`, { stdio: 'pipe' });
        return { success: true, message: `Removed Windows Task Scheduler entry: ${TASK_NAME}` };
      case 'darwin': {
        const plistPath = join(homedir(), 'Library', 'LaunchAgents', `com.crbro.miner.plist`);
        execSync(`launchctl unload "${plistPath}"`, { stdio: 'pipe' });
        execSync(`rm "${plistPath}"`, { stdio: 'pipe' });
        return { success: true, message: `Removed macOS LaunchAgent: ${plistPath}` };
      }
      case 'linux': {
        const currentCron = execSync('crontab -l 2>/dev/null || echo ""', { encoding: 'utf-8' });
        const filtered = currentCron.split('\n').filter(l => !l.includes('crbro-memory mine')).join('\n');
        execSync(`echo "${filtered}" | crontab -`, { stdio: 'pipe' });
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
    try {
      execSync(`schtasks /Delete /TN "${TASK_NAME}" /F`, { stdio: 'pipe' });
    } catch { /* doesn't exist yet */ }

    // Find npx path
    const npxPath = findNpxPath();

    // Create the task
    execSync(
      `schtasks /Create /TN "${TASK_NAME}" ` +
      `/TR "\"${npxPath}\" -y crbro-memory mine" ` +
      `/SC HOURLY /MO ${FREQUENCY_HOURS} ` +
      `/F /RL LIMITED`,
      { stdio: 'pipe' }
    );

    return {
      success: true,
      platform: 'windows',
      method: 'Task Scheduler (schtasks)',
      frequency: `Every ${FREQUENCY_HOURS} hours`,
      message: `✅ CRBRO Auto-Miner scheduled!\n\n` +
        `  Task Name:  ${TASK_NAME}\n` +
        `  Frequency:  Every ${FREQUENCY_HOURS} hours\n` +
        `  Command:    npx crbro-memory mine\n\n` +
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
      message: `Failed to create scheduled task: ${err instanceof Error ? err.message : String(err)}.\n\nTry running as Administrator, or create the task manually:\n  schtasks /Create /TN "${TASK_NAME}" /TR "npx -y crbro-memory mine" /SC HOURLY /MO ${FREQUENCY_HOURS}`,
    };
  }
}

function getWindowsStatus() {
  try {
    const output = execSync(
      `schtasks /Query /TN "${TASK_NAME}" /FO CSV /NH`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
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
    <string>${npxPath}</string>
    <string>-y</string>
    <string>crbro-memory</string>
    <string>mine</string>
  </array>
  <key>StartInterval</key>
  <integer>${FREQUENCY_HOURS * 3600}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${join(homedir(), '.crbro', 'miner.log')}</string>
  <key>StandardErrorPath</key>
  <string>${join(homedir(), '.crbro', 'miner_error.log')}</string>
</dict>
</plist>`;

  try {
    await writeFile(plistPath, plistContent, 'utf-8');
    execSync(`launchctl load "${plistPath}"`, { stdio: 'pipe' });

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

function setupLinux(): SchedulerResult {
  try {
    const npxPath = findNpxPath();
    const cronLine = `0 */${FREQUENCY_HOURS} * * * ${npxPath} -y crbro-memory mine >> ${join(homedir(), '.crbro', 'miner.log')} 2>&1`;

    // Get current crontab, filter out old CRBRO entries, add new one
    let currentCron = '';
    try {
      currentCron = execSync('crontab -l 2>/dev/null', { encoding: 'utf-8' });
    } catch { /* no existing crontab */ }

    const filtered = currentCron.split('\n').filter(l => !l.includes('crbro-memory mine'));
    filtered.push(cronLine);
    const newCron = filtered.filter(l => l.trim()).join('\n') + '\n';

    execSync(`echo "${newCron}" | crontab -`, { stdio: 'pipe' });

    return {
      success: true,
      platform: 'linux',
      method: 'Crontab',
      frequency: `Every ${FREQUENCY_HOURS} hours`,
      message: `✅ CRBRO Auto-Miner scheduled!\n\n` +
        `  Cron:       ${cronLine}\n` +
        `  Frequency:  Every ${FREQUENCY_HOURS} hours\n` +
        `  Log:        ~/.crbro/miner.log\n\n` +
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
    const cron = execSync('crontab -l 2>/dev/null', { encoding: 'utf-8' });
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

function findNpxPath(): string {
  try {
    const os = platform();
    if (os === 'win32') {
      return execSync('where npx', { encoding: 'utf-8' }).trim().split('\n')[0].trim();
    }
    return execSync('which npx', { encoding: 'utf-8' }).trim();
  } catch {
    return 'npx'; // Fallback to PATH
  }
}
