# Instalador de Tienda Napoles Offline

`build-installer.ps1` compila un iniciador Windows sin consola y genera un unico
`dist/Tienda-Napoles-Offline-Setup-1.0.4.exe` con Inno Setup 6. Esta versión
agrega filtros de mesas y terrazas, selección segura de QR y control para
habilitar su regeneración desde Marca. Conserva el acceso offline y el resto
de la operación existente.

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
