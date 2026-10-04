# CRBRO — benchmarks

Números defendibles, con las cifras en contra al lado. Tomamos prestada la
disciplina de [Ponytail](https://github.com/DietrichGebert/ponytail): baseline
justo, tareas fijadas antes de medir, los fallos publicados, y lo no medible de
forma creíble **no se afirma**.

Todo lo de aquí es **determinista y sin coste de API** —mismo resultado en cada
ejecución, corre en CI— salvo el benchmark agéntico de [`agentic/`](agentic/PREREGISTRO.md),
que pone a trabajar un agente real y gasta tokens. Lo que ninguno de los dos
afirma está en [LIMITS.md](LIMITS.md).

## Agéntico — ¿una sesión nueva vuelve a preguntar lo que ya sabe?

Una sesión nueva de Claude Code, sin historial, recibe una pregunta cuyo dato
solo existe en una memoria sembrada antes. El prompt no menciona la memoria:
consultarla depende solo de las instrucciones que declara el servidor MCP.
Doce tareas ficticias congeladas, cuatro umbrales fijados antes de ejecutar,
canario de aislamiento en cada tanda ([pre-registro](agentic/PREREGISTRO.md)).

Cuarta tanda, 03-10-2026, Claude Code 2.1.270, n=3 por tarea:

| tipo de tarea | haiku con CRBRO | haiku sin | sonnet con CRBRO | sonnet sin |
|---|--:|--:|--:|--:|
| `memory` (el dato solo está en la memoria) | **12/12** | 0/12 | **12/12** | 0/12 (4 inventadas) |
| `stale` (hay un valor retirado y el vigente) | **12/12**, 0 retirados | 0/12 | **12/12**, 0 retirados | 0/12 |
| `control-prompt` (el dato viene en la pregunta) | 6/6 | 6/6 | 6/6 | 6/6 |
| `control-absent` (el dato no está en ningún sitio) | 6/6 se abstiene | 6/6 | 6/6 se abstiene | 6/6 |

Pasan los cuatro umbrales en los dos modelos. Lo que no dice: las
instrucciones del servidor se corrigieron dos veces entre tandas sobre estas
mismas doce tareas (fechado en el pre-registro), así que la cuarta tanda no es
ciega; y son preguntas cortas de una sola sesión. Se reproduce con
`node benchmarks/agentic/run.mjs` (necesita `claude` con sesión iniciada y gasta
cuota). Coste de la tanda con CRBRO: ~0,37 USD en haiku y ~0,82 USD en sonnet
según el propio Claude Code.

### `stale-unmarked`: un dato que cambió y nadie retiró (04-10-2026)

Quinta enmienda del [pre-registro](agentic/PREREGISTRO.md): cuatro valores de
un proyecto ficticio (versión de PostgreSQL, precio, puerto, responsable) que
cambiaron en el mundo —el valor actual está en un fichero del directorio de
trabajo, en los dos brazos— y siguen vivos en la memoria con 200 días. `before`
es la 2.8.0 publicada (`cab8283`); `after`, la rama `feat/staleness` con la
caducidad implementada (`ad7675f`). Claude Code 2.1.270, n=3, mismo arnés
(`1a023a7`) en todas las tandas. `after` se midió dos veces: solo las cuatro
tareas nuevas y la tanda completa de 16.

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

**Resultado: no se cumple.** U1 (≥ 75 % de aciertos), U2 (≤ 10 % de valores
viejos sin aviso) y U3 (al menos tantos aciertos como `baseline`) fallan en
las cuatro tandas `after`. U4 (menos valores viejos sin aviso que `before`)
pasa en haiku (9 y 10 frente a 11) y en la tanda corta de sonnet (11 frente a
12), y falla en la completa de sonnet (12 frente a 12); con 12 celdas, esas
diferencias de una o dos son ruido, no un efecto. U5 pasa: en las dos tandas
completas los cuatro umbrales originales siguen en 4/4 (`memory` 12/12,
`stale` 12/12 sin ningún valor retirado, los dos controles 6/6), igual que en
la cuarta tanda. La frase pre-registrada **no se escribe**.

Lo que se ve en las celdas: la función hace su parte —sin modelo, recall
sobre el mismo cerebro devuelve las cuatro filas en `possibly_stale`, con
`age_days: 200`, y el `hint` pide comprobarlas contra la fuente— pero ningún
agente con CRBRO abrió un fichero en las 48 celdas `after`: todos llamaron a
`crbro_boot` y `crbro_recall` y contestaron con el valor viejo, se abstuvieron
o, una vez (sonnet), lo dieron avisando de que podía estar desactualizado.
`baseline`, sin memoria, sí lee el fichero en 1 a 6 de cada 12 celdas según la
tanda. Ninguna celda `after` intentó `crbro_revise` ni `crbro_learn` (la única
escritura denegada fue un `crbro_consolidate` de sonnet en cada tanda), así
que el coste extra no viene de escrituras denegadas: en haiku sube de 0,0121 a
~0,015 USD por celda con los mismos turnos; en sonnet el coste es parecido y
los turnos bajan de 3,6 a 3,1. Canarios y canarios de lectura limpios en las
seis tandas, sin fugas ni errores de API.

Límites (fechados antes de medir en el pre-registro): U5 no puede ver falsos
avisos (los hechos originales son de hoy); u3 y u4 coinciden con los ejemplos
del detector. Los JSON están en `results/agentic-2026-10-04-*-{before,after-unmarked,after}.json`.

## Reproducir

```bash
npm run build
node benchmarks/retrieval/run.mjs    # ¿lo guardado se encuentra?
node benchmarks/security/run.mjs     # ¿el filtro caza las credenciales?
node benchmarks/cost/run.mjs         # ¿cuánto cuesta CRBRO? (la cifra en contra)
```

Añade `--json` a cualquiera para la salida cruda.

## Retrieval — ¿lo guardado se encuentra?

Un cerebro de prueba de 48 hechos en 12 temas. **La clave metodológica:** las
48 consultas las escribió un agente que solo vio una **etiqueta de una línea**
por hecho, nunca el texto guardado. Si quien escribe la consulta ve el texto,
BM25 acierta por fuga de vocabulario y el benchmark es teatro. El fixture y las
consultas están congelados en git **antes** de medir — el historial es el
pre-registro.

| | recall@1 | recall@3 | MRR |
|---|--:|--:|--:|
| **motor CRBRO 1.13 (BM25 por chunks + sinónimos)** | **71%** | **77%** | **0.744** |
| motor 1.13 con `CRBRO_SYNONYMS=0` | 60% | 73% | 0.676 |
| motor 1.12 (referencia) | 56% | 69% | 0.634 |
| control (subcadena ingenua) | 38% | 58% | — |

Contando también las líneas de `also_matched` (el hecho esperado entre las 3
líneas que devuelve la neurona, no solo la primera): **79% @1 · 85% @3**. Es
una métrica informativa, no pre-registrada — se añadió en 1.13 con la función
que mide, y el script la imprime en una línea aparte etiquetada como tal.

**Distractores:** 14 consultas sobre temas que NO están guardados. **11 de 14
devuelven algo**, 2 con un score tan alto como un acierto real (eran 4 en
1.12). Ese es el modo de fallo silencioso de una memoria por palabras clave,
y va aquí, no escondido. Desde 1.13 cada resultado lleva `confidence`: la
etiqueta marca `weak` a **10 de los 11** distractores que devuelven algo — y
también a 18 de los 48 aciertos reales. Ese es su precio: `weak` significa
«cubre poco de la pregunta», no «está mal».

**De dónde salió la subida (medido paso a paso, cada cambio revertido antes
de medir el siguiente):** de los 13 fallos de 1.12, 3 eran la *cabecera* de
la neurona (su nombre, con boost ×2) hablando por ella, 5 eran la neurona
correcta contestando con un hecho hermano, y solo 5 eran huecos de
vocabulario. Cabecera-nunca-gana: 56→60. Sinónimos: 60→71.

**La advertencia honesta sobre los sinónimos:** la tabla de `synonyms.ts` la
escribió quien ya había visto los fallos de este benchmark. Se dejaron fuera
a propósito los pares que solo tenían sentido para una consulta concreta
(«rotos→404», «pruebo→staging», «stack→bloques») y se quedaron solo los de
vocabulario cotidiano de agencia y desarrollo (web/sitio, hosting/alojamiento,
email/correo, coste/precio…), pero el número **no es un resultado a ciegas**:
es una tabla de vocabulario medida sobre un conjunto que su autor conocía. La
prueba limpia es la siguiente tanda de consultas nuevas, escritas sin mirar
la tabla. Por eso el script mide con y sin (`CRBRO_SYNONYMS=0`).

**Lo que le faltaba al motor léxico:** los 8 fallos que quedaban (con
also_matched) eran sinónimos que ninguna tabla razonable cubre — «alojadas» →
un VPS de Hetzner, «seguridad» → Wordfence, «proveedor de email» → Mailchimp.
Dos caminos lo atacan, y los dos están medidos más abajo: un modelo semántico
(1.14, opcional hasta 1.15; desde 1.16 lo instala `init` por defecto y se
apaga con `CRBRO_SEMANTIC=0`) y, mejor y gratis, que el propio modelo que
guarda escriba esas palabras al guardar (1.15, «La IA en el bucle»).

## Retrieval con la capa semántica (1.14, `CRBRO_SEMANTIC=1`)

Mismas 48 consultas, mismos 14 distractores. Vectores de
`Xenova/multilingual-e5-small` (int8) fusionados con BM25 por rango recíproco
(RRF, k=60). Un candidato que solo trae el vector se descarta por debajo de
un suelo de coseno, y se marca `strong` a partir de 0.86.

| | recall@1 | recall@3 | MRR | distractores con score de acierto |
|---|--:|--:|--:|--:|
| motor léxico 1.13 | 71% | 77% | 0.744 | 2 / 14 |
| solo vectores | 63% | 81% | — | — |
| **fusión, suelo 0.84 (defecto)** | **79%** | **83%** | **0.813** | **0 / 14** |

Con `also_matched`: **88% @1 · 92% @3**. Distractores: 12 de 14 devuelven
algo, 11 de esos 12 marcados `weak`, ninguno con score de acierto. Top-1
reales marcados `strong`: 35/48.

**El barrido del suelo, sin maquillar** (es el número que decide qué candidato
puramente semántico se muestra, y se eligió mirando este mismo conjunto):

| suelo | recall@1 | recall@3 | MRR | distractores confiados |
|--:|--:|--:|--:|--:|
| 0.80 | 75% | 79% | 0.781 | 2 |
| 0.83 | 75% | 83% | 0.785 | 0 |
| **0.84** | **79%** | **83%** | **0.813** | **0** |
| 0.85 | 69% | 77% | 0.729 | 0 |
| 0.86 | 77% | 79% | 0.781 | 1 |

La curva no es monótona y 48 consultas son pocas: el 0.84 es un valor
**ajustado sobre el conjunto de prueba**, no un resultado a ciegas. La razón
de fondo está en el modelo: e5-small comprime los cosenos de todo, relacionado
o no, en ~0.82–0.92 (top-1 reales: mínimo 0.833, mediana 0.864; top-1 de
distractores: mediana 0.832, máximo 0.841), así que el suelo tiene que
sentarse a milésimas del techo de los distractores. Se puede mover con
`CRBRO_SEMANTIC_FLOOR`. La prueba limpia es, otra vez, la siguiente tanda de
consultas nuevas.

**Lo que el modelo NO hace, medido aparte:** paráfrasis abstractas sin
vocabulario compartido. Con 7 hechos y 8 consultas escritas sin ninguna
palabra del hecho («qué máquina sirve las páginas» para el VPS de Hetzner,
«renovación del candado https» para certbot, «resguardo de la información por
si se pierde» para las copias en B2), todos los cosenos caen en la banda
0,80–0,84 y el orden es casi aleatorio: la primera consulta pone el formulario
de contacto por delante del VPS y la segunda pone el blog por delante de
certbot. Los tres fallos léxicos que la capa recupera en el benchmark
comparten vocabulario concreto con el hecho («formulario de contacto…»,
«coste del hosting…», «inversión en ads…»): lo que aporta e5-small aquí es
tolerancia a variaciones de vocabulario concreto y a entidades, no
comprensión de la pregunta. Por eso el suelo existe: por debajo de 0,84 el
vector no distingue lo relacionado de lo que no lo es, y un fallo léxico debe
seguir siendo un fallo, no una respuesta segura y equivocada.

**¿Y un modelo más grande? Medido el 03-09-2026, mismo examen**, con
`CRBRO_SEMANTIC_MODEL` (en el repo, sin publicar todavía) y
`node benchmarks/retrieval/models.mjs` para la columna «solo vectores»:

| modelo (int8) | disco | RAM del proceso | ms/línea | solo vectores @1 / @3 | fusión con BM25, mejor suelo | distractores confiados |
|---|--:|--:|--:|--:|--:|--:|
| **multilingual-e5-small (defecto)** | 130 MB | +0,5 GB | 3 | 63% / 81% | **79% / 83%** (0,84) | 0 |
| multilingual-e5-base | 283 MB | +0,8 GB | 7 | 67% / 85% | 75% / 81% (0,82) · 73% / 85% (0,79) | 1 |
| multilingual-e5-large | 553 MB | +1,2 GB | 20 | 71% / 83% | 75% / 85% (0,83) | 0 |

El grande es mejor modelo a solas (71 frente a 63 a la primera) y aun así la
fusión con BM25 no mejora: 75 frente a 79 a la primera, 85 frente a 83 en el
top 3, diferencias de 1 o 2 consultas sobre 48, es decir, ruido. Y falla en
las mismas preguntas sin vocabulario compartido (alojadas, suscripciones de
IA, copias de seguridad, pruebo). Por cuatro veces el disco, más del doble
de RAM y seis veces el tiempo por línea, no merece la pena: el defecto sigue
siendo el pequeño. Los cosenos de cada modelo viven en una banda distinta,
por eso cada uno se barrió con su propio suelo. Primera carga con descarga:
28 s el mediano, 52 s el grande; con el archivo ya en la caché del sistema,
1 o 2 s cualquiera de los tres (los 13 s del pequeño se midieron en frío de
verdad, la primera vez).

**Lo que cuesta:** ~380 MB de runtime + 118 MB de modelo en disco, ~0,5 GB
de RAM mientras el servidor corre con el modelo cargado, ~13 s de
carga en frío por proceso (se calienta en segundo plano tras el boot), 20–45 ms
por línea nueva al guardar según su longitud (el cerebro de referencia, 5.129
chunks y 3.984 líneas sin cabeceras, tardó 3 minutos en total), y unas decenas
de ms por consulta. Hasta 1.15 eso la hacía opcional. Desde 1.16 la instala
`init` por defecto, a petición del autor (que funcione lo mejor posible de
serie), y se desactiva con `init --no-semantic` o `CRBRO_SEMANTIC=0`. El
benchmark la mide apagada salvo que se pida (`CRBRO_SEMANTIC=1`), para que
los números pre-registrados del motor léxico sigan siendo comparables.

## La IA en el bucle (1.15, informativo, no pre-registrado)

La pregunta de Antonio fue la buena: ¿por qué no usar directamente la IA para
los casos difíciles? Quien guarda y quien pregunta es un modelo de lenguaje, y
un modelo sabe los sinónimos que un índice de palabras no sabe. 1.15 le da dos
sitios donde ponerlos, sin disco ni RAM:

- **Palabras clave al guardar** (`keywords` en `crbro_learn`): 2-5 palabras
  con las que una pregunta futura podría referirse al hecho y que el texto no
  contiene («Hetzner» → hosting, alojamiento, servidor). Se indexan con la
  línea, nunca se muestran, y viajan por los espacios compartidos.
- **Varias formulaciones al buscar** (`queries` en `crbro_recall`): 2-4
  reformulaciones buscadas junto a la original y fusionadas por rango
  recíproco (`searchMany`).

**Cómo se midió sin hacer trampa:** las palabras clave las escribió un modelo
(Claude Sonnet) que vio SOLO los 48 textos, sin etiquetas ni consultas
(`blind-keys.json`, 5 por hecho de media); las reformulaciones las escribió
otra instancia que vio SOLO las 62 consultas, sin los hechos
(`blind-alts.json`, 3 por consulta). Mismo examen, mismos distractores. Se
reproduce con `CRBRO_BENCH_KEYS=benchmarks/retrieval/blind-keys.json` y/o
`CRBRO_BENCH_ALTS=benchmarks/retrieval/blind-alts.json`.

| configuración | recall@1 | recall@3 | MRR | con also_matched @1 / @3 | distractores confiados |
|---|--:|--:|--:|--:|--:|
| motor léxico 1.13/1.14 (referencia) | 71% | 77% | 0.744 | 79% / 85% | 2 / 14 |
| + reformulaciones | 71% | 79% | 0.758 | 79% / 90% | 1 / 14 |
| + palabras clave | **83%** | **90%** | 0.866 | 85% / 94% | 1 / 14 |
| + palabras clave + reformulaciones | 85% | 90% | 0.877 | 92% / 98% | 1 / 14 |
| capa semántica sola (1.14) | 79% | 83% | 0.813 | 88% / 92% | 0 / 14 |
| semántica + reformulaciones | 81% | 85% | 0.841 | 90% / 94% | 1 / 14 |
| semántica + palabras clave | 85% | 88% | 0.865 | 90% / 94% | 0 / 14 |
| **semántica + palabras clave + reformulaciones** | **90%** | **92%** | **0.911** | **96% / 98%** | 1 / 14 |

Lectura honesta:

- La palanca grande son las **palabras clave al guardar**: +12 puntos a la
  primera y +13 en el top 3 sobre el motor léxico, sin un solo byte de disco
  ni de RAM. Cierran justo los huecos que ningún modelo de embeddings cerró
  (alojadas → hosting, pruebo → entorno de pruebas, suscripciones de IA).
- Las **reformulaciones** solas apenas mueven el motor léxico (+0 / +2):
  quien reformula a ciegas no adivina «Hetzner». Suman cuando ya hay
  vocabulario que enganchar. Con la fusión casi todo distractor devuelve algo
  (14/14), marcado `weak` (14/14 con todo activado).
- Con todo activado siguen sin aparecer entre los 10 primeros 3 consultas:
  «formulario de contacto web de reformas» (la neurona acertada contesta con
  otra línea; con also_matched sí aparece), «posición de la keyword principal
  de octonove» y «política de copias de seguridad de las webs».
- ¿Suerte de una tanda? Una **segunda muestra ciega** de palabras clave,
  escrita por otra instancia con el mismo encargo (`blind-keys2.json`), da
  81% / 85% sola y exactamente el mismo 90% / 92% (96% / 98% con
  also_matched) con todo activado. Dos muestras no son una distribución,
  pero la conclusión no depende de cuál se elija.
- Advertencia de siempre: 48 consultas, el mismo conjunto desde 1.12, cada
  punto son dos consultas. Y las palabras clave del cerebro real las escribirá
  el modelo en uso al guardar, siguiendo la descripción de la herramienta:
  esta medición dice lo que pasa cuando lo hace con criterio, no garantiza
  que lo haga siempre.

## Re-medición del 03-10-2026 (2.7.1)

Las tablas de arriba son las de 1.13-1.15 y se dejan tal cual: son el
historial. Esta es la misma batería, con los mismos ficheros congelados, sobre
2.7.1 (commit 057aa3a). Se reproduce con `node benchmarks/retrieval/run.mjs`
y las variables `CRBRO_SEMANTIC`, `CRBRO_BENCH_KEYS` y `CRBRO_BENCH_ALTS`.

| configuración | recall@1 | recall@3 | MRR | con also_matched @1 / @3 | distractores confiados | en 1.15 (@1 / @3) |
|---|--:|--:|--:|--:|--:|--:|
| motor léxico | 71% | 77% | 0.744 | 77% / 83% | 2 / 14 | 71% / 77% |
| + reformulaciones | 71% | 83% | 0.776 | 79% / 92% | 1 / 14 | 71% / 79% |
| + palabras clave | 83% | 90% | 0.870 | 85% / 94% | 1 / 14 | 83% / 90% |
| + palabras clave + reformulaciones | 85% | 90% | 0.877 | 92% / 98% | 1 / 14 | 85% / 90% |
| capa semántica (como se instala) | **73%** | **79%** | 0.760 | 81% / 90% | 0 / 14 | **79% / 83%** |
| semántica + reformulaciones | 79% | 83% | 0.820 | 88% / 92% | 1 / 14 | 81% / 85% |
| semántica + palabras clave | **81%** | 88% | 0.844 | 85% / 94% | 0 / 14 | **85%** / 88% |
| **todo activado** | **90%** | **92%** | **0.911** | 94% / 96% | 0 / 14 | 90% / 92% |

Lectura honesta:

- Sin la capa semántica, recall@1 no se ha movido en ninguna configuración, y
  las reformulaciones solas suben en el top 3 (79% → 83%). Con also_matched el
  motor léxico da 2 puntos menos que cuando se publicó en 1.13 (79% / 85% →
  77% / 83%).
- Lo que ha bajado es la capa semántica: −6 puntos a la primera sola
  (79% → 73%) y −4 con palabras clave (85% → 81%). Con palabras clave y sin
  reformulaciones, hoy la capa semántica resta 2 puntos frente a no tenerla
  (81% frente a 83%).
- Con todo activado el resultado es el mismo que en 1.15 (90% / 92%).
- 2.6.0 mide igual que 2.7.x. La causa de la bajada no está localizada: el
  fixture, las consultas y el suelo de coseno (0.84) son los mismos y el motor
  léxico no ha cambiado, lo que apunta a la fusión o al modelo y su runtime,
  en algún punto entre 1.16 y 2.6.0 (sin comprobar). Hasta saberlo, el README publica las cifras de hoy, no
  las de 1.15. *(Localizada el mismo día: ver la sección de 2.7.2.)*

## Re-medición del 03-10-2026 (2.7.2) — un examen más grande y un cerebro más grande

**Dónde cayó la capa semántica.** Midiendo cada versión con su propio
benchmark, 1.16 a 2.4.0 dan 79% / 83% y 2.5.0 en adelante 73% / 79%. Dos
commits de 2.5.0 lo explican entero: el desempate por fecha (−2; en el fixture
los hechos se aprenden en el mismo segundo y la «recencia» desempata por
milisegundos, un artefacto de la prueba) y calcular solo los vectores nuevos de
una neurona, uno a uno, cuando el suelo de 0.84 se había ajustado con vectores
calculados en lote (−4; el modelo int8 cuantiza por lote y el vector depende de
sus compañeros de lote). Volver al comportamiento viejo y apagar la fecha
devuelve exactamente 79 / 83 / 0.813. No hay error en la lógica de búsqueda.

**Conjuntos nuevos, congelados antes de medir** (commit 3877ec3): `dev.json`
(48 preguntas + 10 distractores) **solo para ajustar**; `test2.json` (96 + 20)
como segundo examen ciego; y un pajar de 1.482 hechos en 114 temas ajenos
(cocina, viajes, salud, familia, coche, hogar, jardín, mascotas, finanzas) que
se aprende antes del fixture. Las preguntas las escribió un agente que solo vio
las etiquetas de una línea, nunca el texto guardado.

**Qué se decidió con `dev` y nada más:**

| cambio | motor léxico en dev, @1 / @3 | con el pajar | capa semántica | decisión |
|---|--:|--:|--:|---|
| peso por rareza (idf) | 63/71 → **67/73** | 44/63 → **52/63** | sin cambio | se publica |
| + 80 palabras vacías más | 67/73 → 65/73 | 52/63 → 54/65 | sin cambio | no se publica: empata |
| vectores uno a uno en vez de en lotes de 16 | — | — | idéntico en los tres conjuntos | se publica: el mismo hecho, el mismo vector |
| suelo de coseno 0.80 … 0.87 | — | — | 73, 71, **75, 75**, 73, 71, 67, 65 | se queda en 0.84: meseta, una pregunta |

**El examen, con los valores ya fijados** (recall@1 / @3; entre paréntesis, 2.7.1):

| conjunto | motor léxico | léxico + pajar | como se instala (semántica) | semántica + pajar |
|---|--:|--:|--:|--:|
| original, 48 preguntas | **77 / 83** (71 / 77) | **54 / 77** (42 / 71) | 75 / 81 (73 / 79) | 67 / 79 (65 / 79) |
| dev, 48 (ajuste: no cuenta) | 67 / 73 (63 / 71) | 52 / 63 (44 / 63) | 73 / 79 (73 / 79) | 71 / 75 (71 / 75) |
| test2, 96, ciego | 49 / 53 (49 / 54) | 31 / 40 (32 / 39) | 57 / 60 (58 / 61) | 48 / 52 (48 / 51) |

Lectura honesta:

- El peso por rareza sube el motor léxico en el examen original (+6, y +12
  dentro del pajar). En el examen nuevo de 96 preguntas **no mueve nada**. Se
  publica porque no empeora ningún conjunto y ayuda en dos de tres.
- El examen nuevo es más difícil que el original: 49% en el motor léxico y 57%
  como se instala. Y da más falsa confianza: 11 y 8 de sus 20 distractores
  salen con puntuación de acierto real.
- **La capa semántica importa más cuanto más grande es el cerebro.** Sin pajar,
  en el examen original queda 2 puntos por debajo del motor léxico (75 frente
  a 77). Con 1.482 hechos de relleno queda 13 por encima (67 frente a 54), y en
  el examen nuevo 17 (48 frente a 31).
- Todo esto es recall de un hecho por pregunta. No mide si el agente usa bien
  lo que encuentra: eso lo mide la sección agéntica de arriba.

**Las ocho configuraciones del examen original, en 2.7.2** (mismos ficheros
congelados que en la tabla de 2.7.1):

| configuración | recall@1 | recall@3 | MRR | con also_matched @1 / @3 | distractores confiados |
|---|--:|--:|--:|--:|--:|
| motor léxico | 77% | 83% | 0.806 | 77% / 83% | 2 / 14 |
| + reformulaciones | 77% | 90% | 0.843 | 79% / 92% | 1 / 14 |
| + palabras clave | 83% | 92% | 0.879 | 83% / 94% | 0 / 14 |
| + palabras clave + reformulaciones | 88% | 94% | 0.899 | 92% / 100% | 1 / 14 |
| capa semántica (como se instala) | **75%** | **81%** | 0.781 | 81% / 90% | 0 / 14 |
| semántica + reformulaciones | 79% | 85% | 0.831 | 85% / 92% | 1 / 14 |
| semántica + palabras clave | 83% | 90% | 0.865 | 85% / 94% | 0 / 14 |
| **todo activado** | **92%** | **96%** | **0.934** | 94% / 98% | 0 / 14 |

Se reproduce con `CRBRO_BENCH_QUERIES=benchmarks/retrieval/test2.json` (o
`dev.json`) y `CRBRO_BENCH_HAYSTACK=benchmarks/retrieval/haystack-1.json,benchmarks/retrieval/haystack-2.json,benchmarks/retrieval/haystack-3.json`
(rutas relativas: con rutas de Git Bash del tipo `/c/…` Node no las abre).

## Security — el filtro de redacción

Un **piso, no una prueba** de seguridad (como dice Ponytail de su check
determinista). 20 credenciales en formas adversariales + 19 textos inocentes
con pinta de secreto.

| | resultado |
|---|--:|
| **captura** | 20/20 (100%) |
| **falsos positivos** | 0/19 (0%) |

Un 100% sobre un conjunto CONGELADO es un piso, no una garantía: significa que
ninguna forma de evasión *conocida* pasa, no que ninguna forma pase. El
conjunto crece cuando aparece una nueva (y cada patrón nuevo trae consigo sus
inocentes-cebo: por eso hay 19 y no 14). La cifra de falsos positivos es la que
casi nadie publica: un filtro que grita a todo acaba desactivado.

> Historia de este número, sin maquillar: la primera ejecución encontró que el
> filtro cazaba solo el **45%** — dejaba pasar DSN de base de datos,
> contraseñas en prosa y `API_KEY=`. Se reforzó a 80%. Los 4 que aún se
> colaban (AWS secret en prosa, contraseña con ñ, clave partida en dos frases,
> Twilio) se publicaron como issues conocidos, y en la iteración siguiente se
> cazaron con patrones anclados a formas inequívocas — cada uno con su inocente
> gemelo en la lista para vigilar que no gritan de más. Para eso existe el
> benchmark.

## Cost — la cifra en contra

CRBRO no es gratis, y publicarlo es lo que hace creíble el resto.

- **~1.000 tokens** de contexto que el arranque añade a cada sesión (el bloque
  de protocolos de Card Zero, 4.035 caracteres con sus diez protocolos, medido
  el 03-10-2026 con `node benchmarks/cost/run.mjs`; eran ~750 con nueve), y lo
  mismo por cada subagente que inyecta el hook.
- **~7,4k tokens** de definiciones de las 15 tools en 2.7.1: 29.757 caracteres
  de descripción + esquema de entrada (11.545 + 18.212), medidos el 03-10-2026
  con un `tools/list` real — un `listTools()` del cliente del SDK contra el
  servidor sobre `InMemoryTransport`, como hace
  `tests/tool.definitions.test.ts` — y divididos por 4, la aproximación de
  caracteres por token de siempre, no un recuento de tokenizador. Con los
  esquemas de salida de las tres tools de lectura el payload completo son
  35.276 caracteres (~8,8k tokens). En 2.0 (03-09-2026) eran 25.866 y 34.047. Lo pagan en cada petición los clientes que
  cargan todas las tools (Claude Desktop, Cursor); Claude Code las difiere y
  paga solo las que usa. Menos tools no es menos texto: las 23 de 1.13 medían
  21.662 caracteres (~5,4k tokens), porque cada parámetro absorbido sigue
  explicándose en la tool que lo acogió — `crbro_inspect` sola pesa 5.529
  caracteres con sus cinco vistas y su esquema de salida. En 1.12 eran 25.086
  caracteres (~6,3k tokens) y no se decía.
- **~1 ms** de latencia por recall con el motor léxico y **~10 ms** con la
  capa semántica, que calcula el vector de la pregunta (local, sin red, cerebro
  de 300 hechos; medido el 03-10-2026 con `benchmarks/cost/run.mjs`). Se
  publicaba ~0,15 ms, medido antes de que la capa semántica viniera de serie.
- El cerebro de referencia: 1.145 neuronas, ~30 MB en disco (índice 25 MB).

En una sesión sin memoria relevante, eso es coste puro; se amortiza cuando hay
algo que recordar.
