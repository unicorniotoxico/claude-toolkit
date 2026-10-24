import type { RenderElement } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { mcpBlock, mergeAgents, parseMemStats, pickLimits, summarizeSessions } from './register'

test('un servidor MCP apagado bloquea solo sus herramientas', async () => {
  const off = ['mysql-db']
  expect(mcpBlock(off, 'mcp__mysql-db__sql_query')).toContain('"mysql-db" está apagado')
  expect(mcpBlock(off, 'mcp__otro__sql_query')).toBeNull()
  expect(mcpBlock(off, 'Bash')).toBeNull()
  expect(mcpBlock([], 'mcp__mysql-db__sql_query')).toBeNull()
})

test('clic sobre un servidor MCP lo apaga y lo prende', async ($, on) => {
  // lo que el motor respondería: un servidor con una herramienta y el resto vacío
  on('tool.list', () => ({ value: [{ name: 'mcp__mysql-db__sql_query', description: 'consulta', mcp: true }] }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('agent.list', () => ({ value: [] }))
  on('clock.now', () => ({ value: 1000 }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  const ui = await $.ui.mount({
    plugin: 'tablero',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'tablero',
    props: { title: 'Tablero', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
  })
  await ui.press({ key: 'actualizar' })
  const row = async () => (await ui.find({ key: 'mcp:mysql-db' }))?.text ?? ''
  expect(await row()).toContain('1 tools')
  await ui.press({ key: 'mcp:mysql-db' })
  expect(await row()).toContain('apagado')
  await ui.press({ key: 'mcp:mysql-db' })
  expect(await row()).toContain('1 tools')
})

test('los límites de la cuenta salen de la lectura más reciente de cualquier sesión', async () => {
  const five = (p: number) => [{ kind: 'five_hour', percentUsed: p }]
  const own = { ctxWindow: 200000, limits: five(30), limitsAt: 1000 }
  const others = [
    { id: 'yo', folder: 'aca', activeAgents: 0, updatedAt: 9000, limits: five(99), limitsAt: 9000 }, // la propia no cuenta dos veces
    { id: 'b', folder: 'proyectos-dc', activeAgents: 0, updatedAt: 5000, limits: five(54), limitsAt: 5000 },
    { id: 'c', folder: 'vieja', activeAgents: 0, updatedAt: 3000, limits: five(40), limitsAt: 3000 },
  ]
  const best = pickLimits(own, others, 'yo')
  expect(best?.from).toBe('proyectos-dc')
  expect(best?.limits[0]?.percentUsed).toBe(54)
  // sin lecturas en ninguna parte
  expect(pickLimits({ ctxWindow: 1, limits: [] }, [], 'yo')).toBeNull()
  // la propia gana si es la más nueva
  expect(pickLimits({ ...own, limitsAt: 7000 }, others, 'yo')?.from).toBe('esta sesión')
})

test('elegir un modo agrega su rol al prompt de sistema', async ($, on) => {
  // lo que el motor respondería: el prompt base y las llamadas de interfaz
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  // el motor, sin nada propio que dibujar sobre el prompt: una caja vacía
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as RenderElement
  })

  const ask = {
    model: 'claude-opus-5-5',
    promptModel: 'claude-opus-5-5',
    surfaces: ['terminal'] as const,
    tools: [],
    outputStyle: null,
    traits: [],
  }
  // sin modo elegido, el prompt queda igual
  expect((await $.prompt.compose(ask)).sections.map(s => s.id)).toEqual(['intro'])

  const pane = await $.ui.mount({
    plugin: 'tablero',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'tablero',
    props: { title: 'Tablero', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
  await pane.press({ key: 'cambiar-modo' })
  const band = await $.ui.mount({
    plugin: 'tablero',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 80, scroll: { offset: 0, bodyRows: 6 }, view: {} },
  })
  expect(await band.find({ type: 'Text', text: /Para qué es esta sesión/ })).toBeDefined()
  await band.press({ key: 'ciber' })

  const sections = (await $.prompt.compose(ask)).sections
  expect(sections.map(s => s.id)).toEqual(['intro', 'tablero:modo'])
  expect(sections[1]?.text).toContain('Modo de la sesión: Ciberseguridad')
  expect(sections[1]?.scope).toBe('session')
  expect((await pane.find({ type: 'Text', text: /^Modo/ }))?.text).toContain('Ciberseguridad')
  // la barra se cierra tras elegir
  expect(await band.find({ type: 'Text', text: /Para qué es esta sesión/ })).toBeUndefined()
})

test('la apariencia se cambia desde el panel', async $ => {
  const ui = await $.ui.mount({
    plugin: 'tablero',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'tablero',
    props: { title: 'Tablero', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
  const label = async (key: string) => (await ui.find({ key }))?.text ?? ''
  expect(await label('tema')).toContain('tema claude')
  await ui.press({ key: 'tema' })
  expect(await label('tema')).toContain('tema oceano')
  await ui.press({ key: 'fondo' })
  expect(await label('fondo')).toContain('fondo oscuro')
  await ui.press({ key: 'bordes' })
  expect(await label('bordes')).toContain('☑')
  await ui.press({ key: 'compacto' })
  expect(await label('compacto')).toContain('☑')
})

test('suma el gasto de las sesiones locales y distingue activas', async () => {
  const now = 10 * 24 * 3600 * 1000
  const s = summarizeSessions(
    [
      { id: 'a', folder: 'api', usd: 1.5, activeAgents: 2, updatedAt: now - 10_000 },
      { id: 'b', folder: 'web', usd: 0.5, activeAgents: 0, updatedAt: now - 5 * 60_000 },
      { id: 'c', folder: 'cli', usd: 2, activeAgents: 0, updatedAt: now - 20_000, ended: true },
      { id: 'd', folder: 'vieja', usd: 9, activeAgents: 0, updatedAt: now - 2 * 24 * 3600 * 1000 },
    ],
    now,
  )
  expect(s.recent.map(x => x.id)).toEqual(['a', 'c', 'b'])
  expect(s.totalUsd).toBe(4)
  expect(s.activeCount).toBe(1)
  // solo la activa queda a la vista; cerradas e inactivas van agrupadas, con su gasto
  expect(s.active.map(x => x.id)).toEqual(['a'])
  expect(s.idle.map(x => x.id)).toEqual(['c', 'b'])
  expect(s.idleUsd).toBe(2.5)
})

test('sigue el estado de los agentes lanzados', async () => {
  const known = { a1: { description: 'buscar rutas', type: 'evidencia-haiku', model: 'haiku', status: 'running', startedAt: 1000 } }
  // sigue corriendo: conserva modelo e inicio
  let out = mergeAgents(known, [{ id: 'a1', description: 'buscar rutas', type: 'evidencia-haiku', status: 'running' }], 5000)
  expect(out.a1).toEqual({ ...known.a1, endedAt: undefined })
  // termina: marca el fin una sola vez
  out = mergeAgents(out, [{ id: 'a1', description: 'buscar rutas', type: 'evidencia-haiku', status: 'completed' }], 9000)
  expect(out.a1?.status).toBe('completed')
  expect(out.a1?.endedAt).toBe(9000)
  out = mergeAgents(out, [{ id: 'a1', description: 'buscar rutas', type: 'evidencia-haiku', status: 'completed' }], 12000)
  expect(out.a1?.endedAt).toBe(9000)
  // el motor lo suelta de la lista sin estado final: se da por terminado
  out = mergeAgents({ b2: { description: 'revisar', type: 'seguridad-revisor', status: 'running', startedAt: 1 } }, [], 50)
  expect(out.b2?.status).toBe('completed')
})

test('parsea la salida de memory.cmd stats', async () => {
  const out = "estado: {'active': 15, 'stale': 1}\nprompts=68 recuerdos_inyectados=1 hook_p95_ms=313\n"
  expect(parseMemStats(out)).toEqual({ active: 15, stale: 1, prompts: 68, injected: 1, hookP95: 313 })
})

test('el panel dibuja sus secciones en terminal y desktop', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const props = {
      title: 'Tablero',
      isFocused: true,
      bodyColumns: 60,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 30 },
      view: {},
    } as const
    const ui = await $.ui.mount({ plugin: 'tablero', surface, component: 'Pane', props, requestId: 'tablero' })
    expect(await ui.find({ type: 'Text', text: /Esta sesión/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Sesiones locales/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /No hay otras sesiones/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Memory-engine/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Todavía no se lanzó ninguno/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Sin lectura todavía/ })).toBeDefined()
    expect(await ui.find({ type: 'Button' })).toBeDefined()
    await ui.unmount()
  }
})
