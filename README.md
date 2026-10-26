# claude-toolkit

Memoria local, subagentes de evidencia y seguridad, y un panel de gasto para Claude Code en Windows, macOS y Linux.
Todo corre en tu máquina: no hay servicios, contenedores ni llamadas extra al modelo, y no trae datos de nadie.

## Qué incluye

| Pieza | Qué hace |
| --- | --- |
| `memory-engine/` | Memoria de proyecto en SQLite + FTS5. Un hook inyecta 0–3 recuerdos relevantes por prompt (≤1.400 caracteres) y guarda los bloques `MEMORY:` que el modelo emite. Recuerdos ligados a archivos, commits o lockfiles se invalidan solos. Incluye `memory` (CLI) y `run` (outputs largos a log + extracto); en Windows, `memory.cmd` y `run.cmd`. Detalle en [memory-engine/README.md](memory-engine/README.md). |
| Subagente `evidencia-haiku` | Haiku para búsquedas, inventarios y comprobaciones acotadas. |
| Subagente `seguridad-revisor` | Sonnet para revisión independiente de cambios sensibles. |
| Subagentes `dev` y `appsec` | Implementación y AppSec autónomos, por pedido explícito (opcionales: `-NoDevAgents` / `--no-dev-agents`). |
| `security/` | Procedimiento de coordinación (`flujo.md`) y guías de controles por stack (PHP/MySQL, JS/TS, Python). El hook avisa de la guía aplicable una vez por sesión. |
| Sección de `CLAUDE.md` | Reglas de seguridad y de delegación eficiente que usan los agentes de arriba. |
| `mods/tablero/` | Panel que se abre solo al iniciar cada sesión (`/tablero` lo reabre): costo y contexto de la sesión, límites de la cuenta, gasto de todas las sesiones locales, agentes lanzados (tipo, modelo, estado, duración en vivo, tarea), servidores MCP y herramientas usadas (llamadas, errores, latencia) y métricas del memory-engine. Agentes y herramientas se actualizan por eventos; el consumo se consulta cada 2 s y los límites de la cuenta se comparten entre sesiones locales. Apariencia configurable desde el pie del panel: tema de color, fondo (transparente deja ver el de la terminal), bordes y modo compacto (opcional: `-NoTablero` / `--no-tablero`). |

## Modos de sesión

Al iniciar una sesión, una barra sobre el prompt pregunta para qué es:

| Modo | La sesión principal actúa como |
| --- | --- |
| Ciberseguridad | Ingeniero de seguridad: OWASP ASVS/Top 10, CWE Top 25, ISO/IEC 27001/27002, NIST SSDF y CSF 2.0; modelado de amenazas, hallazgos CONFIRMADO/PROBABLE/TEÓRICO con evidencia y remediación. |
| Desarrollo | Ingeniero de software senior: ISO/IEC 25010 y 12207, seguridad por diseño (OWASP Proactive Controls), pruebas y verificación con las herramientas del proyecto. |
| Ambos (orquestador) | Coordina implementación y seguridad: planifica, define controles antes de implementar y delega a `dev`, `seguridad-revisor`, `appsec` o `evidencia-haiku` solo cuando ahorra trabajo o aporta una mirada independiente. |

- El rol se agrega como sección del prompt de sistema; la sesión principal *es* el especialista y arma equipo con los subagentes cuando conviene, sin un agente intermedio que duplique contexto.
- Todos los roles obligan a verificar en fuentes oficiales (NVD, GitHub Advisories, OSV, OWASP, documentación del proveedor) lo que pudo cambiar después de la fecha de corte del modelo.
- "recordar en esta carpeta" guarda el modo por proyecto; `/modo` o "cambiar" en el panel lo cambia.
- Los textos de los roles están en `mods/tablero/hooks/roles.ts`.

## Requisitos

- Windows (PowerShell 5.1 o superior), macOS o Linux.
- Python 3.10+ con SQLite FTS5: el de python.org, Homebrew o la distribución lo traen (`python3` en macOS/Linux). No instala paquetes: el engine usa solo la biblioteca estándar en un venv propio.
- Claude Code (CLI o app de escritorio).

## Instalar

Descomprimí o cloná el toolkit en cualquier carpeta y ejecutá, según el sistema:

```powershell
.\install.ps1
```

```bash
./install.sh
```

En Windows, si la política de ejecución bloquea scripts: `powershell -ExecutionPolicy Bypass -File .\install.ps1`. Los dos lanzadores llaman a `toolkit.py`, que hace el trabajo en cualquier sistema (`python3 toolkit.py install --help`).

El instalador se copia solo a `~/claude-toolkit` (en Windows, `%USERPROFILE%\claude-toolkit`; esa es la carpeta del toolkit de ahí en más, la descargada se puede borrar) e instala desde ahí en `~/.claude`. No hay que crear carpetas a mano.

| PowerShell (`install.ps1`) | sh (`install.sh`) | Qué hace |
| --- | --- | --- |
| `-ToolkitDir <ruta>` | `--toolkit-dir <ruta>` | Otra carpeta para el toolkit; si existe y no es una copia del toolkit, se rechaza. |
| `-ClaudeDir <ruta>` | `--claude-dir <ruta>` | Otra carpeta de configuración de Claude Code. |
| `-BasePython <python>` | `PYTHON=<python3> ./install.sh` | Python con el que se crea el venv. |
| `-NoDevAgents` | `--no-dev-agents` (`--dev-agents` lo revierte) | No instala `dev` ni `appsec`. |
| `-NoTablero` | `--no-tablero` (`--tablero` lo revierte) | No instala el panel. |

Después abrí una sesión nueva de Claude Code. Comprobación: `~/.claude/memory-engine/doctor.ps1` en Windows; `~/.claude/memory-engine/.venv/bin/python ~/.claude/memory-engine/engine.py doctor` en macOS/Linux.

Qué toca en tu `.claude`: copia `memory-engine/`, `security/`, `mods/tablero/` y los cuatro agentes; agrega dos hooks (`UserPromptSubmit`, `Stop`) y la ruta del panel en `env.CLAUDE_CODE_PLUGIN_DIRS` de `settings.json`; agrega dos secciones marcadas a `CLAUDE.md`. Antes de pisar cualquier archivo guarda la versión previa en `.claude/backups/`. Si ya tenías un `env.CLAUDE_CODE_PLUGIN_DIRS`, se le suma la ruta del panel.

## Actualizar

`~/claude-toolkit` es la única fuente: los cambios se hacen ahí (o se instala una versión nueva desde donde la descargues, que reemplaza esa carpeta) y se aplican volviendo a ejecutar su instalador: `~/claude-toolkit/install.ps1` o `~/claude-toolkit/install.sh`.

- Muestra `actualizando claude-toolkit X -> Y` (la versión está en `VERSION`; los cambios en `CHANGELOG.md`).
- Conserva la base de recuerdos, logs, `config.json`, el venv y tus casos de `bench/recall_cases.json`.
- Recuerda las opciones de la instalación anterior (sin agentes dev/appsec, sin panel); pasalas de nuevo solo para cambiarlas.
- Reemplaza en el mismo lugar las secciones marcadas de `CLAUDE.md`; lo que esté fuera de las marcas no se toca.
- No edites los archivos instalados en `.claude` (agentes, `security/`, `mods/tablero`, `memory-engine/app`): la próxima actualización los pisa. Cambialos en la carpeta del toolkit y reinstalá.

## Desinstalar

`~/claude-toolkit/uninstall.ps1` (Windows) o `~/claude-toolkit/uninstall.sh` (macOS/Linux).

Restaura los archivos previos que no cambiaste después de instalar, retira hooks, secciones, panel y engine. La carpeta `~/claude-toolkit` queda para reinstalar; borrala a mano si ya no la querés. La base de recuerdos se archiva en el respaldo salvo `-DeleteData` / `--delete-data`.

## Uso rápido

El CLI es `~/.claude/memory-engine/memory` en macOS/Linux y `memory.cmd` en Windows (igual `run` / `run.cmd`).

- Guardar un hecho: `memory add --type business_rule --topic pagos --fact "..." [--files ...] [--validity until_file_changes]`, o dejá que el modelo cierre su respuesta con un bloque `MEMORY:`.
- Ver qué recuperaría una consulta: `memory search "texto" --inject`.
- Estado: `memory stats`, `memory doctor`.
- Recall con tus propias consultas: copiá `memory-engine/bench/recall_cases.example.json` a `recall_cases.json` y ejecutá `bench/recall.py`.

## Privacidad

- La base (`memory-engine/data/`) y los logs quedan solo en tu máquina, con permisos solo para tu usuario (y SYSTEM en Windows; `700` en macOS/Linux).
- Al guardar, un filtro rechaza hechos que parezcan secretos; archivos sensibles (`.env`, claves) nunca se leen.
- El panel guarda un resumen por sesión (carpeta, gasto, % de contexto, agentes activos) en `~/.claude/tablero/sesiones/` para sumar las sesiones locales; nada sale de la máquina y los archivos de más de 7 días se ignoran.
- El `.gitignore` excluye datos, logs, configuración local y los tipos generados del panel (que listan tus MCP). Si compartís una copia de tu instalación en vez de este repositorio, revisá que no lleve esas carpetas.

## Límites conocidos

- Probado en Windows 11 y Linux (Ubuntu 24.04). macOS usa el mismo camino que Linux (`install.sh`, `.venv/bin/python`), pero no se probó en una Mac.
- El panel lee el engine en `~/.claude/memory-engine`; con un `-ClaudeDir` / `--claude-dir` distinto, esa sección del panel muestra "no se pudo leer".
- El gasto de sesiones en la web o en la nube no se ve: ahí no corre el panel. Los límites de la cuenta sí incluyen ese uso, pero llegan con la próxima respuesta del modelo en la sesión local.
- Apagar un MCP desde el panel bloquea sus herramientas y las saca del prompt, pero no desconecta el proceso del servidor (eso solo lo hace `/mcp`).
- La API de mods no expone si un MCP está caído: el panel muestra los servidores con herramientas cargadas y cómo resultaron sus llamadas.
