import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { brainDir, clip, lines, parse, serverOf, split } from '../hooks/register'
import { STRINGS, langOf } from '../hooks/strings'

// Run with: claude plugin test mods/crbro-pending

const LONG =
  'CRBRO after 2.5.1, waiting on the user: (1) run setx NODE_USE_SYSTEM_CA 1 ONCE; (2) restart Claude Desktop and Codex; (3) decide whether the old SSH passwords are cleaned up.'

const CONTEXT = {
  pending_tasks: [
    { id: 'p_old', text: 'Review the old campaign', added: '2026-09-01' },
    { id: 'p_new', text: 'Fiverr: decide whether the reels and ads gigs lose the AI voice-over', added: '2026-10-01' },
    { id: 'p_long', text: LONG, added: '2026-09-20' },
  ],
  recently_closed: [{ id: 'p_done', text: 'Pin discussion #1', added: '2026-09-04', closed: '2026-09-05' }],
}
const BRAIN = JSON.stringify(CONTEXT)
const NOW = Date.parse('2026-10-03T12:00:00Z')

const CRBRO_TOOLS = [
  { name: 'Bash', description: 'Runs a command', mcp: false },
  { name: 'mcp__crbro__crbro_recall', description: 'Recall', mcp: true },
  { name: 'mcp__crbro__crbro_context', description: 'Working context', mcp: true },
]

const BAND = {
  plugin: 'crbro-pending',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 8,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 7 },
    view: {},
  },
} as const

const PANE = {
  plugin: 'crbro-pending',
  surface: 'desktop',
  component: 'Pane',
  requestId: 'crbro-pending',
  props: {
    title: 'CRBRO open items',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const START = { cwd: 'C:/Users/Test', surface: 'desktop', isInteractive: true } as const

type Call = { server: string; tool: string; args: Record<string, unknown> }
const slashes = (path: string) => path.split('\\').join('/')

type Tool = { name: string; description: string; mcp: boolean }

/**
 * What the engine answers in a real session, answered by hand: the tools the
 * model has, the environment, and a CRBRO server that holds `brain` and closes
 * items in it the way crbro_context does.
 */
function engine(
  on: On,
  opts: {
    tools?: Tool[] | (() => Tool[])
    registered?: string[]
    opened?: string[]
    env?: Record<string, string>
    brain?: () => string
    calls?: Call[]
    onClose?: (id: string, action: 'resolve' | 'discard') => void
    isError?: boolean
    /** What the person has typed in the prompt box. */
    draft?: string
    /** Whether the pane finds room to open. */
    isPlaced?: boolean
  } = {},
) {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => {
    opts.registered?.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.open', (_, e) => {
    opts.opened?.push(e.title ?? '')
    return { value: opts.isPlaced === false ? { isPlaced: false, reason: 'too narrow' } : { isPlaced: true } }
  })
  on('prompt.read', () => ({ value: { text: opts.draft ?? '', cursor: (opts.draft ?? '').length } }))
  // What the engine would draw when the band gives its place up.
  on('ui.render', () => ({ type: 'Box', props: { key: 'engine' }, children: [] }))
  on('tool.list', () => ({ value: typeof opts.tools === 'function' ? opts.tools() : (opts.tools ?? CRBRO_TOOLS) }))
  mock.env(on, opts.env ?? { USERPROFILE: 'C:\\Users\\Test' })
  on('mcp.call', (_, e) => {
    opts.calls?.push({ server: e.server, tool: e.tool, args: e.args })
    if (opts.isError) return { value: { content: [{ type: 'text', text: 'CRBRO context error: disk full' }], isError: true } }
    const resolve = e.args.resolve_pending
    const discard = e.args.discard_pending
    if (typeof resolve === 'string') opts.onClose?.(resolve, 'resolve')
    if (typeof discard === 'string') opts.onClose?.(discard, 'discard')
    return { value: { content: [{ type: 'text', text: (opts.brain ?? (() => BRAIN))() }], isError: false } }
  })
}

test('labels and numbered steps are split, in any language', () => {
  expect(split('Fiverr: pin the thumbnail')).toEqual({ label: 'Fiverr', body: 'pin the thumbnail' })
  expect(split('Strategyon (strategyon.web.app, v1.2.0): confirm').label).toBe('Strategyon')
  expect(split('Decide the official Invokard domain before the X post of 11 Sep: something').label).toBeNull()
  expect(split('No colon here').label).toBeNull()
  const long = lines(split(LONG).body)
  expect(long).toHaveLength(4)
  expect(long[0]).toBe('CRBRO after 2.5.1, waiting on the user:')
  expect(long[3]).toBe('(3) decide whether the old SSH passwords are cleaned up.')
  expect(lines('(1) uno (2) dos')).toEqual(['(1) uno', '(2) dos'])
  // A colon inside a path, a URL or a time is not a label's.
  expect(split('C:/Users/x/proyectos/crbro-memory: revisar el instalador')).toEqual({
    label: 'C:/Users/x/proyectos/crbro-memory',
    body: 'revisar el instalador',
  })
  expect(split('https://github.com/Octonove/crbro-memory/issues/12 sigue abierta')).toEqual({
    label: null,
    body: 'https://github.com/Octonove/crbro-memory/issues/12 sigue abierta',
  })
  expect(split('10:30 llamada con Fiverr').label).toBeNull()
  expect(split('C: algo').label).toBeNull()
  expect(split('Hecho:').label).toBe('Hecho')
  expect(clip('x'.repeat(5000))).toHaveLength(2000)
  expect(clip('short')).toBe('short')
})

test('items with no id, and errors that end in a period, read well in both languages', () => {
  for (const t of [STRINGS.en, STRINGS.es]) {
    const texts = [
      t.closedOn('5 Sep', ''),
      t.closedOn('', ''),
      t.closedOn('', 'p_x'),
      t.workPrompt('', 'x'),
      t.resolved(''),
      t.discarded(''),
      t.stillOpen(''),
    ]
    for (const text of texts) expect(text).not.toMatch(/·\s*$|^\s*·|\(\)|\(-\)|^-|  /)
    expect(t.readError('ENOENT: no such file.')).not.toContain('..')
  }
  expect(STRINGS.en.closedOn('5 Sep', '')).toBe('✓ closed 5 Sep')
  expect(STRINGS.es.closedOn('', 'p_x')).toBe('✓ cerrado · p_x')
  expect(STRINGS.en.workPrompt('', 'Review it')).toBe("Let's work on this CRBRO open item: Review it")
  expect(STRINGS.es.resolved('')).toBe('Cerrado en CRBRO.')
})

test('the brain folder is resolved as the server resolves CRBRO_PATH', () => {
  expect(brainDir('C:\\Users\\Test', undefined)).toBe('C:/Users/Test/.crbro')
  expect(brainDir('/home/test/', '')).toBe('/home/test/.crbro')
  expect(brainDir('/home/test', '/srv/brains/work/')).toBe('/srv/brains/work')
  expect(brainDir('C:\\Users\\Test', 'D:\\Brains\\work')).toBe('D:/Brains/work')
  expect(brainDir('/home/test', '~/alt-brain')).toBe('/home/test/alt-brain')
  expect(brainDir('/home/test', '~')).toBe('/home/test')
  expect(brainDir('/home/test', 'relative/brain')).toBe('/home/test/relative/brain')
  // A launcher that never filled its template hole: the default, as brain.ts does.
  expect(brainDir('/home/test', '${user_config.brain_path}')).toBe('/home/test/.crbro')
  expect(brainDir('C:\\Users\\Test', '%APPDATA%\\crbro')).toBe('C:/Users/Test/.crbro')
  expect(brainDir(undefined, undefined)).toBeUndefined()
  expect(brainDir(undefined, '/abs/brain')).toBe('/abs/brain')
})

test('the server name comes from the tool name, whatever the server is called', () => {
  expect(serverOf('mcp__crbro__crbro_context')).toBe('crbro')
  expect(serverOf('mcp__plugin_memory_crbro__crbro_context')).toBe('plugin_memory_crbro')
  expect(serverOf('mcp__crbro__crbro_consolidate')).toBe('crbro')
  expect(serverOf('Bash')).toBeNull()
  expect(serverOf('mcp__other__search')).toBeNull()
})

test('locales pick the language; v1 brains with plain strings still read', () => {
  expect(langOf('es')).toBe('es')
  expect(langOf('es_ES.UTF-8')).toBe('es')
  expect(langOf('es-419')).toBe('es')
  expect(langOf('en_US.UTF-8')).toBe('en')
  expect(langOf('C')).toBe('en')
  expect(langOf('estonian')).toBe('en')
  const { open, done } = parse(JSON.stringify({ pending_tasks: ['an old v1 item', { id: 'p_x', text: 'new', added: '2026-01-01' }] }))
  expect(open.map(p => p.text)).toEqual(['new', 'an old v1 item'])
  expect(open[1]?.id).toBe('')
  expect(done).toEqual([])
  // Both tables say the same things.
  expect(Object.keys(STRINGS.es).sort()).toEqual(Object.keys(STRINGS.en).sort())
})

test('the band reads CRBRO through its server and shows the item in full (English)', { options: { language: 'en' } }, async ($, on) => {
  const calls: Call[] = []
  engine(on, { calls })
  mock.clock(on, { now: NOW })
  const reads: string[] = []
  on('fs.read', (_, e) => {
    reads.push(e.path)
    return { value: BRAIN }
  })

  await $.session.start(START)
  // Read-only crbro_context, on the server found by its tool; the file is never read.
  expect(calls[0]).toEqual({ server: 'crbro', tool: 'crbro_context', args: {} })
  expect(reads).toEqual([])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    // Newest first, its label apart and the text whole.
    expect(await ui.find({ text: 'Fiverr' })).toBeDefined()
    expect(await ui.find({ text: /lose the AI voice-over/ })).toBeDefined()
    expect(await ui.find({ text: '2 d ago' })).toBeDefined()
    expect(await ui.find({ text: '3 open items' })).toBeDefined()
    expect(await ui.find({ text: '1/3' })).toBeDefined()

    // The long one: each step on its line, the last one not cut.
    await ui.press({ key: 'next' })
    expect(await ui.find({ text: /^\(1\) run setx/ })).toBeDefined()
    expect(await ui.find({ text: /^\(3\) decide whether the old SSH passwords are cleaned up\.$/ })).toBeDefined()

    await ui.press({ key: 'next' })
    expect(await ui.find({ text: /Review the old campaign/ })).toBeDefined()
    expect(await ui.find({ text: '32 d ago' })).toBeDefined()

    await ui.press({ key: 'next' })
    expect(await ui.find({ text: /lose the AI voice-over/ })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ key: 'mode', text: 'Compact' })).toBeDefined()
  await ui.press({ key: 'mode' })
  expect(await ui.find({ key: 'mode', text: 'Read in full' })).toBeDefined()
  await ui.press({ key: 'mode' })
  expect(await ui.find({ key: 'all', text: 'See all' })).toBeDefined()

  await ui.press({ key: 'hide' })
  expect(await ui.find({ key: 'all' })).toBeUndefined()
  expect(await ui.find({ key: 'engine' })).toBeDefined()
})

test('the band in Spanish keeps every word of the original', { options: { language: 'es' } }, async ($, on) => {
  engine(on)
  mock.clock(on, { now: NOW })

  await $.session.start(START)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ text: '3 pendientes' })).toBeDefined()
    expect(await ui.find({ text: 'hace 2 d' })).toBeDefined()
    expect(await ui.find({ key: 'mode', text: 'Compactar' })).toBeDefined()
    expect(await ui.find({ key: 'all', text: 'Ver todos' })).toBeDefined()
    expect(await ui.find({ key: 'hide', text: 'Ocultar' })).toBeDefined()
    await ui.press({ key: 'mode' })
    expect(await ui.find({ key: 'mode', text: 'Leer entero' })).toBeDefined()
    await ui.press({ key: 'mode' })
    await ui.unmount()
  }
})

test('auto follows CRBRO_LANG, then LANG', { options: { language: 'auto' } }, async ($, on) => {
  engine(on, { env: { USERPROFILE: 'C:\\Users\\Test', LANG: 'es_ES.UTF-8' } })
  mock.clock(on, { now: NOW })
  await $.session.start(START)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ key: 'all', text: 'Ver todos' })).toBeDefined()
})

test('a language set in /config applies without waiting for session.start', { options: { language: 'es' } }, async ($, on) => {
  engine(on, { env: { USERPROFILE: 'C:\\Users\\Test', LANG: 'en_US.UTF-8' } })
  mock.clock(on, { now: NOW })
  // A reload after /config runs register() again; session.start may not fire.
  const pane = await $.ui.mount(PANE)
  expect(await pane.find({ key: 'reload', text: 'Recargar' })).toBeDefined()
})

test('CRBRO_LANG wins over LANG under auto', { options: { language: 'auto' } }, async ($, on) => {
  engine(on, { env: { USERPROFILE: 'C:\\Users\\Test', LANG: 'es_ES.UTF-8', CRBRO_LANG: 'en' } })
  mock.clock(on, { now: NOW })
  await $.session.start(START)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ key: 'all', text: 'See all' })).toBeDefined()
})

test('a CRBRO server under another name is found and used', { options: { language: 'en' } }, async ($, on) => {
  const calls: Call[] = []
  engine(on, {
    calls,
    tools: [{ name: 'mcp__plugin_memory_crbro__crbro_context', description: 'Working context', mcp: true }],
  })
  mock.clock(on, { now: NOW })
  await $.session.start(START)
  expect(calls[0]?.server).toBe('plugin_memory_crbro')
  const pane = await $.ui.mount(PANE)
  expect(await pane.find({ text: 'Read from the CRBRO server (plugin_memory_crbro).' })).toBeDefined()
})

test('without a CRBRO server the brain file is read, under CRBRO_PATH when set', { options: { language: 'en' } }, async ($, on) => {
  const calls: Call[] = []
  engine(on, {
    calls,
    tools: [{ name: 'Bash', description: 'Runs a command', mcp: false }],
    env: { USERPROFILE: 'C:\\Users\\Test', CRBRO_PATH: 'D:\\Brains\\work' },
  })
  mock.clock(on, { now: NOW })
  const reads: string[] = []
  on('fs.read', (_, e) => {
    reads.push(e.path)
    return { value: BRAIN }
  })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  await $.session.start(START)
  expect(calls).toEqual([])
  // The engine hands the path over in the platform's own spelling.
  expect(reads.map(slashes)).toEqual(['D:/Brains/work/prefrontal/active_context.json'])
  const pane = await $.ui.mount(PANE)
  expect(await pane.find({ text: '3 open' })).toBeDefined()
  expect(await pane.find({ text: /^Read from D:\/Brains\/work\/prefrontal\/active_context\.json/ })).toBeDefined()

  // Nothing can be closed without the server: it says so and touches nothing.
  await pane.press({ key: 'done-p_old' })
  await pane.press({ key: 'yes-p_old' })
  expect(calls).toEqual([])
  expect(toasts).toEqual(['CRBRO could not close it: the CRBRO MCP server is not connected in this session'])
  expect(await pane.find({ key: 'done-p_old' })).toBeDefined()
})

test('a failing server falls back to the file under the home folder', { options: { language: 'en' } }, async ($, on) => {
  engine(on, { isError: true, env: { HOME: '/home/test', USERPROFILE: 'C:\\Users\\Test' } })
  mock.clock(on, { now: NOW })
  const reads: string[] = []
  on('fs.read', (_, e) => {
    reads.push(e.path)
    return { value: BRAIN }
  })
  await $.session.start(START)
  // HOME first, as brain.ts reads it.
  expect(reads).toHaveLength(1)
  expect(slashes(reads[0] ?? '')).toMatch(/^(?:[A-Za-z]:)?\/home\/test\/\.crbro\/prefrontal\/active_context\.json$/)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: '3 open items' })).toBeDefined()
})

test('with no items, or no brain at all, the band draws nothing', { options: { language: 'en' } }, async ($, on) => {
  engine(on, { tools: [] })
  mock.clock(on, { now: 0 })
  on('fs.read', () => {
    throw new Error('ENOENT')
  })

  await $.session.start(START)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ key: 'all' })).toBeUndefined()
  expect(await ui.find({ key: 'engine' })).toBeDefined()
  const pane = await $.ui.mount(PANE)
  expect(await pane.find({ text: /^Could not read the CRBRO brain: .*Press Reload/ })).toBeDefined()
})

test('the pane shows whole cards, filters and sends the item to the prompt (English)', { options: { language: 'en' } }, async ($, on) => {
  engine(on)
  mock.clock(on, { now: NOW })
  const filled: string[] = []
  on('prompt.fill', (_, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })

  await $.session.start(START)
  for (const surface of ['terminal', 'desktop'] as const) {
    filled.length = 0
    const pane = await $.ui.mount({ ...PANE, surface })
    expect(await pane.find({ text: '3 open' })).toBeDefined()
    expect(await pane.find({ text: '● 1 from the last 3 days' })).toBeDefined()
    expect(await pane.find({ text: /^\(2\) restart Claude Desktop and Codex;$/ })).toBeDefined()
    expect(await pane.findAll({ type: 'Button', text: 'Done' })).toHaveLength(3)

    await pane.input({ key: 'filter', text: 'campaign', kind: 'change' })
    expect(await pane.find({ text: '1 of 3 match "campaign"' })).toBeDefined()
    expect(await pane.findAll({ type: 'Button', text: 'Done' })).toHaveLength(1)

    await pane.press({ key: 'work-p_old' })
    expect(filled).toEqual(["Let's work on this CRBRO open item (p_old): Review the old campaign"])

    // Recently closed, folded until asked for.
    expect(await pane.find({ text: /Pin discussion/ })).toBeUndefined()
    await pane.press({ key: 'closed' })
    expect(await pane.find({ text: /Pin discussion/ })).toBeDefined()
    expect(await pane.find({ text: '✓ closed 5 Sep · p_done' })).toBeDefined()
    // Back as it was for the next surface.
    await pane.press({ key: 'closed' })
    await pane.input({ key: 'filter', text: '', kind: 'change' })
    await pane.unmount()
  }
})

test('on mobile the pane draws the cards with no filter field', { options: { language: 'en' } }, async ($, on) => {
  engine(on)
  mock.clock(on, { now: NOW })
  await $.session.start(START)
  const pane = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect(await pane.find({ text: '3 open' })).toBeDefined()
  expect(await pane.findAll({ type: 'Button', text: 'Done' })).toHaveLength(3)
  expect(await pane.find({ key: 'filter' })).toBeUndefined()
})

test('«Work on this» keeps what the person had typed', { options: { language: 'en' } }, async ($, on) => {
  engine(on, { draft: 'first this' })
  mock.clock(on, { now: NOW })
  const filled: { text: string; mode?: string }[] = []
  on('prompt.fill', (_, e) => {
    filled.push({ text: e.text, mode: e.mode })
    return { isFilled: true }
  })
  await $.session.start(START)
  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'work-p_old' })
  expect(filled).toEqual([{ text: "\nLet's work on this CRBRO open item (p_old): Review the old campaign", mode: 'append' }])
})

test('a long list draws a bounded number of cards and says how many more', { options: { language: 'en' } }, async ($, on) => {
  const many = JSON.stringify({
    pending_tasks: Array.from({ length: 45 }, (_, i) => ({ id: `p_${i}`, text: `Item ${i} ${'y'.repeat(3000)}`, added: '2026-10-01' })),
  })
  engine(on, { brain: () => many })
  mock.clock(on, { now: NOW })
  await $.session.start(START)
  const pane = await $.ui.mount(PANE)
  expect(await pane.find({ text: '45 open' })).toBeDefined()
  expect(await pane.findAll({ type: 'Button', text: 'Done' })).toHaveLength(40)
  expect(await pane.find({ text: '5 more: filter to narrow the list.' })).toBeDefined()
  await pane.input({ key: 'filter', text: 'Item 44', kind: 'change' })
  expect(await pane.findAll({ type: 'Button', text: 'Done' })).toHaveLength(1)
})

test('«See all» says so when there is no room for the pane', { options: { language: 'es' } }, async ($, on) => {
  engine(on, { isPlaced: false })
  mock.clock(on, { now: NOW })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await $.session.start(START)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'all' })
  expect(toasts).toEqual(['CRBRO: aquí no hay sitio para la lista; ensancha la ventana.'])
})

test('the pane in Spanish, and the filter ignores accents', { options: { language: 'es' } }, async ($, on) => {
  const spanish = JSON.stringify({
    pending_tasks: [
      { id: 'p_viejo', text: 'Revisar la campaña antigua', added: '2026-09-01' },
      { id: 'p_nuevo', text: 'Fiverr: decidir la locución', added: '2026-10-01' },
    ],
    recently_closed: [{ id: 'p_hecho', text: 'Fijar la discusión #1', added: '2026-09-04', closed: '2026-09-05' }],
  })
  engine(on, { brain: () => spanish })
  mock.clock(on, { now: NOW })
  const filled: string[] = []
  on('prompt.fill', (_, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })

  await $.session.start(START)
  const pane = await $.ui.mount(PANE)
  expect(await pane.find({ text: '2 abiertos' })).toBeDefined()
  expect(await pane.find({ text: '● 1 de los últimos 3 días' })).toBeDefined()
  expect(await pane.findAll({ type: 'Button', text: 'Hecho' })).toHaveLength(2)
  expect(await pane.find({ text: 'Leído del servidor de CRBRO (crbro).' })).toBeDefined()

  await pane.input({ key: 'filter', text: 'campana', kind: 'change' })
  expect(await pane.find({ text: '1 de 2 coinciden con «campana»' })).toBeDefined()

  await pane.press({ key: 'work-p_viejo' })
  expect(filled).toEqual(['Vamos con este pendiente de CRBRO (p_viejo): Revisar la campaña antigua'])

  await pane.press({ key: 'closed' })
  expect(await pane.find({ text: '✓ cerrado el 5-sep · p_hecho' })).toBeDefined()
})

test('«Done» asks first and closes through the discovered server', { options: { language: 'es' } }, async ($, on) => {
  let brain = CONTEXT
  const calls: Call[] = []
  engine(on, {
    calls,
    brain: () => JSON.stringify(brain),
    onClose: id => {
      brain = { ...brain, pending_tasks: brain.pending_tasks.filter(p => p.id !== id) }
    },
  })
  mock.clock(on, { now: NOW })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  await $.session.start(START)
  const pane = await $.ui.mount(PANE)
  calls.length = 0

  await pane.press({ key: 'done-p_old' })
  expect(await pane.find({ text: '¿Lo marco como hecho?' })).toBeDefined()
  expect(calls).toHaveLength(0)

  // «No» leaves it as it was.
  await pane.press({ key: 'no-p_old' })
  expect(await pane.find({ text: '¿Lo marco como hecho?' })).toBeUndefined()

  await pane.press({ key: 'done-p_old' })
  await pane.press({ key: 'yes-p_old' })
  expect(calls[0]).toEqual({ server: 'crbro', tool: 'crbro_context', args: { resolve_pending: 'p_old' } })
  expect(await pane.find({ text: '2 abiertos' })).toBeDefined()
  expect(await pane.find({ key: 'done-p_old' })).toBeUndefined()
  expect(toasts).toEqual(['p_old cerrado en CRBRO.'])
})

test('«Discard» asks its own question and sends discard_pending', { options: { language: 'en' } }, async ($, on) => {
  let brain = CONTEXT
  const calls: Call[] = []
  engine(on, {
    calls,
    brain: () => JSON.stringify(brain),
    onClose: id => {
      brain = { ...brain, pending_tasks: brain.pending_tasks.filter(p => p.id !== id) }
    },
  })
  mock.clock(on, { now: NOW })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  await $.session.start(START)
  const pane = await $.ui.mount(PANE)
  calls.length = 0
  await pane.press({ key: 'drop-p_long' })
  expect(await pane.find({ text: 'Discard it without recording it?' })).toBeDefined()
  await pane.press({ key: 'yes-p_long' })
  expect(calls[0]).toEqual({ server: 'crbro', tool: 'crbro_context', args: { discard_pending: 'p_long' } })
  expect(await pane.find({ text: '2 open' })).toBeDefined()
  expect(toasts).toEqual(['p_long discarded in CRBRO.'])
})

test('a late CRBRO server is learnt from its first tool call', { options: { language: 'en' } }, async ($, on) => {
  const calls: Call[] = []
  // Not connected yet when the session starts.
  let tools: Tool[] = []
  engine(on, { calls, tools: () => tools })
  mock.clock(on, { now: NOW })
  on('fs.read', () => ({ value: JSON.stringify({ pending_tasks: [] }) }))
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))

  await $.session.start(START)
  expect(calls).toEqual([])
  tools = CRBRO_TOOLS
  // Any other tool goes by untouched.
  await $.tool.call({ tool: 'mcp__other__search', query: 'x' } as never)
  expect(calls).toEqual([])
  await $.tool.call({ tool: 'mcp__crbro__crbro_recall', query: 'x' } as never)
  expect(calls.some(c => c.server === 'crbro' && c.tool === 'crbro_context')).toBe(true)
})

test('/pending and /pendientes both open the list and answer the count', { options: { language: 'en' } }, async ($, on) => {
  const registered: string[] = []
  const opened: string[] = []
  engine(on, { registered, opened })
  mock.clock(on, { now: NOW })

  await $.session.start(START)
  expect(registered).toEqual(['pending', 'pendientes'])
  const one = await $.command.run({ command: 'pending', args: '' } as never)
  const two = await $.command.run({ command: 'pendientes', args: '' } as never)
  expect(one).toEqual({ text: 'CRBRO: 3 open items.' })
  expect(two).toEqual({ text: 'CRBRO: 3 open items.' })
  expect(opened).toEqual(['CRBRO open items', 'CRBRO open items'])
})
