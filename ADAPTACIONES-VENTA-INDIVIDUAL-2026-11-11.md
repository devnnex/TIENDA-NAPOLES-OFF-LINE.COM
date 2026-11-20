# Venta individual y código de barras

Cambios locales del 11 de noviembre de 2026, aplicados en BCA y OFF-LINE.

- «Atender mesa» pasa a «Venta individual» y muestra directamente el formulario de cobro existente, dentro de la sección. Las mesas, terrazas y materas no aparecen allí. Las mesas de Inicio conservan su atención habitual.
- Inicio tiene Venta individual 1, 2 y 3, cada una con su cuenta y borrador. Las ventas guardadas anteriormente en cuadros adicionales se recuperan en «Venta individual», mediante un selector que solo aparece si hay varias.
- «Nuevo producto» incluye un código de barras opcional, separado de las siglas. Conserva ceros iniciales y rechaza códigos duplicados. El campo queda preparado para recibir el escaneo; Enter o Tab pasa al nombre sin guardar el formulario accidentalmente.
- El antiguo botón «Ver cliente» de Inicio abre «Vender con código de barras». Cada escaneo terminado en Enter o Tab agrega una unidad a esa venta. Usa el mismo cobro, pagos, factura e inventario que una venta individual. Los productos no registrados, deshabilitados o sin stock suficiente no se agregan.

## Activación en Supabase

Ejecutar **una sola vez** `supabase/migrations/20261111120000_product_barcodes.sql` en el editor SQL de Supabase. BCA y OFF-LINE apuntan al mismo proyecto. La migración agrega una columna opcional y un índice único; no modifica precios, nombres, siglas, existencias, facturas ni permisos.

La columna aún no existía en la comprobación de solo lectura hecha durante esta adaptación. Posteriormente, el usuario confirmó que ejecutó la migración en Supabase. No se publicaron cambios en GitHub. Los productos que no usan código de barras mantienen el guardado anterior.

## Limpieza exclusiva de OFF-LINE

La limpieza se ejecuta después de validar el acceso y antes de habilitar la operación. El servidor local PowerShell guarda un respaldo cifrado con el usuario de Windows fuera del almacenamiento del navegador. Solo después envía `Clear-Site-Data` para caché, cookies y almacenamiento, y el navegador verifica que no queden Cache Storage, IndexedDB, localStorage, sessionStorage ni registros de service workers.

Inmediatamente se recuperan los datos operativos necesarios, incluidos borradores, inventario y operaciones pendientes. Después se registra de nuevo el service worker para conservar la operación sin internet. **La barra de almacenamiento queda vacía durante el reinicio y puede volver a mostrar uso al recuperar datos y preparar el sistema. Una barra permanentemente vacía no es compatible con el funcionamiento offline actual. La limpieza no equivale a sincronizar una venta pendiente.**

Si se cierra el navegador durante el vaciado, el respaldo pendiente se recupera al abrir de nuevo. Si el respaldo falla o hay otra ventana de la aplicación abierta, no se borran datos y se informa al usuario.

Usar el iniciador habitual de OFF-LINE, que ejecuta `offline-server.ps1`. La versión 1.0.42 comprueba el endpoint de salud del servidor nuevo y reemplaza un servidor anterior identificado como Nápoles al actualizar. El servidor Python alternativo no implementa este endpoint y no ejecutará el vaciado. Se compiló el instalador 1.0.42 con `offline-login-reset.js` y se dejó preparado localmente en `.delivery/release-1.0.42/`, sin publicar ni hacer push.

Respaldos: `%LOCALAPPDATA%\TiendaNapolesOffline\browser-reset-backups\before-login.bin` y `previous-login.bin`, cifrados mediante Windows DPAPI. No se exponen como archivos estáticos del sitio.

## Validación

Pruebas de navegador en escritorio y móvil para los tres borradores, formulario fijo, recuperación de ventas anteriores, inventario con código de barras, lectura tipo teclado, stock, medios de pago y facturación. Pruebas de Chrome contra el servidor PowerShell aislado para el vaciado real, fallo de respaldo, recuperación tras cierre y protección de otras ventanas. Regresiones del cobro, caja, persistencia financiera y cola offline.
