# Dispositivos

El gateway directo está pensado para una prueba entre PCs bajo tu control. Cada equipo emisor solo necesita conectarse al receptor. Para intercambiar mensajes en ambos sentidos, ambas PCs necesitan un gateway alcanzable. El gateway y el tablero de un equipo comparten su base local. La implementación actual no incluye un relay entre VMs ni un transporte separado de la cuenta que ejecuta Claude.

## Configuración

1. Creá una CA privada y emití certificados individuales para cada PC. Usá certificados aptos para TLS cliente y servidor. Guardá la clave de la CA fuera de los equipos. Cada dispositivo recibe su propia clave, su certificado y el certificado público de la CA. Limitá por ACL la carpeta y la clave al usuario que las necesita.
2. En el directorio de datos del motor de memoria, creá `dispositivos/gateway.json` con las rutas absolutas de `cert`, `key` y `ca`, la IPv4 concreta `bind`, el entero `port` y una lista `allow` de IP o redes autorizadas. Usá una red privada para la primera prueba.
3. Ejecutá el Python del venv del toolkit con `-I device_gateway.py RUTA_DATOS/dispositivos serve`. El script `device_firewall.ps1` permite agregar una regla entrante en Windows para el puerto y las IPv4 aprobadas. Revisá antes la política de bloqueo entrante y las reglas existentes para esa interfaz. Usá `-WhatIf` para ver la acción. El instalador del toolkit no abre el puerto.
4. En una sesión nueva, abrí **Dispositivos** en ambas PCs y elegí **Habilitar enlace**. En la receptora tocá **Invitar a otra PC**. Intercambien las huellas por otro canal y pasale a la emisora el código temporal. En la emisora elegí **Tengo una invitación**, completá dirección, puerto, huella y código, y revisá la vista previa antes de tocar **Enviar**.
5. En el tablero de la receptora, entrá en **Solicitudes y permisos**. Revisá la huella del equipo, indicá proyecto y duración, elegí el bloque autorizado y tocá **Autorizar este permiso**. Se pueden agregar permisos de otros bloques mientras la solicitud siga vigente. Para quitar un vínculo usá **Revocar permisos**.
6. En la emisora, tocá **Preparar un envío**. Elegí el tipo de bloque y completá sus campos. El envío se realiza al confirmar la vista previa. El resultado queda en **Mensajes y alertas** del receptor. Cada autorización caduca y desactivar el enlace elimina permisos y solicitudes.

`/dispositivos` mantiene los comandos de consola para uso avanzado.

Las solicitudes de trabajo son registros para revisión humana. La recepción carece de integración con el lanzador de agentes. Los registros estructurados se buscan con `/dispositivos buscar REGLA`. No se inyectan en prompts. El monitor de Windows consulta fuentes existentes mientras corre Claude Code. El monitor y las alertas se configuran por separado en Preferencias.

Las acciones administrativas por comandos del tablero requieren origen humano en Claude Code. Una aplicación con los permisos de la cuenta del sistema todavía puede invocar el CLI o modificar la base. Para exposición pública se necesita aislar el gateway y su estado de la cuenta que ejecuta agentes, agregar un canal local de aprobación protegido por el sistema operativo y validar esa frontera. La instalación actual queda con el enlace apagado hasta que lo actives.
