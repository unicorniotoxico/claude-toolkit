# Coordinación de seguridad

Consulta este procedimiento al delegar, auditar o implementar requisitos de seguridad. Mantén un solo responsable de los cambios de código.

## 1. Elegir el trabajo necesario

| Cambio | Ejecución inicial | Cierre |
| --- | --- | --- |
| Texto, formato o tarea sin efecto en controles | Principal | Comprobación pertinente al cambio |
| Lógica habitual sin superficie sensible | Principal y pruebas dirigidas | Comportamiento solicitado verificado |
| Cambio sensible, nueva dependencia o límite de confianza | Principal y un revisor independiente | Controles afectados verificados y hallazgos resueltos o pendientes explícitos |
| Auditoría amplia, arquitectura dudosa o especificación extensa | Herramienta o especialistas elegidos por cobertura | Cobertura y evidencia por objetivo |

Una refactorización puede ser sensible. Un diff pequeño puede afectar todo un sistema. Si falta contexto para clasificar, inspecciona el flujo relacionado antes de decidir.

## 2. Contrato para cada agente

Entrega únicamente:

- **Objetivo:** una pregunta y los requisitos o controles seleccionados para el stack real; incluye el criterio relevante, no todas las guías.
- **Estado y alcance:** revisión base, diff o archivos, llamadas relevantes y configuración afectada. Incluye cambios locales sin commit cuando existan.
- **Evidencia disponible:** comandos, resultados, ubicaciones de logs y condiciones de ejecución; no vuelques todos los logs al contexto.
- **Cierre:** qué evidencia basta y qué situaciones obligan a ampliar la revisión.

Por defecto, usa un revisor. Dos especialistas pueden trabajar en paralelo si tienen preguntas y cobertura distintas; el paralelismo debe aportar capacidad o reducir espera sin duplicar la tarea. Si aparece otra pregunta, delimítala antes de abrir otro agente. Esto es una política de trabajo, no un límite de concurrencia impuesto por la plataforma.

## 3. Seleccionar controles y herramientas

Confirma el stack con los manifiestos y el código cercanos al cambio (`composer.json`, `package.json`, `pyproject.toml` o equivalentes). Consulta versiones cuando afecten el análisis. No presupongas un framework ni recorras todo el equipo.

| Stack que interviene en el cambio | Guía a consultar |
| --- | --- |
| PHP o consultas MySQL | `{{CLAUDE_DIR}}/security/stacks/php-mysql.md` |
| JavaScript o TypeScript, navegador o servidor | `{{CLAUDE_DIR}}/security/stacks/javascript-typescript.md` |
| Python | `{{CLAUDE_DIR}}/security/stacks/python.md` |

Lee solo las guías pertinentes y selecciona controles por comportamiento afectado. En proyectos mixtos, sigue las conexiones entre capas que puedan invalidar el control; otro lenguaje no exige otro agente. Si el principal ya seleccionó controles, entrega esos criterios al revisor para evitar lecturas repetidas. Las guías no cubren todo stack: para otro lenguaje, framework o infraestructura deriva los controles de los requisitos, código y documentación oficial pertinentes.

Para cada control elegido registra ubicación, criterio de aceptación y evidencia. Añade roles, permisos de negocio, separación entre clientes y operaciones sensibles reales del proyecto; no inventes esas reglas. Distingue verificado, no aplicable, pendiente y hallazgo.

- Las pautas de brevedad y mínimo cambio están en las instrucciones globales de este perfil.
- Usa análisis estático, búsqueda de secretos, revisión de dependencias y tests disponibles en el proyecto según el cambio. Identifica la herramienta antes de proponer su comando.
- Para requisitos documentados, entrega al revisor controles concretos y el código que debe cumplirlos. Cumplir una especificación no demuestra por sí solo que sea segura.
- Para una auditoría amplia, divide el alcance en preguntas independientes y reutiliza las evidencias vigentes.
- No lances todos los scanners ni encadenes varios auditores sobre el mismo objetivo. Incorpora herramientas adicionales solo cuando una necesidad concreta del trabajo lo justifique.
- Usa `seguridad-revisor` como revisor habitual. Si el usuario solicita `appsec`, aprovecha ese agente en su lugar y evita revisar dos veces lo mismo.

## 4. Corregir y reutilizar evidencia

El principal corrige; el revisor valida el hallazgo, las rutas relacionadas y una regresión pertinente. Si el parche modifica otro control o introduce una ruta nueva, revisa esa ampliación. Reinicia una auditoría completa únicamente cuando el cambio invalide su cobertura de forma amplia.

Una revisión anterior sigue siendo útil mientras conserven validez sus entradas: código relacionado, dependencias, configuración, datos de prueba, herramientas y entorno. Un hash de un archivo no prueba todo eso. Para servicios vivos, considera también cambios y vigencia del estado externo.

Registra decisiones y evidencias en la conversación. Si se pide un informe o el trabajo necesita varias sesiones, el principal guarda un archivo local usando `{{CLAUDE_DIR}}/security/INFORME-REVISION.md`. Usa una ruta acordada del proyecto o, si no existe, una carpeta identificada por proyecto dentro de `{{CLAUDE_DIR}}/security/revisiones/`. Conserva el resultado del revisor y elimina secciones vacías; no abras otro agente para redactarlo. No generes un informe extenso por cada edición. No subas el perfil, informes, código ni evidencia, ni publiques comentarios en servicios externos.

## 5. Eficiencia de uso y finalización

El usuario trabaja normalmente con Opus y quiere eficiencia, no ahorro extremo. Optimiza por tarea correctamente resuelta: evita trabajo redundante, pero no reduzcas razonamiento, pruebas o cobertura cuando sean necesarios para seguridad y corrección. Principal y subagentes comparten límites de Pro, por lo que cada delegación debe justificar el trabajo que evita o la cobertura independiente que aporta.

El principal puede usar Opus para razonamiento, arquitectura y decisiones complejas. Usa `evidencia-haiku` para trabajo mecánico o acotado que pueda devolverse como evidencia reutilizable: localizar símbolos, mapear rutas, extraer resultados, clasificar archivos, reunir referencias o ejecutar comprobaciones cuyo objetivo ya esté definido. Usa herramientas directamente cuando ni siquiera haga falta interpretación. `seguridad-revisor` permanece en Sonnet para revisión independiente habitual; escala esa revisión a un modelo mayor solo cuando la complejidad del riesgo lo justifique. Los agentes `dev` y `appsec` conservan su configuración propia.

Usa porcentaje consumido y hora de reinicio de sesión y semana solo si la plataforma los expone al agente o el usuario los facilita. Si no están disponibles, declara el cupo desconocido: no lo calcules desde tokens, dólares o `/context`. No consultes en bucle ni hagas llamadas a modelos para medir el consumo. Ante un aviso de límite próximo, prioriza verificaciones y cierre del alcance activo; conserva un resumen local breve con cambios, evidencia y siguiente paso antes de ampliar trabajo. Esta pauta no es un corte automático ni justifica omitir controles de seguridad.

Continúa una revisión limitada solo sobre lo pendiente. No declares un requisito cumplido si falta evidencia, falla una herramienta o se agota el límite. Completa trabajo autorizado y viable; comunica bloqueos materiales.

Al comparar configuraciones, usa tareas equivalentes desde el mismo estado y registra los modelos, esfuerzo, caché, resultado y cobertura. La medida principal es el cupo Pro consumido para terminar la tarea. Una variación de la barra puede incluir otras conversaciones o agentes simultáneos y está sujeta a redondeo; no la atribuyas íntegramente a una tarea sin comprobarlo. Tokens y estimaciones monetarias ayudan a diagnosticar, sin convertirse en un porcentaje exacto del plan.
