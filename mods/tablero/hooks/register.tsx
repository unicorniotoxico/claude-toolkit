import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRun, Limit, Look, McpServer, MemStats, Mode, ResultadoHerramienta, SessionSummary, SolicitudHerramientas, ToolStat, Usage } from '../types'
import { AMBOS, CIBERSEGURIDAD, DESARROLLO } from './roles'
import { leerPropuesta } from './herramientas'
import { Equipos, planValidado, promptTarea, TIPOS } from './equipos'

// Qué se actualiza cómo:
//  - por eventos: agentes (agent.spawn / classic.SubagentStop / turn.complete del subagente), herramientas y
//    MCP (tool.call), consumo tras cada respuesta del modelo (turn.step), memory-engine al cerrar cada turno.
//  - por consulta: el consumo cada 2 s (esta sesión y las demás sesiones locales, que publican un archivo
//    cada una), el reloj de las duraciones cada 1 s mientras haya agentes activos, y una conciliación de
//    agentes y servidores MCP cada 30 s por si algo se cortó sin evento.

const PLAN = 'mcp__tablero__equipos_desarrollo'
const HERRAMIENTAS = 'mcp__tablero__herramientas_desarrollo'
const PHP = 'mcp__tablero__php_replay'
const lista = { type: 'array', items: { type: 'string' } }
const texto = { type: 'string' }

const PANE = 'tablero'
const TITLE = 'Tablero'
const usage = atom({ plugin: 'tablero', key: 'usage' } as const, null)
const tools = atom({ plugin: 'tablero', key: 'tools' } as const, {})
const mcp = atom({ plugin: 'tablero', key: 'mcp' } as const, [])
const agents = atom({ plugin: 'tablero', key: 'agents' } as const, {})
const sessions = atom({ plugin: 'tablero', key: 'sessions' } as const, [])
const mem = atom({ plugin: 'tablero', key: 'mem' } as const, null)
const updatedAt = atom({ plugin: 'tablero', key: 'updatedAt' } as const, 0)
const lastResponseAt = atom({ plugin: 'tablero', key: 'lastResponseAt' } as const, 0)
const clockNow = atom({ plugin: 'tablero', key: 'now' } as const, 0)
const mode = atom({ plugin: 'tablero', key: 'mode' } as const, null)
const askOpen = atom({ plugin: 'tablero', key: 'askOpen' } as const, false)
const remember = atom({ plugin: 'tablero', key: 'remember' } as const, true)
const DEFAULT_LOOK: Look = { tema: 'claude', fondo: 'transparente', bordes: false, compacto: false }
const look = atom({ plugin: 'tablero', key: 'look' } as const, DEFAULT_LOOK)
const mcpOff = atom({ plugin: 'tablero', key: 'mcpOff' } as const, [])
const equipos = atom({ plugin: 'tablero', key: 'equipos' } as const, [])
const tab = atom({ plugin: 'tablero', key: 'tab' } as const, 'general')
const seccionesAbiertas = atom({ plugin: 'tablero', key: 'seccionesAbiertas' } as const, [])
const avisosHerramientas = atom({ plugin: 'tablero', key: 'avisosHerramientas' } as const, true)
const solicitudHerramientas = atom({ plugin: 'tablero', key: 'solicitudHerramientas' } as const, null)
const detallesHerramientas = atom({ plugin: 'tablero', key: 'detallesHerramientas' } as const, [])
const excluidasHerramientas = atom({ plugin: 'tablero', key: 'excluidasHerramientas' } as const, [])
const showIdle = atom({ plugin: 'tablero', key: 'showIdle' } as const, false)

// Temas: colores de títulos, barras y estados. 'claude' sigue el tema de Claude Code (claro u oscuro).
type Tone = 'accent' | 'ok' | 'warn' | 'bad' | 'run' | 'muted'
export const THEMES: Record<string, Record<Tone | 'bar', string>> = {
  claude: { accent: 'claude', bar: 'claude', ok: 'success', warn: 'warning', bad: 'error', run: 'suggestion', muted: 'inactive' },
  oceano: { accent: '#4FC3F7', bar: '#29B6F6', ok: '#26A69A', warn: '#FFB74D', bad: '#EF5350', run: '#4DD0E1', muted: '#78909C' },
  matrix: { accent: '#00FF66', bar: '#00CC52', ok: '#00FF66', warn: '#CCFF00', bad: '#FF3B3B', run: '#7CFFB2', muted: '#3E7D55' },
  atardecer: { accent: '#FF8A65', bar: '#FF7043', ok: '#AED581', warn: '#FFD54F', bad: '#E57373', run: '#BA68C8', muted: '#A1887F' },
  sobrio: { accent: 'text', bar: '#9E9E9E', ok: '#BDBDBD', warn: '#E0E0E0', bad: '#FFFFFF', run: '#BDBDBD', muted: '#757575' },
  contraste: { accent: 'yellow', bar: 'white', ok: 'green', warn: 'yellow', bad: 'red', run: 'cyan', muted: 'gray' },
}
const BACKGROUNDS: Record<Look['fondo'], string | undefined> = { transparente: undefined, oscuro: '#1E1E2E', negro: '#000000' }
const nextOf = <T,>(list: readonly T[], cur: T) => list[(list.indexOf(cur) + 1) % list.length] as T

// Los límites son de la cuenta: vale la lectura más reciente de cualquier sesión local, no solo la de esta.
export function pickLimits(own: Usage | null, list: readonly SessionSummary[], ownId: string) {
  let best: { limits: Limit[]; at: number; from: string } | null = null
  if (own?.limits.length && own.limitsAt) best = { limits: own.limits, at: own.limitsAt, from: 'esta sesión' }
  for (const s of list) {
    if (s.id === ownId || !s.limits?.length || !s.limitsAt) continue
    if (!best || s.limitsAt > best.at) best = { limits: s.limits, at: s.limitsAt, from: s.folder || s.id.slice(0, 8) }
  }
  return best
}

// Modo de la sesión: la sesión principal adopta el rol (roles/<modo>.md) como sección del prompt de sistema
// y arma equipo con los subagentes cuando conviene. Se elige al iniciar y se puede recordar por carpeta.
export const MODES: Record<Exclude<Mode, 'ninguno'>, string> = {
  ciberseguridad: 'Ciberseguridad',
  desarrollo: 'Desarrollo',
  ambos: 'Desarrollo + Ciberseguridad',
}
const ROLES: Record<keyof typeof MODES, string> = { ciberseguridad: CIBERSEGURIDAD, desarrollo: DESARROLLO, ambos: AMBOS }
const isRole = (m: unknown): m is keyof typeof MODES => typeof m === 'string' && m in MODES
const modeLabel = (m: Mode | null) => (m === null ? 'sin elegir' : m === 'ninguno' ? 'sin modo' : MODES[m])
let modeKey = '' // carpeta de la sesión, para recordar el modo

const DONE = new Set(['completed', 'failed', 'killed'])
const MAX_AGENTS = 15
const USAGE_MS = 2000
const CLOCK_MS = 1000
const RECONCILE_MS = 30000
const HEARTBEAT_MS = 30000
const ACTIVE_MS = 90000 // una sesión sin latido en este lapso se muestra inactiva
const KEEP_MS = 24 * 3600 * 1000 // sesiones que entran en el total
const PURGE_MS = 7 * 24 * 3600 * 1000 // archivos de sesión que se borran

// mcp__<server>__<tool>: el server es el segundo tramo
const serverOf = (name: string) => (name.startsWith('mcp__') ? name.split('__')[1] : undefined)

const bar = (pct: number, width = 16) => {
  const n = Math.round((Math.max(0, Math.min(100, pct)) / 100) * width)
  return '█'.repeat(n) + '░'.repeat(width - n)
}
const STATUS: Record<string, [label: string, tone: 'ok' | 'warn' | 'bad' | 'run']> = {
  pending: ['en cola', 'warn'],
  running: ['corriendo', 'run'],
  waiting: ['esperando', 'warn'],
  idle: ['en espera', 'warn'],
  completed: ['terminado', 'ok'],
  failed: ['falló', 'bad'],
  killed: ['detenido', 'bad'],
}
const statusLabel = (s: string) => STATUS[s]?.[0] ?? s
const statusTone = (s: string) => STATUS[s]?.[1] ?? 'muted'
const duration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}
const usd = (n?: number) => (n === undefined ? '—' : `US$ ${n.toFixed(2)}`)
const k = (n?: number) => (n === undefined ? '?' : n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : `${n}`)

export function parseMemStats(out: string): MemStats {
  const kv: Record<string, number> = {}
  for (const [, key, value] of out.matchAll(/(\w+)=(\d+(?:\.\d+)?)/g)) if (key && value) kv[key] = Number(value)
  const estado = /estado:\s*\{([^}]*)\}/.exec(out)?.[1] ?? ''
  const count = (s: string) => Number(new RegExp(`'${s}':\\s*(\\d+)`).exec(estado)?.[1] ?? 0)
  return {
    active: count('active'),
    stale: count('stale'),
    prompts: kv.prompts ?? 0,
    injected: kv.recuerdos_inyectados ?? 0,
    hookP95: kv.hook_p95_ms ?? 0,
  }
}

// Cruza lo registrado al lanzar cada agente con su estado actual. Un agente que el motor ya soltó de la
// lista sin estado final se da por terminado.
export function mergeAgents(
  known: Record<string, AgentRun>,
  listed: readonly { id: string; description: string; type: string; status: string }[],
  now: number,
): Record<string, AgentRun> {
  const out: Record<string, AgentRun> = { ...known }
  const seen = new Set<string>()
  for (const a of listed) {
    seen.add(a.id)
    const prev = out[a.id] ?? { description: a.description, type: a.type, status: a.status, startedAt: now }
    const ended = DONE.has(a.status) ? (prev.endedAt ?? now) : undefined
    out[a.id] = { ...prev, description: a.description || prev.description, type: a.type, status: a.status, endedAt: ended }
  }
  for (const [id, a] of Object.entries(out)) {
    if (!seen.has(id) && !DONE.has(a.status)) out[id] = { ...a, status: 'completed', endedAt: a.endedAt ?? now }
  }
  return trimAgents(out)
}

function trimAgents(all: Record<string, AgentRun>) {
  return Object.fromEntries(Object.entries(all).sort((x, y) => y[1].startedAt - x[1].startedAt).slice(0, MAX_AGENTS))
}

// Las sesiones locales vigentes (incluida esta), sin las viejas, y el gasto sumado de todas.
export function summarizeSessions(list: readonly SessionSummary[], now: number) {
  const recent = list.filter(s => now - s.updatedAt <= KEEP_MS).sort((a, b) => b.updatedAt - a.updatedAt)
  const isActive = (s: SessionSummary) => !s.ended && now - s.updatedAt <= ACTIVE_MS
  const idle = recent.filter(s => !isActive(s))
  return {
    recent,
    isActive,
    active: recent.filter(isActive),
    idle,
    idleUsd: idle.reduce((sum, s) => sum + (s.usd ?? 0), 0),
    totalUsd: recent.reduce((sum, s) => sum + (s.usd ?? 0), 0),
    activeCount: recent.length - idle.length,
  }
}

// ---------------------------------------------------------------- estado del módulo (se reinicia al recargar)

let home = ''
let venvPython = '.venv/bin/python' // macOS/Linux; en Windows, .venv/Scripts/python.exe
let sessionId = ''
let folder = ''
let lastPublished = ''
let lastWriteAt = 0
const timers: { cancel: () => void }[] = []
const busy = new Set<string>()

const sessionsDir = () => `${home}/.claude/tablero/sesiones`

// Cada escritura redibuja el panel y algunos pulsos corren cada pocos segundos: se escribe solo si cambió.
const changed = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b)

async function safeNow($: EngineInterface) {
  try {
    return await $.clock.now()
  } catch {
    return 0
  }
}

// Corre `fn` salvo que la anterior del mismo tipo siga en curso: un pulso lento no se apila.
function once(name: string, fn: () => Promise<unknown>) {
  if (busy.has(name)) return
  busy.add(name)
  fn()
    .catch(() => {})
    .finally(() => busy.delete(name))
}

async function readMem($: EngineInterface): Promise<MemStats> {
  const base = `${home}/.claude/memory-engine`
  try {
    const r = await $.process.run([`${base}/${venvPython}`, '-I', `${base}/app/cli.py`, 'stats'], {
      timeoutMs: 10000,
    })
    if (r.exitCode !== 0) return { active: 0, stale: 0, prompts: 0, injected: 0, hookP95: 0, error: `exit ${r.exitCode}` }
    return parseMemStats(r.stdout)
  } catch {
    return { active: 0, stale: 0, prompts: 0, injected: 0, hookP95: 0, error: 'no disponible' }
  }
}

async function activeAgentCount($: EngineInterface) {
  return Object.values(await read($, agents)).filter(a => !DONE.has(a.status)).length
}

// Publica el resumen de esta sesión para las demás: al cambiar, o como latido cada 30 s.
async function publish($: EngineInterface, ended = false) {
  if (!sessionId || !home) return
  const u = await read($, usage)
  const body = {
    id: sessionId,
    folder,
    usd: u?.usd,
    ctxPercent: u?.ctxPercent,
    activeAgents: await activeAgentCount($),
    ended,
    limits: u?.limits.length ? u.limits : undefined,
    limitsAt: u?.limits.length ? u.limitsAt : undefined,
  }
  const now = await $.clock.now()
  const sig = JSON.stringify(body)
  if (sig === lastPublished && now - lastWriteAt < HEARTBEAT_MS) return
  const summary: SessionSummary = { ...body, updatedAt: now }
  await $.fs.write(`${sessionsDir()}/${sessionId}.json`, JSON.stringify(summary))
  lastPublished = sig
  lastWriteAt = now
}

async function readSessions($: EngineInterface) {
  if (!home) return
  const now = await $.clock.now()
  const out: SessionSummary[] = []
  let entries: { name: string; kind: string }[] = []
  try {
    entries = await $.fs.list(sessionsDir())
  } catch {
    return
  }
  for (const f of entries) {
    if (f.kind !== 'file' || !f.name.endsWith('.json')) continue
    try {
      const s = JSON.parse(String(await $.fs.read(`${sessionsDir()}/${f.name}`))) as SessionSummary
      if (typeof s.updatedAt !== 'number' || typeof s.id !== 'string') continue
      if (now - s.updatedAt > PURGE_MS) continue
      out.push(s)
    } catch {}
  }
  {
    const v = out.sort((a, b) => a.id.localeCompare(b.id))
    if (changed(await read($, sessions), v)) await update($, sessions, () => v)
  }
}

async function refreshUsage($: EngineInterface) {
  const u = await $.session.usage()
  const next: Usage = {
    usd: u.cost?.usd,
    ctxPercent: u.context.percent,
    ctxTokens: u.context.tokens,
    ctxWindow: u.context.window,
    limits: u.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
  }
  if (next.limits.length) {
    const prev = await read($, usage)
    const fresh = await read($, lastResponseAt)
    next.limitsAt = changed(prev?.limits, next.limits) ? await $.clock.now() : Math.max(prev?.limitsAt ?? 0, fresh)
  }
  {
    const v = next
    if (changed(await read($, usage), v)) await update($, usage, () => v)
  }
  await publish($)
}

async function reconcileAgents($: EngineInterface) {
  const listed = await $.agent.list()
  const now = await $.clock.now()
  {
    const v = mergeAgents(await read($, agents), listed, now)
    if (changed(await read($, agents), v)) await update($, agents, () => v)
  }
}

async function finishAgent($: EngineInterface, id: string, status: string) {
  const now = await $.clock.now()
  await update($, agents, all => {
    const a = all[id]
    if (!a || DONE.has(a.status)) return all
    return { ...all, [id]: { ...a, status, endedAt: now } }
  })
  await publish($)
}

async function refreshTools($: EngineInterface) {
  const counts = new Map<string, number>()
  for (const t of await $.tool.list()) {
    const s = t.mcp ? serverOf(t.name) : undefined
    if (s) counts.set(s, (counts.get(s) ?? 0) + 1)
  }
  const servers: McpServer[] = [...counts].map(([name, n]) => ({ name, tools: n })).sort((a, b) => a.name.localeCompare(b.name))
  {
    const v = servers
    if (changed(await read($, mcp), v)) await update($, mcp, () => v)
  }
}

async function refreshAll($: EngineInterface) {
  await refreshUsage($)
  await reconcileAgents($)
  await refreshTools($)
  await readSessions($)
  {
    const v = await readMem($)
    if (changed(await read($, mem), v)) await update($, mem, () => v)
  }
  const now = await $.clock.now()
  await update($, updatedAt, () => now)
}

function startTimers($: EngineInterface) {
  for (const t of timers.splice(0)) t.cancel()
  timers.push(
    $.clock.every(USAGE_MS, () => once('usage', () => refreshUsage($).then(() => readSessions($)))),
    $.clock.every(CLOCK_MS, () =>
      once('clock', async () => {
        // solo redibuja las duraciones mientras hay agentes corriendo; no consulta nada
        if ((await activeAgentCount($)) > 0) {
          const now = await $.clock.now()
          await update($, clockNow, () => now)
        }
      }),
    ),
    $.clock.every(RECONCILE_MS, () => once('reconcile', () => reconcileAgents($).then(() => refreshTools($)))),
  )
}

async function setMode($: EngineInterface, m: Mode) {
  await update($, mode, () => m)
  await update($, askOpen, () => false)
  try {
    if (modeKey) {
      if (await read($, remember)) await $.store.set(`modo:${modeKey}`, m)
      else await $.store.delete(`modo:${modeKey}`)
    }
  } catch {}
  // la sección del rol sale en el próximo pedido al modelo
  $.ui.invalidate('prompt.section')
  $.ui.toast(m === 'ninguno' ? 'Sesión sin modo' : `Modo ${MODES[m]} activo`)
}

// Un servidor apagado desde el panel: sus herramientas no corren y salen de la lista del prompt.
// El proceso del servidor sigue conectado (un mod no puede desconectarlo); /mcp lo hace del todo.
export function mcpBlock(off: readonly string[], tool: string): string | null {
  const server = serverOf(tool)
  if (!server || !off.includes(server)) return null
  return `El servidor MCP "${server}" está apagado desde el tablero. No lo uses; si hace falta, pedile al usuario que lo prenda (clic sobre él en el panel).`
}

async function toggleMcp($: EngineInterface, server: string) {
  const isOff = (await read($, mcpOff)).includes(server)
  await update($, mcpOff, list => (isOff ? list.filter(x => x !== server) : [...list, server].sort()))
  try {
    await $.store.set('mcpApagados', await read($, mcpOff))
  } catch {}
  // la lista de herramientas del prompt cambia en el próximo pedido al modelo
  $.ui.invalidate('tool.describe')
  $.ui.toast(isOff ? `MCP ${server} prendido` : `MCP ${server} apagado`)
}

function toggleSection($: EngineInterface, id: string) {
  return update($, seccionesAbiertas, ids => ids.includes(id) ? ids.filter(current => current !== id) : [...ids, id])
}

async function setLook($: EngineInterface, change: (l: Look) => Look) {
  await update($, look, change)
  try {
    await $.store.set('apariencia', await read($, look))
  } catch {}
}

function avisarResultado($: EngineInterface) {
  void $.prompt.submit({
    text: 'El usuario resolvió el aviso de herramientas. Consultá herramientas_desarrollo con acción estado y continuá la tarea según esa decisión. Si eligió seguir sin instalar, usá las herramientas disponibles.',
  }).catch(() => {})
}

async function instalarHerramientas($: EngineInterface, solicitud: SolicitudHerramientas) {
  const base = $.plugin.root + '/../../memory-engine'
  const rutaPython = base + '/' + venvPython
  const script = $.plugin.root + '/scripts/install_tool.py'
  const resultados: NonNullable<SolicitudHerramientas['resultados']> = []
  for (const herramienta of solicitud.herramientas) {
    let resultado: ResultadoHerramienta
    try {
      const salida = await $.process.run([rutaPython, '-I', script], {
        timeoutMs: 270_000,
        stdin: JSON.stringify(herramienta),
      })
      if (salida.exitCode !== 0 || salida.isStdoutTruncated) throw new Error('El instalador no devolvió un resultado.')
      resultado = JSON.parse(salida.stdout) as ResultadoHerramienta
    } catch (error) {
      resultado = { estado: 'error', detalle: String(error).slice(0, 300) }
    }
    resultados.push({ ...herramienta, ...resultado })
  }
  try {
    const guardadas = await $.store.get('herramientasDisponibles')
    const recientes = [
      ...resultados.filter(r => r.estado === 'disponible' && r.ruta),
      ...(Array.isArray(guardadas) ? guardadas : []),
    ]
    const distintas = recientes.filter((r, i) => recientes.findIndex(x => x.gestor === r.gestor && x.paquete === r.paquete) === i)
    await $.store.set('herramientasDisponibles', distintas.slice(0, 30))
  } catch {}
  const finalizada: SolicitudHerramientas = { ...solicitud, estado: 'finalizada', resultados }
  await update($, solicitudHerramientas, () => finalizada)
  avisarResultado($)
}

let resolviendoAviso = false

async function resolverAviso($: EngineInterface, instalar: boolean) {
  const solicitud = await read($, solicitudHerramientas)
  if (resolviendoAviso || solicitud?.estado !== 'pendiente') return
  resolviendoAviso = true
  try {
    const excluidas = await read($, excluidasHerramientas)
    const elegidas = solicitud.herramientas.filter(h => !excluidas.includes(h.gestor + ':' + h.paquete))
    if (instalar && !elegidas.length) return
    const estado = instalar ? 'instalando' : 'omitida'
    await update($, solicitudHerramientas, () => ({ ...solicitud, estado }))
    if (instalar) {
      $.clock.after(1, () => instalarHerramientas($, { ...solicitud, herramientas: elegidas }))
    } else {
      avisarResultado($)
    }
  } finally {
    resolviendoAviso = false
  }
}

async function alternarAvisos($: EngineInterface) {
  const activo = await read($, avisosHerramientas)
  await update($, avisosHerramientas, () => !activo)
  try { await $.store.set('avisosHerramientas', !activo) } catch {}
  if (activo) await resolverAviso($, false)
}

// ---------------------------------------------------------------- hooks

async function iniciarDesarrollo($: EngineInterface) {
  await $.command.register({ name: 'equipos', immediate: true, description: 'Muestra los equipos y comprobaciones de Desarrollo' })
  await $.tool.register({ name: 'equipos_desarrollo', description: 'Planifica y sigue equipos de Desarrollo. iniciar define tareas con dependencias; estado devuelve evidencia; reintentar reasigna un fallo concluido o una implementación que requiere corrección y vuelve a comprobar sus dependencias.',
    inputSchema: {
      type: 'object', required: ['accion'], properties: {
        accion: { enum: ['iniciar', 'estado', 'reintentar'] },
        tareas: { type: 'array', items: {
          type: 'object', required: ['id', 'equipo', 'tipo', 'objetivo'], properties: {
            id: texto, equipo: texto, tipo: { enum: [...TIPOS] }, objetivo: texto,
            depende: lista, archivos: lista, simulacionPHP: { type: 'boolean' },
          },
        } },
        concurrencia: { type: 'integer', minimum: 1, maximum: 3 },
        minutos: { type: 'integer', minimum: 1, maximum: 30 },
        id: texto, ajuste: texto,
      },
    },
  })
  await $.tool.register({
    name: 'herramientas_desarrollo',
    description: 'Consultá estado y rutas ya registradas o proponé herramientas faltantes para un diagnóstico concreto. El tablero solicita la decisión del usuario.',
    inputSchema: { type: 'object', required: ['accion'], properties: {
      accion: { enum: ['estado', 'proponer'] },
      herramientas: { type: 'array', items: {
        type: 'object', required: ['nombre', 'motivo', 'gestor', 'paquete', 'ejecutable'],
        properties: { nombre: texto, motivo: texto, gestor: { enum: ['winget', 'brew', 'apt', 'go'] }, paquete: texto, ejecutable: texto },
      } },
    } },
  })
  await $.tool.register({ name: 'php_replay', description: 'Solo para el verificador PHP asignado. Ejecuta el mismo driver contra el commit base y el PHP actual en Docker sin red. El driver PHP lee stdin, usa /app para los fuentes y escribe el resultado observado. Comparación literal de stdout.',
    inputSchema: {
      type: 'object', required: ['archivos', 'driver', 'casos'], properties: {
        archivos: lista, driver: texto,
        casos: { type: 'array', items: {
          type: 'object', required: ['id', 'entrada', 'esperado', 'relacion'], properties: {
            id: texto, entrada: texto, esperado: texto, relacion: { enum: ['igual', 'distinto', 'cualquiera'] },
          },
        } },
      },
    },
  })
  const comunes = { omitClaudeMd: true as const, maxTurns: 10 }
  const lectura = ['Read', 'Grep', 'Glob']
  const terminales = (await $.tool.list().catch(() => []))
    .filter(t => t.name === 'Bash' || t.name === 'PowerShell')
    .map(t => t.name)
  if (!terminales.length) terminales.push('Bash')
  await $.agent.register({ ...comunes, name: 'desarrollo-dev', model: 'sonnet', maxTurns: 24,
    description: 'Implementa una pieza del plan de Desarrollo.',
    tools: [...lectura, 'Edit', 'Write', ...terminales],
    prompt: 'Implementas una sola tarea del orquestador. Respeta sus rutas y criterios. Consulta las etapas pertinentes de ub-mode y devuelve evidencia compacta.',
  })
  await $.agent.register({ ...comunes, name: 'desarrollo-verificador', model: 'haiku',
    description: 'Prepara evidencia o verifica un requisito concreto.',
    tools: [...lectura, ...terminales],
    prompt: 'Eres un verificador independiente. Usa análisis estático o comandos de prueba offline acotados. No modifiques el producto. Informa solo evidencia observada.',
  })
  await $.agent.register({ ...comunes, name: 'desarrollo-php', model: 'haiku',
    description: 'Traza PHP y verifica el comportamiento mediante php_replay.',
    tools: [...lectura, PHP],
    prompt: 'Eres un verificador PHP independiente. Traza los caminos del código. Prepara un driver que ejecute los fuentes montados en /app, reemplace dependencias por datos de prueba y devuelva evidencia del comportamiento. No leas credenciales ni copies lógica del producto al driver.',
  })
}
export const register: Register = on => {
  let flujo: Equipos | undefined
  let iniciando = false
  let programado: { cancel(): void } | undefined
  let cerrando = false
  const replays = new Set<string>()

  function cerrarDesarrollo() {
    cerrando = true
    programado?.cancel()
    flujo?.cerrar()
  }

  on('command.run', { command: 'equipos' }, () => {
    const filas = flujo?.resumen() ?? []
    return { text: filas.length ? filas.map(f =>
      f.equipo + ' · ' + f.id + ' · ' + f.estado + (f.demorada ? ' · demorada' : '') +
      (f.verificacion ? ' · PHP ' + f.verificacion : ''),
    ).join('\n') : 'Todavía no hay equipos en esta sesión.' }
  })

  on('tool.run', { tool: HERRAMIENTAS }, async ($, e) => {
    const seleccionado = await read($, mode)
    if (e.agentId || (seleccionado !== 'desarrollo' && seleccionado !== 'ambos'))
      return { deny: 'La solicitud la gestiona el orquestador de Desarrollo.' }
    const args = e as unknown as Record<string, unknown>
    if (args.accion === 'estado') {
      const disponibles = await $.store.get('herramientasDisponibles')
      return { result: JSON.stringify({
        avisos: await read($, avisosHerramientas),
        solicitud: await read($, solicitudHerramientas),
        disponibles: Array.isArray(disponibles) ? disponibles : [],
      }) }
    }
    if (args.accion !== 'proponer') return { deny: 'Acción inválida.' }
    if (!(await read($, avisosHerramientas))) return { result: 'Avisos desactivados. Continuá con las herramientas disponibles.' }
    const actual = await read($, solicitudHerramientas)
    if (actual?.estado === 'pendiente' || actual?.estado === 'instalando')
      return { result: 'Ya hay un aviso en curso. Continuá con el trabajo independiente y esperá la decisión sin consultar en bucle.' }
    try {
      const herramientas = leerPropuesta(args.herramientas)
      await update($, detallesHerramientas, () => [])
      await update($, excluidasHerramientas, () => [])
      await update($, solicitudHerramientas, () => ({ estado: 'pendiente', herramientas }))
      void $.ui.open({ id: PANE, title: TITLE }).catch(() => {})
      return { result: 'Aviso visible en el tablero. Podés avanzar con tareas independientes. El tablero comunicará la decisión cuando el usuario responda.' }
    } catch (error) {
      return { deny: String(error).slice(0, 260) }
    }
  })

  on('tool.run', { tool: PLAN }, async ($, e) => {
    const seleccionado = await read($, mode)
    if (e.agentId || (seleccionado !== 'desarrollo' && seleccionado !== 'ambos')) return { deny: 'Solo el orquestador en Desarrollo o Ambos puede gestionar equipos.' }
    const args = e as unknown as Record<string, unknown>
    if (args.accion === 'estado') {
      const filas = flujo?.resumen(true) ?? []
      return { result: JSON.stringify(typeof args.id === 'string'
        ? filas.filter(f => f.id === args.id)
        : filas.map(({ evidencia, ...fila }) => fila)) }
    }
    try {
      if (args.accion === 'reintentar' && flujo && typeof args.id === 'string' && typeof args.ajuste === 'string') {
        await flujo.reintentar(args.id, args.ajuste)
        return { result: JSON.stringify(flujo.resumen()) }
      }
      if (args.accion !== 'iniciar') return { deny: 'Acción inválida.' }
      if (flujo?.activo || iniciando) return { deny: 'Ya hay un plan en curso.' }
      iniciando = true
      try {
        const plan = planValidado(args.tareas)
        const n = args.concurrencia ?? 2
        const minutos = args.minutos ?? 10
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 3 ||
            typeof minutos !== 'number' || !Number.isInteger(minutos) || minutos < 1 || minutos > 30)
          throw new Error('Concurrencia entre 1 y 3, punto de control entre 1 y 30 minutos.')
        const root = await $.session.root()
        const base = await $.process.run(['git', '-C', root, 'rev-parse', '--verify', 'HEAD'], { timeoutMs: 5000 })
          .then(r => r.exitCode === 0 ? r.stdout.trim() : '', () => '')
        flujo?.cerrar()
        const nuevo: Equipos = new Equipos({
          lanzar: (t, evidencia) => {
            const tipo = t.tipo === 'implementacion' ? 'desarrollo-dev' : t.simulacionPHP ? 'desarrollo-php' : 'desarrollo-verificador'
            const instrucciones = t.tipo === 'implementacion'
              ? '\nGuía ub-mode: ' + $.plugin.root + '/skills/ub-mode/SKILL.md. Lee las fases pertinentes. Conserva la entrega local.'
              : ''
            return $.agent.spawn({
              cwd: root,
              subagentType: 'tablero:' + tipo,
              description: (t.equipo + ': ' + t.id).slice(0, 100),
              prompt: promptTarea(t, evidencia) + instrucciones + (base ? '\nCommit base: ' + base : ''),
            })
          },
          actualizar: () => { void update($, equipos, () => nuevo.resumen()) },
          aviso: t => { void $.ui.toast(t.equipo + ' · ' + t.id + ': llegó al punto de control. Revisá el avance en /equipos.') },
          reloj: (ms, callback) => {
            const timer = $.clock.after(ms, callback)
            return () => timer.cancel()
          },
        }, plan, n, minutos * 60_000, base)
        flujo = nuevo
        await flujo.avanzar()
        return { result: JSON.stringify(flujo.resumen()) }
      } finally {
        iniciando = false
      }
    } catch (error) {
      return { deny: String(error).slice(0, 600) }
    }
  })

  on('tool.run', { tool: PHP }, async ($, e) => {
    const t = flujo?.buscar(e.agentId)
    if (!flujo || !t?.simulacionPHP || !e.agentId) return { deny: 'Disponible solo para el verificador PHP de una tarea activa.' }
    if (!flujo.base) return { deny: 'La comparación PHP necesita un commit base disponible.' }
    const args = e as unknown as Record<string, unknown>
    if (!Array.isArray(args.archivos) || !args.archivos.every(a => typeof a === 'string' &&
      t.archivos.some(p => a === p || a.startsWith(p + '/'))) ||
      !t.archivos.filter(p => p.toLowerCase().endsWith('.php')).every(p => (args.archivos as string[]).includes(p)))
      return { deny: 'Incluí solo fuentes PHP declarados en la tarea.' }
    if (replays.has(e.agentId)) return { deny: 'Ya hay una simulación en curso para esta tarea.' }
    replays.add(e.agentId)
    try {
      const root = await $.session.root()
      const windows = (await $.env.get('OS')) === 'Windows_NT'
      const engine = $.plugin.root + '/../../memory-engine'
      const python = engine + (windows ? '/.venv/Scripts/python.exe' : '/.venv/bin/python')
      const script = $.plugin.root + '/scripts/php_replay.py'
      const run = await $.process.run([python, '-I', script], {
        cwd: root, timeoutMs: 145_000,
        stdin: JSON.stringify({ base: flujo.base, archivos: args.archivos, casos: args.casos, driver: args.driver }),
      })
      if (run.exitCode !== 0 || run.isStdoutTruncated) throw new Error('El ejecutor PHP no devolvió un informe completo.')
      const evidencia = run.stdout.trim()
      const resultado = JSON.parse(evidencia) as { estado?: string; detalle?: string }
      if (!['verificado', 'diferencias', 'pendiente'].includes(resultado.estado ?? ''))
        throw new Error('Estado de simulación inválido.')
      t.simulacion = { estado: resultado.estado!, evidencia, detalle: resultado.detalle }
      const filas = flujo.resumen()
      void update($, equipos, () => filas)
      return { result: evidencia }
    } catch (error) {
      t.simulacion = { estado: 'pendiente', detalle: String(error).slice(0, 400) }
      return { result: JSON.stringify(t.simulacion) }
    } finally {
      replays.delete(e.agentId)
    }
  })

  on('agent.offer', { agent: 'tablero:desarrollo-dev' }, () => ({ isOffered: false }))
  on('agent.offer', { agent: 'tablero:desarrollo-verificador' }, () => ({ isOffered: false }))
  on('agent.offer', { agent: 'tablero:desarrollo-php' }, () => ({ isOffered: false }))

  on('session.start', async ($, e, next) => {
    await iniciarDesarrollo($)
    await $.command.register({ name: 'tablero', description: 'Abre el tablero de gasto, agentes, herramientas y memoria' })
    await $.command.register({ name: 'modo', description: 'Elige el modo de la sesión: ciberseguridad, desarrollo o ambos' })
    const ran = await next(e)
    try {
      home = ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '').replace(/\\/g, '/')
      if ((await $.env.get('OS')) === 'Windows_NT') venvPython = '.venv/Scripts/python.exe'
      sessionId = (await $.session.id()).replace(/[^A-Za-z0-9_-]/g, '')
      const root = (await $.session.root()).replace(/\\/g, '/')
      folder = root.split('/').filter(Boolean).pop() ?? ''
      modeKey = root.toLowerCase()
    } catch {}
    // modo: el recordado para esta carpeta, o preguntar (una sola vez por sesión)
    try {
      if ((await read($, mode)) === null) {
        const saved = modeKey ? await $.store.get(`modo:${modeKey}`) : undefined
        if (isRole(saved) || saved === 'ninguno') {
          await update($, mode, () => saved)
          $.ui.invalidate('prompt.section')
          $.ui.toast(`Modo ${modeLabel(saved)} (recordado para esta carpeta) · /modo para cambiarlo`)
        } else {
          await update($, askOpen, () => true)
        }
      }
    } catch {}
    try {
      const saved = (await $.store.get('apariencia')) as Partial<Look> | undefined
      if (saved && typeof saved === 'object') {
        const v: Look = {
          tema: typeof saved.tema === 'string' && saved.tema in THEMES ? saved.tema : DEFAULT_LOOK.tema,
          fondo: saved.fondo && saved.fondo in BACKGROUNDS ? saved.fondo : DEFAULT_LOOK.fondo,
          bordes: saved.bordes === true,
          compacto: saved.compacto === true,
        }
        await update($, look, () => v)
      }
    } catch {}
    try {
      const off = await $.store.get('mcpApagados')
      if (Array.isArray(off)) {
        const v = off.filter((x): x is string => typeof x === 'string')
        await update($, mcpOff, () => v)
        if (v.length) $.ui.invalidate('tool.describe')
      }
    } catch {}
    try {
      if ((await $.store.get('avisosHerramientas')) === false)
        await update($, avisosHerramientas, () => false)
    } catch {}
    void $.ui.open({ id: PANE, title: TITLE }) // se abre solo; /tablero lo reabre si se cerró
    startTimers($)
    once('all', () => refreshAll($))
    return ran
  })

  // el motor empuja el consumo cuando cambia (fin de turno, un punto de límite): sin esperar al pulso
  on('session.measure', async ($, e, next) => {
    const ran = await next(e)
    once('usage', () => refreshUsage($))
    return ran
  })

  on('session.end', async ($, e, next) => {
    cerrarDesarrollo()
    for (const t of timers.splice(0)) t.cancel()
    try {
      await publish($, true)
    } catch {}
    return next(e)
  })

  on('command.run', { command: 'tablero' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    once('all', () => refreshAll($))
    return { text: 'Tablero abierto.' }
  })

  on('command.run', { command: 'modo' }, async $ => {
    await update($, askOpen, () => true)
    return { text: `Modo actual: ${modeLabel(await read($, mode))}. Elegí el nuevo en la barra sobre el prompt.` }
  })

  // La sesión principal adopta el rol elegido: una sección al final del prompt de sistema.
  on('prompt.compose', async ($, e, next) => {
    const ran = await next(e)
    if (e.traits.includes('teammate')) return ran
    try {
      const m = await read($, mode)
      if (!isRole(m)) return ran
      return { sections: [...ran.sections, { id: 'tablero:modo', text: ROLES[m], scope: 'session' as const }] }
    } catch {
      return ran
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, askOpen))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const keep = await read($, remember)
    return (
      <Box flexDirection="column">
        <Text bold>¿Para qué es esta sesión?</Text>
        <Box flexDirection="row" gap={1}>
          <Button key="ciber" variant="primary" onPress={() => setMode($, 'ciberseguridad')}>
            Ciberseguridad
          </Button>
          <Button key="dev" onPress={() => setMode($, 'desarrollo')}>
            Desarrollo
          </Button>
          <Button key="ambos" onPress={() => setMode($, 'ambos')}>
            Ambos (orquestador)
          </Button>
          <Button key="ninguno" onPress={() => setMode($, 'ninguno')}>
            Sin modo
          </Button>
          <Button key="recordar" plain onPress={() => update($, remember, r => !r)}>
            {keep ? '☑' : '☐'} recordar en esta carpeta
          </Button>
        </Box>
      </Box>
    )
  })

  on('tool.check', async ($, e, next) => {
    const reason = mcpBlock(await read($, mcpOff), e.tool)
    if (reason) return { decision: 'deny' as const, reason }
    return next(e)
  })

  on('tool.describe', async ($, e, next) => {
    const ran = await next(e)
    if (!mcpBlock(await read($, mcpOff), e.tool)) return ran
    return { description: `[APAGADO desde el tablero: no usar] ${ran.description}`, isDeferred: true }
  })

  on('agent.spawn', async ($, e, next) => {
    const ran = await next(e)
    // Solo observa: anotar nunca debe impedir ni alterar el lanzamiento del agente.
    try {
      if (ran.agentId) {
        const id = ran.agentId
        const now = await $.clock.now()
        await update($, agents, all =>
          trimAgents({
            ...all,
            [id]: { description: e.description, type: e.subagentType, model: ran.model, status: 'running', startedAt: now },
          }),
        )
        await update($, clockNow, () => now)
        await publish($)
      }
    } catch {}
    return ran
  })

  on('classic.SubagentStop', async ($, e, next) => {
    const ran = await next(e)
    try {
      await finishAgent($, e.agent_id, 'completed')
    } catch {}
    return ran
  })

  // evento de streaming: reenvía los fragmentos sin tocarlos y actúa cuando la respuesta terminó
  on('turn.step', async function* ($, e, next) {
    const ran = yield* next(e)
    // una respuesta del modelo (de esta sesión o de un subagente) acaba de cambiar el consumo
    try {
      const now = await $.clock.now()
      await update($, lastResponseAt, () => now)
      once('usage', () => refreshUsage($))
    } catch {}
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId && flujo?.terminar(e.agentId, e.answer, e.reason) && !programado && !cerrando) {
      programado = $.clock.after(20, async () => {
        programado = undefined
        await flujo?.avanzar()
      })
    }
    try {
      if (e.agentId) {
        await finishAgent($, e.agentId, e.isAborted ? 'killed' : 'completed')
      } else {
        once('all', () => refreshAll($))
      }
    } catch {}
    return ran
  })

  on('tool.call', async ($, e, next) => {
    const server = serverOf(e.tool)
    const key = server ? `mcp:${server}` : e.tool
    const t0 = await $.clock.now()
    const ran = await next(e)
    const args = e as unknown as Record<string, unknown>
    if (e.agentId && (e.tool === 'Bash' || e.tool === 'PowerShell') &&
        typeof args.command === 'string' && !ran.deny && !ran.isError)
      flujo?.comando(e.agentId, args.command)
    // Solo observa: un fallo al anotar nunca debe alterar el resultado de la herramienta.
    try {
      const ms = (await $.clock.now()) - t0
      const failed = ran.deny !== undefined || !!ran.isError
      await update($, tools, all => {
        const prev: ToolStat = all[key] ?? { calls: 0, errors: 0, lastMs: 0 }
        return {
          ...all,
          [key]: {
            calls: prev.calls + 1,
            errors: prev.errors + (failed ? 1 : 0),
            lastMs: ms,
            lastError: failed ? e.tool : prev.lastError,
          },
        }
      })
    } catch {}
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const u = await read($, usage)
    const ts = await read($, tools)
    const filasEquipos = await read($, equipos)
    const servers = await read($, mcp)
    const m = await read($, mem)
    const at = await read($, updatedAt)
    const ags = Object.entries(await read($, agents)).sort((a, b) => b[1].startedAt - a[1].startedAt)
    const lk = await read($, look)
    const th = THEMES[lk.tema] ?? THEMES.claude!
    const all = await read($, sessions)
    const lim = pickLimits(u, all, sessionId)
    // el pulso escribe `now` cada segundo mientras hay agentes activos: esa escritura redibuja las duraciones
    const now = Math.max(await read($, clockNow), ags.length || lim ? await safeNow($) : 0)
    const sess = summarizeSessions(all, now)
    const isOther = (s: SessionSummary) => s.id !== sessionId
    const activeOthers = sess.active.filter(isOther)
    const idleOthers = sess.idle.filter(isOther)
    const idleOpen = await read($, showIdle)
    const curMode = await read($, mode)
    const off = await read($, mcpOff)
    const tabActual = await read($, tab)
    const solicitud = await read($, solicitudHerramientas)
    const detalles = await read($, detallesHerramientas)
    const excluidas = await read($, excluidasHerramientas)
    const avisos = await read($, avisosHerramientas)
    const abiertas = await read($, seccionesAbiertas)
    const abierta = (id: string) => abiertas.includes(id)
    const flecha = (id: string) => abierta(id) ? '▾' : '▸'

    const toolRows = Object.entries(ts).sort((a, b) => b[1].calls - a[1].calls)
    const mcpStat = (name: string) => ts[`mcp:${name}`]
    const hhmm = (t: number) => (t ? new Date(t).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) : '—')
    const barColor = (pct: number) => (pct >= 90 ? th.bad : pct >= 75 ? th.warn : th.bar)
    const solid = BACKGROUNDS[lk.fondo]

    const general = tabActual === 'general' && (
      <Box flexDirection="column" gap={lk.compacto ? 0 : 1}>
        <Box flexDirection="row" gap={1}>
          <Text bold>
            Modo: <Text color={isRole(curMode) ? th.accent : th.muted}>{modeLabel(curMode)}</Text>
          </Text>
          <Button key="cambiar-modo" plain onPress={() => update($, askOpen, () => true)}>
            cambiar
          </Button>
        </Box>

        <Box flexDirection="column">
          <Button key="seccion:sesion" plain onPress={() => toggleSection($, 'sesion')}>
            <Text bold color={th.accent}>{flecha('sesion')} Esta sesión</Text>
          </Button>
          {abierta('sesion') && (
            <Box flexDirection="column">
              <Text>Costo: {usd(u?.usd)}</Text>
              <Text>
                Contexto: <Text color={barColor(u?.ctxPercent ?? 0)}>{bar(u?.ctxPercent ?? 0)}</Text>{' '}
                {u?.ctxPercent !== undefined ? `${Math.round(u.ctxPercent)}%` : '?'}{' '}
                <Text dimColor>
                  ({k(u?.ctxTokens)} / {k(u?.ctxWindow)})
                </Text>
              </Text>
            </Box>
          )}
        </Box>

        <Box flexDirection="column">
          <Button key="seccion:cuenta" plain onPress={() => toggleSection($, 'cuenta')}>
            <Text bold color={th.accent}>
              {flecha('cuenta')} Cuenta <Text dimColor>{lim ? `(lectura de ${lim.from}, hace ${duration(now - lim.at)})` : ''}</Text>
            </Text>
          </Button>
          {abierta('cuenta') && (
            <Box flexDirection="column">
              {!lim && <Text dimColor>Sin lectura todavía: llega con la primera respuesta del modelo en cualquier sesión local.</Text>}
              {(lim?.limits ?? []).map(l => (
                <Text>
                  {l.kind === 'five_hour' ? '5 h' : l.kind === 'seven_day' ? '7 días' : l.kind}:{' '}
                  <Text color={barColor(l.percentUsed)}>{bar(l.percentUsed)}</Text> {Math.round(l.percentUsed)}%
                  {l.resetsAt ? (
                    <Text dimColor>
                      {' '}
                      · reinicia {new Date(l.resetsAt).toLocaleString('es-AR', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}
                    </Text>
                  ) : (
                    ''
                  )}
                </Text>
              ))}
              {lim && !lk.compacto && <Text dimColor>El uso en la web se refleja con la próxima respuesta en una sesión local.</Text>}
            </Box>
          )}
        </Box>

        <Box flexDirection="column">
          <Button key="seccion:sesiones" plain onPress={() => toggleSection($, 'sesiones')}>
            <Text bold color={th.accent}>
              {flecha('sesiones')} Sesiones locales{' '}
              <Text dimColor>({sess.activeCount} activas · {usd(sess.totalUsd)} en 24 h)</Text>
            </Text>
          </Button>
          {abierta('sesiones') && (
            <Box flexDirection="column">
              {activeOthers.length === 0 && <Text dimColor>No hay otras sesiones activas en esta máquina.</Text>}
              {activeOthers.map(s => (
                <Text key={s.id}>
                  <Text color={th.ok}>●</Text> {s.folder || s.id.slice(0, 8)}
                  <Text dimColor>
                    {' '}
                    · {usd(s.usd)}
                    {s.ctxPercent !== undefined ? ` · ctx ${Math.round(s.ctxPercent)}%` : ''}
                    {s.activeAgents ? ` · ${s.activeAgents} agentes` : ''}
                  </Text>
                </Text>
              ))}
              {idleOthers.length > 0 && (
                <Button key="ver-inactivas" plain onPress={() => update($, showIdle, v => !v)}>
                  <Text dimColor>
                    {idleOpen ? '▾' : '▸'} {idleOthers.length} cerradas o inactivas · {usd(idleOthers.reduce((t, x) => t + (x.usd ?? 0), 0))}
                    {idleOpen ? ' · ocultar' : ' · ver'}
                  </Text>
                </Button>
              )}
              {idleOpen &&
                idleOthers.map(s => (
                  <Text key={s.id} dimColor>
                    {'  '}○ {s.folder || s.id.slice(0, 8)} · {usd(s.usd)} · {s.ended ? 'cerrada' : 'inactiva'} hace{' '}
                    {duration(now - s.updatedAt)}
                  </Text>
                ))}
            </Box>
          )}
        </Box>

        <Box flexDirection="column">
          <Button key="seccion:mcp" plain onPress={() => toggleSection($, 'mcp')}>
            <Text bold color={th.accent}>{flecha('mcp')} MCP</Text>{' '}
            <Text dimColor>({servers.length} servidores)</Text>
          </Button>
          {abierta('mcp') && servers.length === 0 && <Text dimColor>Sin servidores MCP con herramientas cargadas.</Text>}
          {abierta('mcp') && servers.map(s => {
            const st = mcpStat(s.name)
            const isOff = off.includes(s.name)
            return (
              <Button key={`mcp:${s.name}`} plain onPress={() => toggleMcp($, s.name)}>
                <Text color={isOff ? th.muted : st && st.errors > 0 ? th.warn : th.ok}>{isOff ? '○' : '●'}</Text> {s.name}{' '}
                <Text dimColor>
                  {isOff
                    ? '· apagado · clic para prender'
                    : `· ${s.tools} tools${st ? ` · ${st.calls} llamadas${st.errors ? `, ${st.errors} con error` : ''} · última ${st.lastMs} ms` : ''}`}
                </Text>
              </Button>
            )
          })}
        </Box>

        <Box flexDirection="column">
          <Button key="seccion:herramientas" plain onPress={() => toggleSection($, 'herramientas')}>
            <Text bold color={th.accent}>{flecha('herramientas')} Herramientas usadas</Text>
          </Button>
          {abierta('herramientas') && (
            <Box flexDirection="column">
              {toolRows.length === 0 && <Text dimColor>Todavía ninguna.</Text>}
              {toolRows.slice(0, lk.compacto ? 5 : 10).map(([name, st]) => (
                <Text>
                  {name}{' '}
                  <Text dimColor>
                    · {st.calls}×{st.errors ? ` · ${st.errors} error` : ''} · {st.lastMs} ms
                  </Text>
                </Text>
              ))}
            </Box>
          )}
        </Box>

        <Box flexDirection="column">
          <Button key="seccion:memoria" plain onPress={() => toggleSection($, 'memoria')}>
            <Text bold color={th.accent}>{flecha('memoria')} Memory-engine</Text>
          </Button>
          {abierta('memoria') && (
            <Box flexDirection="column">
              {!m && <Text dimColor>Cargando…</Text>}
              {m?.error && <Text color={th.bad}>No se pudo leer: {m.error}</Text>}
              {m && !m.error && (
                <Box flexDirection="column">
                  <Text>
                    Recuerdos: {m.active} activos{m.stale ? <Text color={th.warn}>, {m.stale} vencidos</Text> : ''}
                  </Text>
                  <Text>
                    Inyecciones: {m.injected} en {m.prompts} prompts <Text dimColor>· hook p95 {m.hookP95} ms</Text>
                  </Text>
                </Box>
              )}
            </Box>
          )}
        </Box>

        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Button key="actualizar" onPress={async () => once('all', () => refreshAll($))}>
              Actualizar todo
            </Button>
            <Text dimColor>consumo cada 2 s · revisión completa {hhmm(at)}</Text>
          </Box>
          <Button key="seccion:apariencia" plain onPress={() => toggleSection($, 'apariencia')}>
            <Text bold color={th.accent}>{flecha('apariencia')} Apariencia</Text>
          </Button>
          {abierta('apariencia') && (
            <Box flexDirection="row" flexWrap="wrap" gap={1}>
              <Button key="tema" plain onPress={() => setLook($, l => ({ ...l, tema: nextOf(Object.keys(THEMES), l.tema) }))}>
                tema {lk.tema} ›
              </Button>
              <Button
                key="fondo"
                plain
                onPress={() => setLook($, l => ({ ...l, fondo: nextOf(Object.keys(BACKGROUNDS) as Look['fondo'][], l.fondo) }))}
              >
                fondo {lk.fondo} ›
              </Button>
              <Button key="bordes" plain onPress={() => setLook($, l => ({ ...l, bordes: !l.bordes }))}>
                {lk.bordes ? '☑' : '☐'} bordes
              </Button>
              <Button key="compacto" plain onPress={() => setLook($, l => ({ ...l, compacto: !l.compacto }))}>
                {lk.compacto ? '☑' : '☐'} compacto
              </Button>
              <Button key="herramientas:avisos" plain onPress={() => alternarAvisos($)}>
                {avisos ? '☑' : '☐'} Avisos de herramientas
              </Button>
            </Box>
          )}
        </Box>
      </Box>
    )

    const vistaAgentes = tabActual === 'agentes' && (
      <Box flexDirection="column" gap={lk.compacto ? 0 : 1}>
        <Box flexDirection="column">
          <Text bold color={th.accent}>
            Agentes{' '}
            <Text dimColor>
              ({ags.filter(([, a]) => !DONE.has(a.status)).length} activos · {ags.length} en la sesión)
            </Text>
          </Text>
          {ags.length === 0 && <Text dimColor>Todavía no se lanzó ninguno.</Text>}
          {ags.map(([id, a]) => (
            <Text key={id}>
              <Text color={th[statusTone(a.status)]}>●</Text> {a.type}
              <Text dimColor>
                {a.model ? ` · ${a.model}` : ''} · {statusLabel(a.status)} · {duration((a.endedAt ?? now) - a.startedAt)}
              </Text>{' '}
              {a.description}
            </Text>
          ))}
        </Box>

        {!!filasEquipos.length && (
          <Box flexDirection="column">
            <Text bold color={th.accent}>Equipos de desarrollo</Text>
            {filasEquipos.map(f => (
              <Text key={f.id} color={f.demorada || f.estado === 'pendiente' ? th.warn : undefined}>
                {f.equipo} · {f.id} · {f.estado}{f.demorada ? ' · demorada' : ''}
                {f.verificacion ? ' · PHP ' + f.verificacion : ''}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )

    return (
      <Box
        flexDirection="column"
        gap={lk.compacto ? 0 : 1}
        backgroundColor={solid}
        borderStyle={lk.bordes ? 'round' : undefined}
        borderColor={lk.bordes ? th.accent : undefined}
        paddingX={lk.bordes || solid ? 1 : 0}
      >
        <Box flexDirection="row" gap={1}>
          {(['general', 'agentes'] as const).map(id => (
            <Button key={`tab:${id}`} variant={tabActual === id ? 'primary' : undefined} onPress={async () => {
              if (tabActual === id) return
              await update($, tab, () => id)
              try {
                await $.ui.scroll({ in: PANE, to: 'start' })
              } catch {}
            }}>
              {id === 'general' ? 'General' : 'Agentes'}
            </Button>
          ))}
        </Box>

        {solicitud && !solicitud.oculta && solicitud.estado !== 'omitida' && (
          <Box flexDirection="column" borderStyle="round" borderColor={th.warn} paddingX={1}>
            <Text bold color={th.accent}>Herramientas para el diagnóstico</Text>
            {solicitud.herramientas.map(herramienta => {
              const id = herramienta.gestor + ':' + herramienta.paquete
              const abierto = detalles.includes(id)
              const resultado = solicitud.resultados?.find(r => r.gestor === herramienta.gestor && r.paquete === herramienta.paquete)
              return (
                <Box key={id} flexDirection="column">
                  <Box flexDirection="row" flexWrap="wrap" gap={1}>
                    <Button key={`detalle:${id}`} plain onPress={() =>
                      update($, detallesHerramientas, ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id])}>
                      {abierto ? '▾' : '▸'} {herramienta.nombre} · {id}{resultado ? ' · ' + resultado.estado : ''}
                    </Button>
                    {solicitud.estado === 'pendiente' && (
                      <Button key={`seleccionar:${id}`} plain onPress={() =>
                        update($, excluidasHerramientas, ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id])}>
                        {excluidas.includes(id) ? '☐ Excluida' : '☑ Seleccionada'}
                      </Button>
                    )}
                  </Box>
                  {abierto && (
                    <Box flexDirection="column" paddingLeft={2}>
                      <Text>{herramienta.motivo}</Text>
                      <Text dimColor>{herramienta.gestor} · {herramienta.paquete}</Text>
                      <Text dimColor>Ejecutable: {herramienta.ejecutable}</Text>
                      {resultado?.ruta && <Text>Ruta: {resultado.ruta}</Text>}
                      {resultado?.detalle && <Text>{resultado.detalle}</Text>}
                    </Box>
                  )}
                </Box>
              )
            })}
            {solicitud.estado === 'pendiente' && (
              <Box flexDirection="row" flexWrap="wrap" gap={1}>
                {solicitud.herramientas.some(h => !excluidas.includes(h.gestor + ':' + h.paquete)) && (
                  <Button key="herramientas:instalar" variant="primary" onPress={() => resolverAviso($, true)}>Instalar seleccionadas</Button>
                )}
                <Button key="herramientas:omitir" onPress={() => resolverAviso($, false)}>Seguir sin instalar</Button>
                <Button key="herramientas:silenciar" plain onPress={() => alternarAvisos($)}>Desactivar avisos</Button>
              </Box>
            )}
            {solicitud.estado === 'instalando' && <Text dimColor>Instalación en curso…</Text>}
            {solicitud.estado === 'finalizada' && (
              <Button key="herramientas:cerrar" plain onPress={() => update($, solicitudHerramientas, () => ({ ...solicitud, oculta: true }))}>
                Cerrar
              </Button>
            )}
          </Box>
        )}

        {general}
        {vistaAgentes}
      </Box>
    )
  })
}
