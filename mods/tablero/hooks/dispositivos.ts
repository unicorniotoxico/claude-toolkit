import type { FormularioDispositivo } from '../types'

export const BLOQUES = {
  status: 'Estado del proyecto',
  test_result: 'Resultado de pruebas',
  work_request: 'Solicitud de trabajo',
} as const

export const ALERTAS: Record<string, string> = {
  tls_rejected: 'Certificado rechazado',
  rate_limit: 'Demasiadas conexiones',
  network_denied: 'Origen fuera de la lista permitida',
  route_rejected: 'Ruta no permitida',
  schema_rejected: 'Mensaje con formato inválido',
  permission_denied: 'Intento sin permiso',
  replay: 'Mensaje repetido',
  peer_pending: 'Nueva solicitud de conexión',
  invitation_rejected: 'Código de invitación rechazado',
  remote_logon: 'Inicio de sesión por Escritorio remoto',
  outbound_review: 'Conexión saliente de un intérprete',
}

export const FORMULARIO_INICIAL: FormularioDispositivo = {
  host: '', puerto: '', huella: '', codigo: '', proyecto: '', valor: '', revision: '',
  bloque: 'status', minutos: '30', coincide: false,
}

export function validarDestino(form: FormularioDispositivo) {
  const host = form.host.trim()
  const puerto = Number(form.puerto)
  const huella = form.huella.replace(/[ :]/g, '').toLowerCase()
  if (!/^(?:[a-z0-9][a-z0-9.-]{0,252}|\[[0-9a-f:]+\])$/i.test(host) ||
      !/^\d+$/.test(form.puerto) || !Number.isInteger(puerto) || puerto < 1 || puerto > 65535)
    throw new Error('Ingresá la dirección y el puerto de la otra PC.')
  if (!/^[a-f0-9]{64}$/.test(huella) || !form.coincide)
    throw new Error('Compará la huella completa y confirmá que coincide.')
  return [host, String(puerto), huella] as const
}

export function prepararEnvio(form: FormularioDispositivo, invitacion: boolean) {
  const [host, puerto, huella] = validarDestino(form)
  if (invitacion) {
    const code = form.codigo.trim().toLowerCase()
    if (!/^[a-f0-9]{32}$/.test(code)) throw new Error('Pegá el código temporal de la otra PC.')
    return [host, puerto, huella, 'vinculacion', 'pair', JSON.stringify({ code })]
  }
  const proyecto = form.proyecto.trim()
  if (!/^[a-z0-9][a-z0-9_.-]{0,79}$/i.test(proyecto))
    throw new Error('Ingresá el identificador del proyecto autorizado.')
  let data: Record<string, string | number>
  if (form.bloque === 'test_result') {
    if (![form.valor, form.revision].every(value => /^\d{1,6}$/.test(value) && Number(value) <= 100_000))
      throw new Error('Indicá por separado la cantidad de pruebas aprobadas y fallidas.')
    data = { passed: Number(form.valor), failed: Number(form.revision) }
  } else if (form.bloque === 'work_request') {
    if (!['review', 'test', 'develop'].includes(form.valor) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(form.revision))
      throw new Error('Elegí qué trabajo solicitás e ingresá el commit completo.')
    data = { operation: form.valor, revision: form.revision.toLowerCase() }
  } else {
    if (!['queued', 'running', 'finished', 'blocked'].includes(form.valor))
      throw new Error('Elegí un estado del proyecto.')
    data = { state: form.valor }
  }
  return [host, puerto, huella, proyecto, form.bloque, JSON.stringify(data)]
}

export function describirBloque(kind: string, raw: string) {
  if (kind === 'pair') return 'Solicitud de vinculación'
  try {
    const data = JSON.parse(raw)
    if (kind === 'test_result') return data.passed + ' aprobadas · ' + data.failed + ' fallidas'
    if (kind === 'work_request') {
      const operaciones: Record<string, string> = { review: 'Revisar código', test: 'Ejecutar pruebas', develop: 'Implementar' }
      return (operaciones[data.operation] ?? 'Trabajo') + ' · commit ' + data.revision
    }
    const estados: Record<string, string> = { queued: 'En cola', running: 'En curso', finished: 'Terminado', blocked: 'Bloqueado' }
    return estados[data.state] ?? 'Estado desconocido'
  } catch {
    return 'Detalle no disponible'
  }
}
