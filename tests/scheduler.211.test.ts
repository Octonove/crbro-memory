// 2.11 miner scheduler: the crontab goes through stdin and the user's lines
// survive byte for byte (I1); the Windows task gets a quoted npx.cmd (I11).
// Every command is stubbed: nothing here touches the real crontab or Task Scheduler.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  setupScheduler, removeScheduler, findNpxPath, windowsCreateArgs, windowsTaskCommand, linuxCronLine,
  _setSchedulerRunnerForTests, type SchedRun,
} from '../src/miner/scheduler.js';

let brain: string;
const prevPath = process.env.CRBRO_PATH;
beforeEach(async () => {
  brain = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-sched-'));
  process.env.CRBRO_PATH = brain;
});
afterEach(async () => {
  _setSchedulerRunnerForTests(null);
  if (prevPath === undefined) delete process.env.CRBRO_PATH; else process.env.CRBRO_PATH = prevPath;
  await fs.rm(brain, { recursive: true, force: true });
});

const ajenas = [
  '# backups',
  '0 3 * * * echo "$(date)" >> /tmp/x',
  '15 4 * * * cd ~ && `which backup` --flag \'single quoted $HOME\'',
  '',
  '@reboot /usr/bin/env FOO="a b" run.sh',
].join('\n') + '\n';

function fakeCron(initial: string) {
  const state = { crontab: initial, calls: [] as Array<{ cmd: string; args: string[]; input?: string }> };
  _setSchedulerRunnerForTests((cmd, args, input): SchedRun => {
    state.calls.push({ cmd, args, input });
    if (cmd === 'which') return { status: 0, stdout: '/opt/node 22/bin/npx\n', stderr: '' };
    if (cmd === 'crontab' && args[0] === '-l') {
      return state.crontab ? { status: 0, stdout: state.crontab, stderr: '' } : { status: 1, stdout: '', stderr: 'no crontab for user' };
    }
    if (cmd === 'crontab' && args[0] === '-') { state.crontab = input ?? ''; return { status: 0, stdout: '', stderr: '' }; }
    return { status: 0, stdout: '', stderr: '' };
  }, 'linux');
  return state;
}

describe('crontab through stdin (I1)', () => {
  it('setup keeps every foreign line byte for byte and never uses a shell', async () => {
    const st = fakeCron(ajenas);
    const r = await setupScheduler();
    expect(r.success).toBe(true);
    expect(st.crontab.startsWith(ajenas.replace(/\n+$/, '\n'))).toBe(true);
    expect(st.crontab).toContain("'/opt/node 22/bin/npx' -y crbro-memory mine");
    expect(st.calls.every(c => c.cmd !== 'sh' && c.cmd !== 'bash' && !c.args.join(' ').includes('echo'))).toBe(true);
    // The previous crontab was saved next to the brain.
    const saved = (await fs.readdir(brain)).filter(f => f.startsWith('crontab.before-crbro-'));
    expect(saved).toHaveLength(1);
    expect(await fs.readFile(path.join(brain, saved[0]), 'utf8')).toBe(ajenas);
  });

  it('setup twice leaves one CRBRO line', async () => {
    const st = fakeCron(ajenas);
    await setupScheduler();
    await setupScheduler();
    expect(st.crontab.split('\n').filter(l => l.includes('crbro-memory mine'))).toHaveLength(1);
  });

  it('remove takes only our line out', async () => {
    const st = fakeCron(ajenas);
    await setupScheduler();
    const r = await removeScheduler();
    expect(r.success).toBe(true);
    expect(st.crontab).not.toContain('crbro-memory mine');
    expect(st.crontab).toContain('0 3 * * * echo "$(date)" >> /tmp/x');
    expect(st.crontab).toContain("'single quoted $HOME'");
  });

  it('a crontab that cannot be read is an error, not an empty one to overwrite', async () => {
    const st = fakeCron(ajenas);
    _setSchedulerRunnerForTests((cmd, args) => {
      st.calls.push({ cmd, args });
      if (cmd === 'crontab' && args[0] === '-l') return { status: 1, stdout: '', stderr: 'permission denied' };
      return { status: 0, stdout: '/usr/bin/npx\n', stderr: '' };
    }, 'linux');
    const r = await setupScheduler();
    expect(r.success).toBe(false);
    expect(st.calls.some(c => c.cmd === 'crontab' && c.args[0] === '-')).toBe(false);
  });

  it('the cron line quotes paths for /bin/sh', () => {
    expect(linuxCronLine("/home/o'neil/npx", '/b/miner.log')).toContain(`'/home/o'\\''neil/npx'`);
  });
});

describe('Windows task (I11)', () => {
  it('passes /TR as one argument with the quoted absolute npx.cmd', () => {
    const args = windowsCreateArgs('C:\\Program Files\\nodejs\\npx.cmd');
    const tr = args[args.indexOf('/TR') + 1];
    expect(tr).toBe('"C:\\Program Files\\nodejs\\npx.cmd" -y crbro-memory mine');
    expect(windowsTaskCommand('C:\\x\\npx.cmd')).toBe('"C:\\x\\npx.cmd" -y crbro-memory mine');
  });

  it('picks npx.cmd, not the extensionless script', () => {
    _setSchedulerRunnerForTests((cmd, args) => (cmd === 'where' && args[0] === 'npx.cmd'
      ? { status: 0, stdout: 'C:\\Program Files\\nodejs\\npx.cmd\r\n', stderr: '' }
      : { status: 1, stdout: '', stderr: '' }), 'win32');
    expect(findNpxPath()).toBe('C:\\Program Files\\nodejs\\npx.cmd');
  });

  it('setup runs schtasks without a shell and checks what was registered', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    _setSchedulerRunnerForTests((cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'where') return { status: 0, stdout: 'C:\\Program Files\\nodejs\\npx.cmd\r\n', stderr: '' };
      if (cmd === 'schtasks' && args.includes('/XML')) return { status: 0, stdout: '<Command>"C:\\Program Files\\nodejs\\npx.cmd"</Command><Arguments>-y crbro-memory mine</Arguments>', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    }, 'win32');
    const r = await setupScheduler();
    expect(r.success).toBe(true);
    const create = calls.find(c => c.cmd === 'schtasks' && c.args[0] === '/Create')!;
    expect(create.args).toEqual(windowsCreateArgs('C:\\Program Files\\nodejs\\npx.cmd'));
  });
});
