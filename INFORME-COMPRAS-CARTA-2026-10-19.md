**Intervención de Compras, contraste de cobro y Carta — 19 de octubre de 2026**

Aplicada directamente en estas dos carpetas:

- `D:\NAPOLES-BACKUP-19-10-2026\TIENDA-NAPOLES-OFF-LINE.COM-main`
- `D:\NAPOLES-BACKUP-19-10-2026\TIENDA-NAPOLES-BCA.COM-main`

Los tres cambios solicitados están implementados en ambos proyectos. También se corrigió en BCA la función `isManager`, después de la autorización adicional del usuario. La Carta necesita activar su migración en el Supabase compartido antes de utilizarla en producción.

**Compras → Descargar PDF**

El controlador anterior esperaba una consulta completa de Movimientos antes de generar el archivo. Un rechazo de esa consulta, incluso con compras ya visibles, impedía la descarga. El servidor exige permiso de `movements` para esa lectura, mientras que Compras pertenece a Inventario. La prueba de regresión reproduce el bloqueo con una consulta rechazada; el nuevo exportador descarga sin depender de ella.

Se exporta exactamente la selección que devuelve `purchaseMovements()`: producto, fechas, búsqueda, exclusiones y registros cargados en la pantalla. Se conservan el costo registrado o su sustitución por el costo actual, las cantidades, fechas y sumas utilizadas por Compras. No se modificó cómo se registran o editan las compras.

El PDF usa A4 horizontal, identificación del negocio, período, total destacado, resumen por producto, detalle, importes alineados a la derecha, encabezados repetidos y números de página. Los textos largos pueden continuar en otra página. Los registros vacíos, fechas inválidas y errores aparecen dentro del diálogo de Compras; el botón vuelve a quedar disponible.

El documento identifica su alcance: compras filtradas de los registros cargados. Si queda historial anterior por cargar o se exporta sin conexión, lo indica expresamente. No presenta una copia parcial como si fuera todo el historial remoto.

**Texto del cobro**

La única modificación del CSS existente es el color del componente `#cashChange` en estado suficiente: `#000000`. El fondo sigue siendo exactamente `#e3f8ec`. Los textos «Vueltas / cambio», el importe y «Recibido» heredan el negro. Se verificaron los colores calculados en Chrome. No se cambiaron medidas, tipografía, distribución ni cálculos del cobro.

**Administración y consulta de Carta**

Se inspeccionaron `menu-cards.js`, `menu-cards.css`, su integración y su migración SQL en [LOS-A-MARAVILLOSOS.COM](https://github.com/devnnex/LOS-A-MARAVILLOSOS.COM), revisión `427f3ebde6163a3e97ce1ed2ce9e7f0976995cc6`. Se adaptaron biblioteca, asignación por mesa, almacenamiento privado y consulta visual. No se trasladaron sus interruptores de solicitudes, cuenta, chat o canciones.

En **Marca → Carta · administrar imágenes**, un Jefe o un Administrador con permiso de Marca puede cargar hasta 20 imágenes JPG, PNG o WebP de hasta 15 MB cada una, consultar vistas previas, cambiar nombres, reemplazar, eliminar, ordenar y elegir todas las mesas o una selección. Se reutiliza el cliente de Supabase existente. No se añadieron dependencias de ejecución a la aplicación.

Las imágenes se guardan en el bucket privado `pos-menu-cards`; sus metadatos y asignaciones se guardan en `pos_menu_cards` y `pos_menu_card_tables`. Las funciones y políticas nuevas se limitan a esta biblioteca. No cambian las tablas ni contratos de ventas o solicitudes. Los enlaces firmados duran cinco minutos y se renuevan al volver a consultar la imagen.

Se validan formato, firma del archivo, tamaño y decodificación. La carga verifica que Storage puede devolver la imagen antes de publicar sus metadatos. Los reintentos usan identidades derivadas del contenido; las respuestas perdidas se concilian consultando el servidor. El reemplazo conserva la carta anterior hasta confirmar la nueva. Las ediciones de nombre/asignación y las eliminaciones comprueban versiones para detectar cambios simultáneos.

En `index.html`, **Carta** abre un visor independiente con anterior/siguiente, contador, ampliación, desplazamiento, cierre y recuperación del foco. Conserva la proporción de las imágenes y funciona en la vista móvil comprobada de 375 × 812. El servidor valida el QR y devuelve las cartas correspondientes a la mesa. El cliente vuelve a consultar al abrir el visor; los cambios administrativos aparecen en esa consulta. La consulta inicial y las modificaciones requieren conexión; no se encolan como ventas o solicitudes ni se simulan como guardadas sin red.

**Corrección adicional autorizada en BCA**

Tres funciones de recuperación y publicación de cobros utilizaban `isManager()` sin que existiera su definición en BCA. Se reprodujo el error usando la copia de `app.js` anterior a esta intervención. Se añadió el predicado junto a los otros controles de rol: reconoce `boss` y `admin`; rechaza Mesero o sesión ausente. El arranque completo posterior ya no genera ese error. No se cambiaron importes ni procesos de cobro.

**Archivos de la entrega**

| Archivo relativo | OFF-LINE | BCA | Cambio |
| --- | --- | --- | --- |
| `app.js` | Modificado | Modificado | Exportador de Compras e inicialización de Carta; BCA también define `isManager` |
| `style.css` | Modificado | Modificado | Negro en el componente verde del cobro |
| `admin.html` | Modificado | Modificado | Carga de los archivos de Carta y actualización de versión de recursos |
| `index.html` | Modificado | Modificado | Botón Carta y carga de sus archivos |
| `service-worker.js` | Modificado | Modificado | Versión de recursos; OFF-LINE incluye los nuevos archivos en su caché de aplicación |
| `menu-cards.js` | Nuevo | Nuevo | Administración, persistencia y visor |
| `menu-cards.css` | Nuevo | Nuevo | Estilos limitados a Carta |
| `supabase/migrations/20261019190000_pos_menu_cards.sql` | Nuevo | Nuevo | Tablas, funciones, bucket y permisos de Carta |
| `packaging/TiendaNapolesOffline.iss` | Modificado | No aplica | Inclusión de los dos archivos de Carta al construir el instalador |
| `tests/report-pdf-and-movement-totals.test.cjs` | Ampliado | Ampliado | Datos, filtros, paginación y errores del PDF |
| `tests/menu-cards-backend.test.cjs` | Nuevo | Nuevo | Permisos SQL/RLS, Storage, mesas, versiones y reintentos |
| `tests/menu-cards-browser.test.cjs` | Nuevo | Nuevo | Carga, persistencia simulada, visor, PDF descargado y colores |
| `tests/manager-role-guard.test.cjs` | No aplica | Nuevo | Control de roles usado por recuperación de cobros |
| `INFORME-COMPRAS-CARTA-2026-10-19.md` | Nuevo | Nuevo | Este informe |

`appscript/Code.gs` permanece idéntico a la copia del inicio de esta intervención, en ambos proyectos, y continúa en versión `2.13.0`. Estos cambios no requieren volver a desplegar Apps Script.

**Resultados y alcance de las pruebas**

| Verificación local | Resultado |
| --- | --- |
| Suite completa OFF-LINE | 228 aprobadas; 0 fallos y 0 omitidas |
| Suite completa BCA, incluida la corrección de roles | 198 aprobadas; 0 fallos y 0 omitidas |
| Chrome, administración y cliente en contextos separados | Carga múltiple, vista previa, renombre, mesas, orden, reemplazo, eliminación y recarga aprobados con backend simulado compartido |
| Fallos de carga | Archivo falso, más de 15 MB, sin conexión, error de red, respuesta perdida y repetición sin duplicados comprobados |
| PostgreSQL local con PGlite | Migración aplicada dos veces; restricciones, roles, QR, asignaciones, permisos de Storage y conflictos comprobados |
| Descarga desde botón real | PDF generado en Chrome en ambos proyectos con 135 compras de prueba y total de $5.062.500 |
| Apertura independiente del PDF | PDF.js abrió las 24 páginas de cada archivo; recuperó el último producto y el total; no detectó texto fuera de página |
| Páginas completas con APIs interceptadas | Arranque de `index.html` y `admin.html`, consulta de Carta y envío posterior de Mesero aprobados en ambos; sin errores JavaScript después del arreglo de BCA |

Las solicitudes existentes conservaron su código y sus contratos. La comparación con la copia previa confirma 599 bloques/declaraciones existentes sin cambios en OFF-LINE y 575 en BCA, incluidos los flujos de cliente, chat, cuenta, canciones, notificaciones, pagos e inventario. Dentro de `app.js`, solo se modificaron los bloques existentes de exportación de Compras e inicialización; se añadieron el generador de Compras y, en BCA, el control de rol autorizado. La comprobación de las páginas completas confirmó que abrir y cerrar Carta no impide enviar la solicitud de Mesero ni cambia su mesa y código.

Las evidencias están en `.pos-audit/menu-pdf-20261019/` de OFF-LINE: `offline-final.log`, `bca-final.log`, `scope-check.json`, `full-page-smoke.json`, `baseline-bca-smoke.json`, `pdf-readback.json` y las carpetas `screenshots-offline/` y `screenshots-bca/`. Allí están también el PDF de prueba descargado y sus páginas renderizadas. Son datos de prueba, no compras ni imágenes reales del negocio.

**Activación pendiente**

Ejecutar `supabase/migrations/20261019190000_pos_menu_cards.sql` **una sola vez** en el proyecto Supabase que comparten ambos POS, usando SQL Editor o el procedimiento de migraciones autorizado. El mismo archivo existe en las dos carpetas y es idempotente. Después, publicar los archivos del frontend de cada proyecto y recargar la aplicación. Para una instalación empaquetada de OFF-LINE, reconstruir el instalador con la lista de archivos actualizada; el ejecutable anterior de `dist` no se reconstruyó en esta intervención.

No se aplicó la migración al servidor del negocio ni se desplegaron archivos remotos. La persistencia y los permisos se comprobaron localmente y con servicios simulados; queda la verificación en el Supabase real tras activar la migración y cargar las imágenes reales. Una interrupción de carga puede dejar un archivo no publicado en Storage; el sistema no lo presenta como carta publicada. Una imagen con un enlace firmado previamente emitido puede seguir accesible hasta que ese enlace expire.
