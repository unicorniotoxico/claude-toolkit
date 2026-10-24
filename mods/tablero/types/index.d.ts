export type Usage = {
  usd?: number
  ctxPercent?: number
  ctxTokens?: number
  ctxWindow: number
  limits: Limit[]
  /** cuándo llegó la lectura de límites (la última respuesta del modelo que la trajo) */
  limitsAt?: number
}
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type ToolStat = { calls: number; errors: number; lastMs: number; lastError?: string }
export type McpServer = { name: string; tools: number }
export type AgentRun = {
  description: string
  type: string
  model?: string
  status: string
  startedAt: number
  endedAt?: number
}
/** Lo que cada sesión local publica en ~/.claude/tablero/sesiones/<id>.json */
export type SessionSummary = {
  id: string
  folder: string
  usd?: number
  ctxPercent?: number
  activeAgents: number
  updatedAt: number
  ended?: boolean
  /** límites de la cuenta según la última respuesta de esa sesión: se comparten entre sesiones */
  limits?: Limit[]
  limitsAt?: number
}
/** Apariencia del panel; se guarda entre sesiones */
export type Look = {
  tema: string
  fondo: 'transparente' | 'oscuro' | 'negro'
  bordes: boolean
  compacto: boolean
}
/** Rol de la sesión; 'ninguno' = el usuario eligió no usar modo */
export type Mode = 'ciberseguridad' | 'desarrollo' | 'ambos' | 'ninguno'
export type MemStats ={ active: number; stale: number; prompts: number; injected: number; hookP95: number; error?: string }

declare module 'claude-code' {
  interface PluginState {
    tablero: {
      usage: Usage | null
      tools: Record<string, ToolStat>
      mcp: McpServer[]
      agents: Record<string, AgentRun>
      sessions: SessionSummary[]
      mem: MemStats | null
      updatedAt: number
      lastResponseAt: number
      now: number
      mode: Mode | null
      askOpen: boolean
      remember: boolean
      look: Look
      /** servidores MCP apagados desde el panel (se guardan entre sesiones) */
      mcpOff: string[]
      /** lista de sesiones cerradas o inactivas desplegada */
      showIdle: boolean
    }
  }
}
