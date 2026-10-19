# Auditoría y correcciones de POS — 19 de octubre de 2026

## Resultado y alcance

Se trabajó sobre las fuentes locales de `TIENDA-NAPOLES-OFF-LINE.COM-main` y `TIENDA-NAPOLES-BCA.COM-main`, sin publicar cambios en producción ni modificar datos del negocio.

Ambos proyectos son aplicaciones HTML/CSS/JavaScript sin etapa de compilación. Usan Supabase para cuentas, consumos, usuarios y solicitudes, y Apps Script/Google Sheets para ventas, inventario e informes. OFF-LINE añade el service worker que persiste y reenvía mutaciones. BCA conserva su comunicación remota y no recibe esa cola offline. Su outbox existente recibe únicamente la protección de persistencia necesaria para que la confirmación de un envío anterior no borre una venta recién cobrada, y para conservar ventas rechazadas; el caso de carrera queda reproducido por una prueba específica.

**Dependencia compartida comprobada:** ambas copias tenían exactamente el mismo `appscript/Code.gs` y apuntan a la misma Supabase, la misma URL de Apps Script y el mismo spreadsheet. Por ello se entrega la misma corrección de integridad del backend en ambos `Code.gs`. Publicar desde BCA una versión anterior del backend anularía la corrección de OFF-LINE. Esta es la excepción técnicamente necesaria al aislamiento del trabajo de sincronización; no se trasladó la cola del cliente offline a BCA.

## Diagnóstico y evidencia

| Hallazgo confirmado | Origen | Consecuencia y corrección |
|---|---|---|
| La cola guardaba `jobs.slice(-2000)` | OFF-LINE, `writeAppsScriptOutbox` | Descartaba trabajos antiguos sin confirmación. Ahora conserva todos los pendientes. |
| IndexedDB resolvía al éxito de una petición, antes del commit de su transacción | OFF-LINE, service worker, `withStore` | Un aborto posterior podía parecer un guardado exitoso. Ahora espera `transaction.oncomplete` y rechaza abortos. La prueba reproduce petición exitosa seguida de aborto. |
| La verificación REST no tenía límite de espera y el timeout de fetch terminaba al recibir cabeceras | OFF-LINE, `verifyRestMutation` y `fetchWithTimeout` | Una conexión o cuerpo HTTP incompleto podía mantener ocupado el procesamiento. La lectura y el cuerpo quedan dentro del límite de espera. |
| El consumo aguardaba escrituras remotas y hasta cuatro reintentos | Ambos, `addConsumptionBatch` | Se acumulaban esperas de red antes de liberar el formulario. OFF-LINE confirma tras el commit local; BCA limita cada intento y verifica INSERT ambiguos por sus IDs estables. |
| Se escribía todo el historial de movimientos por cada producto del cobro | Ambos, `recordLocalInventoryMovement` y `applyPaidInventoryLocally` | Con 100 productos se serializaba el historial 101 veces. Ahora se guarda una vez y se usa un índice de IDs en memoria durante el cobro. |
| BCA cerraba la cuenta antes de conservar la factura; errores podían dejar controles bloqueados | BCA, `processPayment` | Ahora se protege primero la intención, se confirma el cierre y se guardan juntas las proyecciones financieras. Ambos flujos liberan controles en `finally`. |
| La presentación pasaba a “Sincronizado” por tiempo y ocultaba ciertos conflictos 406 | OFF-LINE, `updateGlobalSyncStatus` | Podía presentar respaldo completo con operaciones pendientes. Ahora muestra pendientes y conflictos hasta que se resuelvan. |
| Apps Script descontaba stock antes de completar la fila de venta | Backend compartido, `recordSale_` | Una ejecución interrumpida podía dejar efectos parciales. Se introduce un plan durable y recuperable antes de aplicar inventario. |
| El marcador diario de ventas procesadas crecía dentro de una única celda | Backend compartido, `updateDailyIncome_` | Un día con mucho volumen podía alcanzar el límite de la celda. Los marcadores adicionales se conservan en columnas anexas, sin desplazar las existentes. |

No se reprodujo la sesión concreta del negocio ni una congelación real de Windows de 20–30 segundos. Sí se reprodujeron las dependencias de red, el coste acumulativo del historial, los abortos de almacenamiento, la respuesta perdida y las escrituras parciales indicadas arriba. No se afirma haber demostrado una fuga de memoria ni estabilidad durante semanas reales de operación.

## Persistencia, sincronización y recuperación

1. Cada cobro conserva una intención durable con factura, cuenta, saldo esperado, fecha estable y etapa. Su identidad nueva es la de la cuenta; reintentar recupera esa operación.
2. El cierre conserva las validaciones de consumos y abonos. OFF-LINE puede aceptarlo en su cola durable; BCA espera confirmación remota.
3. Factura, inventario, movimientos, trabajo de respaldo y retirada de la intención se confirman en una sola transacción IndexedDB. Si falla, se conserva la intención y no se informa éxito financiero.
4. Una intención interrumpida se recupera al iniciar sesión, al reconectar o al reintentar el cobro. La misma fecha de cierre permite verificar respuestas ambiguas sin generar otra venta.
5. Web Locks coordina los cobros entre pestañas. La persistencia del outbox financiero combina escrituras en transacciones IndexedDB y conserva marcadores individuales de operaciones ya confirmadas para impedir que una pestaña atrasada las reintroduzca. Esos marcadores se consultan por clave, sin recorrer ni reescribir todo el historial de confirmaciones. BCA mantiene su remitente existente con esa protección mínima del cobro.
6. Las operaciones relacionadas mantienen su orden; las independientes conservan el procesamiento existente. Las ventas esperan sus propias dependencias en Supabase.
7. En Apps Script, `POS_Operaciones` almacena el plan antes de aplicar stock, detalles, pagos, venta y acumulado diario. Antes de otra mutación de inventario se recupera cualquier plan interrumpido. Los efectos se reconocen por sus identidades y estados previamente previstos. Una diferencia no explicable requiere revisión; no se pisa inventario válido para forzar coincidencia.
8. Los errores definitivos siguen visibles y conservan sus operaciones. OFF-LINE incorpora **Reintentar respaldo**, que mantiene IDs y datos. Tampoco se elimina un movimiento porque una versión antigua de Apps Script todavía no acepte su acción.

Las solicitudes de clientes no reciben el modo de confirmación local rápida de los consumos del personal. Sus rutas y cuerpos se conservan. El cierre sigue resolviendo las solicitudes de su cuenta con los mismos filtros y estados; esa actualización secundaria deja de retrasar la terminación financiera del cobro.

El cobro con y sin impresión comparte el mismo commit. La impresión ocurre después, en la integración existente. Un error al imprimir no revierte el cobro; la factura puede reimprimirse desde Ventas. La cancelación del modal durante el guardado se bloquea para conservar el resultado verificable.

## Tarjeta y compatibilidad

Tarjeta se integra en ambos proyectos en el cobro directo, los pagos mixtos, el filtro de Ventas, la edición de ventas y su distribución de pagos, el historial, los recibos y la exportación del informe. El KPI usa los mismos periodos, filtros y combinación de ventas locales/remotas de los indicadores existentes. Apps Script calcula `totals.card` y añade `tarjeta` al final de la hoja diaria.

No se modifica retroactivamente el método de ventas anteriores. Los métodos y validadores de **abonos** se mantienen: el nuevo requisito se aplica al cobro de la venta. No se requiere una migración SQL nueva.

## Rendimiento medido

Benchmark local en Node v24.22.0, mediana de cinco ejecuciones por caso. Se conservaron las fuentes anteriores para comparar las mismas funciones. Los tiempos siguientes corresponden al procesamiento del inventario del cobro, no al cobro completo ni a la impresora.

| Caso con 20.000 movimientos históricos | Antes | Después | Escrituras del historial antes → después |
|---|---:|---:|---:|
| OFF-LINE, 20 productos | 190,75 ms | 13,46 ms | 21 → 1 |
| OFF-LINE, 100 productos | 895,22 ms | 15,60 ms | 101 → 1 |
| BCA, 20 productos | 176,58 ms | 12,77 ms | 21 → 1 |
| BCA, 100 productos | 914,29 ms | 15,97 ms | 101 → 1 |
| OFF-LINE, confirmación de una escritura de consumo con 80 ms de demora remota simulada | 91,37 ms | 1,49 ms | Confirmación local tras commit |

Con 100 productos, la serialización medida pasó de aproximadamente 174 MB acumulados a 1,74 MB por ejecución. Se conserva el resaltado verde de 2,2 segundos del formulario de consumos; no representa una espera de red ni un guardado pendiente.

Resultados y script reproducible: `.pos-audit/performance-results.json` y `.pos-audit/benchmark.cjs` en OFF-LINE. No son mediciones de producción ni una prueba de duración de semanas.

## Pruebas ejecutadas

- **OFF-LINE: 221 pruebas Node aprobadas; cero fallos y cero omitidas.** La pasada completa se ejecutó con permisos para habilitar el servidor local de Windows.
- **BCA: 190 pruebas Node aprobadas; cero fallos y cero omitidas.** Incluye las pruebas del backend compartido y de retención del cobro ante un remitente atrasado o un rechazo.
- La suite existente del service worker incluye **86 escenarios internos** de sincronización: offline, reconexión, dependencias, duplicados, conflictos, autorización, recuperación y lecturas concurrentes.
- Pruebas nuevas con IndexedDB simulado: commit financiero conjunto, aborto a mitad de escritura, recuperación tras recarga, cuota de localStorage, migración del almacenamiento anterior, respuesta de cierre perdida, dos pestañas y 2.505 trabajos pendientes sin truncamiento.
- Simulación del backend de Sheets: interrupción después de cada una de **11 escrituras**, recuperación antes de otro movimiento, reintentos sin duplicar stock/venta/pago/acumulado, identidad canónica, rechazo de otro importe o distribución de pago, plan grande dividido en celdas y 2.200 ventas diarias sin desbordar el marcador.
- Cobros con/sin impresión, Tarjeta, mixtos, efectivo, abonos existentes, doble envío, fallo de impresión y cierre del modal durante el guardado.
- Tarjeta: persistencia, filtros de fecha, KPI, totales y conservación del método histórico. Los demás medios siguen cubiertos por las suites existentes.
- Pruebas SQL con PGlite para contratos y validaciones existentes de Supabase. Comprobación sintáctica de JavaScript y Apps Script en ambas copias.
- Prueba de navegador existente en Chrome para selector por teclado, presentación y visibilidad de la cuenta del cliente. Las pruebas del servidor local verifican credenciales y controlador de caja sin activar hardware físico.

Inicialmente faltaban dependencias de prueba y el entorno restringido impedía crear `System.Net.HttpListener`. Se instalaron PGlite, fake-indexeddb y Playwright únicamente bajo `.pos-audit/tools`, y las pruebas del servidor se ejecutaron fuera de esa restricción. No se añadieron dependencias de producción.

Los fixtures existentes se ampliaron para Tarjeta, los helpers de escritura y el nuevo orden de confirmación. Se corrigió un fixture antiguo de refresco que no incluía el estado de lecturas pendientes. Las aserciones que esperaban “Sincronizado” pese a pendientes se sustituyeron por el comportamiento solicitado.

Evidencia local: `.pos-audit/offline-tests-final.log`, `.pos-audit/bca-tests-final.log`, `.pos-audit/request-regression-hashes.json`. Se compararon **26 funciones de solicitudes y chat** entre las fuentes originales y finales; sus hashes normalizados son idénticos. Las pruebas existentes de solicitudes, chat, notificaciones, abonos y cuenta del cliente pasan. Los archivos SQL existentes permanecen intactos.

## Archivos modificados

Rutas relativas a cada proyecto. Los auxiliares de preparación, fuentes anteriores, dependencias y logs quedan en `.pos-audit/`, excluido de Git en OFF-LINE.

| Archivo | Proyecto | Finalidad |
|---|---|---|
| `app.js` | Ambos | Cobro recuperable y atómico; persistencia del outbox financiero; guardado de consumos; procesamiento de inventario por lote; Tarjeta y KPI. OFF-LINE añade las correcciones de coordinación offline, estado y reintento. |
| `admin.html` | Ambos | Tarjeta en cobro, mixtos, filtros y edición. OFF-LINE añade el botón de reintento de respaldo. |
| `index.html` | Ambos | Versión de recursos para activar las fuentes actualizadas. |
| `style.css` | Ambos | Espacio para Tarjeta entre medios y KPI, conservando reglas móviles. |
| `service-worker.js` | OFF-LINE | Commit durable, confirmación local selectiva, espera HTTP acotada, reintentos y recuperación. |
| `service-worker.js` | BCA | Únicamente versión de caché; no recibe cola offline. |
| `appscript/Code.gs` | Ambos, backend compartido | Tarjeta, journal remoto recuperable, identidad canónica y marcadores diarios sin desbordamiento. |
| `tests/admin-request-persistence.test.cjs` | Ambos | Fixture de escritura y lectura del cierre; conserva aserciones de solicitudes. |
| `tests/admin-requested-flows.test.cjs` | Ambos | Campo de Tarjeta en el fixture de edición. |
| `tests/click-response.test.cjs` | Ambos | Fixture de recuperación al iniciar administración. |
| `tests/income-edit-speed.test.cjs` | Ambos | Campo de Tarjeta en edición mixta. |
| `tests/payment-cash-drawer.test.cjs` | Ambos | Orden durable, Tarjeta, doble envío y fallos de impresión. OFF-LINE añade cancelación durante guardado. |
| `tests/consumption-reconciliation.test.cjs` | OFF-LINE | Fixture del helper de escritura; conserva comprobaciones de identidad y concurrencia. |
| `tests/offline-sync-presentation.test.cjs` | OFF-LINE | Pendientes y conflictos visibles hasta su confirmación real. |
| `tests/manual-refresh.test.js` | BCA | Fixture del estado de lecturas pendientes y combinación de movimientos. |
| `tests/pos-transaction-durability.test.cjs` | Ambos, nuevo | Atomicidad, recarga, cuota, recuperación, persistencia entre pestañas y retención frente a un envío anterior. |
| `tests/pos-card-payments.test.cjs` | Ambos, nuevo | Tarjeta, mixtos, periodos, KPI y compatibilidad histórica. |
| `tests/pos-backend-idempotency.test.cjs` | Ambos, nuevo | Backend compartido ante escrituras ambiguas, duplicados y volumen diario. |
| `tests/worker-durable-ack.test.cjs` | OFF-LINE, nuevo | Aborto posterior a petición, consumo rápido durable y reintento explícito conservando contratos de clientes. |
| `tests/payment-outbox-retention.test.cjs` | BCA, nuevo | Conserva la venta rechazada y permite respaldar otra independiente. |
| `.gitignore` | OFF-LINE | Excluye auxiliares locales de auditoría. |
| `AUDITORIA-POS-2026-10-19.md` | Ambos, nuevo | Este informe. |

## Activación y límites pendientes

Para activar la corrección remota, actualizar **la implementación existente y compartida de Apps Script** con el `Code.gs` final y publicar una nueva versión de esa implementación, conservando su URL. Los dos archivos finales deben ser iguales. La hoja `POS_Operaciones` y las columnas anexas se crean al utilizarlas. Después, recargar los POS para activar los recursos y service workers actualizados. Para distribuir un instalador, regenerarlo desde `packaging/build-installer.ps1`.

No se publicaron cambios ni se ejecutaron ventas contra los servicios reales. Quedan pendientes una prueba controlada con la impresora física, la configuración real de Supabase/Apps Script y una jornada prolongada de operación. Las pruebas ejecutadas no acreditan todos los escenarios de fallo posibles de esos servicios.

La coordinación entre pestañas usa Web Locks, disponible en los navegadores objetivo Chrome/Edge actuales. No se acredita esa exclusión en navegadores que carezcan de la API. IndexedDB debe estar disponible para confirmar el cobro local; si no puede guardar, el sistema conserva el intento y comunica el error.

Supabase, IndexedDB y Sheets no forman una sola transacción distribuida. Se conserva la consistencia mediante etapas e idempotencia comprobadas. Dos equipos aislados que intenten cobrar la misma cuenta requieren conciliación al recuperar conexión: un rechazo por estado, abonos o consumos diferentes permanece visible y no se transforma automáticamente en una venta confirmada. Las ediciones manuales de inventario fuera de los flujos protegidos también pueden requerir revisión del journal. No se borran datos del negocio para resolver esas diferencias.
