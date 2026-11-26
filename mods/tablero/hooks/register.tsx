import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRun, Consumo, ConfiguracionDispositivos, EstadoDispositivos, FormularioDispositivo, PreferenciasSeguridad, VistaDispositivos, Limit, Look, McpServer, MemStats, Mode, ResultadoHerramienta, SessionSummary, SolicitudHerramientas, ToolStat, Usage } from '../types'
import { alcancePedido, AMBOS, CIBERSEGURIDAD, DESARROLLO } from './roles'
import { ALERTAS, BLOQUES, FORMULARIO_INICIAL, describirBloque, prepararEnvio, validarDestino } from './dispositivos'
import { ConsumoLocal, sumarConsumos, totalTokens } from './consumo'
import { leerPropuesta } from './herramientas'
import { Equipos, incluirAppSec, planValidado, promptTarea, TIPOS, type PlanGuardado, type Tarea } from './equipos'

// Qué se actualiza cómo:
//  - por eventos: agentes (agent.spawn / classic.SubagentStop / turn.complete del subagente), herramientas y
//    MCP (tool.call), consumo tras cada respuesta del modelo (turn.step), memory-engine al cerrar cada turno.
//  - por consulta: el consumo cada 2 s (esta sesión y las demás sesiones locales, que publican un archivo
//    cada una), el reloj de las duraciones cada 1 s mientras haya agentes activos, y una conciliación de
//    agentes y servidores MCP cada 30 s por si algo se cortó sin evento.

const REGLAS_DEV = 'Reglas obligatorias de Dev: identifica el stack y el flujo afectado. Reutiliza convenciones y dependencias, implementa el cambio mínimo completo y verifica con las pruebas nativas pertinentes. Informa qué evidencia obtuviste.'
const REGLAS_APPSEC = 'Reglas obligatorias de AppSec: revisa defensivamente los controles afectados y limita el alcance al código y la configuración local. Contrasta entradas, autorización y manejo de datos con la evidencia disponible. Usa pruebas de comportamiento esperado con datos ficticios cuando aporten. Informa archivo y línea, impacto y qué queda por verificar. Conserva los archivos durante la revisión.'

const EDICION = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch'])
const TERMINAL = new Set(['Bash', 'PowerShell'])
const PLAN = 'mcp__tablero__equipos_desarrollo'
const HERRAMIENTAS = 'mcp__tablero__herramientas_desarrollo'
const PHP = 'mcp__tablero__php_replay'
const lista = { type: 'array', items: { type: 'string' } }
const texto = { type: 'string' }

const PANE = 'tablero'
const TITLE = 'Tablero'
const usage = atom({ plugin: 'tablero', key: 'usage' } as const, null)
const consumoAgentes = atom({ plugin: 'tablero', key: 'consumoAgentes' } as const, null)
const detallesConsumo = atom({ plugin: 'tablero', key: 'detallesConsumo' } as const, [])
const registroConsumo = new ConsumoLocal()
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
const estadoDispositivos = atom({ plugin: 'tablero', key: 'estadoDispositivos' } as const, null)
const preferenciasSeguridad = atom({ plugin: 'tablero', key: 'preferenciasSeguridad' } as const,
  { monitor: false, rdp: true, salida: true, puerto: true })
const estadoMonitor = atom({ plugin: 'tablero', key: 'estadoMonitor' } as const, '')
const envioDispositivo = atom({ plugin: 'tablero', key: 'envioDispositivo' } as const, [])
const vistaDispositivo = atom({ plugin: 'tablero', key: 'vistaDispositivo' } as const, 'inicio')
const formularioDispositivo = atom({ plugin: 'tablero', key: 'formularioDispositivo' } as const, FORMULARIO_INICIAL)
const peerDispositivo = atom({ plugin: 'tablero', key: 'peerDispositivo' } as const, '')
const codigoDispositivo = atom({ plugin: 'tablero', key: 'codigoDispositivo' } as const, '')
const mensajeDispositivo = atom({ plugin: 'tablero', key: 'mensajeDispositivo' } as const, '')
const configuracionDispositivos = atom({ plugin: 'tablero', key: 'configuracionDispositivos' } as const,
  { cert: '', clave: '', autoridad: '', ip: '', puerto: '4321', origenes: '' })
const CERTIFICADOS_INICIAL = { archivo: '', huella: '', huellaAutoridad: '', entrada: '', confirmada: false }
const certificadosDispositivos = atom({ plugin: 'tablero', key: 'certificadosDispositivos' } as const, CERTIFICADOS_INICIAL)
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
  return fn()
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

async function refrescarConsumo($: EngineInterface) {
  if (await read($, tab) !== 'agentes') return
  const sesion = await $.session.id()
  const info = await $.session.info()
  const medicion = await registroConsumo.medir({
    list: ruta => $.fs.list(ruta),
    stat: ruta => $.fs.stat(ruta),
    read: (ruta, offset, length) => $.fs.read(ruta, { offset, length }),
  }, sesion, info.transcriptPath)
  if (changed(await read($, consumoAgentes), medicion)) await update($, consumoAgentes, () => medicion)
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

async function gateway($: EngineInterface, action: string, args: string[] = []) {
  const base = $.plugin.root + '/../../memory-engine'
  const porEntrada = ['send', 'check-identity', 'configure'].includes(action)
  const result = await $.process.run([base + '/' + venvPython, '-I', $.plugin.root + '/scripts/device_gateway.py',
    base + '/data/dispositivos', action, ...(porEntrada ? [] : args)], {
    timeoutMs: 16_000, stdin: porEntrada ? JSON.stringify(args) : undefined,
  })
  if (result.isStdoutTruncated) throw new Error('No se pudo completar la operación.')
  const salida = JSON.parse(result.stdout)
  if (result.exitCode !== 0) throw new Error(typeof salida.error === 'string' ? salida.error : 'No se pudo completar la operación.')
  return salida
}

async function refrescarSeguridad($: EngineInterface, monitor = false) {
  try {
    const prefs = await read($, preferenciasSeguridad)
    if (monitor && prefs.monitor) {
      const info = await gateway($, 'local-events')
      await update($, estadoMonitor, () => String(info.status))
    }
    const estado = await gateway($, 'snapshot') as EstadoDispositivos
    const anterior = await read($, estadoDispositivos)
    await update($, estadoDispositivos, () => estado)
    if (estado.alerts.some(([rule, peer, total, at]) =>
      (rule === 'remote_logon' ? prefs.rdp : rule === 'outbound_review' ? prefs.salida : prefs.puerto) &&
      !anterior?.alerts.some(([r, p, n, previous]) => r === rule && p === peer && n === total && previous === at)))
      $.ui.toast('Actividad para revisar en Dispositivos → Alertas.')
  } catch {
    await update($, estadoMonitor, () => 'No se pudo consultar la auditoría local.')
  }
}

async function cambiarSeguridad($: EngineInterface, key: keyof PreferenciasSeguridad) {
  const prefs = await update($, preferenciasSeguridad, current => ({ ...current, [key]: !current[key] }))
  try { await $.store.set('preferenciasSeguridad', prefs) } catch {}
  if (key === 'monitor') once('seguridad', () => refrescarSeguridad($, true))
}

async function cambiarVistaDispositivo($: EngineInterface, vista: VistaDispositivos) {
  await update($, vistaDispositivo, () => vista)
  await update($, mensajeDispositivo, () => '')
  await update($, peerDispositivo, () => '')
  await update($, envioDispositivo, () => [])
  await update($, formularioDispositivo, current => ({ ...current, codigo: '', valor: '', revision: '', coincide: false }))
}

async function abrirFirmaDispositivo($: EngineInterface) {
  await cambiarVistaDispositivo($, 'cert-firmar')
  await update($, certificadosDispositivos, () => CERTIFICADOS_INICIAL)
}

// Un campo guarda su texto en cada cambio: Siguiente valida lo escrito aunque no se haya apretado Enter.
const alEscribir = (guardar: (value: string) => unknown) => ({ onInput: guardar, onSubmit: guardar })

let gestionandoCertificados = false

async function operarCertificados($: EngineInterface, accion: 'crear-autoridad' | 'crear-solicitud' | 'leer-solicitud' | 'firmar' | 'importar') {
  if (gestionandoCertificados) return
  gestionandoCertificados = true
  try {
    const data = await read($, certificadosDispositivos)
    const entrada = data.entrada.trim()
    if (accion === 'firmar' && !data.confirmada) throw new Error('Confirmá la huella de la solicitud antes de firmar.')
    if (accion === 'importar' && (!entrada || !data.huellaAutoridad.trim()))
      throw new Error('Ingresá el archivo firmado y la huella de la CA confirmada.')
    if (accion === 'leer-solicitud' && !entrada) throw new Error('Ingresá la ruta del archivo .csr.')
    const args = accion === 'firmar' ? [entrada, data.huella] :
      accion === 'importar' ? [entrada, data.huellaAutoridad] :
        accion === 'leer-solicitud' ? [entrada] : []
    const base = $.plugin.root + '/../../memory-engine'
    const resultado = await $.process.run([base + '/' + venvPython, '-I',
      $.plugin.root + '/scripts/device_certificates.py', base + '/data/dispositivos', accion], {
      timeoutMs: 30_000, stdin: JSON.stringify(args),
    })
    if (resultado.isStdoutTruncated) throw new Error('No se pudo verificar la respuesta local.')
    const salida = JSON.parse(resultado.stdout)
    if (resultado.exitCode !== 0) throw new Error(typeof salida.error === 'string' ? salida.error : 'No se pudo completar.')
    if (typeof salida.cert === 'string' && typeof salida.key === 'string' && typeof salida.ca === 'string') {
      await update($, configuracionDispositivos, f => ({ ...f, cert: salida.cert, clave: salida.key, autoridad: salida.ca }))
      await cambiarVistaDispositivo($, 'red')
    } else {
      if (accion === 'crear-solicitud') await cambiarVistaDispositivo($, 'cert-solicitud')
      await update($, certificadosDispositivos, current => ({ ...current,
        archivo: String(salida.archivo ?? ''), huella: String(salida.huella ?? ''),
        huellaAutoridad: String(salida.huellaAutoridad ?? ''), confirmada: false,
      }))
      await update($, mensajeDispositivo, () => '')
    }
  } catch (error) {
    await update($, mensajeDispositivo, () => error instanceof Error ? error.message : 'No se pudo completar.')
  } finally {
    gestionandoCertificados = false
  }
}

async function comenzarVinculacion($: EngineInterface) {
  const estado = await read($, estadoDispositivos)
  const vista = estado?.conexion?.estado !== 'configurada' ? 'identidad' : estado.enabled ? 'agregar' : 'activar'
  await cambiarVistaDispositivo($, vista)
  await update($, codigoDispositivo, () => '')
}

let vinculoEnCurso = false

async function avanzarVinculacion($: EngineInterface, paso: 'identidad' | 'red' | 'activar' | 'invitar' | 'destino') {
  if (vinculoEnCurso) return
  vinculoEnCurso = true
  try {
    const config = await read($, configuracionDispositivos)
    const identidad = [config.cert, config.clave, config.autoridad]
    if (paso === 'identidad') {
      if (identidad.some(value => !value.trim())) throw new Error('Completá los tres archivos.')
      await gateway($, 'check-identity', identidad)
      await cambiarVistaDispositivo($, 'red')
    } else if (paso === 'red') {
      if (!config.ip.trim() || !config.puerto.trim() || !config.origenes.trim()) throw new Error('Completá la IP, el puerto y los origenes.')
      await gateway($, 'configure', [...identidad, config.ip, config.puerto, config.origenes])
      await refrescarSeguridad($)
      await cambiarVistaDispositivo($, 'activar')
    } else if (paso === 'activar') {
      await gateway($, 'link', ['on'])
      await refrescarSeguridad($)
      await cambiarVistaDispositivo($, 'agregar')
    } else if (paso === 'invitar') {
      await gateway($, 'start-gateway')
      const invitacion = await gateway($, 'invite')
      await cambiarVistaDispositivo($, 'invitar')
      await update($, codigoDispositivo, () => String(invitacion.code))
    } else {
      validarDestino(await read($, formularioDispositivo))
      await update($, vistaDispositivo, () => 'usar')
      await update($, mensajeDispositivo, () => '')
    }
  } catch (error) {
    await update($, mensajeDispositivo, () => error instanceof Error ? error.message : 'Revisá este paso.')
  } finally {
    vinculoEnCurso = false
  }
}

async function plantearEnvioDispositivo($: EngineInterface, invitacion: boolean) {
  try {
    const args = prepararEnvio(await read($, formularioDispositivo), invitacion)
    await update($, envioDispositivo, () => args)
    await update($, mensajeDispositivo, () => '')
  } catch (error) {
    await update($, mensajeDispositivo, () => error instanceof Error ? error.message : 'Revisá los datos del envío.')
  }
}

async function operarDispositivo($: EngineInterface, action: string, args: string[]) {
  const feedback = (text: string) => update($, mensajeDispositivo, () => text)
  try {
    const result = await gateway($, action, args)
    if (action === 'invite') {
      await update($, codigoDispositivo, () => String(result.code))
      await feedback('Invitación creada. Vence en cinco minutos y sirve una sola vez.')
    } else if (action === 'send') {
      if (result.status === 202) {
        await update($, envioDispositivo, () => [])
        if (args[4] === 'pair') await update($, formularioDispositivo, current => ({ ...current, codigo: '' }))
        await feedback(args[4] === 'pair' ? 'Solicitud recibida. La otra PC tiene que aprobarla.' : 'El otro dispositivo confirmó la recepción.')
      } else {
        const mensajes: Record<number, string> = {
          400: 'La otra PC rechazó el formato del mensaje.',
          403: args[4] === 'pair' ? 'El enlace está apagado o la invitación venció, se usó o es incorrecta.'
            : 'La otra PC no autorizó ese proyecto y tipo de información, o el permiso ya venció.',
          409: 'La otra PC ya recibió este mensaje.',
        }
        await feedback(mensajes[result.status] ?? 'El otro dispositivo rechazó la operación.')
      }
    } else if (action === 'grant') {
      await feedback('Permiso temporal guardado en esta PC.')
    } else if (action === 'reject' || action === 'revoke') {
      await update($, peerDispositivo, () => '')
      await feedback(action === 'reject' ? 'Solicitud rechazada.' : 'Permisos del dispositivo revocados.')
    } else if (action === 'link') {
      if (args[0] === 'off') await update($, codigoDispositivo, () => '')
      await feedback(args[0] === 'off' ? 'Enlace desactivado. Se revocaron los permisos.' : 'Enlace activado en esta PC.')
    }
    await refrescarSeguridad($)
  } catch {
    await feedback(action === 'send' ? 'No se pudo conectar. Revisá la dirección, el puerto, la huella y que el receptor esté en ejecución.'
      : 'No se pudo completar. Revisá que el enlace esté configurado y que la solicitud siga vigente.')
  }
}

async function aprobarDispositivo($: EngineInterface, peer: string) {
  const form = await read($, formularioDispositivo)
  const proyecto = form.proyecto.trim()
  const minutos = Number(form.minutos)
  if (!form.coincide || !/^[a-z0-9][a-z0-9_.-]{0,79}$/i.test(proyecto) ||
      !/^\d{1,3}$/.test(form.minutos) || minutos < 1 || minutos > 120) {
    await update($, mensajeDispositivo, () => 'Confirmá la huella, ingresá el proyecto y elegí una duración de 1 a 120 minutos.')
    return
  }
  await operarDispositivo($, 'grant', [peer, proyecto, form.bloque, form.bloque === 'work_request' ? 'work' : 'read', String(minutos)])
}

function startTimers($: EngineInterface) {
  for (const t of timers.splice(0)) t.cancel()
  timers.push(
    $.clock.every(60_000, () => once('seguridad', async () => {
      if ((await read($, preferenciasSeguridad)).monitor || await read($, estadoDispositivos))
        await refrescarSeguridad($, true)
    })),
    $.clock.every(USAGE_MS, () => once('usage', () => refreshUsage($).then(() => readSessions($)))),
    $.clock.every(5_000, () => once('consumo-agentes', () => refrescarConsumo($))),
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

async function configurarAvisos($: EngineInterface, activo: boolean) {
  await update($, avisosHerramientas, () => activo)
  try { await $.store.set('avisosHerramientas', activo) } catch {}
  if (!activo) await resolverAviso($, false)
}

// ---------------------------------------------------------------- hooks

async function iniciarDesarrollo($: EngineInterface) {
  await $.command.register({ name: 'equipos', immediate: true, description: 'Muestra los equipos y comprobaciones de Desarrollo' })
  await $.tool.register({ name: 'equipos_desarrollo', description: 'Planifica y sigue equipos de Desarrollo. iniciar define tareas; el toolkit agrega AppSec a toda implementación; estado devuelve evidencia; reintentar reasigna un fallo concluido o una implementación que requiere corrección y vuelve a comprobar sus dependencias.',
    inputSchema: {
      type: 'object', required: ['accion'], properties: {
        accion: { enum: ['iniciar', 'estado', 'reintentar'] },
        tareas: { type: 'array', items: {
          type: 'object', required: ['id', 'equipo', 'tipo', 'objetivo'], properties: {
            id: texto, equipo: texto, tipo: { enum: [...TIPOS] }, objetivo: texto,
            depende: lista, archivos: lista, simulacionPHP: { type: 'boolean' },
          },
        } },
        concurrencia: { type: 'integer', minimum: 1, maximum: 5 },
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
    prompt: 'Implementas una sola tarea del orquestador. Respeta sus rutas y criterios. Consulta las etapas pertinentes de ub-mode. ' + REGLAS_DEV,
  })
  await $.agent.register({ ...comunes, name: 'appsec', model: 'haiku',
    description: 'Revisión defensiva independiente de los controles de aplicación.',
    tools: lectura,
    prompt: REGLAS_APPSEC + ' Revisa en solo lectura. Excluye intrusión y pruebas contra servicios activos. Contrasta las pruebas y los resultados disponibles con el código. Atribuye las ejecuciones previas a quien las realizó y pide evidencia adicional si un control sigue sin verificar. Entrega RESULTADO y evidencia breve.',
  })
  await $.agent.register({ ...comunes, name: 'desarrollo-verificador', model: 'haiku',
    description: 'Prepara evidencia o verifica un requisito concreto.',
    tools: [...lectura, ...terminales],
    prompt: 'Eres un verificador independiente. Usa análisis estático o comandos de prueba offline acotados. No modifiques el producto. Informa solo evidencia observada.',
  })
  await $.agent.register({ ...comunes, name: 'desarrollo-ux', model: 'sonnet', maxTurns: 7,
    description: 'Diseña la experiencia de usuario y define criterios para implementar.',
    tools: [...lectura, ...terminales],
    prompt: 'Eres especialista en UX/UI para web, escritorio o terminal. Aplica el diseño existente y el contexto de quien usa el producto. Revisa jerarquía, navegación, legibilidad, teclado y foco, tamaños de pantalla y estados vacíos, de carga y error. Prioriza los problemas que frenan al usuario. En diseño entrega criterios verificables. En revisión observa la interfaz en ejecución con las herramientas locales disponibles y distingue lo renderizado de la lectura estática. Indica pantalla y pasos concretos. Trabaja sin modificar el producto ni instalar herramientas.',
  })
  const revisoresUX = [
    { name: 'desarrollo-ux-visual', description: 'Revisa diseño visual y adaptación a la pantalla.' },
    { name: 'desarrollo-ux-interaccion', description: 'Revisa navegación, interacción y accesibilidad.' },
  ]
  for (const revisor of revisoresUX) {
    await $.agent.register({ ...comunes, ...revisor, model: 'haiku', maxTurns: 6,
      tools: [...lectura, ...terminales],
      prompt: 'Eres un revisor independiente de UX/UI. Limítate a las pantallas, al foco y a los criterios asignados. Usa la vista local o la evidencia existente cuando esté disponible. Distingue la observación en ejecución de la lectura estática. Informa solo problemas concretos, con ubicación y evidencia. Trabaja sin editar el producto ni instalar herramientas.',
    })
  }
  await $.agent.register({ ...comunes, name: 'desarrollo-php', model: 'haiku',
    description: 'Traza PHP y verifica el comportamiento mediante php_replay.',
    tools: [...lectura, PHP],
    prompt: 'Eres un verificador PHP independiente. Traza los caminos del código. Prepara un driver que ejecute los fuentes montados en /app, reemplace dependencias por datos de prueba y devuelva evidencia del comportamiento. No leas credenciales ni copies lógica del producto al driver.',
  })
}
let flujo: Equipos | undefined
let iniciando = false
let cerrando = false
const replays = new Set<string>()

let escrituraPlan = Promise.resolve()
let restauracion: Promise<void> | undefined

async function clavePlan($: EngineInterface) {
  const id = await $.session.id()
  return 'equipos:v1:' + id
}

function guardarPlan($: EngineInterface) {
  if (!flujo) return
  const copia = flujo.guardar()
  const filas = flujo.resumen()
  escrituraPlan = escrituraPlan.then(async () => {
    const clave = await clavePlan($)
    await $.store.set(clave, copia)
    await update($, equipos, () => filas)
  }).catch(async () => { await update($, equipos, () => filas).catch(() => {}) })
}

function subagenteDe(t: Tarea): string {
  const agentesUX = {
    diseno_ux: 'desarrollo-ux', revision_ux: 'desarrollo-ux-visual',
    revision_ux_visual: 'desarrollo-ux-visual', revision_ux_interaccion: 'desarrollo-ux-interaccion',
  } as const
  const tipo = t.tipo in agentesUX ? agentesUX[t.tipo as keyof typeof agentesUX] :
    t.tipo === 'implementacion' ? 'desarrollo-dev' : t.tipo === 'appsec' ? 'appsec' : t.simulacionPHP ? 'desarrollo-php' : 'desarrollo-verificador'
  return 'tablero:' + tipo
}

function motorEquipo($: EngineInterface, root: string, base: string): ConstructorParameters<typeof Equipos>[0] {
  return {
    lanzar: (t, evidencia) => {
      const instrucciones = t.tipo === 'implementacion'
        ? '\nGuía ub-mode: ' + $.plugin.root + '/skills/ub-mode/SKILL.md. Lee las fases pertinentes. Conserva la entrega local.'
        : ''
      return $.agent.spawn({
        cwd: root,
        subagentType: subagenteDe(t),
        description: (t.equipo + ': ' + t.id).slice(0, 100),
        prompt: promptTarea(t, evidencia) + instrucciones + (base ? '\nCommit base: ' + base : ''),
      })
    },
    actualizar: () => guardarPlan($),
    aviso: t => { void $.ui.toast(t.equipo + ' · ' + t.id + ': llegó al punto de control. Revisá el avance en /equipos.') },
    reloj: (ms, callback) => {
      const timer = $.clock.after(ms, callback)
      return () => timer.cancel()
    },
  }
}

async function restaurarPlan($: EngineInterface) {
  if (flujo) return
  restauracion ??= (async () => {
    const clave = await clavePlan($)
    const copia = await $.store.get(clave) as PlanGuardado | undefined
    if (copia?.version !== 1 || flujo) return
    const root = await $.session.root()
    flujo = Equipos.restaurar(motorEquipo($, root, copia.base), copia)
    await update($, equipos, () => flujo?.resumen() ?? [])
  })().catch(() => {}).finally(() => { restauracion = undefined })
  await restauracion
}

export const register: Register = on => {
  let edicionRedirigida = false
  let planDelPedido = false
  let planRegistrado: unknown
  let alcance: ReturnType<typeof alcancePedido> = 'trabajo'
  const respuestaDirecta = 'Este pedido solicita una respuesta directa. Respeta el formato pedido y no inicies planes, agentes ni cambios.'

  on('prompt.submit', async ($, e, next) => {
    const origen = e.origin.kind
    if (!e.isMeta && !e.command && (origen === 'composer' || origen === 'sdk' || origen === 'bridge')) {
      const nuevo = alcancePedido(e.text)
      if (nuevo !== alcance) {
        alcance = nuevo
        $.ui.invalidate('prompt.section')
      }
      edicionRedirigida = false
      planDelPedido = false
    }
    const ran = await next(e)
    if (e.origin.kind === 'composer' && !e.isMeta && !e.command && ran.drop === undefined &&
        /^(?:continue|continu[aáe]|segu[ií]|reanudar|reanud[aáe])[.!]?$/i.test(e.text.trim())) {
      once('reanudar-equipos', async () => {
        await restaurarPlan($)
        if (!flujo?.activo || cerrando) return
        const seleccion = await read($, mode)
        if (!isRole(seleccion) || (seleccion === 'ciberseguridad' && flujo.resumen().some(t => t.tipo !== 'appsec'))) return
        const activo = flujo
        const root = await $.session.root()
        const agentesVivos = (await $.agent.list()).filter(a => !DONE.has(a.status))
        if (flujo !== activo || cerrando) return
        planDelPedido = true
        await activo.reanudar(new Set(agentesVivos.map(a => a.id)), motorEquipo($, root, activo.base))
        await escrituraPlan
      })
    }
    return ran
  })

  function cerrarDesarrollo() {
    cerrando = true
    flujo?.cerrar()
  }

  on('command.run', { command: 'equipos' }, async $ => {
    await restaurarPlan($)
    const filas = flujo?.resumen() ?? []
    return { text: filas.length ? filas.map(f =>
      f.equipo + ' · ' + f.id + ' · ' + f.estado + (f.demorada ? ' · demorada' : '') +
      (f.verificacion ? ' · PHP ' + f.verificacion : ''),
    ).join('\n') : 'Todavía no hay equipos en esta sesión.' }
  })

  on('command.run', { command: 'dispositivos' }, async ($, e) => {
    if (e.origin.kind !== 'composer') return { text: 'Abrí este comando desde la terminal local.' }
    const args = e.args.trim().split(/\s+/)
    if (args[0] === 'enviar') {
      const [_, host, port, peer, project, kind, ...values] = args
      const data = kind === 'status' ? { state: values[0] } :
        kind === 'test_result' ? { passed: Number(values[0]), failed: Number(values[1]) } :
        kind === 'work_request' ? { operation: values[0], revision: values[1] } : { code: values[0] }
      if (!host || !port || !peer || !project || !['pair', 'status', 'test_result', 'work_request'].includes(kind ?? ''))
        return { text: 'Uso: /dispositivos enviar HOST PUERTO HUELLA PROYECTO TIPO [valores]' }
      await cambiarVistaDispositivo($, kind === 'pair' ? 'usar' : 'enviar')
      await update($, envioDispositivo, () => [host, port, peer, project, kind, JSON.stringify(data)])
    } else if (args[0] === 'permitir') {
      await cambiarVistaDispositivo($, 'permisos')
    } else if (args[0] === 'rechazar' || args[0] === 'revocar') {
      await operarDispositivo($, args[0] === 'rechazar' ? 'reject' : 'revoke', args.slice(1))
    } else if (args[0] === 'invitar') {
      await comenzarVinculacion($)
    } else if (args[0] === 'huella') {
      try { return { text: String((await gateway($, 'identity')).fingerprint) } }
      catch { return { text: 'Configurá primero el certificado de este dispositivo.' } }
    } else if (args[0] === 'buscar') {
      try { return { text: JSON.stringify(await gateway($, 'audit', args.slice(1))) } }
      catch { return { text: 'Usá un código de evento, proyecto o huella para buscar.' } }
    }
    await update($, tab, () => 'dispositivos')
    void $.ui.open({ id: PANE, title: TITLE }).catch(() => {})
    await refrescarSeguridad($)
    return { text: 'Dispositivos. Las invitaciones y aprobaciones se confirman desde el panel.' }
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
    if (alcance !== 'trabajo') return { deny: respuestaDirecta }
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
    if (e.agentId || !isRole(seleccionado)) return { deny: 'Elegí un modo del toolkit para gestionar equipos.' }
    const args = e as unknown as Record<string, unknown>
    if (seleccionado === 'desarrollo') {
      if (args.accion === 'estado') return { result: JSON.stringify(planRegistrado ?? []) }
      if (args.accion === 'reintentar')
        return { deny: 'En Desarrollo el tablero no lanza agentes: relanzá la tarea con Agent, con el ajuste en el prompt.' }
    }
    await restaurarPlan($)
    if (args.accion === 'estado') {
      const filas = flujo?.resumen(true) ?? []
      return { result: JSON.stringify(typeof args.id === 'string'
        ? filas.filter(f => f.id === args.id)
        : filas.map(({ evidencia, ...fila }) => fila)) }
    }
    if (alcance !== 'trabajo') return { deny: respuestaDirecta }
    try {
      if (args.accion === 'reintentar' && flujo && typeof args.id === 'string' && typeof args.ajuste === 'string') {
        if (seleccionado === 'ciberseguridad' && flujo.resumen().some(t => t.tipo !== 'appsec'))
          return { deny: 'Retomá el plan de implementación en Desarrollo o Ambos.' }
        await flujo.reintentar(args.id, args.ajuste)
        planDelPedido = true
        await escrituraPlan
        return { result: JSON.stringify(flujo.resumen()) }
      }
      if (args.accion !== 'iniciar') return { deny: 'Acción inválida.' }
      if (flujo?.activo || iniciando) return { deny: 'Ya hay un plan en curso.' }
      iniciando = true
      try {
        const tareas = planValidado(args.tareas)
        if (seleccionado === 'ciberseguridad' && tareas.some(t => t.tipo !== 'appsec'))
          return { deny: 'Usá tareas AppSec para la revisión defensiva en este modo.' }
        const plan = incluirAppSec(tareas)
        const n = args.concurrencia ?? 2
        const minutos = args.minutos ?? 10
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 5 ||
            typeof minutos !== 'number' || !Number.isInteger(minutos) || minutos < 1 || minutos > 30)
          throw new Error('Concurrencia entre 1 y 5, punto de control entre 1 y 30 minutos.')
        if (seleccionado === 'desarrollo') {
          planRegistrado = plan.map(t => ({
            id: t.id, equipo: t.equipo, tipo: t.tipo, objetivo: t.objetivo,
            depende: t.depende, archivos: t.archivos, subagent_type: subagenteDe(t),
          }))
          planDelPedido = true
          return { result: JSON.stringify({
            modo: 'registro', concurrencia: n, tareas: planRegistrado,
            instrucciones: 'El tablero solo registró el plan. Lanzá cada tarea con Agent (subagent_type indicado) en paralelo hasta ' + n +
              ' a la vez, respetando depende; un único escritor por archivo; appsec-cierre al final, cuando terminen las implementaciones.',
          }) }
        }
        const root = await $.session.root()
        const base = await $.process.run(['git', '-C', root, 'rev-parse', '--verify', 'HEAD'], { timeoutMs: 5000 })
          .then(r => r.exitCode === 0 ? r.stdout.trim() : '', () => '')
        flujo?.cerrar()
        flujo = new Equipos(motorEquipo($, root, base), plan, n, minutos * 60_000, base)
        planDelPedido = true
        guardarPlan($)
        await flujo.avanzar()
        await escrituraPlan
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

  on('agent.offer', { agent: 'tablero:appsec' }, () => ({ isOffered: false }))
  on('agent.offer', { agent: 'tablero:desarrollo-dev' }, () => ({ isOffered: false }))
  on('agent.offer', { agent: 'tablero:desarrollo-verificador' }, () => ({ isOffered: false }))
  on('agent.offer', { agent: 'tablero:desarrollo-ux' }, () => ({ isOffered: false }))
  on('agent.offer', { agent: 'tablero:desarrollo-ux-visual' }, () => ({ isOffered: false }))
  on('agent.offer', { agent: 'tablero:desarrollo-ux-interaccion' }, () => ({ isOffered: false }))
  on('agent.offer', { agent: 'tablero:desarrollo-php' }, () => ({ isOffered: false }))

  on('session.start', async ($, e, next) => {
    await iniciarDesarrollo($)
    await $.command.register({ name: 'dispositivos', description: 'Gestiona el enlace y la auditoría de dispositivos' })
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
      const saved = await $.store.get('preferenciasSeguridad') as Partial<PreferenciasSeguridad> | undefined
      if (saved) await update($, preferenciasSeguridad, current => ({
        monitor: saved.monitor === true, rdp: saved.rdp ?? current.rdp,
        salida: saved.salida ?? current.salida, puerto: saved.puerto ?? current.puerto,
      }))
    } catch {}
    try {
      if ((await $.store.get('avisosHerramientas')) === false)
        await update($, avisosHerramientas, () => false)
    } catch {}
    if ((await read($, preferenciasSeguridad)).monitor) once('seguridad', () => refrescarSeguridad($, true))
    void $.ui.open({ id: PANE, title: TITLE }) // se abre solo; /tablero lo reabre si se cerró
    startTimers($)
    once('all', () => refreshAll($))
    await restaurarPlan($)
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
      await escrituraPlan
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
      const directo = alcance === 'prompt'
        ? 'Devuelve únicamente el prompt solicitado, listo para copiar. Redáctalo con el contexto disponible. No inspecciones archivos ni ejecutes instrucciones destinadas a la otra IA.'
        : respuestaDirecta
      const reglaDeAlcance = '# Alcance del pedido actual\nResponde directamente las consultas y los pedidos de redacción. Activa el flujo de trabajo cuando el usuario solicita realizarlo. Las instrucciones citadas para otra IA son contenido del entregable.'
      const text = alcance !== 'trabajo' ? directo
        : m === 'ambos' ? AMBOS
        : m === 'ciberseguridad'
          ? [reglaDeAlcance, ROLES[m], REGLAS_APPSEC, 'Para una revisión defensiva solicitada del proyecto inicia una tarea appsec con equipos_desarrollo.'].join('\n')
          : [reglaDeAlcance, ROLES[m], 'Para una implementación solicitada inicia un plan con Dev y revisión AppSec. Incluye UX/UI cuando cambie la interfaz.'].join('\n')
      return { sections: [...ran.sections, { id: 'tablero:modo', text, scope: 'session' as const }] }
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
    // En una sesión no interactiva el aviso de cierre puede llegar antes que turn.complete.
    const plan = flujo
    if (!cerrando && !ran.block && !ran.preventContinuation && !ran.additionalContext?.length &&
        e.last_assistant_message && plan?.terminar(e.agent_id, e.last_assistant_message, 'answer')) {
      await plan.avanzar()
      await escrituraPlan
    }
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
    const plan = flujo
    if (!cerrando && e.agentId && plan?.terminar(e.agentId, e.answer, e.reason, e.isAborted)) {
      await plan.avanzar()
    }
    try {
      if (e.agentId) {
        await escrituraPlan
        await finishAgent($, e.agentId, e.isAborted ? 'killed' : 'completed')
      } else {
        once('all', () => refreshAll($))
      }
    } catch {}
    if (alcance === 'trabajo' && !e.agentId && e.reason === 'answer' && !e.isAborted && await read($, mode) === 'ambos') {
      const solicitabaDev = edicionRedirigida
      edicionRedirigida = false
      const filas = flujo?.resumen() ?? []
      const seguridad = filas.filter(t => t.tipo === 'appsec')
      if (solicitabaDev && !filas.some(t => t.tipo === 'implementacion')) {
        return { ...ran, text: ran.text + '\n\n**Estado del Tablero.** La edición directa fue bloqueada. Dev y AppSec aún no se ejecutaron.' }
      }
      if (planDelPedido && filas.some(t => t.tipo === 'implementacion') && seguridad.some(t => t.estado !== 'correcto')) {
        const estados = seguridad.map(t => t.id + ': ' + t.estado).join(', ')
        return { ...ran, text: ran.text + '\n\n**Estado del Tablero.** La revisión AppSec todavía no está aprobada (' + estados + ').' }
      }
    }
    return ran
  })

  on('tool.call', async ($, e, next) => {
    if (!e.agentId && alcance !== 'trabajo' && isRole(await read($, mode)) &&
        (alcance === 'prompt' || EDICION.has(e.tool) || TERMINAL.has(e.tool) || e.tool === 'Agent' || e.tool === 'Task')) {
      return { deny: respuestaDirecta }
    }
    if ((EDICION.has(e.tool) || TERMINAL.has(e.tool)) && await read($, mode) === 'ambos') {
      const tarea = flujo?.buscar(e.agentId)
      if (!tarea || (EDICION.has(e.tool) && tarea.tipo !== 'implementacion') ||
          (TERMINAL.has(e.tool) && tarea.tipo === 'appsec')) {
        if (!e.agentId) edicionRedirigida = true
        return { deny: 'Modo Ambos: inicia o retoma el plan en equipos_desarrollo. Dev implementa y AppSec revisa el cambio antes del cierre. Usa Read, Grep o Glob para inspeccionar.' }
      }
    }
    if (!e.agentId && alcance === 'trabajo' &&
        (EDICION.has(e.tool) || TERMINAL.has(e.tool) || e.tool === 'Agent' || e.tool === 'Task') &&
        await read($, mode) === 'desarrollo' && !(planDelPedido || flujo?.activo)) {
      return { deny: 'Modo Desarrollo: antes de editar, usar la terminal o lanzar agentes, analizá la tarea pieza por pieza e iniciá el plan con equipos_desarrollo (acción iniciar) indicando qué delegar y qué hacés vos. Usa Read, Grep o Glob para inspeccionar.' }
    }
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
    const { Box, Text, Button, Input } = $.ui.resolve(e)
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
    const seguridad = await read($, preferenciasSeguridad)
    const dispositivos = await read($, estadoDispositivos)
    const monitor = await read($, estadoMonitor)
    const envio = await read($, envioDispositivo)
    const vistaActual = await read($, vistaDispositivo)
    const pasoAnterior = ['red', 'archivos', 'cert-solicitud'].includes(vistaActual) ? 'identidad' : vistaActual === 'destino' ? 'agregar' :
      vistaActual === 'usar' ? 'destino' : undefined
    const formulario = await read($, formularioDispositivo)
    const peerElegido = await read($, peerDispositivo)
    const codigo = await read($, codigoDispositivo)
    const mensaje = await read($, mensajeDispositivo)
    const config = await read($, configuracionDispositivos)
    const datosCert = await read($, certificadosDispositivos)
    const conexion = dispositivos?.conexion
    const configurada = conexion?.estado === 'configurada'
    const camposCertificado = [['cert', 'Certificado de esta PC'], ['clave', 'Clave local'], ['autoridad', 'Certificado de la CA']] as const
    const camposRed = [['ip', 'IP privada de esta PC'], ['puerto', 'Puerto'], ['origenes', 'IPs de las otras PCs (separadas por coma)']] as const
    const camposDestino = [['host', 'Dirección de la otra PC'], ['puerto', 'Puerto'], ['huella', 'Huella completa de la otra PC']] as const
    const bloques = Object.entries(BLOQUES) as Array<[FormularioDispositivo['bloque'], string]>
    const alertas = dispositivos?.alerts.filter(([rule]) => rule === 'remote_logon' ? seguridad.rdp :
      rule === 'outbound_review' ? seguridad.salida : seguridad.puerto) ?? []
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
              <Button key="herramientas:avisos" plain onPress={() => configurarAvisos($, !avisos)}>
                {avisos ? '☑' : '☐'} Avisos de herramientas
              </Button>
            </Box>
          )}
        </Box>
      </Box>
    )

    const vistaPreferencias = tabActual === 'preferencias' && (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold color={th.accent}>Seguridad de esta PC</Text>
          <Button key="seguridad:monitor" plain onPress={() => cambiarSeguridad($, 'monitor')}>
            {seguridad.monitor ? '☑' : '☐'} Monitorear eventos de Windows
          </Button>
          <Button key="seguridad:rdp" plain onPress={() => cambiarSeguridad($, 'rdp')}>
            {seguridad.rdp ? '☑' : '☐'} Avisos de acceso remoto
          </Button>
          <Button key="seguridad:salida" plain onPress={() => cambiarSeguridad($, 'salida')}>
            {seguridad.salida ? '☑' : '☐'} Avisos de actividad saliente
          </Button>
          {seguridad.monitor && <Text dimColor>{monitor || 'Esperando la primera lectura.'}</Text>}
        </Box>
        <Box flexDirection="column">
          <Text bold color={th.accent}>Dispositivos</Text>
          <Button key="seguridad:puerto" plain onPress={() => cambiarSeguridad($, 'puerto')}>
            {seguridad.puerto ? '☑' : '☐'} Avisos del puerto y del enlace
          </Button>
        </Box>
        <Box flexDirection="column">
          <Text bold color={th.accent}>Herramientas</Text>
          <Button key="preferencias:herramientas" plain onPress={() => configurarAvisos($, !avisos)}>
            {avisos ? '☑' : '☐'} Avisos para instalar herramientas
          </Button>
        </Box>
        <Box flexDirection="column">
          <Text bold color={th.accent}>Privacidad y registros</Text>
          <Text dimColor>Auditoría local FTS5 · retención de 30 días · fuera de la memoria de Claude.</Text>
        </Box>
        <Button key="preferencias:apariencia" plain onPress={async () => {
          await update($, tab, () => 'general')
          await update($, seccionesAbiertas, ids => ids.includes('apariencia') ? ids : [...ids, 'apariencia'])
        }}>Abrir Apariencia</Button>
      </Box>
    )

    const titulosDispositivos = {
      identidad: 'Identidad de esta PC',
      archivos: 'Usar certificados existentes',
      'cert-solicitud': 'Solicitar un certificado',
      'cert-firmar': 'Firmar un certificado',
      red: 'Dirección de esta PC',
      activar: 'Activar enlace',
      agregar: 'Vincular otra PC',
      invitar: 'Invitación creada',
      destino: 'Identificá la otra PC',
      usar: envio.length ? 'Vista previa' : 'Código de invitación',
      enviar: envio.length ? 'Vista previa' : 'Preparar un envío',
      permisos: 'Solicitudes y permisos',
      actividad: 'Mensajes y alertas',
    }
    const vistaDispositivos = tabActual === 'dispositivos' && (
      <Box flexDirection="column" gap={1}>
        {vistaActual !== 'inicio' && (
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            {pasoAnterior ? (
              <Button key="dispositivos:atras" plain onPress={async () => {
                await update($, vistaDispositivo, () => pasoAnterior)
                await update($, envioDispositivo, () => [])
                await update($, mensajeDispositivo, () => '')
              }}>‹ Atrás</Button>
            ) : (
              <Button key="dispositivos:volver" plain onPress={() => cambiarVistaDispositivo($, 'inicio')}>‹ Dispositivos</Button>
            )}
          </Box>
        )}
        {mensaje && (
          <Box borderStyle="round" borderColor={th.accent} paddingX={1}>
            <Text>{mensaje}</Text>
          </Box>
        )}
        {vistaActual === 'inicio' && (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="column" borderStyle="round" borderColor={th.accent} paddingX={1} gap={1}>
              <Box flexDirection="row" flexWrap="wrap" gap={1}>
                <Text bold>Enlace privado</Text>
                <Text color={configurada && dispositivos?.enabled ? th.ok : th.muted}>
                  {configurada ? dispositivos?.enabled ? '● Enlace habilitado' : '○ Enlace desactivado' : '○ Primera conexión'}
                </Text>
              </Box>
              <Box flexDirection="row" flexWrap="wrap" gap={1}>
                <Button key="dispositivos:agregar" variant="primary" onPress={() => comenzarVinculacion($)}>Agregar dispositivo</Button>
                {configurada && dispositivos?.enabled && (
                  <Button key="dispositivos:nuevo-envio" plain onPress={() => cambiarVistaDispositivo($, 'enviar')}>Preparar un envío</Button>
                )}
              </Box>
            </Box>
            <Box flexDirection="column">
              <Button key="dispositivos:permisos" plain onPress={() => cambiarVistaDispositivo($, 'permisos')}>
                Solicitudes y permisos{dispositivos?.pending.length ? ' · ' + dispositivos.pending.length + ' pendientes' : ''}
              </Button>
              <Button key="dispositivos:actividad" plain onPress={() => cambiarVistaDispositivo($, 'actividad')}>
                Mensajes y alertas{alertas.length ? ' · ' + alertas.length + ' alertas' : ''}
              </Button>
              {dispositivos?.puedeFirmar && (
                <Button key="dispositivos:firmar-solicitud" plain onPress={() => abrirFirmaDispositivo($)}>Firmar certificado</Button>
              )}
            </Box>
            <Box flexDirection="row" flexWrap="wrap" gap={1}>
              <Button key="dispositivos:actualizar" plain onPress={() => refrescarSeguridad($)}>Actualizar</Button>
              {dispositivos?.enabled && (
                <Button key="dispositivos:enlace" plain onPress={() => operarDispositivo($, 'link', ['off'])}>Desactivar enlace</Button>
              )}
            </Box>
          </Box>
        )}

        {vistaActual !== 'inicio' && (
          <Box flexDirection="column" gap={1} borderStyle="round" borderColor={th.accent} paddingX={1}>
            <Text bold color={th.accent}>{titulosDispositivos[vistaActual]}</Text>
            {vistaActual === 'identidad' && (
              <Box flexDirection="column" gap={1}>
                <Box flexDirection="column">
                  <Button key="dispositivos:crear-ca" onPress={press => {
                    if (press.surface === 'terminal' || press.surface === 'desktop') return operarCertificados($, 'crear-autoridad')
                  }}>Crear red privada</Button>
                  <Text dimColor>Para la primera PC.</Text>
                </Box>
                <Box flexDirection="column">
                  <Button key="dispositivos:crear-solicitud" onPress={press => {
                    if (press.surface === 'terminal' || press.surface === 'desktop') return operarCertificados($, 'crear-solicitud')
                  }}>Unirme a una red</Button>
                  <Text dimColor>Genera la clave y la solicitud de esta PC.</Text>
                </Box>
                <Button key="dispositivos:usar-archivos" plain onPress={() => cambiarVistaDispositivo($, 'archivos')}>Ya tengo certificados</Button>
              </Box>
            )}

            {vistaActual === 'cert-solicitud' && (
              <Box flexDirection="column" gap={1}>
                <Box flexDirection="column">
                  <Text dimColor>Compartí este archivo con la PC que firma.</Text>
                  <Text>{datosCert.archivo}</Text>
                </Box>
                <Box flexDirection="column">
                  <Text dimColor>Huella de la solicitud</Text>
                  <Text>{datosCert.huella}</Text>
                </Box>
                <Box flexDirection="column">
                  <Text dimColor>Ruta del certificado que te devolvieron</Text>
                  <Input key="dispositivo:respuesta-certificado" value={datosCert.entrada} submitLabel="Guardar"
                    {...alEscribir(value => update($, certificadosDispositivos, f => ({ ...f, entrada: value })))} />
                </Box>
                <Box flexDirection="column">
                  <Text dimColor>Huella de la CA confirmada con la otra PC</Text>
                  <Input key="dispositivo:huella-ca" value={datosCert.huellaAutoridad} submitLabel="Guardar"
                    {...alEscribir(value => update($, certificadosDispositivos, f => ({ ...f, huellaAutoridad: value })))} />
                </Box>
                <Button key="dispositivos:importar-certificado" variant="primary" onPress={press => {
                  if (press.surface === 'terminal' || press.surface === 'desktop') return operarCertificados($, 'importar')
                }}>Importar certificado y continuar</Button>
              </Box>
            )}

            {vistaActual === 'cert-firmar' && (
              <Box flexDirection="column" gap={1}>
                {datosCert.huellaAutoridad ? (
                  <Box flexDirection="column">
                    <Text dimColor>Archivo para entregar a la otra PC</Text>
                    <Text>{datosCert.archivo}</Text>
                    <Text dimColor>Huella de tu CA · confirmala por separado</Text>
                    <Text>{datosCert.huellaAutoridad}</Text>
                  </Box>
                ) : (
                  <Box flexDirection="column">
                    <Box flexDirection="column">
                      <Text dimColor>Ruta del archivo .csr recibido</Text>
                      <Input key="dispositivo:archivo-csr" value={datosCert.entrada} submitLabel="Guardar"
                        {...alEscribir(value => update($, certificadosDispositivos, f => ({ ...f, entrada: value, huella: '', confirmada: false })))} />
                    </Box>
                    {datosCert.huella ? (
                      <Box flexDirection="column">
                        <Text dimColor>Compará la huella con la otra PC</Text>
                        <Text>{datosCert.huella}</Text>
                        <Button key="dispositivos:confirmar-csr" plain onPress={() => update($, certificadosDispositivos, f => ({ ...f, confirmada: !f.confirmada }))}>
                          {datosCert.confirmada ? '☑' : '☐'} Confirmé la huella con la otra PC
                        </Button>
                        {datosCert.confirmada && (
                          <Button key="dispositivos:firmar-certificado" variant="primary" onPress={press => {
                            if (press.surface === 'terminal' || press.surface === 'desktop') return operarCertificados($, 'firmar')
                          }}>Firmar y generar archivo</Button>
                        )}
                      </Box>
                    ) : (
                      <Button key="dispositivos:revisar-csr" onPress={() => operarCertificados($, 'leer-solicitud')}>Ver huella de la solicitud</Button>
                    )}
                  </Box>
                )}
              </Box>
            )}

            {(vistaActual === 'archivos' || vistaActual === 'red') && (
              <Box flexDirection="column" gap={1}>
                {vistaActual === 'red' && <Text dimColor>El firewall se configura por separado.</Text>}
                {(vistaActual === 'archivos' ? camposCertificado : camposRed).map(([id, label]) => (
                  <Box key={id} flexDirection="column">
                    <Text dimColor>{label}</Text>
                    <Input key={'dispositivo:config:' + id} value={config[id]} submitLabel="Guardar"
                      {...alEscribir(value => update($, configuracionDispositivos, f => ({ ...f, [id as keyof ConfiguracionDispositivos]: value })))} />
                  </Box>
                ))}
                <Button key="dispositivos:paso" variant="primary" onPress={press => {
                  if (press.surface === 'terminal' || press.surface === 'desktop') return avanzarVinculacion($, vistaActual === 'archivos' ? 'identidad' : 'red')
                }}>Siguiente</Button>
              </Box>
            )}

            {vistaActual === 'activar' && (
              <Box flexDirection="column">
                <Text dimColor>Habilitá esta PC para vincularla.</Text>
                <Button key="dispositivos:activar" variant="primary" onPress={press => {
                  if (press.surface === 'terminal' || press.surface === 'desktop') return avanzarVinculacion($, 'activar')
                }}>Habilitar y continuar</Button>
              </Box>
            )}

            {vistaActual === 'agregar' && (
              <Box flexDirection="column" gap={1}>
                <Box flexDirection="column">
                  <Button key="dispositivos:invitar" onPress={press => {
                    if (press.surface === 'terminal' || press.surface === 'desktop') return avanzarVinculacion($, 'invitar')
                  }}>Crear invitación</Button>
                  <Text dimColor>Esta PC recibe la solicitud.</Text>
                </Box>
                <Button key="dispositivos:usar" onPress={() => cambiarVistaDispositivo($, 'destino')}>Tengo una invitación</Button>
              </Box>
            )}

            {vistaActual === 'invitar' && (
              <Box flexDirection="column">
                <Text dimColor>Dirección</Text>
                <Text>{conexion?.direccion}:{conexion?.puerto}</Text>
                <Text dimColor>Huella</Text>
                <Text>{conexion?.huella}</Text>
                <Text dimColor>Código · vence en 5 minutos</Text>
                <Text bold>{codigo}</Text>
                <Button key="dispositivos:ver-solicitudes" onPress={async () => {
                  await refrescarSeguridad($)
                  await cambiarVistaDispositivo($, 'permisos')
                }}>Ver solicitudes recibidas</Button>
              </Box>
            )}

            {vistaActual === 'destino' && (
              <Box flexDirection="column" gap={1}>
                {camposDestino.map(([id, label]) => (
                  <Box key={id} flexDirection="column">
                    <Text dimColor>{label}</Text>
                    <Input key={'dispositivo:destino:' + id} value={formulario[id]} submitLabel="Guardar"
                      {...alEscribir(value => update($, formularioDispositivo, f => ({ ...f, [id]: value, coincide: false })))} />
                  </Box>
                ))}
                <Button key="dispositivos:coincide-destino" plain onPress={() =>
                  update($, formularioDispositivo, f => ({ ...f, coincide: !f.coincide }))}>
                  {formulario.coincide ? '☑' : '☐'} Comparé la huella con la otra PC
                </Button>
                <Button key="dispositivos:paso-destino" variant="primary" onPress={() => avanzarVinculacion($, 'destino')}>Siguiente</Button>
              </Box>
            )}

            {vistaActual === 'permisos' && (
              <Box flexDirection="column" gap={1}>
                <Box flexDirection="column">
                  <Text bold>Solicitudes pendientes</Text>
                  {!dispositivos?.pending.length && <Text dimColor>No hay solicitudes pendientes.</Text>}
                  {dispositivos?.pending.map(([peer]) => (
                    <Box key={peer} flexDirection="column">
                      <Text>Huella: {peer}</Text>
                      <Box flexDirection="row" gap={1} flexWrap="wrap">
                        <Button key={'dispositivos:revisar:' + peer} onPress={async () => {
                          await update($, peerDispositivo, () => peer)
                          await update($, formularioDispositivo, current => ({ ...current, coincide: false }))
                        }}>Revisar solicitud</Button>
                        <Button key={'dispositivos:rechazar:' + peer} plain onPress={() => operarDispositivo($, 'reject', [peer])}>Rechazar</Button>
                      </Box>
                    </Box>
                  ))}
                </Box>
                {peerElegido && dispositivos?.pending.some(([peer]) => peer === peerElegido) && (
                  <Box flexDirection="column" gap={1}>
                    <Text bold>Permiso temporal</Text>
                    <Text dimColor>Compará la huella con la otra PC.</Text>
                    <Text>{peerElegido}</Text>
                    <Button key="dispositivos:comparada" plain onPress={() => update($, formularioDispositivo, f => ({ ...f, coincide: !f.coincide }))}>
                      {formulario.coincide ? '☑' : '☐'} La huella coincide
                    </Button>
                    <Box flexDirection="column">
                      <Text dimColor>Identificador del proyecto</Text>
                      <Input key="dispositivo:permiso-proyecto" value={formulario.proyecto}
                        {...alEscribir(value => update($, formularioDispositivo, f => ({ ...f, proyecto: value })))} />
                    </Box>
                    <Box flexDirection="column">
                      <Text dimColor>Duración en minutos</Text>
                      <Input key="dispositivo:permiso-minutos" value={formulario.minutos}
                        {...alEscribir(value => update($, formularioDispositivo, f => ({ ...f, minutos: value })))} />
                    </Box>
                    {bloques.map(([id, nombre]) => (
                      <Button key={'dispositivo:permiso:' + id} plain onPress={() => update($, formularioDispositivo, f => ({ ...f, bloque: id }))}>
                        {formulario.bloque === id ? '●' : '○'} {nombre} · {id === 'work_request' ? 'Trabajo' : 'Lectura'}
                      </Button>
                    ))}
                    <Button key="dispositivo:autorizar" variant="primary" onPress={press => { if (press.surface === 'terminal' || press.surface === 'desktop') return aprobarDispositivo($, peerElegido) }}>
                      Autorizar este permiso
                    </Button>
                  </Box>
                )}
                <Box flexDirection="column">
                  <Text bold>Permisos vigentes</Text>
                  {!dispositivos?.grants.length && <Text dimColor>No hay permisos vigentes.</Text>}
                  {dispositivos?.grants.map(([peer, project, kind, mode, until]) => (
                    <Text key={peer + ':' + project + ':' + kind}>
                      {project} · {BLOQUES[kind as keyof typeof BLOQUES] ?? kind} · {mode === 'work' ? 'Trabajo' : 'Lectura'}
                      {' '}· {peer.slice(0, 12)} · vence {hhmm(until * 1000)}
                    </Text>
                  ))}
                  {[...new Set(dispositivos?.grants.map(([peer]) => peer))].map(peer => (
                    <Button key={'dispositivos:revocar:' + peer} plain onPress={() => operarDispositivo($, 'revoke', [peer])}>
                      Revocar permisos de {peer.slice(0, 12)}
                    </Button>
                  ))}
                </Box>
              </Box>
            )}

            {(vistaActual === 'usar' || vistaActual === 'enviar') && (
              <Box flexDirection="column" gap={1}>
                {!envio.length && (
                  <Box flexDirection="column">
                    {vistaActual === 'enviar' && camposDestino.map(([id, label]) => (
                      <Box key={id} flexDirection="column">
                        <Text dimColor>{label}</Text>
                        <Input key={'dispositivo:destino:' + id} value={formulario[id]} submitLabel="Guardar"
                          {...alEscribir(value => update($, formularioDispositivo, f => ({ ...f, [id]: value, coincide: false })))} />
                      </Box>
                    ))}
                    {vistaActual === 'enviar' && (
                      <Button key="dispositivos:coincide-destino" plain onPress={() =>
                        update($, formularioDispositivo, f => ({ ...f, coincide: !f.coincide }))}>
                        {formulario.coincide ? '☑' : '☐'} Comparé la huella con la otra PC
                      </Button>
                    )}
                    {vistaActual === 'usar' ? (
                      <Box flexDirection="column">
                        <Text dimColor>Código temporal</Text>
                        <Input key="dispositivo:codigo" value={formulario.codigo} submitLabel="Guardar"
                          {...alEscribir(value => update($, formularioDispositivo, f => ({ ...f, codigo: value })))} />
                      </Box>
                    ) : (
                      <Box flexDirection="column">
                        <Box flexDirection="column">
                          <Text dimColor>Identificador del proyecto</Text>
                          <Input key="dispositivo:proyecto" value={formulario.proyecto} submitLabel="Guardar"
                            {...alEscribir(value => update($, formularioDispositivo, f => ({ ...f, proyecto: value })))} />
                        </Box>
                        {bloques.map(([id, nombre]) => (
                          <Button key={'dispositivo:bloque:' + id} plain onPress={() =>
                            update($, formularioDispositivo, f => ({ ...f, bloque: id, valor: '', revision: '' }))}>
                            {formulario.bloque === id ? '●' : '○'} {nombre}
                          </Button>
                        ))}
                        {formulario.bloque === 'test_result' ? (
                          <Box flexDirection="column">
                            <Box flexDirection="column">
                              <Text dimColor>Pruebas aprobadas</Text>
                              <Input key="dispositivo:aprobadas" value={formulario.valor} submitLabel="Guardar"
                                {...alEscribir(value => update($, formularioDispositivo, f => ({ ...f, valor: value })))} />
                            </Box>
                            <Box flexDirection="column">
                              <Text dimColor>Pruebas fallidas</Text>
                              <Input key="dispositivo:fallidas" value={formulario.revision} submitLabel="Guardar"
                                {...alEscribir(value => update($, formularioDispositivo, f => ({ ...f, revision: value })))} />
                            </Box>
                          </Box>
                        ) : (
                          <Box flexDirection="column">
                            {(formulario.bloque === 'status' ?
                              [['queued', 'En cola'], ['running', 'En curso'], ['finished', 'Terminado'], ['blocked', 'Bloqueado']] :
                              [['review', 'Revisar código'], ['test', 'Ejecutar pruebas'], ['develop', 'Implementar']]).map(([id, label]) => (
                              <Button key={'dispositivo:valor:' + id} plain onPress={() =>
                                update($, formularioDispositivo, f => ({ ...f, valor: id ?? '' }))}>
                                {formulario.valor === id ? '●' : '○'} {label}
                              </Button>
                            ))}
                            {formulario.bloque === 'work_request' && (
                              <Box flexDirection="column">
                                <Text dimColor>Commit completo</Text>
                                <Input key="dispositivo:revision" value={formulario.revision} submitLabel="Guardar"
                                  {...alEscribir(value => update($, formularioDispositivo, f => ({ ...f, revision: value })))} />
                              </Box>
                            )}
                          </Box>
                        )}
                      </Box>
                    )}
                    <Button key="dispositivos:previa" onPress={() => plantearEnvioDispositivo($, vistaActual === 'usar')}>Ver antes de enviar</Button>
                  </Box>
                )}
                {!!envio.length && (
                  <Box flexDirection="column">
                    <Text dimColor>Destino: {envio[0]}:{envio[1]}</Text>
                    <Text dimColor>Huella</Text>
                    <Text>{envio[2]}</Text>
                    {envio[4] !== 'pair' && <Text>Proyecto: {envio[3]}</Text>}
                    <Text>{describirBloque(envio[4] ?? '', envio[5] ?? '')}</Text>
                    <Button key="dispositivos:enviar" variant="primary" onPress={press => { if (press.surface === 'terminal' || press.surface === 'desktop') return operarDispositivo($, 'send', envio) }}>Enviar</Button>
                    <Button key="dispositivos:cancelar" plain onPress={() => update($, envioDispositivo, () => [])}>Volver a editar</Button>
                  </Box>
                )}
              </Box>
            )}

            {vistaActual === 'actividad' && (
              <Box flexDirection="column" gap={1}>
                <Box flexDirection="column">
                  <Text bold>Mensajes recibidos</Text>
                  {!dispositivos?.inbox.length && <Text dimColor>Todavía no recibiste mensajes.</Text>}
                  {dispositivos?.inbox.map(([project, kind, data]) => (
                    <Text>{project} · {BLOQUES[kind as keyof typeof BLOQUES] ?? kind} · {describirBloque(kind, data)}</Text>
                  ))}
                </Box>
                <Box flexDirection="column">
                  <Text bold>Alertas de las últimas 24 horas</Text>
                  {!alertas.length && <Text dimColor>No hay alertas visibles.</Text>}
                  {alertas.map(([rule, peer, total, at]) => (
                    <Text key={rule + peer} color={th.warn}>
                      {ALERTAS[rule] ?? rule} · {peer.length === 64 ? peer.slice(0, 12) : peer}
                      {' '}· {total} {total === 1 ? 'evento' : 'eventos'} · {hhmm(at * 1000)}
                    </Text>
                  ))}
                </Box>
              </Box>
            )}
          </Box>
        )}
      </Box>
    )

    const consumoSesion = tabActual === 'agentes' ? await read($, consumoAgentes) : null
    const consumoAbierto = tabActual === 'agentes' ? await read($, detallesConsumo) : []
    const consumoPorAgente = consumoSesion?.agentes ?? {}
    const agentesActivos = ags.filter(([, a]) => !DONE.has(a.status))
    const mediciones = [consumoSesion?.principal, ...Object.values(consumoPorAgente).map(a => a.consumo)]
      .filter((c): c is Consumo => c !== undefined)
    const tokens = (n: number) => n.toLocaleString('es-AR')
    const filaConsumo = (id: string, nombre: string, consumo?: Consumo) => {
      const abierta = consumoAbierto.includes(id)
      if (!consumo) return <Text>{nombre} <Text dimColor>· Sin medición</Text></Text>
      return (
        <Box flexDirection="column">
          <Button key={'consumo:' + id} plain onPress={() =>
            update($, detallesConsumo, ids => abierta ? ids.filter(x => x !== id) : [...ids, id])}>
            {abierta ? '▾' : '▸'} {nombre} · {tokens(totalTokens(consumo))} tokens
          </Button>
          {abierta && (
            <Box flexDirection="column" paddingLeft={2}>
              <Text dimColor>Entrada nueva {tokens(consumo.entrada)} · Salida {tokens(consumo.salida)}</Text>
              <Text dimColor>Caché escrita {tokens(consumo.cacheCreada)} · Leída {tokens(consumo.cacheLeida)}</Text>
            </Box>
          )}
        </Box>
      )
    }
    const vistaAgentes = tabActual === 'agentes' && (
      <Box flexDirection="column" gap={lk.compacto ? 0 : 1}>
        <Box flexDirection="column" gap={lk.compacto ? 0 : 1}>
          <Box flexDirection="column">
            <Text bold color={th.accent}>Consumo de esta sesión</Text>
            <Text dimColor>
              {!consumoSesion ? 'Leyendo el registro local…' : mediciones.length ?
                tokens(totalTokens(sumarConsumos(mediciones))) + ' tokens registrados' : 'Todavía no hay tokens registrados'}
              {consumoSesion?.parcial ? ' · Lectura parcial' : ''}
            </Text>
          </Box>
          {filaConsumo('principal', 'Agente principal', consumoSesion?.principal)}
          {agentesActivos.length === 0 && <Text dimColor>No hay subagentes activos.</Text>}
          {agentesActivos.map(([id, a]) => (
            <Box key={id} flexDirection="column">
              {filaConsumo(id, a.type || 'Subagente ' + id.slice(0, 12), consumoPorAgente[id]?.consumo)}
              <Text dimColor>
                <Text color={th[statusTone(a.status)]}>●</Text> {statusLabel(a.status)}
                {consumoPorAgente[id]?.modelo || a.model ? ' · ' + (consumoPorAgente[id]?.modelo || a.model) : ''}
                {' · '}{duration((a.endedAt ?? now) - a.startedAt)}
              </Text>
              {a.description && <Text>{a.description}</Text>}
            </Box>
          ))}
        </Box>

        {!!filasEquipos.length && (
          <Box flexDirection="column">
            <Text bold color={th.accent}>Equipos de desarrollo</Text>
            {filasEquipos.map(f => (
              <Text key={f.id} color={f.demorada || f.estado === 'pendiente' || f.estado === 'pausada' ? th.warn : undefined}>
                {f.tipo === 'diseno_ux' ? 'Diseño UX/UI · ' :
                  f.tipo === 'revision_ux_visual' ? 'Revisión visual · ' :
                  f.tipo === 'revision_ux_interaccion' ? 'Navegación y accesibilidad · ' :
                  f.tipo === 'revision_ux' ? 'Revisión UX/UI · ' : ''}
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
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {(['general', 'agentes', 'dispositivos', 'preferencias'] as const).map(id => (
            <Button key={`tab:${id}`} variant={tabActual === id ? 'primary' : undefined} onPress={async () => {
              if (tabActual === id) return
              await update($, tab, () => id)
              if (id === 'dispositivos') await refrescarSeguridad($)
              if (id === 'agentes') {
                try { await reconcileAgents($) } catch {}
                try { await once('consumo-agentes', () => refrescarConsumo($)) } catch {}
              }
              try {
                await $.ui.scroll({ in: PANE, to: 'start' })
              } catch {}
            }}>
              {{ general: 'General', agentes: 'Agentes', dispositivos: 'Dispositivos', preferencias: 'Preferencias' }[id]}
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
                <Button key="herramientas:omitir" onPress={() => resolverAviso($, false)}>Seguir sin instalar esta vez</Button>
                <Button key="herramientas:silenciar" plain onPress={() => configurarAvisos($, false)}>Continuar sin preguntar</Button>
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
        {vistaDispositivos}
        {vistaPreferencias}
      </Box>
    )
  })
}
