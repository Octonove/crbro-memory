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
| **motor CRBRO (BM25 por chunks)** | 56% | 69% | 0.634 |
| control (subcadena ingenua) | 38% | 58% | — |

**Distractores:** 14 consultas sobre temas que NO están guardados. **10 de 14
devuelven algo**, 4 con un score tan alto como un acierto real. Ese es el modo
de fallo silencioso de una memoria por palabras clave, y va aquí, no escondido.

**Lectura honesta:** con consultas parafraseadas, recall@3 se queda en 69%.
BM25 no tiene sinónimos, y [descartamos la búsqueda semántica a sabiendas](LIMITS.md)
por no cargar un modelo de 472 MB. Ese 69% es el **precio conocido** de esa
decisión, no un fallo a tapar. Con las mismas palabras que el texto guardado,
sube mucho; con paráfrasis, esto es lo que hay.

## Security — el filtro de redacción

Un **piso, no una prueba** de seguridad (como dice Ponytail de su check
determinista). 20 credenciales en formas adversariales + 14 textos inocentes
con pinta de secreto.

| | resultado |
|---|--:|
| **captura** | 16/20 (80%) |
| **falsos positivos** | 0/14 (0%) |

Los 4 que se colan (secreto suelto sin etiqueta, contraseña con carácter no
ASCII, secreto partido en dos frases, un par de tokens de proveedor menor) van
como issues conocidos. La cifra de falsos positivos es la que casi nadie
publica: un filtro que grita a todo acaba desactivado.

> Este mismo benchmark, en su primera ejecución, encontró que el filtro cazaba
> solo el 45% — dejaba pasar DSN de base de datos, contraseñas en prosa y
> `API_KEY=`. Se reforzaron los patrones (a 80%) manteniendo el 0% de ruido.
> Para eso existe el benchmark.

## Cost — la cifra en contra

CRBRO no es gratis, y publicarlo es lo que hace creíble el resto.

- **~753 tokens** de contexto que el arranque añade a cada sesión (el bloque de
  protocolos), y lo mismo por cada subagente que inyecta el hook.
- **~0,15 ms** de latencia por recall (local, sin red).
- El cerebro de referencia: 1.138 neuronas, ~27 MB en disco.

En una sesión sin memoria relevante, eso es coste puro; se amortiza cuando hay
algo que recordar.
