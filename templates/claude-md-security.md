## Seguridad y gasto eficiente

- Prioriza requisitos, corrección y seguridad. Conserva validaciones, permisos, manejo de errores y pruebas relevantes al simplificar.
- Implementa el cambio completo más pequeño y legible. Reutiliza código y dependencias existentes; justifica dependencias nuevas.
- Explica decisiones y resultados brevemente. Conserva datos exactos, límites y evidencia necesaria; no comprimas artificialmente el código.
- Antes de ampliar trabajo, identifica el riesgo y busca con rutas y símbolos concretos. Lee también las llamadas y configuraciones que puedan cambiar el comportamiento.
- El agente principal conserva las decisiones complejas y la implementación. Delega solo cuando el trabajo delegado ahorra lectura, exploración o repetición sustancial. Usa `evidencia-haiku` para búsquedas, inventarios, extracción y comprobaciones acotadas; entrega objetivo, rutas o símbolos, evidencia previa, formato esperado y criterio de cierre. Si el usuario pide `appsec`, usa ese revisor en lugar de `seguridad-revisor` para el mismo objetivo; `dev` conserva su uso por pedido explícito.
- Usa `seguridad-revisor` para cambios en autenticación, autorización, datos sensibles, SQL, archivos, deserialización, destinos de red, criptografía, dependencias, infraestructura, dinero o borrado de datos. El riesgo depende del comportamiento, aunque cambie una sola línea.
- Una revisión existente puede cubrir ese paso si examinó el mismo estado y los mismos controles. Reutiliza evidencia solo mientras sigan válidos código, dependencias, configuración y entorno relevantes.
- Ejecuta primero las verificaciones dirigidas pertinentes. Conserva resultados completos localmente y presenta al modelo los fragmentos necesarios, con contexto suficiente para diagnosticar fallos.
- Usa las pautas de brevedad y mínimo cambio de este perfil. Carga instrucciones adicionales únicamente cuando aporten un procedimiento necesario y evita varias para el mismo objetivo.
- Para delegar, auditar o resolver requisitos de seguridad, consulta `{{CLAUDE_DIR}}/security/flujo.md`. Si una revisión queda incompleta, informa lo pendiente; continúa desde esa pregunta concreta cuando esté justificado.
- Mantén este perfil, sus informes y la evidencia en archivos locales. No los subas ni publiques comentarios en GitHub u otros servicios.
- Prioriza eficiencia de resolución, no ahorro ciego: usa toda la capacidad que aporte valor, pero evita vueltas, contexto irrelevante, agentes redundantes y relecturas. Conserva detalle suficiente para seguridad, corrección y cierre. El cupo del plan es una restricción operativa, no el objetivo principal.
- Cierra con cambios, comprobaciones y pendientes reales. Informa consumo solo a partir de contadores disponibles, sin inventar porcentajes ni ahorro.
