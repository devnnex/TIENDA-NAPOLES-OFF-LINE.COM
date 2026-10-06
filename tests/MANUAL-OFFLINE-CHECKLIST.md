# Validación manual offline y reconciliación

Usar un negocio de prueba o productos/mesas identificados como prueba. Antes de
comenzar, anotar existencias, cantidad de ventas y estado de la mesa. En cada
caso comprobar el indicador global del encabezado y, al finalizar, contrastar
Supabase, las hojas de Apps Script y la interfaz.

1. Abrir con internet: debe mostrar `En línea · sincronizado` y los últimos
   colores, catálogo, mesas, inventario, movimientos y ventas.
2. Abrir la aplicación, cortar internet y confirmar que el shell sigue usable.
3. Crear y cobrar una venta completa sin internet.
4. Cobrar varias ventas offline consecutivas y comprobar que ninguna desaparece.
5. Cerrar y reabrir la aplicación todavía sin internet.
6. Reiniciar Windows con operaciones pendientes y reabrir todavía sin internet.
7. Recuperar internet y esperar la sincronización automática.
8. Confirmar que no fue necesario pulsar un botón de sincronización.
9. Cortar internet mientras el indicador muestra `Sincronizando`.
10. Recuperar internet nuevamente y esperar la confirmación.
11. Reintentar el mismo `operationId` y verificar una sola venta/movimiento.
12. Cobrar una mesa y cortar la red durante el cierre de la sesión.
13. Confirmar una sola fila de venta en Apps Script.
14. Confirmar un solo conjunto de detalles, pagos y movimientos.
15. Confirmar que la existencia final corresponde exactamente a lo vendido.
16. Confirmar que la mesa cobrada queda cerrada/libre en Supabase y en pantalla.
17. Cobrar y cerrar la aplicación inmediatamente; reabrir y sincronizar.
18. Simular timeout de Apps Script y verificar backoff sin duplicación.
19. Simular error temporal de Supabase y verificar que la cola permanezca.
20. Comparar conteos finales: ninguna venta, movimiento o descuento perdido o
    duplicado y ninguna operación pendiente eliminada sin confirmación.

Resultado esperado en todos los casos: la venta existe una sola vez, el
inventario coincide, los movimientos existen una sola vez, la mesa queda en el
estado correcto y las colas sólo se vacían después de una respuesta confirmada.
