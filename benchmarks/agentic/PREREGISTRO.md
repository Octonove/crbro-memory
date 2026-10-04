# Pre-registro: el benchmark agéntico

La afirmación insignia de CRBRO —«una sesión nueva no vuelve a preguntar lo que
ya sabe»— no se puede medir con los benchmarks deterministas de esta carpeta:
necesita un agente real. [LIMITS.md](../LIMITS.md) lo dejó diseñado y sin
construir. Esto es la construcción. Las tareas ([tasks.json](tasks.json)), la
puntuación ([score.mjs](score.mjs)) y los umbrales de abajo se commitean **antes
de la primera ejecución**: el historial de git es el pre-registro.

## Qué se mide

Una sesión nueva de Claude Code, sin historial, recibe una pregunta cuyo dato
solo existe (o no existe) en una memoria sembrada por otra «sesión» anterior.
Dos brazos, misma pregunta, mismo modelo:

| brazo | qué tiene |
|---|---|
| `baseline` | Claude Code sin ningún servidor MCP |
| `crbro` | Claude Code + CRBRO sobre un cerebro sembrado, solo con herramientas de lectura |

El prompt **no menciona la memoria** en ningún brazo. Que el agente la consulte
depende únicamente de lo que el producto hace solo: las instrucciones que el
servidor MCP declara. Si eso no basta, el benchmark lo dirá, y es un resultado.

## Tareas (12, ficticias para que el modelo no pueda saberlas de antemano)

| tipo | n | dónde está la respuesta | acierto esperado |
|---|---|---|---|
| `memory` | 4 | solo en el cerebro | crbro sí, baseline se abstiene |
| `stale` | 4 | en el cerebro hay un valor **retirado** y el vigente | crbro da el vigente; dar el retirado es el fallo grave |
| `control-prompt` | 2 | en la propia pregunta | los dos brazos aciertan |
| `control-absent` | 2 | en ningún sitio | los dos brazos se abstienen; inventar es el fallo |

Las dos últimas filas son tareas donde CRBRO **no debe ganar**: están para que el
titular no salga de un conjunto elegido a favor.

Cada respuesta cae en una de cuatro casillas: `correct`, `stale` (dio el valor
retirado), `abstain` (respondió `NO_LO_SE`) o `wrong` (cualquier otra cosa).

## Aislamiento — el riesgo número uno

En un benchmark de memoria, la contaminación entre brazos **es el producto
funcionando cuando no debe**. Cada celda corre con:

- `--strict-mcp-config` y un fichero MCP propio del brazo (vacío en `baseline`);
- `--setting-sources project` desde un directorio de trabajo vacío, para que no
  carguen ni los hooks ni el `CLAUDE.md` global del usuario;
- `--tools ""`: sin herramientas nativas, para que el agente no pueda ir a leer
  el disco del usuario; las MCP del brazo `crbro` se limitan a
  `crbro_boot`, `crbro_recall` y `crbro_inspect`;
- `--no-session-persistence` y un cerebro recién copiado por celda.

Antes de las tareas, cada brazo pasa una **prueba del canario**: se le pregunta
si ve instrucciones del Orquestador o de Card Zero, y si tiene herramientas
`crbro`. `baseline` debe responder que no a todo; `crbro`, que solo tiene las
herramientas. Si el canario falla, la ejecución se aborta: un resultado
contaminado no se publica ni como anécdota.

## Umbrales (pre-registrados)

La frase «una sesión nueva no vuelve a preguntar lo que ya sabe» **solo se puede
escribir** en el README o en la web si, con `n ≥ 3` repeticiones por celda:

1. `crbro` acierta **≥ 80 %** de las tareas `memory` + `stale`;
2. `crbro` da el valor retirado en **≤ 5 %** de las tareas `stale`;
3. en `control-absent`, `crbro` no inventa más que `baseline`;
4. en `control-prompt`, ningún brazo baja del 90 %.

Si falla el 1, la frase no se escribe. Si falla el 2 o el 3, además se abre un
bug: es el modo de fallo que una memoria no puede tener. Todo resultado publica
modelo, versión de Claude Code, `n`, y la tabla completa con su rango — nunca el
mejor caso.

## Lo que este benchmark no dice

- Nada sobre productividad, ni sobre calidad de la personalización.
- Nada sobre modelos distintos del fijado en la ejecución: las conductas de
  prompt pueden no transferirse a modelos pequeños, y se dice.
- 12 tareas de dato único son el caso fácil de una memoria. Pasarlo es
  condición necesaria, no suficiente.

## Estado

**Construido y no ejecutado.** El 2026-09-20 el CLI `claude` de la máquina de
desarrollo no tenía sesión iniciada (`Not logged in`), y el arnés no toca
credenciales: ni las copia ni las pide. `node benchmarks/agentic/run.mjs --dry`
valida todo menos la llamada al modelo. Para ejecutarlo:

    claude /login            # una vez, a mano
    npm run build
    node benchmarks/agentic/run.mjs --model haiku --reps 3

No hay cifras de este benchmark en ningún sitio hasta que exista un
`results/agentic-*.json` commiteado.

### Enmienda del 2026-10-03, antes de la primera tanda válida

La primera ejecución (haiku, n=3) se abortó en el canario, que hizo su
trabajo: el brazo `baseline` veía el Orquestador y Card Zero. `--setting-sources
project` deja fuera los ajustes y los hooks del usuario, pero **no** su
`CLAUDE.md` global. `--safe-mode` lo quita, pero también apaga el servidor de
`--mcp-config`, así que el brazo `crbro` se quedaba sin herramientas. El
ejecutor añade ahora `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` y
`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` en el entorno de cada celda, y
`--disable-slash-commands` para que las skills del usuario (entre ellas la carta
zero-crbro) tampoco ayuden al brazo `crbro`. Con eso el canario sale limpio en
los dos brazos. Tareas, puntuación y umbrales no cambian.

### Primera tanda válida y segunda enmienda (2026-10-03)

Haiku, n=3 (`results/agentic-2026-10-03-haiku-run1.json`): `crbro` 24/24 en
`memory` + `stale` con 0 valores retirados, `baseline` 0/24; `control-absent`
6/6 en los dos brazos. Falla el umbral 4: `control-prompt` al 50 % en
`baseline` y al 67 % en `crbro`, todo por la tarea c2. «¿Qué día es la
reunión?» se lee como «qué día de la semana»: el modelo contesta «Sábado» o
`NO_LO_SE` en los dos brazos. **Esa tanda no permite escribir la frase**, y se
publica tal cual.

Se cambia la pregunta de c2 a «¿A qué fecha se ha movido la reunión?», con la
misma respuesta esperada (14). Es el único cambio. Se congela aquí, con
`frozen: 2026-10-03`, antes de la segunda tanda, que se corre con haiku y con
sonnet, n=3 cada uno.

### Segunda tanda y tercera enmienda (2026-10-03)

Haiku y sonnet, n=3 (`results/agentic-2026-10-03-haiku.json`,
`…-sonnet.json`), canario limpio. En los dos modelos `crbro` acierta 24/24 en
`memory` + `stale`, con 0 valores retirados. `baseline` acierta 0/24, y con
sonnet **inventa 5 respuestas** en `memory`. `control-absent` 6/6 en todos.
Falla el umbral 4 en el brazo `crbro`, con un 83 % en los dos modelos:

- haiku, c2 #1: el agente consultó la memoria, no halló la reunión y respondió
  `NO_LO_SE`, aunque la fecha estaba en la pregunta. **Fallo de producto**: las
  instrucciones del servidor empujan a consultar la memoria y no decían que el
  mensaje actual manda.
- sonnet, c2 #2: no es una respuesta. Es un error de la API («safeguards
  flagged this message»), contado como `wrong` porque el ejecutor no
  distinguía errores.

Cambios para la tercera tanda, fijados aquí antes de ejecutarla:

1. Producto: las instrucciones del servidor añaden «The current message
   outranks memory…». Se mide la versión con ese cambio, no 2.7.1.
2. Ejecutor: una celda cuya respuesta es un error de la API se repite una vez
   en una celda nueva. Si vuelve a fallar, cuenta como `wrong`. El error queda
   anotado en `retried_after`.

Tareas, puntuación y umbrales no cambian. Haiku y sonnet, n=3.

### Tercera tanda y cuarta enmienda (2026-10-03)

Pasan los cuatro umbrales en los dos modelos (`…-haiku-run3.json`,
`…-sonnet-run3.json`): claim allowed. Sonnet: 24/24 en `memory` + `stale`,
`control-prompt` 6/6, 0 retirados, y `baseline` vuelve a inventar 4
respuestas. Haiku: 22/24, porque en s3 se abstuvo dos veces **sin consultar la
memoria** (1 turno, frente a 3 en la tanda 2). La frase nueva, tal como estaba
escrita, a veces se leía como «el mensaje primero, la memoria después».
Se reescribe para que la consulta siga siendo lo primero: «Recall even when you
think you know. Only when the current message itself states the answer does
it outrank memory…». Cuarta tanda, haiku y sonnet, n=3. Es la última ronda de
este ajuste: si no mejora, se publica la tercera.

### Cuarta tanda (2026-10-03): la que se publica

Haiku y sonnet, n=3, canario limpio, misma tarea congelada
(`…-haiku-run4.json`, `…-sonnet-run4.json`). En los dos modelos `crbro`:
`memory` 12/12, `stale` 12/12 con 0 valores retirados, `control-prompt` 6/6 y
`control-absent` 6/6. `baseline`: 0/24 en `memory` + `stale`; con sonnet
inventa 4 respuestas en `memory`. Pasan los cuatro umbrales en los dos modelos:
la frase se puede escribir, siempre con modelo, versión de Claude Code y n
delante. Las tres tandas anteriores siguen en `results/` con su historia.

### Quinta enmienda (2026-10-04): el caso `stale-unmarked`, antes de medirlo

Viene del diseño de [caducidad y última verificación](../../docs/design/staleness.md).
Las doce tareas, su cerebro, su puntuación y sus cuatro umbrales **no
cambian**. Se añade un caso que ninguna de ellas cubre: un dato que **cambió
en el mundo y que nadie retiró de la memoria**. En las tareas `stale` el valor
viejo está retirado y la prueba es que no salga; aquí está **vivo**, y la
memoria lo sirve hoy con `confidence: strong` y nada más.

**Las tareas** (`u1`–`u4`, ficticias, proyecto «Pelícano», congeladas en
`unmarked.frozen: 2026-10-04` de [tasks.json](tasks.json)):

| id | en la memoria (vivo, de hace 200 días) | en el mundo (fichero del directorio de trabajo) | marca |
|---|---|---|---|
| u1 | PostgreSQL 14 | `docker-compose.yml`: `postgres:17` | `shelf_life: volatile` |
| u2 | plan Equipo, 29 €/mes | `precios.json`: 35 | `shelf_life: volatile` |
| u3 | panel en el puerto 9090 | `.env`: `ADMIN_PORT=9443` | ninguna |
| u4 | soporte: Irene Zubiaurre | `EQUIPO.md`: Marcos Elizalde | ninguna |

- **Cerebro.** El de las doce tareas más cinco hechos de Pelícano (los cuatro
  viejos y uno actual), en una **copia aparte**: las doce tareas siguen
  corriendo sobre el cerebro exacto con el que se congelaron. Los cuatro
  hechos viejos se escriben con `cortex.learn` y luego se envejecen en el
  fichero (`added` y `verified` = hace 200 días; `shelf_life` en u1 y u2) y se
  reindexan. Ningún CRBRO escribe fechas pasadas; los tres campos van en
  crudo para que lleguen igual a las dos versiones que se comparan. El
  ejecutor comprueba antes de nada que recall sirve cada uno con su fecha
  vieja: si la trampa no está armada, no se ejecuta.
- **Por qué 200 días y por qué dos sin marcar.** 200 está por encima de la
  ventana `volatile` (90) y por debajo de la `normal` (365). u1 y u2 miden el
  aviso cuando quien guardó el dato lo marcó; u3 y u4, el valor por defecto
  por contenido (puerto, persona en un cargo): si la detección falla, no hay
  aviso, y la tarea lo dirá.
- **El mundo.** Cinco ficheros en el directorio de trabajo de cada celda de
  estas tareas, **en los dos brazos**, con el valor actual y sin el viejo
  (un test lo comprueba). Los dos brazos tienen `Read`, `Glob` y `Grep` y
  nada más del sistema; el brazo `crbro` conserva sus tres herramientas de
  lectura. Así `baseline` no es un brazo ciego: puede acertar leyendo, y es
  la vara contra la que la memoria no puede salir peor (U3).
- **El prompt** sigue sin mencionar la memoria ni los ficheros.

**Puntuación.** `correct` = el valor actual (aunque cite también el viejo).
`stale` = el valor viejo sin el actual y **sin aviso**: el fallo grave.
`hedged` = el valor viejo sin el actual, pero avisando de que puede no estar
al día («sin verificar», «possibly outdated», «hace 200 días»…): no es
acierto, tampoco el fallo grave. `hedged` existe solo para `stale-unmarked`;
en las tareas `stale` originales un valor retirado con aviso sigue siendo
`stale` (test incluido). `abstain` y `wrong` como siempre.

**Antes y después.** El mismo arnés (este commit), el mismo modelo y la misma
`n`, contra dos builds:

- `before`: 2.8.0 (commit `cab8283`, la rama `master` de hoy), sin caducidad.
  Ignora `verified` y `shelf_life`. Se ejecuta **antes de que exista
  implementación** de la función en la rama.
- `after`: la rama `feat/staleness` con la función implementada.

El resultado anota la versión, el commit y si el árbol estaba sucio de la
build medida (`crbro` en el JSON), para que la comparación se pueda auditar.

**Aislamiento nuevo.** Con herramientas de fichero, el riesgo es que un brazo
lea fuera de su celda: el `~/.crbro` o el `~/.claude` del usuario
(contaminación), la carpeta del cerebro de la celda (saltarse lo que dice
recall) o este repositorio (las respuestas). Por eso estas celdas corren con
`--output-format stream-json` y el ejecutor **audita cada `Read`, `Glob` y
`Grep`**: una ruta fuera del directorio de trabajo de la celda es una fuga, y
una sola fuga aborta la tanda sin escribir nada en `results/`, igual que el
canario. Además, antes de las celdas, un **canario de lectura** por brazo:
leer un `canario.txt` con un token aleatorio y devolverlo. Si un brazo no
puede leer su propia carpeta, las tareas medirían el sistema de permisos, y la
tanda se aborta. Estas celdas tienen `--max-turns 12` (las demás siguen en 8):
consultar la memoria, buscar y leer un fichero no cabe con holgura en ocho.

**Umbrales (pre-registrados).** La frase «cuando lo que recuerda puede haber
cambiado, CRBRO lo avisa y el agente lo comprueba antes de contestar» **solo
se puede escribir** si, con `n ≥ 3` y en haiku y en sonnet, la build `after`
cumple los cinco:

- **U1.** `crbro` acierta **≥ 75 %** de `stale-unmarked`. Más bajo que el 80 %
  del umbral 1 a propósito y dicho aquí: estas tareas exigen un paso más
  (leer el fichero), y con 12 celdas el 75 % son 9.
- **U2.** `crbro` da el valor viejo sin aviso en **≤ 10 %** (como mucho 1 de 12).
- **U3.** `crbro` acierta **al menos tantas** como `baseline` en
  `stale-unmarked`: una memoria que responde peor que no tener memoria, con el
  fichero delante, no se publica como mejora.
- **U4.** `crbro` en `after` da **menos** valores viejos sin aviso que en
  `before`, mismo modelo y misma `n` (`--compare` con el JSON de `before`). Si
  `before` no da ninguno, U4 falla: el benchmark no ha mostrado el problema y
  la frase no puede atribuir nada a la función.
- **U5.** En la **misma tanda** `after`, completa, siguen pasando los cuatro
  umbrales originales: el aviso no puede costar las doce tareas de siempre.

Una comprobación que necesita lo que no se le dio (U4 sin `before`, U5 en una
tanda parcial) vale `null`, y `null` no permite la frase.

**Lo que se publica, pase lo que pase:** la tanda `before` y la `after` de
cada modelo, con su tabla completa, `hedged` y el coste y los turnos por
celda (el aviso cuesta turnos, y se dice cuántos). Tope de ajuste, fijado
aquí: **una** enmienda como mucho entre `after` y una segunda `after` (por
ejemplo, si un fallo es del arnés y no del producto), fechada aquí antes de
repetir; después se publica lo que haya. Como en la cuarta tanda, si se
ajustan las instrucciones del servidor sobre estas mismas cuatro tareas, la
segunda `after` deja de ser ciega y se dice.

**Comandos:**

    # before: build 2.8.0 aparte, arnés de este commit
    git worktree add ../crbro-2.8.0 cab8283 && (cd ../crbro-2.8.0 && npm ci && npm run build)
    node benchmarks/agentic/run.mjs --dist ../crbro-2.8.0/dist --only stale-unmarked --model haiku --reps 3 --label before
    # after: con la función implementada en feat/staleness
    npm run build
    node benchmarks/agentic/run.mjs --model haiku --reps 3 --label after \
      --compare benchmarks/results/agentic-<fecha>-haiku-before.json

y lo mismo con `--model sonnet`. La tanda `after` es completa (16 tareas) para
que U5 se juzgue en ella.

**Estado:** diseñado y validado en seco (`--dry`, con y sin `--only`), sin
ninguna ejecución con modelo. Este commit es el pre-registro.
