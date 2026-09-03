# CRBRO — benchmarks

Números defendibles, con las cifras en contra al lado. Tomamos prestada la
disciplina de [Ponytail](https://github.com/DietrichGebert/ponytail): baseline
justo, tareas fijadas antes de medir, los fallos publicados, y lo no medible de
forma creíble **no se afirma**.

Todo lo de aquí es **determinista y sin coste de API**: mismo resultado en cada
ejecución, corre en CI. Los benchmarks agénticos (con un agente real gastando
tokens) son un paso posterior, documentado en [LIMITS.md](LIMITS.md).

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
Eso solo lo cierra un modelo semántico, y el que se descartó en 1.4 por «472
MB» era el fp32: el int8 de `multilingual-e5-small` pesa 118 MB. Desde 1.14
existe como **capa opcional** (`CRBRO_SEMANTIC=1` + `npx crbro-memory
semantic install`); sin activarla, el motor es el de 1.13 byte a byte.

## Retrieval con la capa semántica (1.14, `CRBRO_SEMANTIC=1`)

Mismas 48 consultas, mismos 14 distractores. Vectores de
`Xenova/multilingual-e5-small` (int8) fusionados con BM25 por rango recíproco
(RRF, k=60). Un candidato que solo trae el vector se descarta por debajo de
un suelo de coseno, y se marca `strong` a partir de 0.86.

| | recall@1 | recall@3 | MRR | distractores con score de acierto |
|---|--:|--:|--:|--:|
| motor léxico 1.13 | 71% | 77% | 0.744 | 2 / 14 |
| solo vectores | 60% | 83% | — | — |
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
de ms por consulta. Por eso es opcional y va a seguir siéndolo.

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

- **~750 tokens** de contexto que el arranque añade a cada sesión (el bloque de
  protocolos), y lo mismo por cada subagente que inyecta el hook.
- **~5,4k tokens** de definiciones de las 23 tools (descripción + esquema de
  entrada, 21.662 caracteres medidos con un `tools/list` real), que pagan en
  cada petición los clientes que cargan todas las tools (Claude Desktop,
  Cursor); Claude Code las difiere y paga solo las que usa. En 1.12 eran
  25.086 caracteres (~6,3k tokens) y no se decía.
- **~0,15 ms** de latencia por recall (local, sin red).
- El cerebro de referencia: 1.145 neuronas, ~30 MB en disco (índice 25 MB).

En una sesión sin memoria relevante, eso es coste puro; se amortiza cuando hay
algo que recordar.
