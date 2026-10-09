# Turnos y base compartida

Publicar el `Code.gs` actualizado en la implementación existente de Apps Script, manteniendo su URL. Ambos proyectos utilizan el mismo servicio y archivo de ventas: basta con actualizar ese servicio una vez. GitHub no publica Apps Script automáticamente.

La actualización añade la pestaña `Turnos_Caja`, con una fila por apertura o cambio de base. Guarda importe inicial, saldo actual, horario, usuario, fecha y hora. Las operaciones llevan un identificador único para evitar duplicados al reintentar; una versión protege los cambios simultáneos desde varios equipos.

Al iniciar sesión, los usuarios con acceso a Ventas ven el formulario. Un nuevo turno muestra la fecha actual de Colombia y las horas vacías: inicio PM, cierre AM. Las horas admiten `800` o `8:00`, y también `8` para las ocho en punto. No admite horas militares, minutos inválidos ni inicio y cierre iguales. Cancelar no cambia la base ni abre otro turno.

Si ya existe un turno sin finalizar, el formulario permite actualizar o agregar base al mismo turno. No abre otro superpuesto. El indicador morado de Ventas muestra la base actual, la inicial y la última actualización; no incorpora ese dinero a los ingresos.

Ventas abre en Hoy. Un turno del 8 de octubre de 3:00 PM a 1:00 AM incluye las ventas desde las 3:00 PM del día 8 hasta antes de la 1:00 AM del día 9. A las 12:30 AM sigue mostrando el turno del día 8; a la 1:00 AM Hoy pasa al día 9, sin volver a sumar el tramo ya contado en el turno anterior. Si se guarda otro horario, se usan esas horas.

Un turno de 3:00 PM a 10:00 PM termina el mismo día. Después del cierre, Hoy muestra el tramo posterior; al llegar medianoche cambia la fecha. Ayer, 7 días, 15 días, este mes, 30 días, este año y los rangos manuales usan días calendario completos, sin horario de turno.

Actualizar base reemplaza el saldo; agregar base suma al existente. Ejemplo: inicial $100.000, agregar $50.000 deja $150.000; actualizar a $120.000 deja $120.000 y conserva la referencia inicial de $100.000.

Sin conexión, el cambio queda guardado en el equipo y se identifica como pendiente de compartir. Al recuperar la conexión se reintenta sin duplicarlo. Si otro equipo cambió la base mientras tanto, se recupera el valor compartido y se pide revisar la operación, evitando sobrescribir dinero silenciosamente.

Los informes remotos, sus totales y sus páginas aplican el mismo intervalo de horas. Hasta publicar el Code.gs actualizado, la nueva función de turno compartido no estará disponible.
