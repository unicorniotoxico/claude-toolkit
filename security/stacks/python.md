# Python

Confirma librerías, framework y versión que intervienen en el flujo. Selecciona
solo controles afectados y usa primero pruebas y herramientas del proyecto.

- **PY-01, procesos:** evita que entradas no confiables lleguen a un intérprete de comandos. Prefiere argumentos separados y comprueba opciones que cambian la conducta del ejecutable. En Windows, examina también el tratamiento especial de archivos batch; `shell=False` no prueba seguridad por sí solo.
- **PY-02, deserialización:** identifica `pickle`, cargadores YAML inseguros, `eval` y equivalentes sobre datos no confiables. Sustituye ejecución implícita por formatos y validación apropiados al requisito.
- **PY-03, archivos:** verifica límites de rutas, enlaces y extracción de archivos comprimidos cuando el origen sea controlable. Considera sobrescritura, permisos y límites de recursos pertinentes.
- **PY-04, aplicaciones y datos:** comprueba autorización por recurso/cliente, campos modificables, validación en ejecución y consultas parametrizadas. Inspecciona destinos de solicitudes salientes si son controlables.
- **PY-05, despliegue:** cuando se afecten, revisa depuración, exposición de errores, secretos, permisos y dependencias. Para autenticación basada en cookies, verifica atributos, invalidación y CSRF.

Registra el estado examinado y evidencia por control. Reproduce el fallo y una
regresión dirigida cuando sea viable; distingue sospecha, hallazgo y verificación
incompleta. No interpretes ausencia de alertas como prueba de seguridad.

Referencia de procesos: https://docs.python.org/3/library/subprocess.html#security-considerations
