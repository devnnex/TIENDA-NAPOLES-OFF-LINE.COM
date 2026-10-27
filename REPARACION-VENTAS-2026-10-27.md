# Ventas, turno y borrado de movimientos — 27 de octubre de 2026

Base: main publicado desde la carpeta de Documentos (08ac098f). Cambios limitados a lo solicitado.

## Correcciones

- Hoy consulta el día calendario completo en America/Bogota. El horario del turno guardado se aplica al seleccionar ese turno en el historial. Un turno que comienza más tarde ya no excluye las ventas anteriores de Hoy.
- Hoy, Ayer y los periodos relativos cambian al pasar medianoche. Se conserva el periodo elegido al salir y volver a Ventas; las respuestas atrasadas se descartan.
- Las cifras disponibles del mismo filtro permanecen visibles mientras se verifica la revisión remota. Si no cambia el contenido, los indicadores y las facturas mantienen sus nodos. Los errores conservan el último informe; una lectura inicial fallida se identifica como no confirmada, sin presentar un cero como respuesta del servidor.
- Las facturas pendientes completas pueden recuperarse de la cola durable aunque todavía no estén en el historial en memoria. Se evita duplicar facturas ya incluidas fuera de la primera página.
- Abrir un turno existente selecciona Editar horario, habilitando las horas. Se conservan las acciones de base, validaciones, versiones y permisos existentes.
- Eliminar todos los movimientos vacía exclusivamente ese historial y su copia de movimientos. Conserva ventas, productos, existencias y costos. Requiere la confirmación y los permisos existentes; conserva la recuperación ante fallos y evita reconstruir correcciones anteriores al borrado.
- El consumo por lotes reutiliza sus formateadores de fecha y hora y evita una escritura duplicada del snapshot. Se conservan doble espacio, guardado durable y parpadeo de 2,2 segundos.

## Verificación

Pruebas de fechas y medianoche, selección de periodo, respuestas tardías, revisión sin cambios, errores de lectura, pérdida y recuperación de red, cola pendiente, ceros confirmados, edición de turno y borrado sin efectos de inventario. Pruebas de navegador en escritorio y móvil comprueban los mismos nodos KPI al navegar y una actualización ante datos nuevos. Se ejecutaron también las suites existentes de ambos proyectos.

Prueba local adicional: cuenta de 500 líneas y tres lotes consecutivos de 80 productos. Resultado: 740 líneas con identificadores únicos, tres inserciones y confirmación visible conservada. En el equipo de prueba, el tiempo previo a la confirmación pasó de 512–687 ms a 166–224 ms; esos tiempos no representan un límite garantizado para otros equipos o redes.

El endpoint de estado respondió versión 2.14.0 con revisiones de ventas y movimientos. Los escenarios funcionales usaron datos de prueba; no se consultaron ni modificaron facturas reales del negocio. No se cambió Apps Script, SQL, estilos, inventario, impresión ni la lógica de cobro. No requiere desplegar un Apps Script nuevo por estos cambios. La versión de recursos del navegador se incrementó para distribuir los archivos actualizados.
