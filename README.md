# claude-toolkit

Memoria local, subagentes de evidencia y seguridad, y un panel de gasto para Claude Code en Windows.
Todo corre en tu máquina: no hay servicios, contenedores ni llamadas extra al modelo, y no trae datos de nadie.

## Qué incluye

| Pieza | Qué hace |
| --- | --- |
| `memory-engine/` | Memoria de proyecto en SQLite + FTS5. Un hook inyecta 0–3 recuerdos relevantes por prompt (≤1.400 caracteres) y guarda los bloques `MEMORY:` que el modelo emite. Recuerdos ligados a archivos, commits o lockfiles se invalidan solos. Incluye `memory.cmd` (CLI) y `run.cmd` (outputs largos a log + extracto). Detalle en [memory-engine/README.md](memory-engine/README.md). |
| Subagente `evidencia-haiku` | Haiku para búsquedas, inventarios y comprobaciones acotadas. |
| Subagente `seguridad-revisor` | Sonnet para revisión independiente de cambios sensibles. |
| Subagentes `dev` y `appsec` | Implementación y AppSec autónomos, por pedido explícito (opcionales: `-NoDevAgents`). |
| `security/` | Procedimiento de coordinación (`flujo.md`) y guías de controles por stack (PHP/MySQL, JS/TS, Python). El hook avisa de la guía aplicable una vez por sesión. |
| Sección de `CLAUDE.md` | Reglas de seguridad y de delegación eficiente que usan los agentes de arriba. |
| `mods/tablero/` | Panel que se abre solo al iniciar cada sesión (`/tablero` lo reabre): costo y contexto de la sesión, límites de la cuenta, gasto de todas las sesiones locales, agentes lanzados (tipo, modelo, estado, duración en vivo, tarea), servidores MCP y herramientas usadas (llamadas, errores, latencia) y métricas del memory-engine. Agentes y herramientas se actualizan por eventos; el consumo se consulta cada 2 s y los límites de la cuenta se comparten entre sesiones locales. Apariencia configurable desde el pie del panel: tema de color, fondo (transparente deja ver el de la terminal), bordes y modo compacto (opcional: `-NoTablero`). |

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

- Windows con PowerShell 5.1 o superior.
- Python 3.10+ con SQLite FTS5 (el de python.org lo trae). No instala paquetes: el engine usa solo la biblioteca estándar en un venv propio.
- Claude Code (CLI o app de escritorio).

## Instalar

Descomprimí o cloná el toolkit en cualquier carpeta y ejecutá:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

El instalador se copia solo a `%USERPROFILE%\claude-toolkit` (esa es la carpeta del toolkit de ahí en más; la descargada se puede borrar) e instala desde ahí en `%USERPROFILE%\.claude`. No hay que crear carpetas a mano.

Opciones: `-ToolkitDir <ruta>` (otra carpeta para el toolkit; si existe y no es una copia del toolkit, se rechaza), `-ClaudeDir <ruta>`, `-BasePython <python.exe>`, `-NoDevAgents`, `-NoTablero`.

Después abrí una sesión nueva de Claude Code. Comprobación: `%USERPROFILE%\.claude\memory-engine\doctor.ps1`.

Qué toca en tu `.claude`: copia `memory-engine/`, `security/`, `mods/tablero/` y los cuatro agentes; agrega dos hooks (`UserPromptSubmit`, `Stop`) y la ruta del panel en `env.CLAUDE_CODE_PLUGIN_DIRS` de `settings.json`; agrega dos secciones marcadas a `CLAUDE.md`. Antes de pisar cualquier archivo guarda la versión previa en `.claudeackups\`. Si ya tenías un `env.CLAUDE_CODE_PLUGIN_DIRS`, se le suma la ruta del panel.

## Actualizar

`%USERPROFILE%\claude-toolkit` es la única fuente: los cambios se hacen ahí (o se instala una versión nueva desde donde la descargues, que reemplaza esa carpeta) y se aplican con:

```powershell
powershell -ExecutionPolicy Bypass -File $env:USERPROFILE\claude-toolkit\install.ps1
```

- Muestra `actualizando claude-toolkit X -> Y` (la versión está en `VERSION`; los cambios en `CHANGELOG.md`).
- Conserva la base de recuerdos, logs, `config.json`, el venv y tus casos de `bench
ecall_cases.json`.
- Recuerda las opciones de la instalación anterior (`-NoDevAgents`, `-NoTablero`); pasalas de nuevo solo para cambiarlas.
- Reemplaza en el mismo lugar las secciones marcadas de `CLAUDE.md`; lo que esté fuera de las marcas no se toca.
- No edites los archivos instalados en `.claude` (agentes, `security/`, `mods/tablero`, `memory-engine/app`): la próxima actualización los pisa. Cambialos en la carpeta del toolkit y reinstalá.

## Desinstalar

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

Restaura los archivos previos que no cambiaste después de instalar, retira hooks, secciones, panel y engine. La carpeta `%USERPROFILE%\claude-toolkit` queda para reinstalar; borrala a mano si ya no la querés. La base de recuerdos se archiva en el respaldo salvo `-DeleteData`.

## Uso rápido

- Guardar un hecho: `memory.cmd add --type business_rule --topic pagos --fact "..." [--files ...] [--validity until_file_changes]`, o dejá que el modelo cierre su respuesta con un bloque `MEMORY:`.
- Ver qué recuperaría una consulta: `memory.cmd search "texto" --inject`.
- Estado: `memory.cmd stats`, `memory.cmd doctor`.
- Recall con tus propias consultas: copiá `memory-engine\bench\recall_cases.example.json` a `recall_cases.json` y ejecutá `bench\recall.py`.

## Privacidad

- La base (`memory-engine\data\`) y los logs quedan solo en tu máquina, con permisos solo para tu usuario y SYSTEM.
- Al guardar, un filtro rechaza hechos que parezcan secretos; archivos sensibles (`.env`, claves) nunca se leen.
- El panel guarda un resumen por sesión (carpeta, gasto, % de contexto, agentes activos) en `%USERPROFILE%\.claude\tablero\sesiones\` para sumar las sesiones locales; nada sale de la máquina y los archivos de más de 7 días se ignoran.
- El `.gitignore` excluye datos, logs, configuración local y los tipos generados del panel (que listan tus MCP). Si compartís una copia de tu instalación en vez de este repositorio, revisá que no lleve esas carpetas.

## Límites conocidos

- Solo Windows (instaladores en PowerShell, rutas del venv).
- El panel lee el engine en `%USERPROFILE%\.claude\memory-engine`; con un `-ClaudeDir` distinto, esa sección del panel muestra "no se pudo leer".
- El gasto de sesiones en la web o en la nube no se ve: ahí no corre el panel. Los límites de la cuenta sí incluyen ese uso, pero llegan con la próxima respuesta del modelo en la sesión local.
- Apagar un MCP desde el panel bloquea sus herramientas y las saca del prompt, pero no desconecta el proceso del servidor (eso solo lo hace `/mcp`).
- La API de mods no expone si un MCP está caído: el panel muestra los servidores con herramientas cargadas y cómo resultaron sus llamadas.
