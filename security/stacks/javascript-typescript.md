# JavaScript / TypeScript

Confirma si el cambio corre en navegador, servidor o ambos, y el framework real.
Selecciona los controles relacionados; tipos estáticos no sustituyen validación
en ejecución.

- **JS-01, navegador:** sigue datos no confiables hasta operaciones que interpretan HTML o código. Comprueba codificación, sanitización y escapes propios del contexto; considera los mecanismos del framework y sus vías de escape.
- **JS-02, API:** valida cuerpos, parámetros y campos modificables. Comprueba autorización por operación, objeto y cliente/tenant, sin permitir atributos privilegiados mediante asignación masiva.
- **JS-03, red del servidor:** ante destinos controlables, examina SSRF: protocolos, resolución de direcciones, redirecciones y acceso a redes internas. CORS no reemplaza autenticación ni autorización.
- **JS-04, ejecución y rutas:** sigue entradas hasta comandos, plantillas, evaluación dinámica, mezclas de objetos y archivos. Comprueba inyección, contaminación de prototipos o recorridos de rutas donde exista una conexión real.
- **JS-05, sesión y entrega:** si se usan cookies, verifica atributos, invalidación y CSRF de operaciones que cambian estado. Si cambia compilación o dependencias, comprueba secretos en recursos del navegador y paquetes afectados.

Registra evidencia del servidor para controles de acceso, aunque exista validación
en la interfaz. Añade pruebas de rechazo o bypass pertinentes. Evita auditar todas
las dependencias por cada edición; declara las limitaciones de cobertura.

Referencia de validación: https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html
