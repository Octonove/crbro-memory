// Runs before every test file: keyword-only unless a test says otherwise.
process.env.CRBRO_SEMANTIC ??= '0';

// No automatic backups from the suite. consolidate makes one a day next to the
// brain it belongs to, and every server test builds its brain in a temporary
// folder: the backup lands in a sibling of it that no afterAll removes. The
// tests that cover backups call the module directly with their own folder, and
// the one that covers consolidate switches this back on.
process.env.CRBRO_AUTOBACKUP ??= '0';
