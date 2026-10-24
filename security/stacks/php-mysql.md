# PHP / MySQL

Selecciona solo controles conectados con el cambio. Confirma framework, driver y
versiones cuando modifiquen el comportamiento. Registra código, criterio y evidencia;
no ejecutes una batería completa por encontrar un archivo PHP.

- **PHP-01, SQL:** separa valores y estructura con parámetros del driver. Comprueba listas permitidas para identificadores u ordenamientos dinámicos y cualquier SQL construido en procedimientos almacenados. Revisa opciones del driver relevantes.
- **PHP-02, autorización:** verifica permisos en el servidor, objeto y cliente/tenant. Un identificador cambiado no debe permitir consultar o modificar recursos ajenos. Usa roles y relaciones reales del proyecto.
- **PHP-03, sesiones:** en cambios de autenticación, verifica renovación del identificador al elevar privilegios, expiración e invalidación. Con cookies, comprueba atributos y protección CSRF de operaciones que cambian estado.
- **PHP-04, salidas y archivos:** sigue entradas hasta HTML/JS/URL y aplica codificación según contexto. En cargas, comprueba tipo, tamaño, nombres, ubicación y acceso, evitando ejecución y recorridos de rutas.
- **PHP-05, integridad:** en operaciones concurrentes sensibles, revisa transacciones, restricciones, bloqueos o idempotencia que hagan cumplir la regla de negocio. Revisa privilegios de la cuenta o `DEFINER` si intervienen en el flujo.

Usa pruebas dirigidas de acceso permitido/rechazado, entradas adversas o concurrencia
cuando resuelvan un riesgo concreto. No pruebes con datos productivos para cubrir una
carencia del entorno. Declara pendiente lo que no puedas verificar.

Referencia del mecanismo SQL: https://www.php.net/manual/en/pdo.prepare.php
