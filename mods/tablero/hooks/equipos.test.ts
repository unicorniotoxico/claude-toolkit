import { expect, test } from 'claude-code/testing'
import { Equipos, planValidado, promptTarea, type Tarea } from './equipos'

const tarea = (id: string, otros: Partial<Tarea> = {}): Tarea => ({
  id, equipo: id, tipo: 'implementacion', objetivo: 'Criterio verificable',
  archivos: [id + '.php'], depende: [], simulacionPHP: false, ...otros,
})

function correr(tareas: Tarea[]) {
  const lanzadas: string[] = []
  const avisos: Array<() => void> = []
  const plan = new Equipos({
    lanzar: async t => {
      lanzadas.push(t.id)
      return { agentId: t.id }
    },
    actualizar: () => {},
    aviso: () => {},
    reloj: (_ms, cb) => {
      avisos.push(cb)
      return () => {}
    },
  }, planValidado(tareas), 2, 60_000, 'base')
  return { plan, lanzadas, avisos }
}

test('corre equipos independientes y espera dependencias y archivos compartidos', async () => {
  const { plan, lanzadas, avisos } = correr([
    tarea('datos', { archivos: ['src'] }),
    tarea('busqueda', { archivos: ['src/consulta.php'] }),
    tarea('ficha'),
    tarea('integracion', { tipo: 'integracion', depende: ['busqueda', 'ficha'] }),
  ])
  await plan.avanzar()
  expect(lanzadas).toEqual(['datos', 'ficha'])
  avisos[0]!()
  expect(plan.resumen()[0]?.demorada).toBe(true)
  plan.terminar('datos', 'RESULTADO: OK', 'answer')
  await plan.avanzar()
  expect(lanzadas).toEqual(['datos', 'ficha', 'busqueda'])
  plan.terminar('busqueda', 'RESULTADO: FALLO', 'answer')
  await plan.avanzar()
  expect(plan.resumen()[3]?.estado).toBe('bloqueado')
  await plan.reintentar('busqueda', 'Corregir el caso que falló')
  plan.terminar('ficha', 'RESULTADO: OK', 'answer')
  plan.terminar('busqueda', 'RESULTADO: OK', 'answer')
  await plan.avanzar()
  expect(lanzadas.at(-1)).toBe('integracion')
})

test('una aprobación declarada sin simulación PHP sigue pendiente', async () => {
  const { plan } = correr([tarea('replay', { tipo: 'verificacion', simulacionPHP: true })])
  await plan.avanzar()
  plan.terminar('replay', 'RESULTADO: OK', 'answer')
  expect(plan.resumen()[0]?.estado).toBe('pendiente')
  await plan.reintentar('replay', 'Ejecutar simulación')
  plan.buscar('replay')!.simulacion = { estado: 'diferencias' }
  plan.terminar('replay', 'RESULTADO: OK', 'answer')
  expect(plan.resumen()[0]?.estado).toBe('falló')
})

test('rechaza dependencias circulares en lugar de dejar equipos esperando', () => {
  let mensaje = ''
  try {
    planValidado([tarea('uno', { depende: ['dos'] }), tarea('dos', { depende: ['uno'] })])
  } catch (error) {
    mensaje = String(error)
  }
  expect(mensaje).toContain('circular')
})


test('una corrección invalida solo las etapas dependientes ya terminadas', async () => {
  const { plan, lanzadas } = correr([
    tarea('dev'), tarea('ficha'),
    tarea('verificar', { tipo: 'verificacion', depende: ['dev'] }),
  ])
  await plan.avanzar()
  plan.terminar('dev', 'RESULTADO: OK', 'answer')
  plan.terminar('ficha', 'RESULTADO: OK', 'answer')
  await plan.avanzar()
  plan.terminar('verificar', 'RESULTADO: FALLO', 'answer')
  await plan.reintentar('dev', 'Arreglar el caso observado')
  expect(plan.resumen().map(t => t.estado)).toEqual(['en curso', 'correcto', 'en cola'])
  expect(lanzadas).toEqual(['dev', 'ficha', 'verificar', 'dev'])
})


test('Go y Visual Basic usan el verificador genérico y sus propios comandos', async () => {
  const tareas = [
    tarea('go', { tipo: 'verificacion', archivos: ['go.mod', 'main.go'] }),
    tarea('vb', { tipo: 'verificacion', archivos: ['App.vbproj', 'Main.vb'] }),
  ]
  const { plan, lanzadas } = correr(tareas)
  await plan.avanzar()
  expect(lanzadas).toEqual(['go', 'vb'])
  for (const t of tareas) {
    expect(promptTarea(t, '')).toContain('comandos nativos')
    expect(promptTarea(t, '')).not.toContain('php_replay')
  }
  plan.comando('go', 'go test ./...')
  plan.comando('vb', 'dotnet test')
  plan.terminar('go', 'RESULTADO: OK', 'answer')
  plan.terminar('vb', 'RESULTADO: OK', 'answer')
  expect(plan.resumen().map(t => t.estado)).toEqual(['correcto', 'correcto'])
})

test('reanuda solo la tarea interrumpida y preserva la terminada y la que sigue activa', async () => {
  const { plan, lanzadas } = correr([tarea('hecha'), tarea('cortada'), tarea('activa'), tarea('dep', { depende: ['cortada'] })])
  await plan.avanzar()
  plan.terminar('hecha', 'RESULTADO: OK', 'answer')
  await plan.avanzar()
  plan.terminar('cortada', '', 'abort', true)
  await plan.avanzar()
  expect(plan.resumen().map(t => t.estado)).toEqual(['correcto', 'pausada', 'en curso', 'en cola'])
  await plan.reanudar(new Set(['activa']))
  expect(lanzadas).toEqual(['hecha', 'cortada', 'activa', 'cortada'])
  expect(plan.resumen().map(t => t.estado)).toEqual(['correcto', 'en curso', 'en curso', 'en cola'])
  plan.terminar('cortada', 'RESULTADO: OK', 'answer')
  await plan.avanzar()
  expect(lanzadas.at(-1)).toBe('dep')
})

test('restaura el plan guardado y distingue ausencia de evidencia de una interrupción', async () => {
  const { plan } = correr([tarea('hecha'), tarea('cortada'), tarea('sin-evidencia', { tipo: 'verificacion' })])
  await plan.avanzar()
  plan.terminar('hecha', 'RESULTADO: OK', 'answer')
  await plan.avanzar()
  plan.terminar('sin-evidencia', 'RESULTADO: OK', 'answer')
  const lanzadas: string[] = []
  const copia = JSON.parse(JSON.stringify(plan.guardar()))
  const nuevo = Equipos.restaurar({
    lanzar: async (t, evidencia) => {
      lanzadas.push(t.id)
      expect(evidencia).toContain('cambios existentes')
      return { agentId: t.id + '-nuevo' }
    },
    actualizar: () => {},
    aviso: () => {},
    reloj: () => () => {},
  }, copia)
  expect(nuevo.resumen().map(t => t.estado)).toEqual(['correcto', 'en curso', 'pendiente'])
  expect(lanzadas).toEqual([])
  await nuevo.reanudar(new Set())
  expect(lanzadas).toEqual(['cortada'])
  expect(nuevo.resumen().map(t => t.estado)).toEqual(['correcto', 'en curso', 'pendiente'])
})
