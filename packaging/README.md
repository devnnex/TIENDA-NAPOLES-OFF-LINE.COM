# Instalador de Tienda Napoles Offline

`build-installer.ps1` compila un iniciador Windows sin consola y genera un unico
`dist/Tienda-Napoles-Offline-Setup-1.0.34.exe` con Inno Setup 6.

La version 1.0.34 recupera los calculos antiguos de existencias que podian
ser distintos entre equipos con las mismas revisiones. Verifica que operaciones
se aplicaron antes de conciliar una instantanea remota completa, conserva las
realmente pendientes y vuelve a verificar ante nuevas operaciones o revisiones.
Una lectura incompleta o interrumpida conserva la copia anterior. Usa cache v66.
El cambio se limita al inventario; no requiere SQL ni actualizar Code.gs.

La version 1.0.33 corrige el doble conteo de ajustes locales de existencias
al conciliar el inventario. La base confirmada excluye las entradas y los
retiros pendientes que ya aparecen localmente, para aplicarlos una sola vez
al confirmarse. Ambos equipos conservan iguales las unidades y los KPI al
reintentar o reconectar. Usa cache v65.
No cambia otras secciones, Code.gs ni requiere SQL adicional.

La version 1.0.32 comparte los ajustes manuales y los lotes confirmados de
inventario, incluidos nombre, categoria y existencias. Al agrupar escrituras
conserva la variacion completa y las operaciones que ya se estaban enviando.
Los abonos se concilian con la cuenta vigente aunque se actualice durante su
confirmacion y mantienen su ID al reintentar. Usa cache v64.
No cambia Code.gs ni requiere SQL adicional.

La version 1.0.31 conserva las reposiciones confirmadas mientras se concilian
ventas pendientes y evita que un aviso anterior vuelva a mostrar el producto
como agotado. Actualiza las existencias del selector de consumo en segundo
plano y las verifica antes de rechazar un cobro por falta de stock. Conserva
las unidades reales y los reintentos sin duplicar entradas. Usa cache v63.
No cambia Code.gs ni requiere SQL adicional.

La version 1.0.30 alinea los indicadores del inicio y presenta en verde los
avisos informativos de respaldo y consulta. El selector de Movimientos permite
buscar por palabras sin tildes y por siglas, manteniendo la seleccion original.
Carta se integra a las cuatro opciones del cliente, con dos columnas en movil.
Su visor adopta la presentacion de Los Maravillosos: lupa, cierre rojo, arrastre,
zoom tactil y restablecimiento con doble clic o doble toque, con texto inferior
grande. Las imagenes nuevas siguen disponibles para todas las mesas por defecto.
Usa cache v62. No cambia Code.gs ni requiere SQL adicional.

La version 1.0.29 lleva las diferencias de existencias en el mismo lote rapido
de ventas, ediciones y borrados. Los acuses parciales concilian esas operaciones
por su ID sin repetir los descuentos o las reposiciones visibles. Conserva
los pendientes durables y recupera el saldo al interrumpir y reanudar la conexion.
Evita sumar correcciones intermedias de movimientos encima del resultado final.
El aviso Usando respaldo local se presenta en verde. Usa cache v61.
El inicio reemplaza Reintentar respaldo por el indicador verde Usando el software.
No cambia Code.gs ni requiere SQL adicional.

La version 1.0.28 cierra el turno al primer clic en la X o fuera del modal.
Dibuja las listas de Ventas, Inventario y Movimientos en tramos pequenos para
atender clics y escritura sin esperar las consultas, y pausa el dibujo oculto.
Reutiliza formatos de moneda y fecha sin cambiar sus valores. El encabezado y
la barra lateral del inicio muestran SOFTWARE junto al nombre, sin cambiar Marca.
Corrige el doble descuento del propio lote de borrados y descarta inventarios
con una version anterior a la ya recibida. La cache de recursos pasa a v60.
No cambia Code.gs ni requiere SQL adicional.

La version 1.0.27 incluye ediciones y borrados pendientes en la misma via rapida
por lotes que las ventas nuevas al reconectar. Conserva los acuses por operacion,
protege las mutaciones recientes frente a recibos anteriores de Google y aplica
los cambios de KPI y movimientos al recibir el conjunto. El inventario comparte
una sola instantanea remota con todos los productos del lote; las ediciones
ajustan el stock local por diferencia y se oculta el indicador de pendientes
de inventario en Offline. Usa cache v59.
No cambia Code.gs ni requiere SQL adicional al lote publicado en 1.0.26.

La version 1.0.26 verifica el informe remoto antes de mostrar las cifras al
abrir Ventas con conexion. Al volver a la aplicacion consulta otra vez y descarta
respuestas anteriores a la reanudacion. Si los datos no cambian, conserva las
tarjetas y detalles visibles. Sin conexion mantiene la ultima copia disponible.
La cache de recursos pasa a v58.

Las acciones aisladas mantienen el envio individual; los avisos confirmados
acumulados se publican en lotes de hasta 20. La recepcion paginada aplica el
conjunto completo una sola vez y conserva el cursor si alguna pagina falla.
Para habilitar esa publicacion por lotes en ambos proyectos, ejecutar una vez
la migracion supabase/migrations/20261019233000_report_change_batches.sql en
Supabase. Hasta entonces conserva el envio individual compatible. Code.gs sigue
en 2.14.0: si ya esta publicado, no requiere volver a actualizarlo.

La versión 1.0.25 oculta los pendientes de respaldo del encabezado y de Ventas;
Ventas conserva el número de facturas. Conserva las altas antes de sus ediciones
y borrados aunque se interrumpa la conexión. Envía hasta 20 operaciones de ventas
en una petición y retira de la cola solamente las confirmadas. Los bloqueos
temporales se reintentan en segundo plano. La caché de recursos pasa a v57.

Para habilitar los lotes y la recuperación de ediciones/borrados, actualizar
la implementación web existente con `appscript/Code.gs` 2.14.0, conservando su URL.
Mientras el backend anterior siga desplegado, la aplicación usa el envío individual
compatible y conserva los reintentos. No requiere SQL nuevo.

La landing consulta GitHub Releases (`releases/latest`), no los archivos de `main`.
El workflow `.github/workflows/publish-installer.yml` publica automáticamente el
instalador de mayor versión de `dist` al subir un instalador a `main`. Primero
crea un borrador, sube y verifica el archivo y después lo marca como la última
publicación. Una versión antigua no desplaza una más reciente. Para cada cambio
del paquete incrementa la versión, compila y sube el nuevo `.exe`. También se
puede ejecutar el workflow manualmente desde Actions. No modifica la landing.

Desde 1.0.24, `.github/workflows/build-installer-release.yml` también compila
el código del commit en Windows de GitHub Actions y publica su instalador como
Release. Se activa al subir una versión nueva en `TiendaNapolesOffline.iss` o
manualmente. No basta con subir `app.js`: para distribuir cambios por la landing
hay que incrementar AppVersion y completar esa publicación. Las versiones ya
publicadas siguen siendo inmutables; no se reemplaza su ejecutable.

La versión 1.0.24 incluye el código actual de main: optimización de lecturas
Supabase, respaldo prioritario de solicitudes cada segundo, caché temporal de
firmas privadas de Carta y protección de los textos de Marca durante edición y
guardado. Incluye los ajustes previos de Carta de dos imágenes, compras y cobros.
La caché de recursos es v56; es independiente de la versión del instalador.
Esta actualización de rendimiento no cambia Code.gs ni requiere SQL adicional.

La versión 1.0.23 prepara la sesión solo al enviar una solicitud explícita
desde una mesa libre y evita el conflicto SQL de la ruta anterior. Usa el ID y
el QR de cada mesa, incluidas las que se creen después; 30 mesas es un caso de
prueba, no un límite. Abrir el QR continúa siendo de lectura y no ocupa la mesa.
Con conexión, Offline devuelve la confirmación real de Supabase. Al reconectar
envía hasta cuatro operaciones independientes en paralelo y respeta el orden
de cambios relacionados. Las lecturas nuevas aceptan los cambios confirmados
del otro equipo sin restaurar un consumo o una cuenta anterior.
En ambos proyectos, el selector de Movimientos abre hacia abajo, el importe
recibido tiene el tamaño de las vueltas y el diseño móvil evita scroll horizontal.
No requiere una migración adicional ni cambia los cálculos de cobro o stock.

La versión 1.0.22 da prioridad a solicitudes y chat: lee solicitudes cada
segundo sin esperar el snapshot de cuentas ni los reportes, separa el canal
de avisos del de cambios de filas y permite enviar un nuevo llamado aunque
otro continúe pendiente. Conserva confirmación por backend y límites de canciones.
Movimientos vuelve a una sola lista, conserva tres KPI y solo el selector de
producto; no requiere facturas ni metadatos de paginación para mostrar datos.

La versión 1.0.21 evita consultar historiales completos al entrar o filtrar
Movimientos. Conserva tres KPI y cambia entre inventario y ventas en memoria.
Concilia borrados del respaldo y retira movimientos de las ventas eliminadas.
La recepción de solicitudes y chat conserva su conexión independiente y los
límites de canciones. No modifica cálculos de cobro o restauración de stock.

La versión 1.0.20 coloca Guardar marca junto al logo y la portada y añade
Guardar mesas de afuera dentro del configurador. Ambos botones bloquean
envíos repetidos hasta que se confirme el guardado.

Abrir, recuperar o actualizar una página del QR consulta la cuenta con
`ensure_session: false`. La consulta alternativa también es de lectura.
Las mesas y los indicadores solo consideran ocupadas las cuentas con consumo
confirmado o abonos reales. Las sesiones vacías de llamados o chat anteriores
se conservan para atender las solicitudes y reutilizarlas al agregar consumo.
El navegador comprueba la cuenta actual en segundo plano, incluyendo cierres
y nuevas cuentas. Pedir mesero, canción y chatear conservan sus acciones
explícitas. Ver cuenta muestra el consumo cuando corresponde.

La versión 1.0.19 incorpora la lectura rápida de ventas y movimientos compartidos
en Supabase, la selección persistente con las flechas del teclado, las vueltas
más grandes, los totales de entradas, salidas y unidades vendidas por producto,
y los reportes PDF de ventas y compras. Marca permite mostrar u ocultar
«Ver cuenta» para los clientes en todos los dispositivos.

Para las nuevas funciones compartidas, aplica una vez en el SQL Editor de Supabase
`supabase/migrations/20261013160000_fast_reports_and_client_bill.sql`.
El archivo es repetible y no borra las ventas ni el inventario. La bitácora exige
un empleado autorizado; los avisos públicos de Realtime no contienen importes
ni facturas. El receptor consulta Supabase al recibir el aviso y cada 1,5 segundos
como respaldo. No espera la consulta del reporte completo de Google. Una venta
de mesa se publica en la ruta rápida cuando su cierre queda confirmado; al
trabajar sin conexión, conserva su cola hasta que el cierre se sincronice.
Las operaciones conservan su identidad y los informes se concilian por ID.
Los cambios de inventario enviados al receptor usan la confirmación remota.

Los PDF online recorren todas las páginas del rango o turno seleccionado.
Sin conexión identifican la copia disponible y avisan si el reporte de ventas
es parcial. En Movimientos, «vendidas» cuenta líneas de cuentas cobradas;
«retiradas» también puede incluir consumo pendiente y retiros manuales.
La consulta completa del historial evita presentar los primeros 800 registros
como si fueran todo el inventario.

La versión 1.0.18 añadió a cada venta el botón de reimprimir factura de BCA,
incluidos los abonos disponibles de la cuenta, sin volver a cobrar ni modificar
el inventario. Los avisos de escritura confirmada inician las consultas de Ventas
y Movimientos en paralelo sin una consulta previa de estado ni esperar Inventario.
Un aviso recibido durante una lectura provoca otra consulta al terminar. La
consulta periódica por revisiones sigue como respaldo. Al recuperar internet,
las operaciones listas se envían mientras arrancan las lecturas; cada venta
conserva su dependencia del cierre de la cuenta y su identidad de operación.
Se evita iniciar dos envíos simultáneos de la misma cola tras el guardado durable.

En ambos proyectos, el cobro con o sin impresión abre automáticamente solo la caja
local y solo si el pago actual incluye efectivo positivo. Un abono en efectivo
también abre la caja local al confirmarse, antes de reconstruir la interfaz; un
reintento reconocido como duplicado no vuelve a abrirla. Un dispositivo distinto
del PC conectado no solicita apertura remota automáticamente. La reimpresión
no abre la caja. Conserva el control de apertura manual existente. No requiere
SQL ni cambios o despliegues de Apps Script. La caché de Offline pasa a v46.

La versión 1.0.17 extiende la protección frente a consultas atrasadas a Marca,
mesas, catálogo, usuarios y movimientos. Conserva los cambios locales hechos
mientras se consultaba y recibe los datos nuevos de otras filas. Las cuentas
revisan de nuevo su cola y snapshot local al terminar la lectura. Los movimientos
pendientes conservan sus correcciones al mezclarse con el historial remoto.
Eliminar una venta o registrar un cobro invalida las consultas de Ventas anteriores.
Las categorías iniciales conservan UUID y se mezclan sin repetir identificadores.
Mantiene la corrección de consumos de 1.0.16 y las protecciones existentes de
solicitudes, chat, abonos, cobros, inventario y turnos. No requiere SQL ni cambios
en BCA o Apps Script. La caché de la aplicación pasa a v45.

La versión 1.0.16 corrige la duplicación local y la reaparición de consumos al
eliminarlos. Cada alta conserva un UUID desde la vista local hasta la cola y el
servidor. La confirmación mezcla por identificador: una lectura recibida antes
de terminar la escritura no añade el mismo consumo otra vez. Las cancelaciones
actualizan la protección local y el snapshot durable; una lectura atrasada no
repone el estado anterior. Al rechazar una cancelación se restaura únicamente
esa línea y se conservan otras eliminaciones realizadas mientras tanto.
Normaliza copias locales repetidas del mismo UUID, sin agrupar productos con
UUID distintos ni borrar registros del backend. Conserva las validaciones de
abonos, los datos offline y el iniciador de 1.0.15. No requiere SQL ni cambios
en BCA o Apps Script. La caché de la aplicación pasa a v44 para cargar el ajuste.

La versión 1.0.15 corrige únicamente el arranque instalado y los accesos directos.
En el PC revisado faltaba `TiendaNapolesOffline.exe` en la carpeta instalada;
no se pudo confirmar qué lo eliminó. Los accesos del escritorio, Inicio y los
nuevos anclajes usan Windows PowerShell y el script instalado, que abre el `.exe`
normalmente y carga el mismo iniciador desde su fuente si falta el ejecutable.
Pueden abrir aunque falte ese ejecutable. El `.exe` también conserva la
compatibilidad con accesos antiguos. No se recrean ejecutables
ni se cambian las opciones del antivirus.

La carpeta de instalación conserva la de la versión anterior y no depende del
nombre ni la ubicación de la descarga. Cada instalación vuelve a escribir los
accesos del escritorio e Inicio. Para reparar una instalación existente, ejecuta
1.0.15 con el mismo usuario de Windows, sin desinstalar. Si tenías un anclaje
antiguo en la barra de tareas, desánclalo y ancla el acceso actualizado de Inicio.
No hay cambios en `app.js`, servidor, interfaz, sincronización ni datos locales.
El script y los archivos instalados deben conservarse; esta corrección no puede
evitar una eliminación manual ni un bloqueo de Windows o de un antivirus.

La versión 1.0.14 limita el ajuste a los avisos de Offline hacia BCA: cada
escritura confirmada avisa sin esperar al resto de la cola. La entrega a
Realtime se confirma por HTTP y reintenta si falla, incluso al volver internet.
Marca, mesas, catálogo, cuentas, solicitudes, usuarios e informes usan los
eventos que BCA ya escucha. Los avisos contienen únicamente invalidaciones;
no publican cambios locales pendientes como si estuvieran guardados en el backend.
No cambia BCA ni requiere SQL o cambios en Apps Script.

La versión 1.0.13 corrige únicamente la consulta del inventario de Offline:
lee Apps Script aunque haya una escritura pendiente o en curso. El indicador
cuenta solo cambios activos que afectan inventario. Las operaciones rechazadas
conservan su registro y permiten mostrar las existencias actuales del backend.
Los cambios locales pendientes se protegen por producto, incluida una carga inicial;
una lectura anterior no pisa escrituras confirmadas mientras se consultaba.
Conserva la consulta cada cinco segundos y la recuperación al volver internet.
No requiere SQL ni cambios en Apps Script o BCA.

La versión 1.0.12 limita el ajuste a la rapidez del inventario y al aviso visual
histórico 406/PGRST116 de cuentas sin filas. Inventario consulta cada cinco segundos,
espera solo los cambios de su producto y retoma sus envíos al confirmarse el catálogo.
Cada envío revisa el estado actual de los pendientes. El aviso histórico se omite
en la presentación; conserva la operación y muestra los demás errores reales.
No requiere SQL adicional. BCA retira Abrir caja y Configurar caja de Cuentas.

La versión 1.0.11 consulta los snapshots autorizados actuales al iniciar sesión
sin esperar a que terminen las colas de escritura. Un GET vacío por permisos o
una lectura fallida no reemplaza datos válidos. Los pendientes conservan sus
campos y líneas propios; reciben consumos, abonos y cambios de los otros equipos.
Las escrituras confirmadas avisan a las sesiones abiertas de ambos proyectos;
las lecturas y los cambios únicamente locales no generan avisos de confirmación.
La actualización periódica y la reconexión siguen como respaldo.
Un alta de cuenta con 406 se confirma únicamente al comprobar el mismo UUID,
mesa y canal mediante lectura autorizada. No repite un cobro ni borra la cola.
Los avisos recibidos durante una lectura se revisan de nuevo al terminar.

Para la NUEVA regla de consumos y abonos, ejecutar una vez en el backend compartido
`supabase/migrations/20261007230000_abonos_consumos_coherentes.sql` después del SQL
de abonos de 1.0.9. Rechaza reducciones que dejen consumo positivo inferior a
lo abonado. Al retirar todo el consumo de una cuenta abierta elimina sus abonos,
permite liberar la mesa y deja de mostrarlos en el QR. Conserva pagos archivados
de cuentas cerradas. Las validaciones de productos y abonos comparten el bloqueo
de cuenta del backend. La app valida también antes de modificar el consumo.
Este SQL adicional debe ejecutarse en Supabase; el instalador no lo ejecuta.

La versión 1.0.10 corrige la lectura de cuentas cuando una operación antigua
identificada ya no tiene copia en el caché. Conserva las escrituras pendientes
y actualiza las otras cuentas y solicitudes desde el servidor. Recupera los
metadatos incompletos de operaciones anteriores sin cambiar su UUID ni su cuerpo.
Los cambios tardíos de nombre o responsable sobre cuentas cerradas se concilian
con sesión validada y estado remoto comprobado, sin volver a cobrar ni reabrirlas.
Los conflictos de importes conservan su protección y registro.

En ambos proyectos, «Tu cuenta» del QR muestra el abono con fecha y hora y el
saldo pendiente, incluso si no cambiaron los consumos. Las respuestas fallidas
no borran abonos cargados y las respuestas tardías de otra mesa no se mezclan.
Mantiene la actualización al iniciar sesión y los intervalos de la versión 1.0.8.
Si la migración de abonos de 1.0.9 ya terminó correctamente, esta actualización
no requiere ejecutar otro SQL.

La versión 1.0.9 añade abonos con registro de fecha y hora, turnos QR y apertura
remota de una sola caja conectada. Comparte estas funciones con BCA, junto con
el cobro mediante Enter sin imprimir, búsqueda y orden de cuentas y facturas
en negro y negrita con el pie de Devnex. El atajo de dos ceros del teclado
numérico abre la caja si no hay modales ni campos de escritura activos.
La recuperación del último conflicto de cuentas `406/PGRST116` usa una lectura
autorizada y reenvía el cambio original; no interpreta una respuesta REST vacía
como prueba de que se borró la cuenta.

Antes de activar estas funciones, ejecutar una vez en el backend compartido
`supabase/migrations/20261007190000_abonos_turnos_caja.sql` y volver a iniciar
sesión con internet. Consultar `supabase/ACTIVAR-ABONOS-TURNOS-CAJA.md`.
El instalador no ejecuta SQL ni limpia los datos pendientes del navegador.

Conserva las correcciones de 1.0.8: esta versión
recupera `save_table_zones` rechazado con `21000` usando solamente cambios
de `is_outdoor` filtrados por UUID y comprobados en el servidor. Conserva
los puntos de servicio y exige el rol y acceso a Marca ya previstos por la app.
Renueva credenciales de las operaciones administrativas pendientes tras
validar el login vigente, incluyendo catálogo y las RPC con `p_auth_token`.
Las credenciales QR no se reemplazan por credenciales administrativas.

Una operación rechazada conserva el error y sus datos, pero permite enviar
operaciones independientes. Conserva el orden y las dependencias de cada
cuenta/producto. Las lecturas del panel preservan las cuentas y solicitudes
pendientes del caché durable y actualizan las demás desde el servidor; si no
puede identificarse el cambio local, mantiene la protección anterior.
Los cierres `406` de cuentas que aún están abiertas se reintentan con sus
filtros e importes originales, sin modificar cuentas ya cerradas con otros importes.
Se mantienen los intervalos y la actualización paralela de inventario,
movimientos y ventas existentes.

`supabase/fix-save-table-zones.sql` corrige únicamente los UPDATE sin WHERE
compatibles de la definición actual de esa función en Supabase. Conserva
su firma, autenticación, permisos y retorno; no desactiva `safeupdate`.
Subirlo al repositorio no lo aplica al servidor. El instalador recupera el
guardado de zonas mediante REST sin depender de ejecutar ese SQL.

Conserva la recuperación de la versión 1.0.7, que
recupera las solicitudes bloqueadas por el error SQL `0A000` del servidor,
incluso si el token no cambia. Usa el guardado REST ya previsto por la app,
valida primero al usuario y comprueba el resultado remoto. Un consumo `406`
no se descarta por estar ausente: se restaura el mismo UUID si su cuenta está
abierta y el cambio conserva los datos completos; si está facturado, debe
coincidir con la línea de la factura remota. Una cancelación ya ausente se
concilia solo con acceso autenticado y sin una creación pendiente del consumo.
Los casos sin evidencia suficiente conservan el conflicto y sus datos.

La corrección SQL de origen está en
`supabase/fix-acknowledge-service-requests.sql`: ejecutarla en el SQL Editor
del mismo proyecto Supabase reemplaza únicamente esa función, conservando
autenticación, firma y permisos. Subir el archivo a GitHub o reinstalar no
ejecuta SQL en Supabase. La recuperación del instalador funciona mediante
REST aunque todavía no se haya aplicado ese archivo al servidor.

Conserva el comportamiento de la versión 1.0.6: abre la caja al cobrar
desde Inicio, Atender mesa o Cuentas, tanto con recibo
como sin él. Enter y Enter del teclado numérico cobran sin imprimir. La apertura
usa la impresora POS o el puente de caja ya configurados; el recibo existente
se imprime al pulsar Cobrar e imprimir.

Conserva las correcciones de la versión 1.0.5, que
corrige el clic de confirmar consumo cuando la lista de productos desplaza
el botón en pantallas pequeñas, recupera solicitudes 400 y consumos 406 con
una credencial nueva validada y define la identidad del icono anclado en Windows.
Los rechazos que persistan conservan el mensaje real del servidor en el aviso.

Para actualizar el PC del cliente, cierra las ventanas de Tienda Nápoles y
ejecuta este instalador con el mismo usuario de Windows, en la misma carpeta.
Abre el acceso directo del escritorio e inicia sesión con internet para validar
la credencial y reintentar las operaciones pendientes. No desinstales ni borres
los datos del navegador: ahí se conserva la cola. Si el aviso sigue rojo,
copia el detalle al dejar el cursor sobre él; no significa que esté sincronizado.

Para reemplazar un anclaje antiguo con el icono de Chrome, desancla esa entrada
y ancla el acceso directo actualizado de Tienda Nápoles del menú Inicio.
El anclaje abre el iniciador local y mantiene el icono del negocio.

El instalador copia solo los archivos necesarios para ejecutar la aplicacion,
crea el acceso directo del escritorio y una entrada del menu Inicio. Instala en
el perfil del usuario, sin pedir permisos de administrador. El iniciador usa el
mismo `http://127.0.0.1:8766` y el perfil habitual de Chrome o Edge; por eso
conserva los datos offline que ya existen en ese navegador. No borres los datos
del navegador ni cambies de perfil si hay operaciones pendientes.

El primer acceso de cada usuario en este PC requiere internet. Despues, el
usuario y PIN se pueden validar sin red durante 30 dias desde el ultimo login
online. El PIN no se guarda en claro: un verificador y el token/perfil quedan
protegidos por DPAPI del usuario de Windows. Tras cinco PIN erróneos, espera
cinco minutos. Al volver internet, el sistema solicita un token nuevo antes
de enviar cambios pendientes. Si el usuario fue desactivado o su PIN cambio
en el backend, se pedira iniciar sesion otra vez online. Borrar el perfil de
Windows o usar otro usuario de Windows no conserva este acceso local.

Para un cajon conectado al puerto DK de una impresora de recibos compatible
con ESC/POS: instala en Windows el controlador de la impresora, conecta el
cajon y pulsa **Abrir caja**. La primera vez selecciona la impresora POS y el
pin 2 (o pin 5 si lo indica el fabricante); despues pulsa **Probar y guardar**.
Las siguientes aperturas son de un clic. El boton de ajustes permite cambiar
la impresora. Windows gestiona su puerto USB, COM o de red. Se conserva un
puente `window.posCashDrawer` existente.

Un cajon USB/OPOS independiente o con protocolo propietario requiere su driver
y una integracion especifica. Sin conocer y probar el modelo no se puede
garantizar compatibilidad universal. La respuesta de Windows confirma que la
orden entro a la cola de impresion, no que el cajon se abrio fisicamente.

Al cerrar la ventana con la X, el servidor local puede seguir activo para que
la siguiente apertura sea inmediata. El iniciador comprueba que sea la copia
instalada y lo reutiliza. En la primera apertura despues de instalar, si sigue
activo el servidor anterior, el iniciador verifica su proceso y los archivos
que sirve, lo detiene y abre la copia instalada sin reiniciar Windows. Si el
puerto esta ocupado por otro programa, no lo detiene.

Para compilar de nuevo, instala Inno Setup 6 y ejecuta:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\packaging\build-installer.ps1
```

Para comprobar el iniciador y su respaldo sin abrir el navegador ni usar datos reales:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tests\installed-launcher.test.ps1
```

El `.exe` generado puede alojarse como archivo de descarga directa en la futura
pagina web; esa pagina no forma parte de este paquete. Este instalador no esta
firmado: Windows puede mostrar SmartScreen al descargarlo o instalarlo. Para
distribucion publica continua conviene firmar cada version con un certificado
de editor confiable.
