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

- **Objetivo:** una pregunta y los controles que apliquen al comportamiento afectado; incluye el criterio relevante, no listas completas.
- **Estado y alcance:** revisión base, diff o archivos, llamadas relevantes y configuración afectada. Incluye cambios locales sin commit cuando existan.
- **Evidencia disponible:** comandos, resultados, ubicaciones de logs y condiciones de ejecución; no vuelques todos los logs al contexto.
- **Cierre:** qué evidencia basta y qué situaciones obligan a ampliar la revisión.

Por defecto, usa un revisor. Dos especialistas pueden trabajar en paralelo si tienen preguntas y cobertura distintas; el paralelismo debe aportar capacidad o reducir espera sin duplicar la tarea. Si aparece otra pregunta, delimítala antes de abrir otro agente. Esto es una política de trabajo, no un límite de concurrencia impuesto por la plataforma.

## 3. Controles y herramientas: pensar por comportamiento, no por lenguaje

No hay guías por lenguaje. Los controles se derivan de lo que el código hace, y las herramientas se eligen según lo que haya instalado.

1. **Identifica el stack real** con el código, los manifiestos y el CI cercanos al cambio (`go.mod`, `package.json`, `*.vbproj`, `composer.json`, etc.). Usa los comandos nativos del proyecto. No presupongas framework ni recorras todo el equipo.
2. **Deriva los controles del comportamiento afectado**, con el estándar que aplique (OWASP ASVS/Top 10, CWE, NIST SSDF): quién entra y con qué permiso, qué dato no confiable llega a qué destino (consulta, comando, archivo, URL, plantilla, deserializador), qué se guarda o se registra, qué secretos o claves intervienen y qué operación mueve dinero o borra datos. Añade los roles, la separación entre clientes y las operaciones sensibles reales del proyecto; no los inventes.
3. **Si no conoces el lenguaje o framework, no lo adivines.** Busca en la documentación oficial cómo ese stack expresa el control (consultas parametrizadas, escape de salida, sesiones, subida de archivos, etc.) y qué herramienta lo comprueba: analizador estático, auditoría de dependencias, búsqueda de secretos, linter de seguridad o tests. Comprueba qué está instalado antes de proponer un comando (`Get-Command <x>`, `command -v <x>`). Si falta, usa su imagen de Docker u otra equivalente o deja la comprobación pendiente.
4. **Lo que quede fuera de lo previsto no se descarta.** Un componente raro, una llamada dinámica o una configuración externa se rastrea hasta su efecto; si no se puede, queda como UNVERIFIED con lo que falta.
5. En proyectos mixtos sigue las conexiones entre capas que puedan invalidar el control; otro lenguaje no exige otro agente.

Para cada control elegido registra ubicación, criterio de aceptación y evidencia, y distingue verificado, no aplicable, pendiente y hallazgo.

- Cumplir una especificación no demuestra que sea segura: señala los requisitos insuficientes.
- Para una auditoría amplia, divide el alcance en preguntas independientes y reutiliza las evidencias vigentes.
- No lances todos los scanners ni encadenes varios auditores sobre el mismo objetivo; añade una herramienta solo si una necesidad concreta lo justifica.
- Usa `seguridad-revisor` como revisor habitual. Si el usuario pide `appsec`, usa ese agente en su lugar y evita revisar dos veces lo mismo.

## 4. Corregir y reutilizar evidencia

El principal corrige; el revisor valida el hallazgo, las rutas relacionadas y una regresión pertinente. Si el parche modifica otro control o introduce una ruta nueva, revisa esa ampliación. Reinicia una auditoría completa únicamente cuando el cambio invalide su cobertura de forma amplia.

Una revisión anterior sigue siendo útil mientras conserven validez sus entradas: código relacionado, dependencias, configuración, datos de prueba, herramientas y entorno. Un hash de un archivo no prueba todo eso. Para servicios vivos, considera también cambios y vigencia del estado externo.

Registra decisiones y evidencias en la conversación. Si se pide un informe o el trabajo necesita varias sesiones, el principal guarda un archivo local usando `{{CLAUDE_DIR}}/security/INFORME-REVISION.md`. Usa una ruta acordada del proyecto o, si no existe, una carpeta identificada por proyecto dentro de `{{CLAUDE_DIR}}/security/revisiones/`. Conserva el resultado del revisor y elimina secciones vacías; no abras otro agente para redactarlo. No generes un informe extenso por cada edición. No subas el perfil, informes, código ni evidencia, ni publiques comentarios en servicios externos.

## 5. Eficiencia y finalización

Optimiza por tarea correctamente resuelta: evita trabajo redundante, pero no reduzcas razonamiento, pruebas ni cobertura cuando sean necesarios para seguridad y corrección.

Cada tarea va al modelo que su peso pide, y los subagentes llevan el suyo fijo: no heredan el del principal.

| Peso de la tarea | Quién | Modelo |
| --- | --- | --- |
| Mecánica: buscar, inventariar, extraer, comprobar algo ya definido | `evidencia-haiku` | Haiku |
| Media: implementar un cambio acotado, revisar los controles de un cambio sensible | `dev`, `seguridad-revisor` | Sonnet |
| Pesada: auditoría profunda, validar vulnerabilidades, cadenas de varios fallos | `appsec` | Opus |
| Orquestar, planificar y decidir | agente principal | El de la sesión; lo elige el usuario y no se cambia por cuenta propia |

Analiza la tarea y reparte pieza por pieza: delega lo que ahorra lectura o repetición o puede correr en paralelo; hazlo tú cuando es pequeño, ya tienes el contexto o explicarlo cuesta lo mismo. No subas un agente de nivel sin motivo ni lo bajes si la pieza exige más razonamiento.

Usa `evidencia-haiku` para trabajo mecánico y acotado que pueda devolverse como evidencia reutilizable (localizar símbolos, mapear rutas, extraer resultados, ejecutar comprobaciones ya definidas). Usa herramientas directamente cuando no haga falta interpretación.

Informa el consumo solo si la plataforma lo expone o el usuario lo da; no lo calcules a partir de tokens ni consultes en bucle. Si se acerca un límite, prioriza las verificaciones del alcance activo y deja un resumen breve de cambios, evidencia y siguiente paso. Esto no justifica omitir controles de seguridad.

Continúa una revisión limitada solo sobre lo pendiente. No declares un requisito cumplido si falta evidencia, falla una herramienta o se agota un límite. Completa el trabajo autorizado y viable; comunica los bloqueos materiales.
