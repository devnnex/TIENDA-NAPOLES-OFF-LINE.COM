# Tienda Nápoles Offline

Esta carpeta es la edición local de Tienda Nápoles y conserva la configuración
propia del negocio.

## Instalación y uso diario

1. Conserva la carpeta completa en una ubicación fija del computador.
2. Ejecuta `Iniciar-Tienda-Napoles-Offline.cmd` una vez.
3. El sistema crea automáticamente en el escritorio el acceso directo
   **Tienda Nápoles**, con el icono oficial del negocio.
4. En adelante, abre la aplicación con doble clic en ese acceso directo.

El iniciador levanta el servidor local en
`http://127.0.0.1:8766/admin.html` y abre la aplicación en una ventana
independiente de Chrome o Microsoft Edge. Funciona nuevamente después de
apagar o reiniciar el computador; no se debe eliminar ni mover esta carpeta,
porque el acceso directo apunta a ella.

## Trabajo sin conexión

Los archivos necesarios están incluidos localmente. Cada operación se guarda
primero de forma persistente en el navegador y la interfaz responde de
inmediato. Si no hay internet, la operación permanece en una cola FIFO; cuando
regresa la red se envía al mismo Supabase y Apps Script de Tienda Nápoles, con
identificadores estables para evitar duplicados.

No borres los datos del navegador ni cambies el perfil de Chrome/Edge: allí se
conservan la sesión local, las instantáneas y las operaciones pendientes.

## Activación del backend de sincronización

Antes de usar esta edición en producción se deben completar una sola vez estos
dos pasos sobre los servicios de Tienda Nápoles:

1. Ejecutar en Supabase, en orden:
   - `supabase/migrations/20260919120000_offline_sync_realtime.sql`
   - `supabase/migrations/20260920120000_shared_tips_and_table_zones.sql`
2. Publicar `appscript/Code.gs` como una nueva versión de la aplicación web.
   El endpoint debe informar la versión `2.7.0`.

La primera migración habilita Realtime para negocio, mesas, categorías y
productos. La segunda comparte la configuración de propina y las zonas de
mesas entre dispositivos. Apps Script 2.7.0 añade idempotencia a ventas,
inventario, movimientos e ingresos.

## Verificación técnica

Desde esta carpeta ejecuta `node tests/offline-sync.test.cjs`. Deben aprobarse
los 15 escenarios automatizados de persistencia, orden, reintentos,
idempotencia, conflictos y eliminaciones.
