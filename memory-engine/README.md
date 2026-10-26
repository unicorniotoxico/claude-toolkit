# memory-engine — memoria lateral, contexto de sesión y outputs acotados para Claude Code

Todo local, solo stdlib (sqlite3 + FTS5), sin daemons, sin embeddings ni llamadas extra al modelo.
Complementa el perfil existente (`CLAUDE.md`, `security/flujo.md`, `security/stacks/`, agentes).

## Arquitectura

```
prompt del usuario
   │
   ▼
UserPromptSubmit ──► .venv/python -I app/hooks.py prompt          (proceso corto, timeout 5 s)
   │                   ├─ señales: proyecto (raíz git), rama/commit (lee .git), palabras, archivos, símbolos
   │                   ├─ FTS5 (candidatos) ─► ranking híbrido ─► umbral ─► vigencia (solo candidatos)
   │                   ├─ 0–3 recuerdos ≤ 1400 chars   (nada relevante = 0 bytes)
   │                   ├─ contexto de sesión           (solo si el prompt es breve y anafórico: "¿y acá?")
   │                   └─ aviso de stack               (solo superficie sensible, una vez por sesión)
   ▼
Claude (Opus) ── evidencia-haiku (Haiku): búsqueda/inventario acotado
   │          └─ seguridad-revisor (Sonnet): revisión independiente de controles afectados
   │          └─ run (run.cmd): outputs grandes → log completo local + extracto determinístico
   ▼
Stop ──► .venv/python -I app/hooks.py stop                         (timeout 10 s)
          ├─ parsea bloques MEMORY: de last_assistant_message → filtro de secretos → dedupe → SQLite
          ├─ session context: archivos tocados, última decisión (JSON < 2 KB, expira 24 h)
          └─ métricas del turno (tools, agentes, tokens del transcript) → logs/metrics.jsonl
```

Cero CPU/RAM en reposo: no hay procesos residentes. SQLite se abre solo durante cada hook.

## Archivos

| Ruta | Función |
| --- | --- |
| `app/hooks.py` | hooks `prompt` / `stop`; failure-safe (todo error → exit 0, sin salida; se registra solo el tipo de error) |
| `app/store.py` | esquema, FTS5, alta + dedupe, ranking, vigencia, formato inyectado |
| `app/context.py` | proyecto/git sin lanzar git, extracción de términos, session context, detección de stack |
| `app/secrets_filter.py` | patrones deny + entropía; archivos sensibles nunca se leen (ni para hashear) |
| `app/cli.py` | `memory` (Windows: `memory.cmd`) |
| `app/runlog.py` | `run` (Windows: `run.cmd`) |
| `app/installer.py` | parcheo reversible de settings.json / CLAUDE.md / agentes |
| `templates/` | sección de CLAUDE.md y agentes instalados |
| `config.json` | límites, pesos y feature flags |
| `data/memory.db`, `data/session/` | datos (ACL: solo tu usuario + SYSTEM) |
| `logs/` | `metrics.jsonl`, `errors.log` (sin contenido), `runs/` (últimos 50 outputs) |

## Ranking

```
score = 0.35·text + 0.15·project + 0.25·file + 0.20·symbol + 0.10·topic + 0.10·session
      + 0.05·importance/5 + 0.05·confidence + 0.05·recency            (pesos en config.json)
text    = cobertura × (0.75 + 0.25·bm25_saturado)      cobertura = términos del prompt presentes / min(n,5)
project = 1 mismo proyecto · 0.4 global · otro proyecto = excluido en SQL
recency = 0.5^(días desde última verificación / 90)
gate    = text ≥ 0.15  ó  coincide archivo/símbolo  ó  (prompt ambiguo y coincide con la sesión)
inyecta si gate y score ≥ 0.45; máximo 3; nunca rellena hasta 3
```

Por qué así: la base mínima de cualquier recuerdo del mismo proyecto es ≈0.27, así que coincidir solo en el
proyecto nunca alcanza el umbral; hacen falta ≈0.18 de evidencia específica (texto, archivo, símbolo, tópico).
BM25 de FTS5 tiende a 0 con pocas memorias (el IDF se anula) y con muchas premia coincidencias casuales, por
eso solo refuerza la cobertura. Los términos pasan por un recorte conservador de sufijos es/en (imputó/imputar/imputación -> imput) y FTS5 busca por prefijo. Benchmark sintético: consultas aleatorias 0/20 y relevantes 30/30 en 1k, 10k y 100k memorias; búsqueda p50 1 ms / 20 ms / 67 ms.

## Vigencia (stale)

| validity | Se invalida cuando |
| --- | --- |
| `durable` | nunca (decae por recencia) |
| `until_file_changes` | cambia el sha256 de algún `files` (se guardan al crear; sin archivos legibles degrada a `until_commit_changes`) |
| `until_commit_changes` | HEAD distinto |
| `until_dependency_changes` | cambia el hash de manifiestos/lockfiles de la raíz |
| `session_only` | otra sesión |

Los recuerdos `global` se guardan siempre como `durable` (salvo `session_only`): se recuperan desde cualquier
proyecto, así que no hay archivo, commit ni lockfile contra el cual verificarlos.

Al guardar, los identificadores con forma de código del `fact` (CamelCase, snake_case, `algo(`) se agregan a
`symbols`, para que la señal `symbol` del ranking funcione sin pasarlos a mano.

Solo se verifica sobre los candidatos que pasan el umbral. Un recuerdo inválido se marca `stale` y se excluye
(`stale_action: "flag"` lo entrega con `REVERIFICAR` y penalización). `memory verify <id>` lo reactiva tras
comprobarlo.

## Deduplicación

Huella exacta (proyecto+tipo+texto normalizado) → actualiza. Casi duplicado (Jaccard ≥ 0.75, mismo
proyecto/tipo) → el nuevo reemplaza al viejo (`superseded_by`) uniendo archivos y símbolos.
`supersedes=<id>` en el bloque lo hace explícito (correcciones). `memory vacuum` purga reemplazados u
olvidados de más de 30 días y stale de más de 90 días.

## Feature flags (`config.json`)

```json
{ "enabled": true,                      // todo el sistema (también: variable CLAUDE_MEMORY_DISABLED=1)
  "memory": { "enabled": true, "retrieve": true, "store": true, ... },
  "session_context": { "enabled": true },
  "stack_hints": { "enabled": true },
  "security_review": { "enabled": true }, // false → inyecta: "no abras seguridad-revisor; el principal verifica"
  "subagents": { "enabled": true },       // false → inyecta: "no abras subagentes"
  "metrics": { "enabled": true } }
```

Los flags `security_review` y `subagents` son de política: la línea se inyecta solo si están apagados
(costo cero en el caso normal). Un `config.json` ilegible apaga el sistema; nunca adivina.

## CLI

`memory` es `~/.claude/memory-engine/memory` en macOS/Linux y `memory.cmd` en Windows (igual `run` / `run.cmd`):

```bash
memory search "autorización showInvoice" --inject   # scores, features y el bloque exacto que vería Claude
memory add --type security_decision --topic auth --fact "..." --files src/a.php --validity until_file_changes
memory list [--here] [--type T] [--all]
memory show 12 ; memory verify 12 ; memory forget 12 [--purge]
memory stats ; memory metrics [--days 7] ; memory doctor ; memory vacuum
```

Outputs grandes: `run -- npm test` · `run --grep "FAIL|Error" -- pytest -q` ·
`run --file <log> --lines 120-180`.

## Comparar A (sin sistema) vs B (con sistema)

1. Elige 3–5 tareas reales y repetibles (bugfix, cambio sensible, revisión) desde el mismo commit.
2. A: `config.json` → `"enabled": false` (los hooks no hacen nada; las reglas de CLAUDE.md siguen cargadas;
   para A puro, desinstala o comenta la sección marcada). B: `"enabled": true`.
3. Tras cada tarea: `memory metrics --days 0.1` (tool calls, agentes, tokens nuevos/cache del transcript,
   recuerdos inyectados/descartados) + `/usage` del plan antes/después + resultado (¿correcto?, ¿verificado?).
4. La métrica principal es tarea correcta por uso; los tokens son diagnóstico, no % del cupo Pro.

## Instalación

`engine.py install` (idempotente) · `engine.py doctor` · `engine.py uninstall [--delete-data]`, con cualquier
Python 3.10+ (uninstall, con el Python base: el venv se borra). En Windows, también `install.ps1` · `doctor.ps1` ·
`uninstall.ps1 [-DeleteData]`. Permisos de `data/` y `logs/`: solo tu usuario (Windows: más SYSTEM; macOS/Linux: `700`).
Respaldo previo en `~/.claude/backups/memory-engine-<fecha>/antes` + `manifest.json` con hashes.
Uninstall restaura byte a byte los archivos que no cambiaste desde la instalación; si los cambiaste, retira
solo lo propio (hooks marcados, sección `<!-- memory-engine -->`) y conserva tus cambios. Los datos se archivan
en el respaldo salvo `--delete-data`.

Con el Python del venv (`.venv/bin/python`; en Windows `.venv\Scripts\python.exe`): tests `-I -m unittest discover -s tests -v` · benchmark `-I bench/bench.py` · recall con consultas reales sobre la DB `-I bench/recall.py` (casos en `bench/recall_cases.json`; copialo de `recall_cases.example.json` y ajustá consultas e ids)
