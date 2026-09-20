// Runs before every test file: keyword-only unless a test says otherwise.
import os from 'node:os';
import path from 'node:path';

process.env.CRBRO_SEMANTIC ??= '0';

// No automatic backups from the suite. consolidate makes one a day next to the
// brain it belongs to, and every server test builds its brain in a temporary
// folder: the backup lands in a sibling of it that no afterAll removes. The
// tests that cover backups call the module directly with their own folder, and
// the one that covers consolidate switches this back on.
process.env.CRBRO_AUTOBACKUP ??= '0';

// No test ever reaches the real brain. Every server test sets CRBRO_PATH to a
// temporary folder of its own; this is for the one that forgets, or sets it too
// late: without it `new Brain()` falls back to ~/.crbro — and once did, writing
// a fake neuron into a live brain. HOME and USERPROFILE move too, because
// resolveBrainDir falls back to them the moment a test deletes CRBRO_PATH in
// its afterAll.
const sandbox = path.join(os.tmpdir(), `crbro-test-home-${process.pid}`);
process.env.CRBRO_PATH ??= path.join(sandbox, '.crbro');
process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox;
