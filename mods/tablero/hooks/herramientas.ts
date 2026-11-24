import type { Herramienta } from '../types'

const GESTORES = ['winget', 'brew', 'apt', 'go'] as const
const ID = /^[a-z0-9][a-z0-9._+@/-]{0,199}$/i
const EJECUTABLE = /^[a-z0-9][a-z0-9._+-]{0,49}$/i

function cadena(valor: unknown, max: number): valor is string {
  return typeof valor === 'string' && !!valor.trim() && valor.length <= max && !/[\u0000-\u001f\u007f]/.test(valor)
}

export function leerPropuesta(input: unknown): Herramienta[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 5) throw new Error('Indicá entre una y cinco herramientas.')
  const ids = new Set<string>()
  return input.map(item => {
    if (!item || typeof item !== 'object' || !cadena(item.nombre, 50) || !cadena(item.motivo, 350) ||
      !cadena(item.paquete, 200) || !ID.test(item.paquete) || !cadena(item.ejecutable, 50) ||
      !EJECUTABLE.test(item.ejecutable) || !GESTORES.includes(item.gestor))
      throw new Error('Proponé nombre, motivo, gestor admitido, identificador del paquete y nombre del ejecutable.')
    const { gestor, paquete, ejecutable, nombre, motivo } = item
    if (gestor === 'go' ? !/^[a-z0-9.-]+(?:\/[a-z0-9._-]+)+@[a-z0-9][a-z0-9._+-]*$/i.test(paquete)
      : !/^[a-z0-9][a-z0-9._+@-]*$/i.test(paquete))
      throw new Error('Identificador inválido para ' + gestor + '.')
    if (gestor === 'apt' && paquete.endsWith('-')) throw new Error('Identificador inválido para apt.')
    const key = gestor + ':' + paquete
    if (ids.has(key)) throw new Error('El mismo paquete aparece dos veces.')
    ids.add(key)
    return { gestor, paquete, ejecutable, nombre, motivo }
  })
}
