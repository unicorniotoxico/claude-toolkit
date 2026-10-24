# Cambios

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
