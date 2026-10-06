# Instalador de Tienda Napoles Offline

`build-installer.ps1` compila un iniciador Windows sin consola y genera un unico
`dist/Tienda-Napoles-Offline-Setup-1.0.1.exe` con Inno Setup 6. No modifica
`app.js`, el Service Worker, el servidor local ni la logica de sincronizacion.

El instalador copia solo los archivos necesarios para ejecutar la aplicacion,
crea el acceso directo del escritorio y una entrada del menu Inicio. Instala en
el perfil del usuario, sin pedir permisos de administrador. El iniciador usa el
mismo `http://127.0.0.1:8766` y el perfil habitual de Chrome o Edge; por eso
conserva los datos offline que ya existen en ese navegador. No borres los datos
del navegador ni cambies de perfil si hay operaciones pendientes.

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
