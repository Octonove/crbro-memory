import { atom, read, update } from 'claude-code'
import type { EngineInterface, McpToolResult, Register } from 'claude-code'

import type { PendingAction, PendingClosed, PendingItem, PendingLang, PendingSource } from '../types'
import { STRINGS, langOf } from './strings'
import type { Strings } from './strings'

// CRBRO's open items, above the prompt and in a pane.
//
// The band shows the newest open item in full (its «Label:» apart, its
// «(1) … (2) …» steps one per line, its age in color) and rotates through the
// rest; /pending (alias /pendientes) opens every item as a card, with a
// filter, «Work on this», «Done» and «Discard».
//
// The list comes from CRBRO itself: crbro_context with no arguments, which
// only reads. The server is whichever MCP server lists a tool ending in
// `__crbro_context` (`crbro` in a standard install), found with $.tool.list().
// When no such server is reachable the brain file is read instead,
// <CRBRO_PATH or ~/.crbro>/prefrontal/active_context.json. Closing and
// discarding always go through the server: this mod never writes the brain.

const PANE = 'crbro-pending'
const CONTEXT_TOOL = 'crbro_context'
const REFRESH_MS = 60_000
const DAY_MS = 86_400_000
const MAX_CLOSED = 10

/** Age colors, raw so they read the same in light and dark themes. */
const FRESH = '#16A34A'
const RECENT = '#D97706'
const OLD = '#DC2626'

const items = atom({ plugin: 'crbro-pending', key: 'items' } as const, [])
const closed = atom({ plugin: 'crbro-pending', key: 'closed' } as const, [])
const index = atom({ plugin: 'crbro-pending', key: 'index' } as const, 0)
const isHidden = atom({ plugin: 'crbro-pending', key: 'isHidden' } as const, false)
const isCompact = atom({ plugin: 'crbro-pending', key: 'isCompact' } as const, false)
const showClosed = atom({ plugin: 'crbro-pending', key: 'showClosed' } as const, false)
const filter = atom({ plugin: 'crbro-pending', key: 'filter' } as const, '')
const confirming = atom({ plugin: 'crbro-pending', key: 'confirming' } as const, null)
const busy = atom({ plugin: 'crbro-pending', key: 'busy' } as const, null)
const error = atom({ plugin: 'crbro-pending', key: 'error' } as const, null)
const lang = atom({ plugin: 'crbro-pending', key: 'lang' } as const, 'en')
const server = atom({ plugin: 'crbro-pending', key: 'server' } as const, null)
const source = atom({ plugin: 'crbro-pending', key: 'source' } as const, null)

/** The manifest's `language` option: `auto`, `en` or `es`. Set once per load. */
let configured = 'auto'
let lastSeen = ''

// ─── Pure helpers (exported for the tests) ──────────────────────

function daysOld(added: string, now: number): number | null {
  const at = Date.parse(added)
  return Number.isNaN(at) ? null : Math.floor((now - at) / DAY_MS)
}

export function age(t: Strings, added: string, now: number): string {
  const days = daysOld(added, now)
  if (days === null) return t.noDate
  if (days <= 0) return t.today
  if (days === 1) return t.yesterday
  if (days < 60) return t.daysAgo(days)
  return t.monthsAgo(Math.round(days / 30))
}

function ageColor(added: string, now: number): string {
  const days = daysOld(added, now)
  if (days === null || days > 14) return OLD
  return days <= 3 ? FRESH : RECENT
}

function shortDate(t: Strings, iso: string): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const day = new Date(at)
  return t.shortDate(day.getUTCDate(), t.months[day.getUTCMonth()] ?? '')
}

/**
 * «Fiverr: when…» reads better as the label «Fiverr» and the rest. Only when
 * the head (without parentheses) is short: «Decide the official domain of…: …»
 * is not a label.
 */
export function split(text: string): { label: string | null; body: string } {
  const colon = text.indexOf(':')
  if (colon > 0) {
    const head = text.slice(0, colon).replace(/\s*\([^)]*\)/g, '').trim()
    if (head.length > 0 && head.length <= 40 && head.split(/\s+/).length <= 6) {
      return { label: head, body: text.slice(colon + 1).trim() }
    }
  }
  return { label: null, body: text }
}

/** Long items carry steps «(1) … (2) …»: each one on its own line. */
export function lines(body: string): string[] {
  return body
    .split(/\s+(?=\(\d{1,2}\)\s)/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
}

/** Lower case without accents, so «campana» finds «campaña». */
function plain(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

function wrapIndex(n: number, length: number): number {
  return ((n % length) + length) % length
}

/**
 * Where the brain lives, resolved as src/engine/brain.ts resolves it:
 * CRBRO_PATH when it is a usable path (a `${…}` or `%VAR%` hole is not one,
 * `~` is the home folder, a relative path is taken inside the home folder),
 * otherwise <home>/.crbro. Forward slashes throughout.
 */
export function brainDir(home: string | undefined, crbroPath: string | undefined): string | undefined {
  const base = home?.trim() ? home.trim().replace(/\\/g, '/').replace(/\/+$/, '') : undefined
  const inHome = (rest: string) => (base === undefined ? undefined : rest ? `${base}/${rest}` : base)
  const raw = (crbroPath ?? '').trim().replace(/\\/g, '/')
  if (!raw || /\$\{|%[A-Za-z_][A-Za-z0-9_]*%/.test(raw)) return inHome('.crbro')
  if (raw === '~' || raw.startsWith('~/')) return inHome(raw.slice(2))
  if (!/^(?:[A-Za-z]:\/|\/)/.test(raw)) return inHome(raw)
  return raw.replace(/\/+$/, '')
}

/** The server part of `mcp__<server>__crbro_<tool>`, or null. */
export function serverOf(tool: string): string | null {
  const match = /^mcp__(.+)__crbro_[a-z_]+$/.exec(tool)
  return match?.[1] ?? null
}

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value
    .map(p => (typeof p === 'string' ? { id: '', text: p, added: '' } : p))
    .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null && typeof p.text === 'string')
}

/** The working context, as crbro_context answers it or as the brain file holds it. */
export function parse(raw: string): { open: PendingItem[]; done: PendingClosed[] } {
  const brain = JSON.parse(raw) as { pending_tasks?: unknown; recently_closed?: unknown }
  const open = rows(brain.pending_tasks)
    .map(p => ({ id: String(p.id ?? ''), text: String(p.text), added: String(p.added ?? '') }))
    .sort((a, b) => b.added.localeCompare(a.added))
  const done = rows(brain.recently_closed)
    .map(p => ({ id: String(p.id ?? ''), text: String(p.text), added: String(p.added ?? ''), closed: String(p.closed ?? '') }))
    .sort((a, b) => b.closed.localeCompare(a.closed))
    .slice(0, MAX_CLOSED)

  return { open, done }
}

/** What crbro_context closes an item by: its id, or its text for a v1 entry with none. */
function handle(p: PendingItem): string {
  return p.id || p.text
}

function textOf(result: McpToolResult): string {
  return result.content
    .map(block => ('text' in block && typeof block.text === 'string' ? block.text : ''))
    .join('')
    .trim()
}

// ─── Engine work ────────────────────────────────────────────────

async function resolveLang($: EngineInterface): Promise<PendingLang> {
  if (configured === 'en' || configured === 'es') return configured
  const asked = [
    await $.env.get('CRBRO_LANG'),
    await $.env.get('LC_ALL'),
    await $.env.get('LC_MESSAGES'),
    await $.env.get('LANG'),
  ].find(value => value !== undefined && value.trim() !== '' && value.trim().toLowerCase() !== 'auto')
  if (asked !== undefined) return langOf(asked)
  // Windows rarely sets LANG: the system locale is the next best signal.
  try {
    const locale = new Intl.DateTimeFormat().resolvedOptions().locale
    if (locale) return langOf(locale)
  } catch {
    // No Intl here: English.
  }
  return 'en'
}

async function words($: EngineInterface): Promise<Strings> {
  return STRINGS[await read($, lang)]
}

async function brainFile($: EngineInterface): Promise<string | undefined> {
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  const dir = brainDir(home, await $.env.get('CRBRO_PATH'))
  return dir ? `${dir}/prefrontal/active_context.json` : undefined
}

/** The CRBRO MCP server's name, remembered once seen; null while none is connected. */
async function findServer($: EngineInterface): Promise<string | null> {
  const known = await read($, server)
  if (known !== null) return known
  let names: string[]
  try {
    names = (await $.tool.list()).filter(tool => tool.mcp).map(tool => tool.name)
  } catch {
    return null
  }
  const found = names
    .filter(name => name.endsWith(`__${CONTEXT_TOOL}`))
    .map(name => serverOf(name))
    .filter((name): name is string => name !== null)
  const name = found.includes('crbro') ? 'crbro' : (found[0] ?? null)
  if (name !== null) await update($, server, () => name)
  return name
}

async function load($: EngineInterface): Promise<void> {
  const t = await words($)
  let data: { open: PendingItem[]; done: PendingClosed[] } | null = null
  let from: PendingSource | null = null

  const name = await findServer($)
  if (name !== null) {
    try {
      const result = await $.mcp.call(name, CONTEXT_TOOL, {})
      if (result.isError) throw new Error(textOf(result) || t.noDetail)
      data = parse(textOf(result))
      from = { kind: 'mcp', server: name }
    } catch {
      // Gone or failing: forget it, read the file, look for it again next time.
      await update($, server, () => null)
    }
  }

  if (data === null) {
    try {
      const path = await brainFile($)
      if (!path) throw new Error(t.noHome)
      data = parse(await $.fs.read(path))
      from = { kind: 'file', path }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await update($, error, () => message)
      return
    }
  }

  const { open, done } = data
  const seen = JSON.stringify([open, done, from])
  if (seen !== lastSeen) {
    lastSeen = seen
    await update($, items, () => open)
    await update($, closed, () => done)
    await update($, source, () => from)
  }
  await update($, error, () => null)
}

async function openList($: EngineInterface): Promise<void> {
  const t = await words($)
  await $.ui.open({ id: PANE, title: t.paneTitle })
}

async function showAll($: EngineInterface): Promise<{ text: string }> {
  await load($)
  await update($, isHidden, () => false)
  await openList($)
  const count = (await read($, items)).length

  return { text: (await words($)).commandAnswer(count) }
}

/** Leaves the item written in the prompt, for the person to finish and send. */
async function workOn($: EngineInterface, p: PendingItem): Promise<void> {
  const t = await words($)
  const filled = await $.prompt.fill({ text: t.workPrompt(p.id || '-', p.text) })
  if (!filled.isFilled) $.ui.toast(t.cannotFill)
}

async function setFilter($: EngineInterface, value: string): Promise<void> {
  await update($, filter, () => value)
}

async function askFirst($: EngineInterface, id: string, action: PendingAction): Promise<void> {
  await update($, confirming, () => ({ id, action }))
}

async function cancel($: EngineInterface): Promise<void> {
  await update($, confirming, () => null)
}

/** Closes (kept under «recently closed») or discards (not kept) through CRBRO's own tool. */
async function closeItem($: EngineInterface, p: PendingItem, action: PendingAction): Promise<void> {
  const t = await words($)
  const id = handle(p)
  await update($, confirming, () => null)
  await update($, busy, () => id)
  try {
    const name = await findServer($)
    if (name === null) throw new Error(t.noServer)
    const args = action === 'resolve' ? { resolve_pending: id } : { discard_pending: id }
    const result = await $.mcp.call(name, CONTEXT_TOOL, args)
    if (result.isError) throw new Error(textOf(result).slice(0, 160) || t.noDetail)
    await load($)
    const still = (await read($, items)).some(item => handle(item) === id)
    if (still) $.ui.toast(t.stillOpen(p.id || '-'))
    else $.ui.toast(action === 'resolve' ? t.resolved(p.id || '-') : t.discarded(p.id || '-'))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    $.ui.toast(t.closeFailed(message))
  } finally {
    await update($, busy, () => null)
  }
}

export const register: Register = (on, options) => {
  configured = typeof options.language === 'string' ? options.language : 'auto'

  on('session.start', async ($, e, next) => {
    const chosen = await resolveLang($)
    await update($, lang, () => chosen)
    const t = STRINGS[chosen]
    await $.command.register({ name: 'pending', description: t.commandDescription })
    await $.command.register({ name: 'pendientes', description: t.aliasDescription })
    await load($)
    $.clock.every(REFRESH_MS, () => {
      void load($)
    })

    return next(e)
  })

  on('command.run', { command: 'pending' }, async $ => showAll($))
  on('command.run', { command: 'pendientes' }, async $ => showAll($))

  // What CRBRO does (crbro_context, crbro_consolidate…) can open or close
  // items: after each of its tools the list is read again. The call also
  // names the server, so a server that connected late is found here.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const name = serverOf(e.tool)
    if (name !== null) {
      if ((await read($, server)) === null) await update($, server, () => name)
      // Awaited: one local read, and the band is right before the turn goes on.
      await load($)
    }

    return ran
  })

  // The band: the item in full (or one line, compacted) and the navigation.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, items)
    if (e.props.hasSurvey || list.length === 0 || (await read($, isHidden))) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const t = await words($)
    const now = await $.clock.now()
    const current = wrapIndex(await read($, index), list.length)
    const item = list[current]
    if (item === undefined) return next(e)
    const compact = await read($, isCompact)
    const { label, body } = split(item.text)
    const isMany = list.length > 1

    return (
      <Box flexDirection="column" width="100%">
        <Box flexDirection="row" gap={1}>
          <Text color="claude" bold>
            ◆ CRBRO
          </Text>
          <Text dimColor>{t.bandCount(list.length)}</Text>
          {isMany && <Button key="prev" label="‹" plain onPress={() => update($, index, n => n - 1)} />}
          {isMany && (
            <Text dimColor>
              {current + 1}/{list.length}
            </Text>
          )}
          {isMany && <Button key="next" label="›" plain onPress={() => update($, index, n => n + 1)} />}
          <Text color={ageColor(item.added, now)} bold>
            {age(t, item.added, now)}
          </Text>
          <Box flexGrow={1} />
          <Button
            key="mode"
            label={compact ? t.readAll : t.compact}
            plain
            onPress={() => update($, isCompact, c => !c)}
          />
          <Button key="all" label={t.seeAll} onPress={() => openList($)} />
          <Button key="hide" label={t.hide} onPress={() => update($, isHidden, () => true)} />
        </Box>
        {compact ? (
          <Text wrap="truncate-end">
            {label !== null && <Text bold>{label}: </Text>}
            {body}
          </Text>
        ) : (
          <Box flexDirection="column" paddingLeft={2}>
            {label !== null && (
              <Text color="claude" bold>
                {label}
              </Text>
            )}
            {lines(body).map(line => (
              <Text wrap="wrap">{line}</Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })

  // The pane: every open item as a card, with a filter and the actions.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const kit = $.ui.resolve(e)
    const { Box, Button, Text } = kit
    // Mobile draws no text field: the filter is left out there.
    const Input = 'Input' in kit ? kit.Input : null
    const t = await words($)
    const list = await read($, items)
    const done = await read($, closed)
    const problem = await read($, error)
    const hidden = await read($, isHidden)
    const query = await read($, filter)
    const asking = await read($, confirming)
    const working = await read($, busy)
    const isClosedOpen = await read($, showClosed)
    const from = await read($, source)
    const now = await $.clock.now()

    const needle = plain(query.trim())
    const shown = needle ? list.filter(p => plain(`${p.id} ${p.text}`).includes(needle)) : list
    const fresh = list.filter(p => (daysOld(p.added, now) ?? 99) <= 3).length
    const old = list.filter(p => (daysOld(p.added, now) ?? 99) > 14).length

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Text color="claude" bold>
            {t.heading}
          </Text>
          <Text bold>{t.openCount(list.length)}</Text>
        </Box>
        {list.length > 0 && (
          <Box flexDirection="row" columnGap={2} flexWrap="wrap">
            <Text color={FRESH}>{t.fresh(fresh)}</Text>
            <Text color={RECENT}>{t.recent(list.length - fresh - old)}</Text>
            <Text color={OLD}>{t.old(old)}</Text>
          </Box>
        )}
        {problem !== null && <Text color="warning">{t.readError(problem)}</Text>}
        {Input !== null && list.length > 0 && (
          <Input
            key="filter"
            placeholder={t.filterPlaceholder}
            value={query}
            onInput={(value: string) => setFilter($, value)}
            onSubmit={(value: string) => setFilter($, value)}
          />
        )}
        {needle.length > 0 && <Text dimColor>{t.matches(shown.length, list.length, query.trim())}</Text>}
        {list.length === 0 && problem === null && <Text dimColor>{t.none}</Text>}

        {shown.map((p, i) => {
          const { label, body } = split(p.text)
          const color = ageColor(p.added, now)
          const id = handle(p)
          const key = p.id || `n${i}`
          const isAsking = asking !== null && asking.id === id

          return (
            <Box key={`p-${key}`} flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
              <Box flexDirection="row" gap={1} flexWrap="wrap">
                {label !== null && (
                  <Text color="claude" bold>
                    {label}
                  </Text>
                )}
                <Text color={color} bold>
                  {age(t, p.added, now)}
                </Text>
                <Text dimColor>
                  {shortDate(t, p.added)}
                  {p.id ? ` · ${p.id}` : ''}
                </Text>
              </Box>
              {lines(body).map(line => (
                <Text wrap="wrap">{line}</Text>
              ))}
              {working === id ? (
                <Text dimColor>{t.closing}</Text>
              ) : isAsking ? (
                <Box flexDirection="row" gap={1} flexWrap="wrap">
                  <Text color="warning" bold>
                    {asking.action === 'resolve' ? t.askResolve : t.askDiscard}
                  </Text>
                  <Button key={`yes-${key}`} label={t.yes} variant="primary" onPress={() => closeItem($, p, asking.action)} />
                  <Button key={`no-${key}`} label={t.no} onPress={() => cancel($)} />
                </Box>
              ) : (
                <Box flexDirection="row" gap={1} flexWrap="wrap">
                  <Button key={`work-${key}`} label={t.workOn} variant="primary" onPress={() => workOn($, p)} />
                  <Button key={`done-${key}`} label={t.done} onPress={() => askFirst($, id, 'resolve')} />
                  <Button key={`drop-${key}`} label={t.discard} onPress={() => askFirst($, id, 'discard')} />
                </Box>
              )}
            </Box>
          )
        })}

        {done.length > 0 && (
          <Button
            key="closed"
            label={t.recentlyClosed(isClosedOpen, done.length)}
            plain
            onPress={() => update($, showClosed, open => !open)}
          />
        )}
        {isClosedOpen &&
          done.map((p, i) => (
            <Box key={`c-${p.id || `n${i}`}`} flexDirection="column" paddingLeft={2}>
              <Text color={FRESH}>{t.closedOn(shortDate(t, p.closed), p.id)}</Text>
              <Text dimColor wrap="wrap">
                {p.text}
              </Text>
            </Box>
          ))}

        <Text dimColor>{t.help}</Text>
        {from !== null && (
          <Text key="source" dimColor>
            {from.kind === 'mcp' ? t.fromServer(from.server) : t.fromFile(from.path)}
          </Text>
        )}
        <Box flexDirection="row" gap={1}>
          <Button key="reload" label={t.reload} onPress={() => load($)} />
          <Button key="band" label={hidden ? t.showBand : t.hideBand} onPress={() => update($, isHidden, h => !h)} />
          <Button key="close" label={t.close} role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })
}
