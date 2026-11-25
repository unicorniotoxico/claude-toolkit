## Seguridad y eficiencia

- Prioriza requisitos, corrección y seguridad: al simplificar conserva validaciones, permisos, manejo de errores y pruebas relevantes.
- Implementa el cambio completo más pequeño y legible; reutiliza código y dependencias existentes y justifica las nuevas.
- Antes de ampliar trabajo, identifica el riesgo y busca con rutas y símbolos concretos; lee las llamadas y configuraciones que puedan cambiar el comportamiento.
- Analiza cada tarea y decide pieza por pieza si delegar ahorra más de lo que cuesta. Mecánica → `evidencia-haiku` (Haiku); media → `dev` o `seguridad-revisor` (Sonnet); pesada (diseño, decisiones, integrar) → tú o `appsec` (Opus). Hazlo tú si es pequeño o ya tienes el contexto. Los agentes no heredan tu modelo; el tuyo lo elige el usuario.
- Usa `seguridad-revisor` en cambios sobre autenticación, autorización, datos sensibles, SQL, archivos, deserialización, red, criptografía, dependencias, infraestructura, dinero o borrados: el riesgo depende del comportamiento, aunque cambie una línea. Una revisión previa sirve mientras no cambien código, dependencias, configuración ni entorno relevantes.
- Para delegar, auditar o resolver requisitos de seguridad consulta `{{CLAUDE_DIR}}/security/flujo.md`; no hay guías por lenguaje, los controles se derivan del comportamiento y las herramientas según el stack real.
- Ejecuta primero verificaciones dirigidas; presenta fragmentos suficientes para diagnosticar. Cierra con cambios, comprobaciones y pendientes reales; informa consumo solo si hay contadores disponibles.
- Perfil, informes y evidencia quedan en archivos locales: no los subas ni comentes en GitHub u otros servicios.
