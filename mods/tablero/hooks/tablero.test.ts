import type { RenderElement } from 'claude-code'
import { expect, test } from 'claude-code/testing'

declare const setTimeout: (callback: () => void, ms: number) => unknown

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
  expect(await row()).toBe('')
  await ui.press({ key: 'seccion:mcp' })
  expect(await row()).toContain('1 tools')
  await ui.press({ key: 'mcp:mysql-db' })
  expect(await row()).toContain('apagado')
  await ui.press({ key: 'mcp:mysql-db' })
  expect(await row()).toContain('1 tools')
  await ui.press({ key: 'seccion:mcp' })
  expect(await row()).toBe('')
  await ui.press({ key: 'seccion:mcp' })
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
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 6, bodyColumns: 80, scroll: { offset: 0, bodyRows: 6 }, view: {} },
  })
  expect(await band.find({ type: 'Text', text: /Para qué es esta sesión/ })).toBeDefined()
  await band.press({ key: 'ciber' })

  const sections = (await $.prompt.compose(ask)).sections
  expect(sections.map(s => s.id)).toEqual(['intro', 'tablero:modo'])
  expect(sections[1]?.text).toContain('Modo de la sesión: Ciberseguridad')
  expect(sections[1]?.text).toContain('revisor defensivo de código')
  expect(sections[1]?.text).toContain('pruebas automatizadas locales')
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
  await ui.press({ key: 'seccion:apariencia' })
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

test('las secciones se despliegan en su lugar y la pestaña Agentes reemplaza la vista General', async $ => {
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
    const secciones = [
      ['sesion', /Costo:/],
      ['cuenta', /Sin lectura todavía/],
      ['sesiones', /No hay otras sesiones/],
      ['mcp', /Sin servidores MCP/],
      ['herramientas', /Todavía ninguna/],
      ['memoria', /Cargando/],
      ['apariencia', /tema claude/],
    ] as const
    for (const [id, texto] of secciones) {
      expect(await ui.find({ key: `seccion:${id}` })).toBeDefined()
      expect(await ui.find({ text: texto })).toBeUndefined()
      await ui.press({ key: `seccion:${id}` })
      expect(await ui.find({ text: texto })).toBeDefined()
      expect(await ui.find({ key: 'seccion:sesiones' })).toBeDefined()
      await ui.press({ key: `seccion:${id}` })
      expect(await ui.find({ text: texto })).toBeUndefined()
    }
    await ui.press({ key: 'seccion:sesion' })
    await ui.press({ key: 'seccion:cuenta' })
    expect(await ui.find({ text: /Costo:/ })).toBeDefined()
    expect(await ui.find({ text: /Sin lectura todavía/ })).toBeDefined()
    await ui.press({ key: 'seccion:sesion' })
    await ui.press({ key: 'seccion:cuenta' })
    await ui.press({ key: 'tab:agentes' })
    expect(await ui.find({ key: 'seccion:mcp' })).toBeUndefined()
    expect(await ui.find({ key: 'seccion:sesion' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Todavía no se lanzó ninguno/ })).toBeDefined()
    await ui.press({ key: 'tab:general' })
    expect(await ui.find({ key: 'seccion:mcp' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Todavía no se lanzó ninguno/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('el modo Desarrollo solicita agentes nativos y muestra las tareas rechazadas por el motor', async ($, on) => {
  const lanzamientos: string[] = []
  on('session.root', () => ({ value: '/proyecto' }))
  on('clock.now', () => ({ value: 1000 }))
  on('agent.spawn', (_$, e) => {
    lanzamientos.push((e as unknown as { subagent_type?: string }).subagent_type ?? '')
    return { deny: 'Motor de prueba sin agentes vivos' }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'a'.repeat(40), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  const pane = await $.ui.mount({
    plugin: 'tablero', surface: 'terminal', component: 'Pane', requestId: 'tablero',
    props: { title: 'Tablero', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 50 }, view: {} },
  })
  await pane.press({ key: 'cambiar-modo' })
  const band = await $.ui.mount({
    plugin: 'tablero', surface: 'terminal', component: 'AbovePrompt',
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 6, bodyColumns: 80, scroll: { offset: 0, bodyRows: 6 }, view: {} },
  })
  await band.press({ key: 'dev' })
  const result = await $.tool.call({
    tool: 'mcp__tablero__equipos_desarrollo',
    accion: 'iniciar',
    tareas: [
      { id: 'catalogo', equipo: 'Catálogo', tipo: 'implementacion', objetivo: 'Listar dinosaurios', archivos: ['listado.php'] },
      { id: 'ficha', equipo: 'Ficha', tipo: 'preparacion', objetivo: 'Definir casos de la ficha' },
      { id: 'integrar', equipo: 'Integración', tipo: 'integracion', objetivo: 'Abrir el detalle de un resultado', depende: ['ficha', 'catalogo'] },
    ],
  })
  expect(result.deny).toBeUndefined()
  expect(lanzamientos).toEqual(['tablero:desarrollo-dev', 'tablero:desarrollo-verificador'])
  expect(JSON.stringify(result.result)).toContain('bloqueado')
  await pane.press({ key: 'tab:agentes' })
  expect((await pane.find({ type: 'Text', text: /Catálogo · catalogo/ }))?.text).toContain('pendiente')
})

test('el aviso detalla cada paquete, permite omitir y se puede silenciar', async ($, on) => {
  let ejecuciones = 0
  on('clock.after', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1000 }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('process.run', () => {
    ejecuciones++
    return { value: { exitCode: 0, stdout: '{"estado":"disponible","ruta":"/prueba/gdb"}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  const pane = await $.ui.mount({
    plugin: 'tablero', surface: 'terminal', component: 'Pane', requestId: 'tablero',
    props: { title: 'Tablero', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 50 }, view: {} },
  })
  await pane.press({ key: 'cambiar-modo' })
  const band = await $.ui.mount({
    plugin: 'tablero', surface: 'terminal', component: 'AbovePrompt',
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 6, bodyColumns: 80, scroll: { offset: 0, bodyRows: 6 }, view: {} },
  })
  await band.press({ key: 'dev' })

  const herramienta = { nombre: 'GDB', gestor: 'apt', paquete: 'gdb', ejecutable: 'gdb', motivo: 'Inspeccionar dónde falla la prueba local.' }
  const propuesta = { tool: 'mcp__tablero__herramientas_desarrollo' as const, accion: 'proponer', herramientas: [herramienta] }
  const estado = async () => String((await $.tool.call({ tool: propuesta.tool, accion: 'estado' })).result)
  const invalida = await $.tool.call({ ...propuesta, herramientas: [{ ...herramienta, paquete: 'gdb-' }] })
  expect(invalida.isError).toBe(true)
  await $.tool.call(propuesta)
  expect(await pane.find({ text: /Inspeccionar/ })).toBeUndefined()
  await pane.press({ key: 'detalle:apt:gdb' })
  expect(await pane.find({ text: /Inspeccionar/ })).toBeDefined()
  expect(ejecuciones).toBe(0)
  await pane.press({ key: 'seleccionar:apt:gdb' })
  expect(await pane.find({ key: 'herramientas:instalar' })).toBeUndefined()
  await pane.press({ key: 'seleccionar:apt:gdb' })
  expect(await pane.find({ key: 'herramientas:instalar' })).toBeDefined()

  expect((await pane.find({ key: 'herramientas:omitir' }))?.text).toContain('esta vez')
  expect((await pane.find({ key: 'herramientas:silenciar' }))?.text).toContain('Continuar sin preguntar')
  await pane.press({ key: 'herramientas:omitir' })
  expect(await estado()).toContain('"avisos":true')
  expect(await estado()).toContain('"estado":"omitida"')
  expect(await pane.find({ key: 'herramientas:instalar' })).toBeUndefined()
  await $.tool.call(propuesta)
  await pane.press({ key: 'herramientas:silenciar' })
  expect(await estado()).toContain('"avisos":false')
  expect(String((await $.tool.call(propuesta)).result)).toContain('Avisos desactivados')
  expect(await pane.find({ key: 'herramientas:instalar' })).toBeUndefined()

  await pane.press({ key: 'seccion:apariencia' })
  await pane.press({ key: 'herramientas:avisos' })
  expect(await estado()).toContain('"avisos":true')
  expect(ejecuciones).toBe(0)
  await $.tool.call({ ...propuesta, herramientas: [herramienta, { ...herramienta, nombre: 'LLDB', paquete: 'lldb', ejecutable: 'lldb' }] })
  await pane.press({ key: 'seleccionar:apt:lldb' })
  await pane.press({ key: 'herramientas:instalar' })
  await new Promise<void>(resolve => setTimeout(resolve, 150))
  const resultado = await estado()
  expect(resultado).toContain('/prueba/gdb')
  expect(resultado).not.toContain('lldb')
  expect(ejecuciones).toBe(1)
})

test('Dispositivos explica el estado y prepara un envío antes de confirmarlo', async ($, on) => {
  const peer = 'a'.repeat(64)
  const calls: string[][] = []
  on('process.run', (_$, e) => {
    const op = e as unknown as { argv: string[] }
    const action = op.argv[4] ?? ''
    calls.push([action])
    return { value: {
      exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false,
      stdout: action === 'send' ? '{"status":202}' : JSON.stringify({
        enabled: true, conexion: { estado: 'configurada', huella: peer, puerto: 4321 },
        pending: [], grants: [], inbox: [], alerts: [],
      }),
    } }
  })
  const ui = await $.ui.mount({
    plugin: 'tablero', surface: 'terminal', component: 'Pane', requestId: 'tablero',
    props: { title: 'Tablero', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
  })
  await ui.press({ key: 'tab:dispositivos' })
  expect(await ui.find({ text: /Enlace habilitado/ })).toBeDefined()
  await ui.press({ key: 'dispositivos:usar' })
  await ui.press({ key: 'dispositivos:previa' })
  expect(await ui.find({ text: /Ingresá la dirección/ })).toBeDefined()
  await ui.input({ key: 'dispositivo:destino:host', text: '192.168.1.10', kind: 'submit' })
  await ui.input({ key: 'dispositivo:destino:puerto', text: '4321', kind: 'submit' })
  await ui.input({ key: 'dispositivo:destino:huella', text: peer, kind: 'submit' })
  await ui.input({ key: 'dispositivo:codigo', text: 'b'.repeat(32), kind: 'submit' })
  await ui.press({ key: 'dispositivos:coincide-destino' })
  await ui.press({ key: 'dispositivos:previa' })
  expect(await ui.find({ text: 'Vista previa' })).toBeDefined()
  expect(calls.flat()).not.toContain('send')
  await ui.press({ key: 'dispositivos:enviar' })
  expect(calls.flat()).toContain('send')
  expect(await ui.find({ text: /La otra PC tiene que aprobarla/ })).toBeDefined()
})
