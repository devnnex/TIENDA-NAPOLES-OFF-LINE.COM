# Verificación de respuesta a clic y teclado — ambos proyectos

Fecha: 19 de octubre de 2026. Alcance autorizado: comprobar el estado existente y publicar evidencia. **No se modificó ningún archivo de código, prueba, configuración, migración ni instalador de la aplicación.** Este commit agrega únicamente este informe. Se conservan todas las optimizaciones previas y el instalador Offline 1.0.24.

Se verificó igualdad SHA256 de los 155 archivos existentes versionados en Offline y 96 en BCA, antes y después de las comprobaciones. Los scripts de medición y resultados brutos se guardaron localmente en la carpeta ignorada .pos-audit/click-typing-20261019, fuera del producto y de este push.

## Qué se comprobó

Chrome headless en el equipo actual, páginas completas de cada proyecto y APIs interceptadas, sin tocar Supabase ni Google de producción. Muestra fija: 200 productos, 30 mesas y 10 cuentas abiertas con consumo. Se hicieron 88 acciones por escenario, 176 por proyecto y **352 mediciones** en total.

- Clics en Inicio, Cuentas, Inventario, Movimientos, Ventas, Mesas, Usuarios y Marca, dos recorridos por escenario.
- Escritura carácter por carácter en Inventario, búsqueda de productos y Marca; filtro de cuentas.
- Apertura y cierre de cobro, cálculo de vueltas por cada tecla, apertura del desglose y del selector de consumo, flechas y Enter para seleccionar producto.
- Cierre del consumo desde `pointerdown`, que es el evento real usado por la aplicación para responder sin esperar al clic completo.
- Borrador de Marca después de un refresco, con y sin demora de red.
- Escenario sin demora artificial y escenario con **2.000 ms añadidos a cada respuesta remota simulada**. Los websockets se cerraron para ejercitar el respaldo existente mientras se usaba la interfaz. Se observaron peticiones demoradas en ambos proyectos.

No se confirmaron consumos, cobros ni impresiones en las páginas de esta medición. Las operaciones de escritura, idempotencia, rechazo y recuperación se verifican mediante las suites existentes con dobles de prueba. El cajón y la impresora físicos no se accionaron.

## Resultados locales

Tiempo en milisegundos desde el evento de entrada hasta el segundo `requestAnimationFrame` después de observar el estado esperado. Es una aproximación a la oportunidad de presentar el siguiente cuadro; no mide el tiempo de confirmación del servidor ni la latencia física de una pantalla. Los valores dependen del equipo, la carga y la cantidad de filas. P95: el 95% de las muestras quedó en ese tiempo o menos.

| Proyecto | Demora remota artificial | Acciones | Mediana ms | P95 ms | Máximo ms |
| --- | --- | ---: | ---: | ---: | ---: |
| OFFLINE | 0 ms | 88 | 36,2 | 62,9 | 173,4 |
| OFFLINE | 2000 ms | 88 | 28,8 | 43,6 | 174,7 |
| BCA | 0 ms | 88 | 30,0 | 56,5 | 280,3 |
| BCA | 2000 ms | 88 | 30,7 | 45,4 | 421,0 |

La mayoría de las interacciones locales respondió sin esperar los dos segundos de red. **No sería correcto afirmar que todas las acciones son instantáneas**: abrir Inventario con 200 productos fue la operación más lenta. Offline alcanzó 174,7 ms y BCA 421,0 ms en esta muestra. También hubo una muestra de vueltas de 115,1 ms en Offline. Se registran estos picos y se conserva el código, conforme a la instrucción expresa del propietario; no se intentó corregirlos ni atribuirlos a una causa sin perfilado adicional.

Detalle combinado de ambos escenarios de red:

| Proyecto | Interacción | Muestras | Mediana ms | P95 ms | Máximo ms |
| --- | --- | ---: | ---: | ---: | ---: |
| OFFLINE | Navegación | 32 | 42,5 | 174,2 | 174,7 |
| OFFLINE | Filtro inventario por tecla | 24 | 24,8 | 34,7 | 38,5 |
| OFFLINE | Filtro cuentas | 2 | 36,2 | 36,2 | 36,2 |
| OFFLINE | Abrir cobro | 10 | 37,7 | 40,1 | 40,1 |
| OFFLINE | Vueltas por tecla | 50 | 26,5 | 42,1 | 115,1 |
| OFFLINE | Cerrar cobro | 10 | 38,4 | 39,3 | 39,3 |
| OFFLINE | Abrir desglose | 2 | 52,4 | 52,4 | 52,4 |
| OFFLINE | Abrir consumo | 2 | 62,9 | 62,9 | 62,9 |
| OFFLINE | Filtro producto por tecla | 8 | 25,6 | 49,6 | 49,6 |
| OFFLINE | Selección con teclado | 2 | 26,9 | 26,9 | 26,9 |
| OFFLINE | Confirmar producto con Enter | 2 | 44,8 | 44,8 | 44,8 |
| OFFLINE | Cerrar consumo | 2 | 40,5 | 40,5 | 40,5 |
| OFFLINE | Marca por tecla | 30 | 26,3 | 28,4 | 29,8 |
| BCA | Navegación | 32 | 41,6 | 280,3 | 421,0 |
| BCA | Filtro inventario por tecla | 24 | 16,8 | 37,4 | 42,2 |
| BCA | Filtro cuentas | 2 | 44,3 | 44,3 | 44,3 |
| BCA | Abrir cobro | 10 | 37,8 | 47,6 | 47,6 |
| BCA | Vueltas por tecla | 50 | 25,5 | 43,6 | 45,4 |
| BCA | Cerrar cobro | 10 | 37,3 | 38,6 | 38,6 |
| BCA | Abrir desglose | 2 | 38,1 | 38,1 | 38,1 |
| BCA | Abrir consumo | 2 | 67,9 | 67,9 | 67,9 |
| BCA | Filtro producto por tecla | 8 | 26,3 | 43,0 | 43,0 |
| BCA | Selección con teclado | 2 | 26,6 | 26,6 | 26,6 |
| BCA | Confirmar producto con Enter | 2 | 42,9 | 42,9 | 42,9 |
| BCA | Cerrar consumo | 2 | 40,5 | 40,5 | 40,5 |
| BCA | Marca por tecla | 30 | 25,5 | 29,3 | 30,0 |

Los filtros mostraron el resultado esperado, las vueltas coincidieron con el importe escrito y el borrador conservó exactamente el texto ingresado tras el refresco. No se detectaron errores JavaScript de página durante el recorrido final. Estos resultados no acreditan idéntica latencia en todos los dispositivos ni bajo cualquier carga.

## Pruebas funcionales existentes

Se ejecutaron de nuevo las suites completas sobre el código publicado: **Offline 236/236 y BCA 206/206**, sin fallos, cancelaciones ni pruebas omitidas.

Incluyen recepción entre dispositivos, solicitudes y chat, respaldo al caer Realtime, recuperación de conexión, durabilidad de ventas y colas, confirmaciones online, idempotencia, inventario, cambios optimistas, edición de ingresos antes de terminar la red y protección de borradores. No se añadieron ni modificaron esas pruebas.

La confirmación de un guardado remoto conserva su espera y sus controles de seguridad. La prueba existente de consumos conserva además el parpadeo verde de 2,2 segundos después de confirmar; no se retiró ni se presentó como un fallo. Respuesta visual, confirmación del backend y cierre posterior de un modal son tiempos diferentes.

## Integridad y publicación

Puntos de partida: Offline 18337c180c889a678b9528d8d7357e4165cb57ab; BCA 4d374229c7ceb26c319ab0d86864c81dd30d2c4a. Se comprobaron los archivos contra las copias de publicación y se volvieron a verificar sus hashes al terminar. No hubo modificaciones de datos, SQL, políticas, Code.gs, credenciales, cachés de ejecución, lógica de negocio ni recursos del producto.

Hashes de referencia, idénticos antes y después:

| Proyecto | Archivo | SHA256 |
| --- | --- | --- |
| OFFLINE | app.js | `8a772e5c796940fd0ee7446bca1fc6da9c88242da69d0f76aa9d355e44b7f047` |
| OFFLINE | menu-cards.js | `223132c0bcd3709ee010bc9451e953f66959030d147962cdf76ab02cf0bcd4d3` |
| OFFLINE | style.css | `4da5ee27886375f19452cd5885ce3956e403b05620d88f665ed09c131c8575d9` |
| OFFLINE | service-worker.js | `72341a76f1035289346104e067838de75b01294b12109346162bd514d863471f` |
| OFFLINE | appscript/Code.gs | `067f45379948443255f81b3df28859af357606e5606c11a5a431a478df3958d8` |
| OFFLINE | supabase/migrations/20261019190000_pos_menu_cards.sql | `8cf995ce73811044ba4f78c59cb3b797857202ecaf801c3135970b7fa0a1cd61` |
| BCA | app.js | `eec45f1af69e754647483ba9ef5d6f4e33067f384b3dbcf882df898901e6a91c` |
| BCA | menu-cards.js | `223132c0bcd3709ee010bc9451e953f66959030d147962cdf76ab02cf0bcd4d3` |
| BCA | style.css | `0da2790f2855d5d3096beb7e0d497e10d2485b8c2f02bbd4fcf122c9d17850b7` |
| BCA | service-worker.js | `3ba32303a2b33f71767f37ff7fe88efe44b30dfe5eac1882c59303b09a196fc5` |
| BCA | appscript/Code.gs | `067f45379948443255f81b3df28859af357606e5606c11a5a431a478df3958d8` |
| BCA | supabase/migrations/20261019190000_pos_menu_cards.sql | `8cf995ce73811044ba4f78c59cb3b797857202ecaf801c3135970b7fa0a1cd61` |

Se publica exclusivamente VERIFICACION-RESPUESTA-2026-10-19.md en main de ambos repositorios. No se genera otra versión del instalador porque los archivos de la aplicación siguen siendo exactamente los ya incluidos en 1.0.24. Para revertir esta entrega bastaría revertir el commit documental; no afecta a ninguna operación de la aplicación.
