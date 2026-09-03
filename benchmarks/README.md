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

**Lo que sigue faltando:** los 8 fallos que quedan (con also_matched) son
sinónimos que ninguna tabla razonable cubre — «alojadas» → un VPS de Hetzner,
«seguridad» → Wordfence, «proveedor de email» → Mailchimp. Eso solo lo cierra
un modelo semántico, y [seguimos sin cargar uno a sabiendas](LIMITS.md): el
int8 de `multilingual-e5-small` pesa 118 MB, no los 472 del fp32 que se
descartó, y sigue siendo una descarga y una latencia que no se imponen por
defecto.

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
