# Cambios

## 1.6.2
- Modo Desarrollo: antes de editar, usar la terminal o lanzar agentes hay que iniciar el plan en `equipos_desarrollo` con el reparto de la tarea. El modo Ambos mantiene su regla.

## 1.6.1
- Dispositivos: los campos del asistente guardan lo escrito sin apretar Enter, así que Siguiente envía y valida lo que se ve. Antes respondía "Completá la IP, el puerto y los origenes" con los campos llenos.

## 1.6.0
- Equipos de Desarrollo con dependencias, concurrencia acotada, puntos de control e integración de ub-mode.
- Verificación diferencial independiente de PHP fuera de Apache con Docker sin red.
- Tablero: navegación por secciones, pestaña Agentes, tokens de la sesión y de los subagentes activos, y aprobación de instalación de herramientas desde el panel.
- Flujo Dev y AppSec por defecto, con revisión UX/UI en paralelo cuando cambia la interfaz. Los equipos interrumpidos se retoman al continuar.
- El Tablero distingue consultas y pedidos de redacción de los pedidos de trabajo: responde directo sin iniciar planes, agentes ni cambios.
- Dispositivos: enlace privado mTLS entre PCs propias, asistente paso a paso con certificados locales, permisos por proyecto y bloque con vencimiento, y auditoría local. Ver `mods/tablero/scripts/DEVICES.md`.
- Ciberseguridad enfocada en revisión defensiva de código. Los controles se derivan del comportamiento (`security/flujo.md`); se quitan las guías por stack y su aviso automático.
- Agentes `appsec` (Opus) y `dev` (Sonnet) con modelo fijo.
- Memoria: indexación por temas y subtemas. Una coincidencia de tema cuenta solo si la consulta cubre al menos la mitad de los términos de ese nivel, para que una palabra suelta no inyecte recuerdos sin relación.

## 1.5.0
- Multiplataforma: Windows, macOS y Linux. La instalación, la actualización, `doctor` y la desinstalación pasan a `toolkit.py` y `memory-engine/engine.py` (solo biblioteca estándar). `install.ps1` / `uninstall.ps1` quedan como lanzadores en Windows, con los mismos parámetros; en macOS/Linux, `install.sh` / `uninstall.sh` (`--no-dev-agents`, `--no-tablero`, `--toolkit-dir`, `--claude-dir`).
- Lanzadores POSIX `memory` y `run` junto a `memory.cmd` / `run.cmd`. `CLAUDE.md` y los agentes instalados nombran el del sistema.
- Hooks y panel usan el Python del venv de cada sistema (`.venv/bin/python` o `.venv\Scripts\python.exe`). En macOS/Linux, `data/` y `logs/` quedan con permisos `700`.
- Los mensajes del instalador salen en UTF-8 y en orden.

## 1.4.1
- Panel: "Sesiones locales" muestra solo las activas; las cerradas o inactivas quedan agrupadas en una línea con su gasto, desplegable con un clic. El total de 24 h las sigue sumando.

## 1.4.0
- Panel: clic sobre un servidor MCP lo apaga o lo prende (se recuerda entre sesiones). Apagado, sus herramientas se rechazan si el modelo las llama y salen de la lista del prompt (diferidas y marcadas). El proceso del servidor sigue conectado: para desconectarlo del todo, `/mcp`.

## 1.3.0
- Límites de la cuenta (5 h / 7 días) compartidos entre sesiones locales: el panel muestra la lectura más reciente de cualquier sesión, con su origen y antigüedad. Se actualiza también con el evento `session.measure`.
- Apariencia: temas de color (claude, oceano, matrix, atardecer, sobrio, contraste), fondo transparente / oscuro / negro, bordes y modo compacto, desde el pie del panel; se recuerda entre sesiones. Las barras se tiñen de advertencia al 75 % y de alerta al 90 %.

## 1.2.0
- Instalador: se copia solo a `%USERPROFILE%\claude-toolkit` (o `-ToolkitDir`) e instala desde ahí; no hace falta crear carpetas. Rechaza una carpeta destino que no sea del toolkit.
- Modos de sesión: al iniciar, una barra pregunta Ciberseguridad / Desarrollo / Ambos (orquestador) / Sin modo, con opción de recordarlo por carpeta. La sesión principal adopta el rol elegido (marcos ISO/OWASP/NIST, forma de trabajo, verificación en fuentes oficiales, armado de equipo con los subagentes). `/modo` o "cambiar" en el panel para cambiarlo.

## 1.1.0
- Panel `/tablero`: se abre solo al iniciar la sesión; agentes en vivo (por eventos), consumo consultado cada 2 s, gasto de todas las sesiones locales.
- Instalador: muestra la versión anterior y la nueva, recuerda `-NoDevAgents` / `-NoTablero` entre actualizaciones y adopta la sección de seguridad de un perfil previo en lugar de duplicarla.

## 1.0.0
- memory-engine con recuerdos globales sin vencimiento falso y símbolos automáticos; subagentes `evidencia-haiku`, `seguridad-revisor`, `dev`, `appsec`; guías de seguridad; panel `/tablero`.
