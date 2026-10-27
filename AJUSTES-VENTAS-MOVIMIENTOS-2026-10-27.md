# Ventas, movimientos y respuesta del POS — 27 de octubre de 2026

Cambios aplicados únicamente a las fuentes locales de OFF-LINE y BCA, según el alcance confirmado. No se hizo push, publicación, migración ni operación sobre los datos reales del negocio. El botón de borrado se probó con datos simulados; no se utilizó para eliminar el historial real.

## Resultado

- **Ventas en OFF-LINE, con internet y sin internet:** al entrar se comprueba el informe aunque ya exista una proyección del navegador. Además de reintentar lecturas, se corrigió la combinación de ventas del servidor con facturas pendientes de respaldo: la factura completa puede recuperarse de la cola durable y un marcador incompleto no retira una venta válida del servidor. Una consulta fallida conserva el informe verificado del mismo filtro. Se conservan la carga, los filtros y la presentación existentes.
- **Respuesta durante actividad rápida:** se eliminó el recorrido completo de facturas al incorporar cada cobro en OFF-LINE. Los totales remotos de las páginas todavía no cargadas se conservan al sumar la factura nueva. En ambos proyectos se reutiliza el formateador de fechas del calendario de ventas y cada proyección del cobro se copia una sola vez antes de su transacción IndexedDB.
- **Selector de producto en Ventas, en ambos proyectos:** buscador por nombre, código o iniciales; compatible con ratón y teclado. Los tres KPI pasan a morado y muestran unidades, importe vendido y ganancia del producto, con su costo. Se suman solo sus líneas por ID, incluso dentro de facturas con otros artículos. La suma no incluye propinas ni importes de otros productos. Las facturas conservan su información completa para editar e imprimir. «Quitar producto» restaura los indicadores y medios de pago habituales.
- **Paginación:** seleccionar un producto completa las páginas necesarias antes de considerar definitivo el conteo de Ventas; no se limita a las primeras 300 facturas. En Movimientos completa el historial del producto, evitando limitar su conteo a las primeras 800 filas. Una revisión completa de movimientos se reutiliza tras verificar que sigue vigente. Los errores o una copia parcial se identifican como tales.
- **Eliminar movimientos:** ya existía la acción. Ahora el botón se llama explícitamente «Eliminar movimientos». El reinicio limpia también su réplica local y las proyecciones anteriores de correcciones, para que no reaparezcan al refrescar. Conserva la confirmación y las restricciones existentes.

**Eliminar movimientos no devuelve productos al inventario y no borra ventas.** Esto se verificó tanto en la función existente de Apps Script como en las pruebas del cliente. Eliminar una venta es una acción distinta y conserva su comportamiento previo de restitución de existencias.

## Comparación de cantidades

Antes, el indicador «has vendido» de Movimientos incluía todos los retiros, por ejemplo ajustes manuales. Ahora cuenta salidas relacionadas con ventas, resta devoluciones/correcciones y excluye consumos identificados con cuentas todavía abiertas. La lista general de entradas y salidas se conserva.

Ventas usa las fechas, el turno y los demás filtros elegidos. Movimientos conserva el historial desde su último borrado. Para comparar cantidades deben corresponder al mismo periodo y producto. Borrar movimientos inicia un historial nuevo; las ventas anteriores siguen existiendo. Las discrepancias históricas de datos ya registrados no se corrigen mediante reescrituras ni cambios de inventario.

## Evidencia de rendimiento

Mediciones locales sintéticas en Node v24.22.0, con las fuentes originales conservadas para comparar. Son tiempos de partes del procesamiento, no del cobro completo, la red o la impresora.

| Operación | Antes, mediana | Después, mediana |
|---|---:|---:|
| Incorporar un cobro al informe OFF-LINE con 50.000 facturas previas | 5.205,91 ms | 0,07 ms |
| Transacción de proyecciones OFF-LINE: 5.000 facturas y 20.000 movimientos | 54,27 ms | 48,81 ms |
| Transacción de proyecciones BCA: 5.000 facturas y 20.000 movimientos | 76,83 ms | 50,42 ms |

La primera medición reproduce un bloqueo suficiente para retrasar los clics de consumo, caja y cobro. No demuestra que fuera la única causa de los episodios del negocio. No se promete ausencia absoluta de esperas ante cualquier volumen, hardware o conexión.

## Validación final

- **OFF-LINE: 333 pruebas aprobadas tras la aclaración del fallo con internet; cero fallos, cancelaciones u omisiones.**
- **BCA: 290 pruebas aprobadas; cero fallos, cancelaciones u omisiones.**
- Navegador Chrome en escritorio y móvil: búsqueda, teclado, cambio de color, restauración exacta de KPI y 30 actualizaciones consecutivas por tamaño, con 650 facturas mixtas.
- Producto por ID, nombres coincidentes, cantidades fraccionarias, 650 facturas, cambio de revisión entre páginas y 1.605 movimientos paginados.
- Borrado de movimientos confirmado, cancelado y fallido; conservación de inventario/facturas y prevención de reaparición de correcciones antiguas.
- Conservación del commit financiero, recuperación tras recarga, aborto de almacenamiento, cola pendiente, cobros repetidos, pagos mixtos, apertura de caja e impresión mediante las suites existentes.
- Comprobación sintáctica de los tres archivos JavaScript modificados en cada proyecto.

Se actualizó un fixture antiguo de `manual-refresh.test.js` de BCA para proporcionar sus dependencias de caché y conservar los filtros igual que el combinador real. Se preservó su prueba específica de borrado en cola durante otro envío.

## Archivos y activación

Archivos de producción modificados en cada carpeta: `app.js`, `admin.html`, `style.css`, `sales-shift.js`, `index.html` y `service-worker.js`. En los dos últimos, los cambios se limitan a versiones de recursos/caché para activar las fuentes nuevas. BCA conserva `20261027-sales-products-v1`. Tras la aclaración del fallo con internet, OFF-LINE usa `20261027-sales-online-v2` y caché de shell `v70`.

Se añadieron `tests/sales-product-analysis.test.cjs` y `tests/sales-product-browser.test.cjs`, y se ajustaron las pruebas directamente relacionadas. Este informe se incluye en ambos proyectos.

`appscript/Code.gs` conserva su hash original en ambos proyectos; no se necesita publicar Apps Script para estos cambios. Se verificó también que las funciones existentes de apertura física de caja, agregado de consumos, ejecución del cobro, cierre de cuenta y envío de su cola conservan exactamente su código previo. Las mejoras actúan sobre los cálculos y copias que rodean esas operaciones.

Para probar las fuentes actualizadas, recargar el POS que se sirve desde cada carpeta. No se regeneró ni sustituyó un instalador o una instalación independiente. Queda por validar una jornada del negocio y el dispositivo físico; las pruebas locales no sustituyen esa comprobación.

Evidencia y fuentes previas: `.pos-audit/sales-20261027/` de OFF-LINE, incluyendo `performance.json`, `scope-evidence.json`, los dos logs finales y los scripts de reproducción.

## Aclaración posterior: KPI que pasan a cero con internet

El caso descrito es: se inicia sesión, las cifras cargan y posteriormente una actualización las deja en cero, aun con conexión. «Local» se refiere a datos guardados en el navegador, que también participan cuando hay internet.

Se reprodujo con el código real una ruta capaz de producir ese resultado: el informe remoto incluía una venta y la cola conservaba su factura completa pendiente de respaldo, pero el historial de facturas en memoria no la incluía. El combinador retiraba la venta remota por estar pendiente y buscaba su reemplazo únicamente en ese historial. El KPI pasaba de 200 a 0 con `navigator.onLine === true`.

La corrección adicional, exclusivamente en OFF-LINE, utiliza la factura completa protegida en la cola. Si solo existe un marcador incompleto, conserva la venta recibida del servidor. También evita sumar de nuevo ventas ya incluidas en los totales de páginas no visibles; una edición pendiente fuera de página consulta su fila antes de confirmar el resultado online.

Actualizar con una consulta fallida conserva el último informe del mismo filtro. Al perder internet se mantiene la copia disponible y al regresar se consulta y concilia normalmente. Cambiar de periodo o recibir un borrado real sigue permitiendo mostrar cero; no se fijan cifras antiguas para ocultar el problema.

Se añadieron pruebas específicas en `tests/sales-online-zero-regression.test.cjs`. La prueba de navegador también crea 650 facturas en la cola IndexedDB real de su entorno aislado, vacía el historial en memoria y comprueba cinco actualizaciones con internet, desconexión y reconexión, tanto en escritorio como en móvil. Las cifras permanecen en 715.000 sin duplicarse. Se completó un fixture del filtro por tipo de venta con fecha e ítems, conservando sus aserciones de importes.

Esta reproducción identifica un defecto real compatible con el síntoma; no acredita que sea la única causa de la sesión del negocio, que no se inspeccionó. No se modificó el mecanismo de envío offline, el inventario ni el cobro. BCA no recibe cambios adicionales en esta aclaración. No hubo push ni operaciones con datos reales.

Evidencia adicional y fuentes inmediatamente anteriores: `.pos-audit/sales-online-zero-20261027/`.
