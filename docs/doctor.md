# Diagnóstico local con doctor

`crbro-memory doctor` muestra evidencias locales. `crbro-memory doctor --json`
devuelve un único objeto JSON en stdout, sin banner. No inicializa el cerebro,
no ejecuta `boot`, no arranca daemons, no instala runtimes, no descarga modelos,
no lee el llavero y no envía cambios a equipos. No repara archivos.

El código de salida es 0 para información, advertencias y datos desconocidos.
Es 1 si se detecta JSON inválido o ilegible en el cerebro, o no puede ejecutarse
el diagnóstico. Un archivo corrupto nunca se presenta como sano ni se reemplaza.

## Qué significa cada evidencia

- `versions.installed`: versión del paquete que ejecuta el comando. Las versiones
  de daemons sólo se confirman mediante el intercambio local autenticado
  `controlDaemon(..., 'status')`. Un estado en disco sin respuesta deja la versión
  en `null` y el estado en `unknown`. No descubre procesos MCP independientes.
- `brain`: ruta resuelta y validación sintáctica de `manifest.json` y los JSON
  directos de cortex, synapses, hippocampus y prefrontal. No es una validación
  exhaustiva de esquemas. `last_boot` es una observación agregada del manifiesto:
  no identifica al cliente ni prueba que se ejecute automáticamente al abrir chats.
- `configs`: rutas conocidas de Claude Desktop, Claude Code, Cursor y Codex;
  también archivos de proyecto en el directorio actual. Sólo devuelve rutas y
  estados de registro/habilitación; no devuelve comandos, argumentos, cabeceras,
  tokens ni valores de otras variables. Reconoce registros cuyo nombre contiene
  `crbro`. Compara la ruta seleccionada por la CLI con las rutas `CRBRO_PATH`
  explícitas de los clientes; un entorno heredado o un launcher
  externo queda desconocido. En Codex interpreta las tablas MCP y `env` habituales;
  tablas inline o sintaxis que no interpreta se señalan como `unknown`.
- `semantic`: configuración y presencia de runtime/caché del modelo; comprueba
  metadatos y tamaño del archivo de vectores. No carga el modelo ni hace inferencia.
  `operation: not_probed` sigue siendo cierto aunque todos los archivos existan.
- `backups`: copia más reciente según los nombres y metadatos del directorio de
  backups. No descomprime ni prueba restauraciones: `integrity: not_probed`.
- `teams`: fecha del último commit y ahead/behind respecto a las referencias
  locales de upstream. **No inspecciona el árbol de trabajo**: `dirty: null` y
  `worktree_state: not_probed` (en texto, `dirty=unknown`). No ejecuta `git status`,
  porque puede invocar filtros `clean`/`process` definidos en la configuración Git
  y `.gitattributes`, incluso con fsmonitor desactivado. No afirma que el árbol
  esté limpio aunque ahead/behind sean cero. Las consultas de historia desactivan
  parches, verificadores de firmas, diff externo y textconv; también se desactivan
  escrituras opcionales del índice, fsmonitor y descargas Git perezosas. Nunca
  hace fetch, push o muestra URLs de remotos. Sin upstream, ahead/behind son
  desconocidos, no cero. Las referencias pueden estar desactualizadas:
  `remote_state: not_fetched`.

Un valor `unknown`, `null` o `not_probed` expresa falta de evidencia. Ni el registro
de un servidor MCP ni la presencia de archivos demuestran una integración operativa.
El comando lee archivos sin actualizarlos; el sistema operativo puede actualizar
tiempos de acceso y un daemon existente puede observar la conexión de diagnóstico.

## Prueba manual entre dos conversaciones

Esta prueba escribe deliberadamente una entrada ficticia; doctor no la ejecuta.
El usuario debe elegir la neurona de prueba y autorizar esa escritura.

1. En una conversación nueva A, ejecuta `crbro_boot` y comprueba la ruta del cerebro.
   Guarda en la neurona elegida una frase inequívoca, por ejemplo
   «Prueba temporal doctor: el faro ficticio tiene color malva-4187».
   Conserva el ID de entrada devuelto.
2. Abre una conversación B independiente en el cliente que quieras comprobar.
   Observa si aparece realmente `crbro_boot`; no lo deduzcas de una instrucción de
   configuración. Consulta «faro ficticio malva-4187» y comprueba la entrada y ruta.
3. Retira sólo la entrada de prueba por su ID con `crbro_forget`, en la neurona
   elegida, y vuelve a consultar para comprobar su retirada. El olvido puede dejar
   una copia recuperable en cuarentena según la política de CRBRO.

El scope de proyecto organiza la recuperación; no es una ACL ni una frontera de
autorización. No uses secretos en esta prueba. `crbro_secret` puede devolver el
valor de una credencial: si lo lee un LLM mediante MCP, ese valor puede salir de la
máquina hacia el proveedor del modelo. Que el llavero esté cifrado localmente no
evita ese envío. Doctor nunca solicita ese valor.

## API

`diagnose({ env?, homeDir?, brainDir?, cwd? }): Promise<DoctorReport>` acepta un
entorno explícito para pruebas y diagnósticos aislados; no lo fusiona con el entorno
del proceso. `formatDoctor(report)` produce la vista humana. El esquema JSON 1
contiene `read_only`, `status`, `versions`, `brain`, `configs`, `semantic`, `backups`
y `teams`. Los textos de excepciones y el contenido de archivos no forman parte
del informe.
