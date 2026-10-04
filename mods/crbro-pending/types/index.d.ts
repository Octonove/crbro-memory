export type PendingItem = { id: string; text: string; added: string }
export type PendingClosed = PendingItem & { closed: string }
export type PendingAction = 'resolve' | 'discard'
export type PendingLang = 'en' | 'es'
/** Where the list came from: the CRBRO MCP server, or the brain file read directly. */
export type PendingSource = { kind: 'mcp'; server: string } | { kind: 'file'; path: string }

declare module 'claude-code' {
  interface PluginState {
    'crbro-pending': {
      items: PendingItem[]
      closed: PendingClosed[]
      index: number
      isHidden: boolean
      isCompact: boolean
      showClosed: boolean
      filter: string
      confirming: { id: string; action: PendingAction } | null
      busy: string | null
      error: string | null
      lang: PendingLang
      /** The CRBRO MCP server's name, as `$.tool.list()` spells it, once found. */
      server: string | null
      source: PendingSource | null
    }
  }
}
