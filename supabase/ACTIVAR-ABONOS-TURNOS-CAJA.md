# Activación compartida de BCA y Offline

## Actualización 1.0.11: coherencia entre consumos y abonos

Si el SQL de abonos de 1.0.9 ya terminó correctamente, conservarlo y ejecutar
UNA vez el nuevo archivo completo `migrations/20261007230000_abonos_consumos_coherentes.sql`
en el mismo backend compartido. Instalar Offline 1.0.11 con sus ventanas cerradas,
recargar BCA e iniciar sesión con internet. No borrar el perfil ni las colas.

La regla rechaza reducir precio/cantidad o retirar productos si el consumo
restante es positivo y menor que los abonos. Si se retira TODO el consumo,
elimina los abonos de la cuenta abierta y permite liberar la mesa. El QR
muestra la cuenta actual sin esos abonos. Conserva pagos de cuentas cerradas
archivadas. La validación del backend comparte el bloqueo de cuenta con el
registro de abonos y comprueba el resultado completo de cada sentencia.

Las lecturas actuales no esperan a que se resuelva una operación antigua.
Los cambios pendientes conservan sus campos y líneas propios sin ocultar otros
consumos, abonos, solicitudes ni cambios de catálogo y Marca. Las lecturas
fallidas conservan el estado visible. Los cambios confirmados avisan a las
sesiones abiertas; la consulta periódica y la reconexión sirven como respaldo.

## Activación inicial de abonos, turnos y caja (1.0.9)

Ambos proyectos usan el mismo backend. Ejecutar una sola vez en su SQL Editor
el archivo completo `migrations/20261007190000_abonos_turnos_caja.sql` y esperar
la confirmación de éxito. Después, abrir la versión actual de BCA e instalar
Offline 1.0.9 con las ventanas de la aplicación cerradas. Iniciar sesión con
internet para recibir la configuración y los datos actuales.

La migración conserva la función administrativa existente y añade abonos,
turnos de solicitudes y órdenes de caja. Repetirla no duplica registros. No
borra cuentas, consumos, ventas ni la cola pendiente del equipo. Publicar estos
archivos en GitHub no ejecuta la migración en Supabase.

## Caja desde el celular o cualquier sesión de personal

En el PC conectado a la impresora POS, abrir Offline 1.0.9, iniciar sesión y
configurar la impresora y el pin en Abrir caja. Mantener la aplicación abierta
y el equipo con internet. BCA también puede recibir órdenes en ese PC usando
el controlador local que proporciona Offline. Si el navegador pide acceso a
la red local, permitirlo para conectar con ese controlador.

Desde BCA u Offline, cualquier usuario del personal con sesión iniciada puede
pulsar Abrir caja. La orden se entrega a una sola caja configurada con señal
reciente, aunque haya otras sesiones abiertas. BCA y Offline en el mismo PC
comparten la identidad del controlador y no repiten el pulso. No se guardan
órdenes remotas sin internet para abrir una caja más tarde. La confirmación
significa que el controlador aceptó la orden; el equipo no tiene un sensor que
compruebe físicamente el cajón.

En el PC, pulsar dos veces `0` en el teclado numérico en menos de 450 ms abre
la caja desde cualquier sección. Num Lock debe estar activado. El atajo se
bloquea si hay un modal abierto o foco en un campo de escritura.

## Cobros, abonos y solicitudes

Inicio, Atender mesa y Cuentas usan el mismo cobro: Enter o Intro numérico
cobra sin imprimir y abre caja. Cobrar e imprimir abre caja e imprime el
recibo. Abonar guarda un pago parcial con fecha, hora, medio y referencia; lo
descuenta del saldo y mantiene abierta la cuenta, incluidos puntos sin QR.
Los abonos en efectivo también envían la apertura de caja.

Los clientes QR ven su posición por orden de llegada. Canciones tiene su
propia cola y admite hasta cinco canciones por mesa durante el turno pendiente.
Cuando el personal atiende todas las canciones del turno, puede comenzar otro.

## Validación

Las pruebas `tests/pos-features.test.cjs` comprueban saldo, propina, búsqueda,
orden, factura y atajo. `tests/pos-backend.test.cjs` ejecuta la migración en
PostgreSQL local con PGlite y pgcrypto para verificar autenticación,
idempotencia de abonos, límites, turnos y entrega única de órdenes de caja.
Esta última prueba requiere `@electric-sql/pglite` disponible en Node.js.
Las pruebas usan datos simulados y no abren la caja física del negocio.
