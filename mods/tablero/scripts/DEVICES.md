# Dispositivos

El gateway directo está pensado para una prueba entre PCs bajo tu control. Cada equipo emisor solo necesita conectarse al receptor. Para intercambiar mensajes en ambos sentidos, ambas PCs necesitan un gateway alcanzable. El gateway y el tablero de un equipo comparten su base local. La implementación actual no incluye un relay entre VMs ni un transporte separado de la cuenta que ejecuta Claude.

## Configuración

1. Abrí **Dispositivos → Agregar dispositivo**. Para la primera PC elegí **Crear red y certificado**. Para otra, elegí **Generar clave y solicitud**. Si ya tenés certificados compatibles, podés usar los existentes. Se requiere OpenSSL disponible en el entorno. En Windows se busca también el de Git for Windows.
2. Pasá solo el archivo `.csr` a la primera PC y confirmá su huella por un canal distinto. En esa PC usá **Firmar certificado de otra PC** y devolvé el JSON generado. Verificá también la huella de la CA por otro canal al importar ese archivo. Las claves privadas se quedan en los dispositivos. Después el asistente pide red, puerto e IPs autorizadas.
3. En el receptor, **Iniciar receptor y crear invitación** inicia el gateway y muestra la dirección, huella y código. El script `device_firewall.ps1` permite agregar una regla entrante de Windows para ese puerto y las IP aprobadas. Revisá las reglas de la interfaz y usá `-WhatIf` para inspeccionar la acción. El asistente no modifica el firewall.
4. En el emisor, elegí **Tengo una invitación**. Ingresá dirección y puerto y verificá la huella por otro canal. El código se pide recién después de esos datos. Revisá la vista previa y tocá **Enviar**.
5. En el tablero de la receptora, entrá en **Solicitudes y permisos**. Revisá la huella del equipo, indicá proyecto y duración, elegí el bloque autorizado y tocá **Autorizar este permiso**. Se pueden agregar permisos de otros bloques mientras la solicitud siga vigente. Para quitar un vínculo usá **Revocar permisos**.
6. En la emisora, tocá **Preparar un envío**. Elegí el tipo de bloque y completá sus campos. El envío se realiza al confirmar la vista previa. El resultado queda en **Mensajes y alertas** del receptor. Cada autorización caduca y desactivar el enlace elimina permisos y solicitudes.

`/dispositivos` mantiene los comandos de consola para uso avanzado.

Las solicitudes de trabajo son registros para revisión humana. La recepción carece de integración con el lanzador de agentes. Los registros estructurados se buscan con `/dispositivos buscar REGLA`. No se inyectan en prompts. El monitor de Windows consulta fuentes existentes mientras corre Claude Code. El monitor y las alertas se configuran por separado en Preferencias.

Las acciones administrativas por comandos del tablero requieren origen humano en Claude Code. Una aplicación con los permisos de la cuenta del sistema todavía puede invocar el CLI o modificar la base. Para exposición pública se necesita aislar el gateway y su estado de la cuenta que ejecuta agentes, agregar un canal local de aprobación protegido por el sistema operativo y validar esa frontera. La instalación actual queda con el enlace apagado hasta que lo actives.
