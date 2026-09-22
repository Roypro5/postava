# Verificación real de autenticación

Fecha: 22 de septiembre de 2026  
Entorno: desarrollo (preview de Replit, Clerk administrado)

## Resultado

La persona responsable del proyecto confirmó manualmente estos recorridos con una cuenta y un correo reales:

- Registro y recepción del código de verificación por correo.
- Acceso a Estadísticas después de completar la verificación.
- Persistencia al reabrir con **Recordarme** activado.
- Cierre de sesión y revocación del acceso a Estadísticas.
- Recuperación por correo, cambio de contraseña y acceso con la contraseña nueva.
- Fin de la sesión al reabrir cuando **Recordarme** no estaba activado.

No se almacenaron en este documento correos, contraseñas, códigos ni identificadores de sesión.

## Mejoras surgidas de la prueba

- El formulario solicita repetir la contraseña al crearla o restablecerla.
- Las contraseñas distintas se rechazan antes de contactar al proveedor.
- Un correo ya registrado muestra una explicación directa y señala la opción de recuperación.
- Estadísticas incluye cierre de sesión y maneja sesiones terminadas o revocadas.

## Validación automática complementaria

- 21 pruebas unitarias aprobadas.
- 5 pruebas de interfaz Playwright aprobadas.
- Comprobación de sintaxis y `git diff --check` aprobadas.

Las pruebas automáticas complementan la comprobación manual; no sustituyen la entrega real de correos.

## Condición antes de publicar

Desarrollo y producción tienen usuarios y configuración de Clerk separados. Antes de considerar validado el entorno publicado, se debe repetir esta matriz con una cuenta de producción.