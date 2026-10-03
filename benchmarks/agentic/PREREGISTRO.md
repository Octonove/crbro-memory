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
