# Instalador de Tienda Napoles Offline

`build-installer.ps1` compila un iniciador Windows sin consola y genera un unico
`dist/Tienda-Napoles-Offline-Setup-1.0.8.exe` con Inno Setup 6. Esta versión
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

El `.exe` generado puede alojarse como archivo de descarga directa en la futura
pagina web; esa pagina no forma parte de este paquete. Este instalador no esta
firmado: Windows puede mostrar SmartScreen al descargarlo o instalarlo. Para
distribucion publica continua conviene firmar cada version con un certificado
de editor confiable.
