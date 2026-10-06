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
primero de forma persistente en IndexedDB (con una proyección compatible en
`localStorage`) y la interfaz responde de inmediato. Si no hay internet, la
operación permanece en una cola FIFO; cuando regresa la red se envía al mismo
Supabase y Apps Script de Tienda Nápoles, con identificadores estables para
evitar duplicados.

Al abrir la aplicación se ejecuta siempre una reconciliación: se intentan enviar
las operaciones pendientes respetando sus dependencias y se consultan en paralelo
los datos independientes de marca, colores, catálogo, mesas, inventario,
movimientos y ventas recientes. Una operación pendiente no impide actualizar
otras secciones. Las respuestas remotas dinámicas no se sirven desde la caché
del Service Worker; si la consulta falla, se conserva la última copia local y
el indicador muestra qué secciones no pudieron verificarse.
La misma comprobación se repite al recuperar internet y al volver a enfocar la
ventana. El indicador del encabezado informa si está sincronizado, sin conexión,
sincronizando o si existe una operación que requiere revisión.

No borres los datos del navegador ni cambies el perfil de Chrome/Edge: allí se
conservan la sesión local, las instantáneas y las operaciones pendientes.

## Compatibilidad del backend de sincronización

Antes de usar esta edición en producción, verifique que los servicios de Tienda
Nápoles ya incluyan las siguientes capacidades:

1. Ejecutar en Supabase, en orden:
   - `supabase/migrations/20260919120000_offline_sync_realtime.sql`
   - `supabase/migrations/20260920120000_shared_tips_and_table_zones.sql`
2. `appscript/Code.gs` está alineado con la versión `2.11.0` del repositorio
   online de referencia. El endpoint consultado el 5 de octubre de 2026
   también informó `2.11.0`. Esta actualización del archivo local no publica
   nada: si el endpoint ya responde `2.11.0`, no hace falta volver a desplegarlo.

La primera migración habilita Realtime para negocio, mesas, categorías y
productos. La segunda comparte la configuración de propina y las zonas de
mesas entre dispositivos. La implementación de Apps Script incluida incorpora
idempotencia para ventas, inventario y movimientos.

## Verificación técnica

Desde esta carpeta ejecuta `node tests/offline-sync.test.cjs`. Deben aprobarse
los 23 escenarios automatizados de persistencia, orden, reintentos,
idempotencia, conflictos y eliminaciones.

Ejecuta también `node tests/offline-roles.test.cjs`: valida los roles Jefe,
Administrador y Mesero, incluida la disponibilidad de Ventas y Usuarios.

`node tests/offline-sales-cache.test.cjs` comprueba que Ventas reutiliza la
copia local cuando la revisión del servidor no cambió y descarga el informe
completo cuando sí cambió.

Para validar contra los backends reales sin alterar datos de producción, siga
los 20 casos de `tests/MANUAL-OFFLINE-CHECKLIST.md` usando un negocio de prueba.
