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
