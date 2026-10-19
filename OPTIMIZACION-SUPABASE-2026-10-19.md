# Optimización de consultas Supabase — BCA y Offline

Fecha: 19 de octubre de 2026. Cambios de frontend sobre los proyectos existentes, con prioridad en continuidad operativa. No se ejecutó SQL en producción, no se cambiaron datos, tablas, funciones, triggers, permisos, RLS, credenciales ni configuración de logs. `appscript/Code.gs` permanece idéntico al punto de partida de esta optimización.

## Consumo real reportado y alcance de la medición

Datos proporcionados por el propietario para el período 22 de septiembre–22 de octubre de 2026; no obtenidos mediante acceso independiente al panel:

| Indicador | Consumo reportado |
| --- | --- |
| Egress de la organización | 5,037 GB / 5 GB; 101% |
| Log Ingestion de la organización | 3,736 GB / 1 GB; 374% |
| Database Size | 7% |
| Realtime Messages | 7% |
| Logs de TIENDA-NAPOLES-COTRA-ECO | Aproximadamente 3,72 GB |
| Logs de JAIRO-FERRER-COLORISTA | Aproximadamente 0,02 GB |

El egress informado corresponde a toda la organización. No se atribuyen esos GB a un proyecto, endpoint o consulta concreta. Ambos códigos configuran el mismo identificador Supabase `izvcbkwgtciuoampunba`; la correspondencia del nombre visible del proyecto debe comprobarse en el panel. El volumen aproximado de logs por proyecto tampoco identifica por sí solo sus rutas, estados HTTP ni causas.

La meta del 70% equivale, con los límites aportados, a menos de 3,5 GB de egress y 0,7 GB de logs por período para toda la organización. Esta entrega reduce trabajo futuro; no acredita haber alcanzado esa meta ni elimina el consumo ya acumulado. Faltan mediciones posteriores de producción y el consumo del resto de proyectos para estimarlo.

Supabase diferencia el tráfico por servicios; para atribuirlo es necesario revisar el desglose del panel, además de rutas y tamaños de respuesta. Referencia: [guía oficial de egress](https://supabase.com/docs/guides/platform/manage-your-usage/egress).

## Diagnóstico del código en ambos proyectos

La siguiente tabla identifica trabajo comprobado en el código. Los bytes son respuestas JSON de una muestra local fija, sin compresión: sirven para comparar frecuencias, no para reconstruir facturación. Las frecuencias periódicas no incluyen acciones del usuario ni avisos nuevos.

| Archivo / función | Antes | Motivo / muestra por respuesta | Mejora aplicada o decisión |
| --- | --- | --- | --- |
| `app.js` / `startAdminPolling`, `loadAdminData` | Snapshot completo cada 1,5 s; 40/min | Mesas, sesiones, consumos y solicitudes; 20.714 bytes | Con ambos canales conectados: ventana 5 s, efectiva 6 s por el reloj de 1,5 s. En segundo plano 15 s. Respaldo 1,5 s si falla un canal |
| `app.js` / `pollAdminRequests` | Cada 1 s; 60/min | Solicitudes prioritarias; 876 bytes | Se conserva independiente, incluso con pestaña oculta; los eventos también refrescan inmediatamente |
| `app.js` / `refreshCoreNow`, `loadUsers` | Comprobación 5 s, efectiva 6 s; 10+10/min | Bootstrap 41.728 bytes; usuarios 2.129 bytes | Con Realtime sano: 15 s, o 60 s oculta; respaldo anterior si falla. Usuarios conserva control Jefe |
| `app.js` / `startConfirmedReportSync` | Lectura cada 1,5 s; 40/min | Cambios incrementales de reportes; 35 bytes sin novedades | Ventana 5 s, efectiva 6 s, o 15 s oculta con broadcast sano. Preparación y envío de escrituras conservan su reloj de 1,5 s |
| `app.js` / `subscribeClient`, `loadChatMessages` | Chat desde relojes de 1,2 y 1,5 s | Conversación completa; 6.614 bytes | Comparten ventana y lectura en curso; eventos siguen forzando lectura. Chat oculto con canal conectado: ventana 5 s |
| `app.js` / estado de mesa cliente | Cada 1,5 s | Estado 4.689 bytes más cola y abonos | Activo conserva 1,5 s. Oculto con Realtime sano usa ventana 5 s; los avisos y las acciones siguen siendo inmediatos |
| `app.js` / canales cliente, administrador y datos | Reintentos propios fijos de 3 / 5 s | Una conexión fallida persistente repite aperturas | Espera progresiva hasta 30 s, reiniciada al suscribir correctamente. Las consultas de respaldo siguen activas |
| `menu-cards.js` / `signedImage`, `renderAdmin`, `renderViewer` | Firma nueva al volver a renderizar / abrir imágenes | Enlaces privados de cinco minutos; archivos admitidos hasta 15 MB | Firma compartida durante cuatro minutos, con petición en curso compartida, separada por sesión y QR. Fallos no quedan cacheados |
| `app.js` / `renderBrand`, `renderBusinessForm` | Reemplazo repetido de logos; refresco de textos del formulario | Trabajo DOM y posible repetición de imágenes / errores | Mantiene el nodo de logo si no cambia y preserva textos pendientes de Marca |
| `app.js`, `service-worker.js` / ventas, cobros, pedidos, stock, colas durables | Identidades y recuperación existentes | Escrituras operativas | Se conservan lógica, contenidos e identificadores; no se introduce caché de respuestas financieras |
| `app.js` / cajón remoto, heartbeat | Relojes operativos existentes | Acoplados al control físico del cajón | Sin cambios para ahorrar tráfico |
| `app.js` / inventario e históricos Apps Script | Lecturas y paginación existentes | Servicio de Google, separado de Supabase | Sin cambios; no se computa como egress Supabase en la comparación |

También se revisaron el adaptador `SupabaseDb`, las consultas `select`, RPC, autenticación, entradas de navegación, suscripciones, `menu-cards.js`, service workers y las definiciones SQL existentes. Las respuestas completas tienen consumidores actuales: recortar sus campos o sustituirlas por nuevas RPC requiere un análisis adicional. No se cambió su contrato ni se añadieron dependencias de ejecución. No se halló evidencia de canales activos duplicados en el recorrido controlado; no se eliminan canales necesarios por dispositivo.

No se modificaron mecanismos de registro ni se silenciaron errores de seguridad, autorización o escritura. La reducción de lecturas o aperturas fallidas puede disminuir solicitudes que producen logs, pero los bytes de Log Ingestion evitados no están medidos. No hay evidencia del panel que permita afirmar que el polling explique los 3,72 GB de ese proyecto.

## Cambios y protección operativa

`createReadBudget` almacena solo tiempos y fallos, con un máximo de 128 entradas. No guarda datos de ventas ni resultados de consultas. Cambiar usuario o QR invalida sus tiempos. Un fallo de lectura aplica espera progresiva, con máximo de 30 segundos; una lectura explícita o un evento siguen pudiendo comprobar el servidor inmediatamente. Se mantiene la respuesta de error existente.

Los relojes periódicos no dejan pendiente otra lectura solo por encontrar una en curso. Un aviso recibido durante esa lectura sí conserva una comprobación posterior. Esto evita bucles de consultas al terminar una respuesta lenta, sin descartar avisos operativos.

La reducción de snapshots administrativos exige confirmación `SUBSCRIBED` de los dos canales existentes. Ante error o reemplazo del canal se recupera el respaldo rápido. El canal por mesa y los dos canales administrativos conservan sus guardas de identidad y limpieza. El temporizador de reportes se crea una sola vez. No se añadió elección de una única pestaña líder: cada dispositivo conserva sus notificaciones y su respaldo.

Las firmas privadas de Carta no se comparten entre credenciales o QR. Su caché dura menos que la validez del enlace. Los cambios de imagen usan rutas nuevas y no requieren esperar a que expire una firma anterior. Se mantiene el límite de dos imágenes y el control de acceso vigente.

Los borradores de nombre, subtítulo y color de Marca sobreviven al refresco remoto y al cambio de sección. Se liberan tras confirmación de guardado; una revisión del formulario evita borrar texto escrito mientras se esperaba esa confirmación. Las imágenes y zonas conservan sus mecanismos existentes de borrador. Esto no convierte el formulario en un guardado automático al cerrar o recargar el navegador.

| Mejora | Impacto previsto | Riesgo / mitigación | Dificultad |
| --- | --- | --- | --- |
| Intervalos administrativos adaptativos | Alto en sesiones con catálogo grande | Más espera si se pierde un evento con canal aparentemente sano: snapshot activo hasta unos 6 s, catálogo 15 s; solicitudes tienen respaldo de 1 s | Baja |
| Consolidación de sondeos de chat / lecturas lentas | Medio | Los eventos conservan lectura inmediata y una repetición posterior si había otra en curso | Media |
| Firmas privadas reutilizadas | Medio, dependiente del uso real de imágenes | Caducidad anticipada, aislamiento por credenciales y eliminación de fallos de la caché | Baja |
| Espera progresiva de reconexión | Medio en fallos persistentes | La conexión websocket puede tardar hasta 30 s en reintentarse; respaldo REST continúa y recuperación online mantiene su camino existente | Baja |
| Preservación de borradores / nodos de logo | Estabilidad y menos trabajo de pantalla | No cambia permisos ni datos guardados sin confirmación | Baja |
| RPC más pequeñas, índices, cambios RLS o servidor | Sin cuantificar | Fuera de esta entrega: requieren análisis y autorización explícita antes de modificar Supabase | Por definir |

## Comparación antes / después: simulación reproducida en ambos códigos

Muestra idéntica: 30 mesas, 200 productos, 10 sesiones abiertas con 8 líneas cada una, 20 usuarios, 5 solicitudes pendientes y 40 mensajes de chat. Se ejecutaron los temporizadores y controladores reales extraídos del código anterior y posterior, con reloj virtual de 60 segundos después del arranque y respuestas JSON fijas. Se incluyeron estado de mesa, cola y abonos cuando el recorrido cliente los solicita. No se incluyeron tráfico inicial, mensajes nuevos, imágenes descargadas, escrituras de negocio, compresión, cabeceras, facturación ni carga de otros proyectos.

| Escenario de una pestaña | Solicitudes/min antes → después | Bytes JSON/min antes → después |
| --- | --- | --- |
| Administrador visible, Realtime sano | 160 → 88 | 1.321.090 → 435.478 |
| Administrador oculto, Realtime sano | 160 → 70 | 1.321.090 → 179.413 |
| Administrador, canales fallando continuamente | 200 → 163 | 1.339.310 → 1.323.718 |
| Cliente visible, Realtime sano | 211 → 171 | 790.634 → 526.074 |
| Cliente oculto, Realtime sano | 211 → 41 | 790.634 → 119.944 |
| Cliente, canal fallando continuamente | 220 → 173 | 850.160 → 539.302 |

Desglose del administrador visible sano: solicitudes prioritarias **60 → 60**, snapshots **40 → 10**, bootstrap **10 → 4**, usuarios **10 → 4**, reportes **40 → 10**. Suma: **160 → 88**. La muestra cliente visible registra **91 → 51** lecturas de chat, conservando sus otros tres lectores de 40/min. Los límites exactos del minuto y las lecturas de conexión explican una lectura adicional de chat frente a 50/min del reloj aislado.

Canales activos estables: administrador **2 → 2**, cliente **1 → 1**; invocar nuevamente la suscripción existente no añade canales. En el escenario artificial donde cada conexión falla, se observaron callbacks de fallo **40 → 6** en administrador y **20 → 3** en cliente durante ese minuto. Esto mide el reintento de conexiones de la prueba; no cuenta errores reales de producción ni bytes de logs. Las aperturas iniciales y sus respuestas explican que el escenario sin Realtime tenga más lecturas que el sano.

Los resultados de BCA y Offline coinciden para estas funciones. No se extrapolan a una sesión real con escrituras, varios operadores ni tráfico variable. Dos pestañas administrativas conservan sus lectores independientes: no se atribuye a la organización el ahorro de una sola pestaña. No se midió latencia de renderizado, memoria ni tiempo de red en producción; la mejora de pantalla comprobada es conservar nodos y borradores, además de reducir consultas simuladas.

## Validación

- Suites completas finales: Offline **236/236**, BCA **206/206**, sin fallos ni omisiones.
- Ocho pruebas nuevas verifican ventanas, cambio de credenciales / QR, reloj, fallos, respaldo al caer Realtime, concurrencia de lecturas, chat, temporizador único de reportes, escrituras sin demora adicional, firmas privadas, borradores y actualización de múltiples logos sin recreación innecesaria.
- La prueba existente de recepción entre dispositivos se ejecuta ahora con el regulador real de lecturas. Comprueba solicitudes, chat, reconexión y pagos demorados.
- Las suites existentes cubren idempotencia de solicitudes y cobros, durabilidad de ventas, respuestas perdidas, reconciliación de stock, permisos, sincronización entre pares y recuperación offline. No se hicieron ventas reales.
- Chrome con las páginas completas de ambos proyectos y APIs interceptadas: formulario de inicio de sesión, navegación, Carta, llamado al mesero con mesa y QR correctos, refresco remoto durante edición de Marca, guardado y texto escrito durante un guardado demorado. Sin errores JavaScript en el recorrido final.
- Comparación de bloques de código con la copia previa: adaptador Supabase intacto; lógica de ventas, cobros, stock, pedidos y colas intacta; Apps Script idéntico. Service workers cambian únicamente la versión de recursos estáticos.
- SQL previo y migraciones existentes intactos. Se agrega solo `supabase/diagnostics/20261019_read_only_usage.sql`: diagnóstico opcional con `BEGIN READ ONLY`, `SELECT` y `ROLLBACK`, fuera del directorio de migraciones. No se ejecutó contra producción y no mide egress ni logs.

El navegador completo detectó durante la validación un error en la iteración de logos introducido al preparar el cambio; se corrigió antes de publicar y se añadió una prueba de regresión para múltiples logos. Las cifras finales corresponden al código corregido.

## Archivos y reversión

- `app.js`: regulación de lecturas periódicas, seguimiento de conexión, reintentos y preservación de borradores / logos.
- `menu-cards.js`: firma compartida con caducidad e invalidación por credenciales / QR.
- `admin.html`, `index.html`, `service-worker.js`: versiones nuevas para que se descargue el código actualizado; no se cambian la cola offline ni sus reglas de confirmación.
- `tests/supabase-read-budget.test.cjs`, `tests/realtime-reception.test.cjs`: comprobaciones de la optimización.
- Este informe, la muestra JSON de mediciones y el SQL opcional de diagnóstico.

Se conservó la rama de trabajo `perf/supabase-usage-20261019`. Puntos previos remotos: BCA `cf37b4ff80338bc7af8ba536b7f172b9b5982b0d`; Offline `41d6955b17bdca73bdb86a1aa546e18ccd4c1893`. Por las desconexiones de D: se guardó una copia completa para validar en `C:\Users\Juans\Documents\NAPOLES-validacion-20261019`, sin reconstruir ni descartar los cambios existentes.

Para revertir, localizar el commit `perf: reduce Supabase background reads while preserving live requests` en cada repositorio y aplicar `git revert <commit>` seguido de push normal a `main`. Así se conserva la historia y no se revierten ventas ni datos. El revert recupera también las versiones previas de recursos; recargar la aplicación para activar esos archivos. No hay migración de base de datos que revertir. No usar reset ni force push.

## Comprobación posterior pendiente de datos reales

La aplicación no requiere ejecutar SQL ni modificar el proyecto Supabase para recibir esta mejora. No hay cambios de base de datos esperando aprobación.

Para evaluar el objetivo mensual, comparar ventanas equivalentes de uso real antes y después del despliegue: misma cantidad de dispositivos, horas de operación y actividad. En el panel distinguir egress por proyecto y servicio; en logs contar rutas y estados, tamaños, errores de autorización y reconexiones repetidas, sin exportar tokens. Revisar especialmente snapshots, bootstrap, usuarios, chat, firmas e imágenes. Registrar el consumo del resto de proyectos por separado.

Una proyección mensual necesita el consumo incremental posterior, los días transcurridos y el resto del período. Los porcentajes actuales ya acumulados no se corrigen retroactivamente. Hasta tener esa evidencia no se puede asegurar permanencia debajo del 70%, ni convertir los bytes JSON de esta simulación en GB facturados o de Log Ingestion evitados.
