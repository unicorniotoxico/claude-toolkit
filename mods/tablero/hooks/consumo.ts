import type { Consumo, ConsumoSesion } from '../types'

const campos = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const
export const totalTokens = (c: Consumo) => c.entrada + c.salida + c.cacheCreada + c.cacheLeida
export const sumarConsumos = (lista: Consumo[]) => lista.reduce((a, b) => ({
  entrada: a.entrada + b.entrada,
  salida: a.salida + b.salida,
  cacheCreada: a.cacheCreada + b.cacheCreada,
  cacheLeida: a.cacheLeida + b.cacheLeida,
}), { entrada: 0, salida: 0, cacheCreada: 0, cacheLeida: 0 })

type Medicion = Consumo & { modelo?: string }
type Lectura = { bytes: number; mtimeMs: number; pendiente: string; respuestas: Map<string, Medicion> }
type ArchivosLocales = {
  stat: (ruta: string) => Promise<{ size: number; mtimeMs: number; kind: string; isLink: boolean }>
  list: (ruta: string) => Promise<readonly { name: string; kind: string; isLink: boolean }[]>
  read: (ruta: string, offset: number, length: number) => Promise<unknown>
}
const TAMANO_BLOQUE = 512 * 1024
const MAX_BLOQUES = 8

function incorporarLineas(lectura: Lectura, texto: string, sesion: string, agente?: string) {
  const lineas = (lectura.pendiente + texto).split('\n')
  lectura.pendiente = lineas.pop() ?? ''
  for (const linea of lineas) {
    if (!linea.includes('"usage"')) continue
    try {
      const fila = JSON.parse(linea)
      if (fila?.type !== 'assistant' || fila.sessionId !== sesion || fila.forkedFrom ||
          (fila.requestSessionId && fila.requestSessionId !== sesion) ||
          (agente ? fila.isSidechain === false || (fila.agentId && fila.agentId !== agente) : fila.isSidechain)) continue
      const mensaje = fila.message
      const uso = mensaje?.usage
      const clave = typeof mensaje?.id === 'string' && mensaje.id ? mensaje.id :
        typeof fila.requestId === 'string' && fila.requestId ? fila.requestId : undefined
      if (!clave || !uso || mensaje.model === '<synthetic>' ||
          !campos.some(k => Object.hasOwn(uso, k)) ||
          campos.some(k => uso[k] != null && (!Number.isSafeInteger(uso[k]) || uso[k] < 0))) continue
      const modo = typeof mensaje.model === 'string' && /^[\w.:-]{1,100}$/.test(mensaje.model) ? mensaje.model : undefined
      const medida = {
        entrada: uso.input_tokens ?? 0, salida: uso.output_tokens ?? 0,
        cacheCreada: uso.cache_creation_input_tokens ?? 0, cacheLeida: uso.cache_read_input_tokens ?? 0,
        modelo: modo,
      }
      const anterior = lectura.respuestas.get(clave)
      // Un mensaje puede registrarse varias veces, por ejemplo si generó varios bloques.
      if (!anterior || totalTokens(medida) >= totalTokens(anterior)) lectura.respuestas.set(clave, medida)
    } catch {}
  }
}

async function buscarAgentes(fs: ArchivosLocales, dir: string, profundidad = 0): Promise<[string, string][]> {
  const archivos: [string, string][] = []
  try {
    for (const entrada of await fs.list(dir)) {
      if (entrada.isLink || !/^[\w.-]+$/.test(entrada.name) || ['.', '..'].includes(entrada.name)) continue
      const ruta = dir + '/' + entrada.name
      const agente = /^agent-([A-Za-z0-9][\w.-]*)\.jsonl$/.exec(entrada.name)?.[1]
      if (entrada.kind === 'file' && agente) archivos.push([agente, ruta])
      if (entrada.kind === 'directory' && profundidad < 4) archivos.push(...await buscarAgentes(fs, ruta, profundidad + 1))
    }
  } catch {}
  return archivos
}

export class ConsumoLocal {
  private sesion = ''
  private archivos = new Map<string, Lectura>()

  private async leer(fs: ArchivosLocales, ruta: string, sesion: string, agente?: string) {
    const stat = await fs.stat(ruta)
    if (stat.isLink || stat.kind !== 'file') return
    let lectura = this.archivos.get(ruta)
    if (!lectura || lectura.bytes > stat.size || (lectura.bytes === stat.size && lectura.mtimeMs !== stat.mtimeMs)) {
      lectura = { bytes: 0, mtimeMs: stat.mtimeMs, pendiente: '', respuestas: new Map() }
      this.archivos.set(ruta, lectura)
    }
    for (let bloque = 0; lectura.bytes < stat.size && bloque < MAX_BLOQUES; bloque++) {
      const length = Math.min(TAMANO_BLOQUE, stat.size - lectura.bytes)
      const texto = await fs.read(ruta, lectura.bytes, length)
      if (typeof texto !== 'string' || !texto) break
      // Las posiciones están en bytes. Al procesar una línea completa quedan solo IDs y contadores.
      incorporarLineas(lectura, texto, sesion, agente)
      lectura.bytes += length
    }
    lectura.mtimeMs = stat.mtimeMs
    return { respuestas: lectura.respuestas, parcial: lectura.bytes < stat.size || !!lectura.pendiente }
  }

  async medir(fs: ArchivosLocales, sesion: string, transcriptPath: string | undefined): Promise<ConsumoSesion> {
    const resultado: ConsumoSesion = { agentes: {}, parcial: false }
    const ruta = transcriptPath?.replace(/\\/g, '/')
    if (!/^[\w-]+$/.test(sesion) || !ruta?.endsWith('/' + sesion + '.jsonl')) return resultado
    if (ruta !== this.sesion) {
      this.sesion = ruta
      this.archivos.clear()
    }
    const raiz = ruta.slice(0, -'.jsonl'.length) + '/subagents'
    const fuentes: [string | undefined, string][] = [[undefined, ruta], ...await buscarAgentes(fs, raiz)]
    const vistas = new Set<string>()
    for (const [agente, archivo] of fuentes) {
      if (agente && resultado.agentes[agente]) continue
      try {
        const datos = await this.leer(fs, archivo, sesion, agente)
        if (!datos) continue
        const medidas: Medicion[] = []
        for (const [id, medicion] of datos.respuestas) {
          if (vistas.has(id)) continue
          vistas.add(id)
          medidas.push(medicion)
        }
        const consumo = medidas.length ? sumarConsumos(medidas) : undefined
        if (agente) {
          const modelos = [...new Set(medidas.map(m => m.modelo).filter(Boolean))]
          resultado.agentes[agente] = { consumo, modelo: modelos.join(', ') || undefined }
        } else {
          resultado.principal = consumo
        }
        resultado.parcial ||= datos.parcial
      } catch {
        resultado.parcial = true
      }
    }
    return resultado
  }
}
