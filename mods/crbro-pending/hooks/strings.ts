import type { PendingLang } from '../types'

// Every word the mod shows, in one table per language. Nothing user-facing is
// written anywhere else: a new language is one more entry here.

export type Strings = {
  /** Short month names for «3 Oct» / «3-oct». */
  months: readonly string[]
  shortDate: (day: number, month: string) => string
  noDate: string
  today: string
  yesterday: string
  daysAgo: (n: number) => string
  monthsAgo: (n: number) => string

  commandDescription: string
  aliasDescription: string
  commandAnswer: (n: number) => string
  paneTitle: string

  bandCount: (n: number) => string
  compact: string
  readAll: string
  seeAll: string
  hide: string

  heading: string
  openCount: (n: number) => string
  fresh: (n: number) => string
  recent: (n: number) => string
  old: (n: number) => string
  readError: (reason: string) => string
  filterPlaceholder: string
  matches: (shown: number, total: number, query: string) => string
  none: string
  closing: string
  askResolve: string
  askDiscard: string
  yes: string
  no: string
  workOn: string
  done: string
  discard: string
  recentlyClosed: (isOpen: boolean, n: number) => string
  closedOn: (date: string, id: string) => string
  help: string
  reload: string
  showBand: string
  hideBand: string
  close: string
  fromServer: (server: string) => string
  fromFile: (path: string) => string

  workPrompt: (id: string, text: string) => string
  cannotFill: string
  stillOpen: (id: string) => string
  resolved: (id: string) => string
  discarded: (id: string) => string
  closeFailed: (reason: string) => string
  noServer: string
  noDetail: string
  noHome: string
}

const en: Strings = {
  months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  shortDate: (day, month) => `${day} ${month}`,
  noDate: 'no date',
  today: 'today',
  yesterday: 'yesterday',
  daysAgo: n => `${n} d ago`,
  monthsAgo: n => `${n} months ago`,

  commandDescription: 'CRBRO open items, in full and as cards (and shows the band again)',
  aliasDescription: 'Same as /pending (Spanish name)',
  commandAnswer: n => `CRBRO: ${n} open ${n === 1 ? 'item' : 'items'}.`,
  paneTitle: 'CRBRO open items',

  bandCount: n => `${n} open ${n === 1 ? 'item' : 'items'}`,
  compact: 'Compact',
  readAll: 'Read in full',
  seeAll: 'See all',
  hide: 'Hide',

  heading: '◆ CRBRO open items',
  openCount: n => `${n} open`,
  fresh: n => `● ${n} from the last 3 days`,
  recent: n => `● ${n} up to 2 weeks old`,
  old: n => `● ${n} older than 2 weeks`,
  readError: reason => `Could not read the CRBRO brain: ${reason}. Press Reload once it is available.`,
  filterPlaceholder: 'Filter: a project, a word…',
  matches: (shown, total, query) => `${shown} of ${total} match "${query}"`,
  none: 'No open items in CRBRO.',
  closing: 'Closing in CRBRO…',
  askResolve: 'Mark it as done?',
  askDiscard: 'Discard it without recording it?',
  yes: 'Yes',
  no: 'No',
  workOn: 'Work on this',
  done: 'Done',
  discard: 'Discard',
  recentlyClosed: (isOpen, n) => `${isOpen ? '▾' : '▸'} Recently closed (${n})`,
  closedOn: (date, id) => `✓ closed ${date} · ${id}`,
  help: '"Done" closes it in CRBRO and keeps it under "recently closed"; "Discard" removes it without recording it.',
  reload: 'Reload',
  showBand: 'Show band',
  hideBand: 'Hide band',
  close: 'Close',
  fromServer: server => `Read from the CRBRO server (${server}).`,
  fromFile: path => `Read from ${path}: the CRBRO server is not reachable in this session.`,

  workPrompt: (id, text) => `Let's work on this CRBRO open item (${id}): ${text}`,
  cannotFill: 'Cannot write in the prompt right now.',
  stillOpen: id => `CRBRO answered, but ${id} is still open.`,
  resolved: id => `${id} closed in CRBRO.`,
  discarded: id => `${id} discarded in CRBRO.`,
  closeFailed: reason => `CRBRO could not close it: ${reason}`,
  noServer: 'the CRBRO MCP server is not connected in this session',
  noDetail: 'error with no detail',
  noHome: 'cannot find the home folder (HOME/USERPROFILE)',
}

const es: Strings = {
  months: ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'],
  shortDate: (day, month) => `${day}-${month}`,
  noDate: 'sin fecha',
  today: 'hoy',
  yesterday: 'ayer',
  daysAgo: n => `hace ${n} d`,
  monthsAgo: n => `hace ${n} meses`,

  commandDescription: 'Pendientes abiertos de CRBRO, completos y en tarjetas (y vuelve a mostrar la banda)',
  aliasDescription: 'Pendientes abiertos de CRBRO (igual que /pending)',
  commandAnswer: n => `CRBRO: ${n} ${n === 1 ? 'pendiente abierto' : 'pendientes abiertos'}.`,
  paneTitle: 'Pendientes CRBRO',

  bandCount: n => `${n} ${n === 1 ? 'pendiente' : 'pendientes'}`,
  compact: 'Compactar',
  readAll: 'Leer entero',
  seeAll: 'Ver todos',
  hide: 'Ocultar',

  heading: '◆ Pendientes de CRBRO',
  openCount: n => `${n} ${n === 1 ? 'abierto' : 'abiertos'}`,
  fresh: n => `● ${n} de los últimos 3 días`,
  recent: n => `● ${n} de hasta 2 semanas`,
  old: n => `● ${n} con más de 2 semanas`,
  readError: reason => `No he podido leer el cerebro de CRBRO: ${reason}. Pulsa Recargar cuando esté disponible.`,
  filterPlaceholder: 'Filtrar: un proyecto, una palabra…',
  matches: (shown, total, query) => `${shown} de ${total} coinciden con «${query}»`,
  none: 'No hay pendientes abiertos en CRBRO.',
  closing: 'Cerrando en CRBRO…',
  askResolve: '¿Lo marco como hecho?',
  askDiscard: '¿Lo descarto sin registrarlo?',
  yes: 'Sí',
  no: 'No',
  workOn: 'Trabajar en esto',
  done: 'Hecho',
  discard: 'Descartar',
  recentlyClosed: (isOpen, n) => `${isOpen ? '▾' : '▸'} Cerrados hace poco (${n})`,
  closedOn: (date, id) => `✓ cerrado el ${date} · ${id}`,
  help: '«Hecho» lo cierra en CRBRO y queda en «cerrados hace poco»; «Descartar» lo quita sin registrarlo.',
  reload: 'Recargar',
  showBand: 'Mostrar banda',
  hideBand: 'Ocultar banda',
  close: 'Cerrar',
  fromServer: server => `Leído del servidor de CRBRO (${server}).`,
  fromFile: path => `Leído de ${path}: el servidor de CRBRO no está accesible en esta sesión.`,

  workPrompt: (id, text) => `Vamos con este pendiente de CRBRO (${id}): ${text}`,
  cannotFill: 'Ahora mismo no puedo escribir en el prompt.',
  stillOpen: id => `CRBRO respondió, pero ${id} sigue abierto.`,
  resolved: id => `${id} cerrado en CRBRO.`,
  discarded: id => `${id} descartado en CRBRO.`,
  closeFailed: reason => `CRBRO no ha podido cerrarlo: ${reason}`,
  noServer: 'el servidor MCP de CRBRO no está conectado en esta sesión',
  noDetail: 'error sin detalle',
  noHome: 'no encuentro la carpeta del usuario (HOME/USERPROFILE)',
}

export const STRINGS: Record<PendingLang, Strings> = { en, es }

/**
 * The language a locale string asks for: Spanish for `es`, `es_ES.UTF-8`,
 * `es-419`…; English for anything else, `C` and `POSIX` included.
 */
export function langOf(locale: string): PendingLang {
  return /^es(?:$|[-_.@])/i.test(locale.trim()) ? 'es' : 'en'
}
