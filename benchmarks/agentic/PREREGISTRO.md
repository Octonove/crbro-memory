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

#### Nota fechada (2026-10-04), antes de la primera tanda `after`

No cambia ninguna tarea, ninguna puntuación ni ningún umbral. Deja por escrito
tres cosas que no salieron como decía el texto de arriba y cómo se va a medir
`after`, antes de medirlo.

**1. El orden.** Arriba dice que `before` se ejecuta «antes de que exista
implementación» en la rama. No fue así: la implementación (`6e247d3`) se
commiteó antes de que corriera ninguna tanda `before`. Por qué no contamina el
`before`: se ejecutó con la build 2.8.0 en un clon aparte (`cab8283`,
`dirty: false` en el JSON) y con el arnés de este pre-registro en otro clon
(`1a023a7`, sin modificar). `git diff 1a023a7..b68600b -- benchmarks/agentic`
sale vacío: el arnés, las tareas y la puntuación que mide `after` son los
mismos bytes. Los resultados están en
`results/agentic-2026-10-04-haiku-before.json` y `…-sonnet-before.json`
(haiku: `crbro` 0/12 aciertos y 11/12 valores viejos sin aviso; sonnet: 0/12 y
12/12; `baseline` 3/12 y 6/12, nunca el valor viejo). Con eso U4 es medible:
`after` tiene que dar menos de 11 en haiku y menos de 12 en sonnet.

**2. Una variable de entorno.** El `before` se lanzó con `CRBRO_MOD=0` en el
entorno del ejecutor, que el CLI hereda al servidor MCP de cada celda: el
`crbro_boot` de la 2.8.0 instala el mod de Claude Code en el `~/.claude` real
del usuario, y eso estaba prohibido. Solo suprime esa instalación y su aviso
en boot; no toca recall. `after` se lanza igual, por paridad.

**3. Cambios de producto tras la revisión, antes de `after`** (commit
`b68600b`, sin ninguna ejecución con modelo de por medio). Dos revisiones del
código encontraron fallos y se corrigieron: verificaciones con fecha futura,
gracia escalonada para cerebros antiguos, el re-learn que añade keywords ya no
cuenta como verificación, un aviso en espacios de equipo, ids de hechos
antiguos, el sello del manifiesto y la huella del daemon. Uno toca lo que el
agente ve en estas cuatro tareas, y por eso se dice aquí: cuando la fila mejor
clasificada pasa a `possibly_stale`, cada fila lleva su `rank` y el `hint`
empieza por «The best match (rank 1) moved to possibly_stale; results holds
lower-ranked rows that may be about something else». Salió de una revisión que
reprodujo la salida de recall de u2 y u3 sobre el cerebro sembrado (en u2,
`results[0]` era el precio de otro producto). Nadie ha visto todavía una
respuesta de un modelo con esta build, así que la primera `after` sigue siendo
ciega en ese sentido; pero el texto del servidor se ajustó mirando estas
tareas, y se dice.

**Cómo se mide `after`.** Con la build de la rama tal como queda en el commit
de esta nota (`dirty: false`), por cada modelo (haiku y sonnet, `n = 3`), dos
tandas, sin cambiar nada del producto entre ellas:

- primero `--only stale-unmarked --label after-unmarked --compare <before>`:
  el mismo conjunto de tareas que `before`, comparación directa;
- después la tanda completa de 16 tareas, `--label after --compare <before>`,
  como estaba pre-registrado. Es la que juzga U1–U5.

Como son dos muestras de la misma build, la frase solo se escribe si **las
dos** cumplen U1–U4 y la completa cumple además U5: más exigente que lo
pre-registrado, no menos. Se publican las dos pase lo que pase. El tope de
una enmienda sigue sin usarse.

`--compare` solo comprueba el modelo. Se comprueba a mano y se deja escrito
con los resultados: el JSON de `before` tiene `crbro.commit` `cab8283…`,
`label: before`, `only: ["stale-unmarked"]`, el mismo modelo, `n = 3` y
Claude Code 2.1.270.

**Límites que se dirán con cualquier resultado** (detalle en
[staleness.md §13](../../docs/design/staleness.md)): U5 no puede ver una
inundación de avisos, porque los doce hechos originales se siembran con fecha
de hoy y ninguna tarea tiene un dato viejo que siga siendo cierto; u3 y u4
coinciden con los ejemplos de la tabla del detector, así que miden si
reconoce sus propios ejemplos, no si generaliza; y en `after` el `hint` pide
`crbro_revise` o `crbro_learn`, que en estas celdas se deniegan: se cuentan a
partir de `tool_calls`. Para la próxima enmienda, pre-registrada antes de
medirla: controles de dato viejo pero cierto, una consulta mixta con una fila
vieja ajena y tareas sin marca redactadas por otra persona.

#### Tandas `after` (2026-10-04): no se cumple

Build `ad7675f` (`dirty: false`), `CRBRO_MOD=0` como en `before`, Claude Code
2.1.270, n=3. Las cuatro tandas `after` corrieron con canarios y canarios de
lectura limpios, sin fugas ni errores de API, y sin tocar el producto entre
ellas. `--compare` comprobado a mano: los dos `before` son `cab8283`,
`label: before`, `only: ["stale-unmarked"]`, mismo modelo, `n = 3`.

| `crbro` en `stale-unmarked` (12 celdas) | haiku before | haiku after (solo u) | haiku after (completa) | sonnet before | sonnet after (solo u) | sonnet after (completa) |
|---|--:|--:|--:|--:|--:|--:|
| acierta (valor actual) | 0 | 0 | 0 | 0 | 0 | 0 |
| valor viejo **sin aviso** | 11 | 9 | 10 | 12 | 11 | 12 |
| valor viejo con aviso (`hedged`) | 0 | 0 | 0 | 0 | 1 | 0 |
| se abstiene | 1 | 3 | 2 | 0 | 0 | 0 |
| celdas que abrieron un fichero | 1 | 0 | 0 | 0 | 0 | 0 |
| `baseline` acierta (la vara de U3) | 3 | 1 | 4 | 6 | 6 | 4 |
| coste medio por celda `crbro` (USD) | 0,0121 | 0,0149 | 0,0151 | 0,0263 | 0,0270 | 0,0274 |
| turnos medios por celda `crbro` | 3,1 | 3,0 | 3,0 | 3,6 | 3,1 | 3,1 |

| umbral | haiku solo u | haiku completa | sonnet solo u | sonnet completa |
|---|---|---|---|---|
| U1 ≥ 75 % | 0 % ✗ | 0 % ✗ | 0 % ✗ | 0 % ✗ |
| U2 ≤ 10 % | 75 % ✗ | 83,3 % ✗ | 91,7 % ✗ | 100 % ✗ |
| U3 crbro ≥ baseline | 0 vs 1 ✗ | 0 vs 4 ✗ | 0 vs 6 ✗ | 0 vs 4 ✗ |
| U4 menos que before | 9 < 11 ✓ | 10 < 11 ✓ | 11 < 12 ✓ | 12 = 12 ✗ |
| U5 originales | — (null) | 4/4 ✓ | — (null) | 4/4 ✓ |

`claim_allowed: false` en todas. La frase **no se escribe**. U4 en verde en
tres de cuatro no cambia nada: con 12 celdas, una o dos de diferencia caben en
el ruido, y en las tres el valor viejo sigue siendo la respuesta mayoritaria.

Por qué falla, según las celdas: recall marca bien las cuatro filas (probado
sin modelo sobre el mismo cerebro: las cuatro en `possibly_stale`, 200 días,
con el `hint`), pero ningún agente con CRBRO abrió un fichero en las 48 celdas
`after`. Todos se quedaron en `crbro_boot` + `crbro_recall` y contestaron con
lo que había, se abstuvieron, o una vez (sonnet, u4) dieron el valor viejo
avisando. Ninguno intentó `crbro_revise` ni `crbro_learn`, así que el coste
extra no son escrituras denegadas. El aviso llega; no cambia lo que hace el
agente en estas tareas. La tanda corta y la completa dicen lo mismo, así que
no hay muestra que elegir.

No se ha gastado la enmienda permitida: el fallo es del producto, no del
arnés, y una segunda `after` con otro texto del servidor sobre estas mismas
tareas dejaría de ser ciega. Lo que se pruebe a partir de aquí irá en una
enmienda nueva, fechada antes de medirla.

### Sexta enmienda (2026-10-04): un segundo caso `stale-unmarked`, antes de medirlo

La quinta no se cumplió. Decisión del mantenedor: **una iteración más** sobre
el producto, y después se publica la 2.9.0 con lo que salga, contado tal cual.
Las tareas u1–u4 **no se reutilizan para juzgarla**: ya se han visto sus
respuestas y el texto del servidor se ajustó mirándolas, así que no serían a
ciegas. Siguen en `tasks.json`, sin tocar, y se pueden seguir corriendo, pero
no deciden nada de esta enmienda. Se escribe un caso nuevo, con otro proyecto
y otro dominio.

**Quién escribe las tareas y qué sabía.** Las redactó un agente distinto del
que cambia el producto, con el encargo de escribirlas como alguien que no
conoce el detector: no leyó `src/engine/shelf.ts` ni la §3 de
[staleness.md](../../docs/design/staleness.md) (las reglas por contenido). Sí
leyó, y se dice porque puede sesgar: la descripción de `crbro_learn` (la misma
que ve cualquier agente, con su lista «volatile = versions, prices, ports,
hosts, paths, config, who holds a role»), la quinta enmienda entera (ventanas
de 90 y 365 días) y la §13 de staleness.md, que incluye una lista de reglas
del detector ampliadas (un puerto hasta 20 caracteres después de la palabra,
`config` con «máximo», «umbral» y parecidos cerca de un número). Ninguna tarea
de abajo se eligió ni se descartó por esas reglas; tampoco se comprobó qué
hace el detector con ellas.

**El proyecto.** «Tramuntana», la app de reservas de una escuela de vela
(dominio `apps`, nada de facturación ni de web). Hechos escritos como los
guardaría un agente real: unos dicen de dónde salió el dato y otros no; unos
llevan el `shelf_life` que pondría un agente que sigue la descripción de
`crbro_learn` y otros no llevan ninguno. Edades distintas, todas entre 90 y
365 días (como en la quinta: más que la ventana `volatile`, menos que la
`normal`).

**Las tareas que juzgan (`stale-unmarked-b`, w1–w6, con el mismo sufijo de
siempre):**

| id | en la memoria (vivo) | edad | dice de dónde salió | marca | en el mundo |
|---|---|--:|---|---|---|
| w1 | SMS de confirmación por Twilio | 230 | sí (`config/notificaciones.yml`) | ninguna | `config/notificaciones.yml`: `messagebird` |
| w2 | curso de iniciación: 240 € | 160 | no | `volatile` | `tarifas.csv`: 265 |
| w3 | cambios fuera de plazo los autoriza Olatz Iturbe | 270 | no | ninguna | `docs/recepcion.md`: Jon Ander Sarasola |
| w4 | API de producción en `api.tramuntana.cat` | 300 | sí (lo dijo Antonio) | `volatile` | `.env.production`: `reservas.tramuntana.cat` |
| w5 | salidas de la mañana a las 10:00 | 130 | no | ninguna | `horarios.json`: `09:30` |
| w6 | cancelación gratis hasta 48 h antes | 200 | sí (condiciones de la web) | `normal` | `CONDICIONES.md`: 24 horas |

w6 lleva `normal` porque es lo que la descripción de `crbro_learn` pide para
una política de cancelación («normal otherwise»). Con 200 días queda dentro de
la ventana `normal` que fija la quinta enmienda, así que un aviso por edad
según esa clase no la cubre. Se deja así porque es como la marcaría un agente,
y se dice antes de medir.

**Secundarias (se publican, no deciden nada):**

- `stale-unmarked-b-free` (w2f, w3f): las preguntas de w2 y w3, palabra por
  palabra, **sin el sufijo** «Responde en una sola línea, solo con el dato y
  nada más…». Una marcada y otra sin marcar. Miden si el sufijo pesa en que el
  agente no abra el fichero (una de las causas probables que dejó la quinta).
  Con 6 celdas por brazo y build, es descriptivo: no permite ni impide ninguna
  frase.
- `old-true-b` (k1, k2): hechos viejos que **siguen siendo ciertos** (Redsys,
  250 días, sin marca; bautismo de mar 55 €, 180 días, `volatile`), con el mismo
  valor en la memoria y en el mundo. Cumplen lo que la nota de la quinta dejó
  para «la próxima enmienda»: miden lo que cuesta el aviso cuando el dato
  aguanta (abstenciones, turnos, coste). Se puntúan `correct` / `abstain` /
  `wrong`.

De lo que esa nota pedía, la «consulta mixta con una fila vieja ajena» **no**
tiene tarea propia: los nueve hechos de Tramuntana viven en una sola neurona
(como Pelícano), así que cada pregunta trae otras líneas viejas del mismo
proyecto en `also_matched`, pero no una fila vieja de otro proyecto. Se dice.

**Cerebro.** El de las doce tareas más los nueve hechos de Tramuntana (seis
viejos de w1–w6, dos viejos de k1–k2 y uno de hoy), en **su propia copia**:
ni Pelícano entra en ella ni Tramuntana en la de Pelícano. Mismo
envejecimiento en crudo que la quinta (`added` y `verified` = hace N días,
`shelf_life` donde se indica), mismo reindexado y misma comprobación previa:
si recall no sirve cada hecho viejo con su fecha vieja, no se ejecuta.

**El mundo.** Ocho ficheros (dos en subcarpetas, `config/` y `docs/`) en el
directorio de cada celda de estas tareas, en los dos brazos, con el valor
actual y sin el viejo; un `README.md` dice dónde está cada cosa, sin valores.
Mismas herramientas (`Read`, `Glob`, `Grep` en los dos brazos; las tres de
lectura de CRBRO en `crbro`), mismo canario de lectura, misma auditoría de
fugas (una sola aborta sin escribir resultados), `--max-turns 12`. El prompt
no menciona ni la memoria ni los ficheros.

**Puntuación.** La de la quinta, sin cambios de regla: `hedged` (el valor
viejo sin el actual, con aviso) vale para todos los tipos `stale-unmarked*`,
y nunca para las `stale` originales. Los tests
([agentic.score.test.ts](../../tests/agentic.score.test.ts)) comprueban que el
mundo tiene el valor actual y no el viejo, que cada valor viejo es un hecho
envejecido vivo, el reparto de marcas (2 `volatile`, 1 `normal`, 3 sin
marca), que w2f/w3f son w2/w3 sin sufijo, que k1/k2 tienen el mismo valor en
la memoria y en el mundo, y ejemplos de puntuación de cada tarea.

**Umbrales (los mismos U1–U5, aplicados a `stale-unmarked-b`, 18 celdas por
brazo).** La frase de la quinta («cuando lo que recuerda puede haber cambiado,
CRBRO lo avisa y el agente lo comprueba antes de contestar») solo se puede
escribir si, con `n = 3` y en haiku y en sonnet, la tanda `after` cumple:

- **U1.** `crbro` acierta ≥ 75 % de w1–w6: **≥ 14 de 18**.
- **U2.** `crbro` da el valor viejo sin aviso en ≤ 10 %: **como mucho 1 de 18**.
- **U3.** `crbro` acierta al menos tantas como `baseline`.
- **U4.** `crbro` da menos valores viejos sin aviso que con la build `before`,
  mismo modelo y misma `n`. Si `before` no da ninguno, U4 falla.
- **U5.** En la misma tanda `after` pasan los cuatro umbrales originales.

`null` sigue sin permitir la frase. Si se cumple en un modelo y no en el otro,
no se escribe, y se publica la tabla de los dos.

**Cambios del arnés, en este commit y antes de cualquier ejecución:**

- `tasks.json`: las diez tareas nuevas y el bloque `unmarked_b` (semilla,
  mundo, tipos), con `frozen: 2026-10-04`. Las 16 tareas anteriores, su
  cerebro y el bloque `unmarked` no cambian ni un byte.
- `run.mjs`: cada caso (`unmarked`, `unmarked_b`) tiene su semilla, su copia
  de cerebro y su mundo; los ficheros del mundo pueden ir en subcarpetas; una
  tarea con `"suffix": false` se pregunta sin sufijo; la tanda calcula
  `verdict_unmarked_b` (U1–U5 sobre `stale-unmarked-b`) junto a los que ya
  calculaba. `--only` ya aceptaba varios tipos: no hace falta otra opción.
- `score.mjs`: `hedged` para todo tipo que empiece por `stale-unmarked`;
  `verdictUnmarked` acepta el tipo que juzga (por defecto `stale-unmarked`,
  así que la quinta se calcula igual).
- Validado en seco (`--dry`) con la build 2.8.0 y con la de la rama, con y sin
  `--only`; los 19 tests del puntuador pasan.

**Orden, estricto y nunca en paralelo:**

1. Este commit: tareas, umbrales, arnés.
2. `before`: la build 2.8.0 (`cab8283`, ya construida en
   `../crbro-staleness-before/build-2.8.0`, `dirty: false`) con el arnés de
   este commit, solo los tres tipos nuevos, haiku y sonnet, `n = 3`. Se
   commitean los resultados.
3. El cambio de producto, commiteado, sin mirar las respuestas de `before`
   para ajustar texto sobre estas tareas (si se miran, se dice).
4. `after`: la build de ese commit (`dirty: false`), las doce originales más
   los tres tipos nuevos (sin u1–u4), haiku y sonnet, `n = 3`, con
   `--compare` al `before` del mismo modelo. Es **una** tanda por modelo y es
   la que se publica. `git diff <este commit>..<commit after> --
   benchmarks/agentic` tiene que salir vacío salvo `results/`.

Sin tope de ajuste esta vez: no hay segunda `after`. Si una tanda aborta por
el arnés (canario, fuga, error de la API repetido), se repite entera con la
misma build y se dice; el producto no cambia entre medio. Todas las celdas con
`CRBRO_MOD=0` en el entorno del ejecutor, como en las tandas de la quinta.
`--compare` solo comprueba el modelo: el `before` se revisa a mano (`label:
before-b`, `crbro.commit` `cab8283…`, `dirty: false`, `n = 3`, mismo modelo,
Claude Code 2.1.270) y se deja escrito con los resultados.

**Lo que se publica, pase lo que pase:** las tablas de `before` y `after` de
los dos modelos para w1–w6, las secundarias por separado (w2f/w3f frente a
w2/w3; k1/k2 con abstenciones, turnos y coste), cuántas celdas `crbro`
abrieron un fichero, y el coste y los turnos por celda.

**Comandos** (desde la raíz del repositorio; la fecha del nombre es la del
día en que corre cada tanda):

    # 2. before, build 2.8.0
    CRBRO_MOD=0 node benchmarks/agentic/run.mjs --dist ../crbro-staleness-before/build-2.8.0/dist \
      --only stale-unmarked-b,stale-unmarked-b-free,old-true-b --model haiku --reps 3 --label before-b
    CRBRO_MOD=0 node benchmarks/agentic/run.mjs --dist ../crbro-staleness-before/build-2.8.0/dist \
      --only stale-unmarked-b,stale-unmarked-b-free,old-true-b --model sonnet --reps 3 --label before-b
    # 4. after, con el cambio de producto commiteado
    npm run build
    CRBRO_MOD=0 node benchmarks/agentic/run.mjs \
      --only memory,stale,control-prompt,control-absent,stale-unmarked-b,stale-unmarked-b-free,old-true-b \
      --model haiku --reps 3 --label after-b --compare benchmarks/results/agentic-<fecha>-haiku-before-b.json
    CRBRO_MOD=0 node benchmarks/agentic/run.mjs \
      --only memory,stale,control-prompt,control-absent,stale-unmarked-b,stale-unmarked-b-free,old-true-b \
      --model sonnet --reps 3 --label after-b --compare benchmarks/results/agentic-<fecha>-sonnet-before-b.json

**Límites que se dirán con cualquier resultado:** seis tareas de un solo
autor y un solo proyecto; las edades se eligieron sabiendo las ventanas de 90
y 365 días; el autor vio la lista de reglas ampliadas de la §13 (arriba); w6
lleva una marca que, con las ventanas de la quinta, deja fuera un aviso por
edad; y la consulta mixta con una
fila ajena sigue sin tarea.

**Estado:** diseñado y validado en seco, sin ninguna ejecución con modelo.
Este commit es el pre-registro de la sexta enmienda.

#### Nota fechada (2026-10-04), antes de la tanda `after-b`

Escrita y commiteada **antes** de medir, en `a2bffef` (15:46, fuera de esta
carpeta: §14 de [staleness.md](../../docs/design/staleness.md), «Limits» y
«What the author of this change knew»), y copiada aquí después, con los
resultados, para que `git diff 4453942..a2bffef -- benchmarks/agentic` siga
vacío como pide el paso 4. No cambia ninguna tarea, puntuación ni umbral, ni
nada del producto: `a2bffef` es `5343047` más documentación.

1. **Lo que el cambio puede alcanzar.** Una comprobación sin modelo (el
   cerebro del caso sembrado como lo siembra `run.mjs`, esta build,
   `crbro_recall` con el prompt de cada tarea) dio que solo **w2** (160 días,
   `volatile`) y **w4** (300, `volatile`) llegan a `possibly_stale` con
   `stale_warning`; entre las secundarias, también k2 (180, `volatile`).
   **w1** (230), **w3** (270) y **w5** (130) no llevan marca y se infieren
   `normal`; **w6** (200) va marcada `normal`. Las cuatro quedan por debajo
   de los 365 días y recall las sirve en `results` como vigentes, sin aviso.
   El cambio no puede tocar 12 de las 18 celdas `crbro` que juzgan por
   modelo, y U1 (≥ 14/18) y U2 (≤ 1/18) solo pueden cumplirse si el agente
   abre el fichero por su cuenta, cosa que en `before-b` no hizo ninguna
   celda `crbro` (0 de 24 por modelo). La enmienda suponía («todas entre 90 y
   365 días… más que la ventana `volatile`») que las líneas sin marca se
   inferirían `volatile`, como u3 y u4; estas no, y solo avisó de w6.
   `namedSources` no actúa en ninguna fila que juzga: la única línea que
   nombra su fichero (w1) nunca se marca, y w2 y w4 reciben el `next_step`
   general. No se toca la detección: hacerlo ahora sería ajustar sobre tareas
   ya vistas. La tanda va como estaba pre-registrada y, además, se da por
   tarea, separando marcadas (w2, w4) y no marcadas (w1, w3, w5, w6): es una
   descripción, no un umbral nuevo.
2. **Una frase de la §14 que no era exacta.** «Los tests usan sujetos y
   valores que no están en ninguna tarea» tenía tres ecos: un ejemplo
   negativo de `tests/staleness.framing.test.ts` («Lo dijo Antonio en la
   reunión del lunes») se parece a cómo la línea de w4 dice de dónde salió;
   `tarifas.json`, en el mismo fichero, a `tarifas.csv` de w2; y los
   ejemplos de `src/engine/source.ts` y de la §14 nombran `.env.production`,
   el fichero de w4. Están en comentarios, tests y documentación: ninguno
   llega en el texto que el servidor manda al agente. Se corrigió la frase.

#### Tandas `after-b` (2026-10-04): no se cumple

Build `a2bffef` (`dirty: false`; el producto es el de `5343047`),
`CRBRO_MOD=0`, Claude Code 2.1.270, n=3, una tanda por modelo con las doce
originales y los tres tipos nuevos (22 tareas, 132 celdas), sin u1–u4.
Primero haiku (terminó a las 15:52), después sonnet (15:59), nunca a la vez.
Canarios y canarios de lectura limpios en los dos brazos de los dos modelos,
0 fugas, 0 errores de API, 0 reintentos. No hubo que repetir nada.
`--compare` comprobado a mano: los dos `before-b` son `label: before-b`,
`crbro.commit` `cab8283…`, `dirty: false`, `n = 3`, el mismo modelo y Claude
Code 2.1.270. `git diff 4453942..a2bffef -- benchmarks/agentic` sale vacío.
Resultados: `results/agentic-2026-10-04-{haiku,sonnet}-after-b.json`.

**Lo que juzga: `stale-unmarked-b` (w1–w6, 18 celdas por brazo).**

| `crbro` | haiku before-b | haiku after-b | sonnet before-b | sonnet after-b |
|---|--:|--:|--:|--:|
| acierta (valor actual) | 0 | 1 | 0 | 0 |
| valor viejo **sin aviso** | 14 | 9 | 18 | 12 |
| valor viejo con aviso (`hedged`) | 0 | 0 | 0 | 6 |
| se abstiene | 4 | 8 | 0 | 0 |
| celdas que abrieron un fichero (w y wf, de 24) | 0 | 1 | 0 | 0 |
| `baseline` acierta (la vara de U3) | 4 | 6 | 10 | 9 |
| coste medio por celda `crbro` (USD) | 0,0114 | 0,0129 | 0,0268 | 0,0272 |
| turnos medios por celda `crbro` | 2,6 | 2,8 | 3,4 | 3,2 |

Por tarea, `crbro` (C acierto, S viejo sin aviso, H con aviso, A abstención):

| tarea | ¿llega a `possibly_stale`? | haiku before-b | haiku after-b | sonnet before-b | sonnet after-b |
|---|---|---|---|---|---|
| w1 | no (230 d, `normal` inferida) | SSS | SSS | SSS | SSS |
| w2 | sí (160 d, `volatile`) | SAS | AAA | SSS | HHH |
| w3 | no (270 d, `normal` inferida) | SSS | SSS | SSS | SSS |
| w4 | sí (300 d, `volatile`) | SSS | AAC | SSS | HHH |
| w5 | no (130 d, `normal` inferida) | AAA | AAA | SSS | SSS |
| w6 | no (200 d, marcada `normal`) | SSS | SSS | SSS | SSS |

Marcadas (w2, w4, 6 celdas): haiku pasa de 5 viejos sin aviso a 0 (5
abstenciones y el único acierto, que es la única celda `crbro` que abrió un
fichero); sonnet, de 6 a 0 (las 6 avisan). No marcadas (w1, w3, w5, w6, 12
celdas): lo mismo antes y después, haiku 9 viejos sin aviso y 3
abstenciones, sonnet 12 viejos sin aviso. Toda la bajada de U2 sale de las
dos filas que recall marca.

| umbral | haiku | sonnet |
|---|---|---|
| U1 ≥ 75 % (≥ 14/18) | 5,6 % (1) ✗ | 0 % ✗ |
| U2 ≤ 10 % (≤ 1/18) | 50 % (9) ✗ | 66,7 % (12) ✗ |
| U3 crbro ≥ baseline | 1 vs 6 ✗ | 0 vs 9 ✗ |
| U4 menos que before-b | 9 < 14 ✓ | 12 < 18 ✓ |
| U5 originales | 4/4 ✓ | 4/4 ✓ |

`claim_allowed: false` en los dos modelos. La frase **no se escribe**. U4 en
verde dice que el aviso cambia la respuesta cuando llega (en las filas
marcadas); no dice que el agente compruebe: con CRBRO se abrió un fichero en
1 de 48 celdas w/wf, y `baseline`, con los mismos ficheros y sin memoria,
sigue acertando más (6 y 9 de 18).

**U5, en la misma tanda.** `crbro`: `memory` 12/12, `stale` 12/12 con 0
valores retirados, `control-prompt` 6/6 y `control-absent` 6/6, en los dos
modelos. `baseline`: 0/24 en `memory` + `stale`; con sonnet inventa 1
respuesta en `memory`.

**Secundarias (descriptivas, no deciden nada).**

- `stale-unmarked-b-free` (w2f y w3f, sin sufijo), `crbro`: en los dos
  modelos, antes SSS y SSS, después w2f HHH y w3f SSS. Con sufijo, w2 da AAA
  (haiku) y HHH (sonnet): sin sufijo, en haiku, la fila marcada sale como
  valor viejo con aviso en vez de abstención; la no marcada sale igual con y
  sin sufijo. Ninguna celda w2f/w3f abrió un fichero. `baseline`: 1/6 (haiku)
  y 0/6 (sonnet); las demás son respuestas libres, puntuadas `wrong` porque
  sin sufijo no hay `NO_LO_SE`.
- `old-true-b` (k1, k2), `crbro`: haiku 3/6 antes y después (k1 CCC; k2 AAA,
  abstención en 1 turno sin llamar a nada, como antes), 2,0 turnos, 0,0084 →
  0,0090 USD por celda. Sonnet 6/6 antes y después, 3,0 turnos, 0,0231 →
  0,0254 USD; después, las tres respuestas de k2 (55 €, marcado y todavía
  cierto) añaden «podría estar desactualizado»: se puntúan `correct`, y son
  el coste del aviso cuando el dato aguanta. `baseline`: haiku 1 → 2, sonnet
  3 → 2 de 6.
- Escrituras: ninguna celda llamó a `crbro_revise` ni a `crbro_learn`.
  Sonnet intentó `crbro_consolidate` (denegado) en 9 celdas `before-b` y en 7
  `after-b`; haiku, en ninguna.
- Coste medio por celda `crbro` en las 30 celdas de los tipos nuevos: haiku
  0,0111 → 0,0121 USD (2,6 → 2,7 turnos), sonnet 0,0262 → 0,0274 (3,3 → 3,2).
  Gasto total de las tandas `after-b`, según el arnés: haiku 1,10 USD, sonnet
  2,09 USD.

**Las dos iteraciones, juntas** (`crbro`; valor actual · valor viejo sin
aviso; n=3):

| | caso | haiku before → after | sonnet before → after |
|---|---|---|---|
| 1.ª (quinta enmienda) | Pelícano, u1–u4, 12 celdas | 0 → 0 · 11 → 9 y 10 | 0 → 0 · 12 → 11 y 12 |
| 2.ª (sexta enmienda) | Tramuntana, w1–w6, 18 celdas | 0 → 1 · 14 → 9 | 0 → 0 · 18 → 12 |

**Lectura, sin más alcance que estas celdas.** La segunda iteración cambia lo
que el agente dice cuando recall marca la fila: deja de dar el valor viejo
como vigente, y avisa (sonnet) o se abstiene (haiku). No consigue que lo
compruebe. Y en este caso la detección marcó dos de las seis filas que
cambiaron: las cuatro sin marca o marcadas `normal`, con menos de 365 días,
se sirven como vigentes, y ahí no cambió nada. Con las dos iteraciones se
publica la 2.9.0, contado tal cual. No hay segunda tanda `after-b`.

**Límites** (además de los de la enmienda): seis tareas de un solo autor y
un solo proyecto; las causas de la §14 siguen sin separarse; la nota de
arriba se escribió sabiendo que el cambio no alcanzaba 12 de 18 celdas, sin
tocar nada por ello; y quien escribió el cambio de producto conocía las
tareas y los resultados `before-b` (§14).
