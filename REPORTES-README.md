# Ventas, movimientos y reportes compartidos

Aplicar una vez en el SQL Editor del proyecto Supabase compartido:
supabase/migrations/20261013160000_fast_reports_and_client_bill.sql.
La migración es repetible y conserva los datos existentes. Añade la opción
de Marca para mostrar u ocultar Ver cuenta a los clientes y una bitácora de
cambios autorizada para empleados. Los avisos públicos no transmiten facturas.

Al confirmar el cierre de la cuenta, la venta se guarda en la ruta rápida de
Supabase. El otro sistema la consulta sin esperar el reporte completo de Google.
Realtime acelera la lectura y la consulta cada 1,5 segundos recupera avisos
perdidos. Los cambios pendientes se conservan al perder la conexión; la
sincronización remota necesita que vuelva internet. Los IDs evitan repetir ventas
y movimientos al conciliar el historial. El stock recibido requiere confirmación
del servicio de inventario para respetar los ajustes concurrentes.

Ventas exporta PDF del filtro, fecha o turno seleccionado y recorre todas las
páginas online. Compras también exporta PDF con resumen por producto y detalle.
Sin conexión se identifica la copia disponible y las ventas parciales.
Movimientos permite elegir producto y fechas, consultar todo el historial y
ver unidades ingresadas, retiradas y vendidas en cuentas cobradas. Consumir
o retirar unidades todavía no equivale a cobrar una venta.

El selector de consumo conserva el producto al actualizarse la lista y las
vueltas se muestran en letra y número más grandes. La caja automática conserva
su comportamiento: solo efectivo y solo en el PC conectado físicamente.

## Marca y consultas del QR

Guardar marca está junto a Logo y Portada; Guardar mesas de afuera está dentro
de su configurador. Los dos botones guardan la configuración y bloquean nuevos
envíos mientras se confirma la operación.

La página del QR consulta la cuenta sin crear sesiones al abrirse, recuperarse
o actualizarse. El navegador detecta cierres y nuevas cuentas en segundo plano.
Las sesiones sin consumo confirmado permanecen libres en el plano y quedan
fuera de las cuentas e indicadores. Los abonos reales y los productos gratuitos
confirmados se conservan como cuentas activas. Pedir mesero, canción y chatear
mantienen su funcionamiento; Ver cuenta aplica cuando hay consumo.
