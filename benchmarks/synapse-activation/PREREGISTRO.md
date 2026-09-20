# Pre-registro: ¿debe una sinapsis influir en el ranking de recall?

Escrito y commiteado **antes** de implementar y de medir. El historial de git es
el pre-registro: si este fichero cambia después de `results.json`, el experimento
no vale.

## Contexto

Hasta la 2.5 las sinapsis no intervienen en `crbro_recall`. Se crean (a mano con
`crbro_connect`, o solas entre las neuronas escritas en una misma sesión), decaen
y se podan, pero el ranking no las mira. La intuición dice que deberían contar:
si dos neuronas conectadas responden a la misma pregunta, cada una hace más
probable a la otra. La intuición no es una medición.

## Hipótesis

Dar a una neurona un pequeño impulso cuando una vecina suya por sinapsis también
ha puntuado para la consulta mejora la posición de la entrada correcta.

## Mecanismo (el único que se prueba)

En `materializeResults`, para cada neurona candidata `N` con vecinas `V` (su
campo `connections`) que también son candidatas:

    relevancia(N) *= 1 + w * max(relevancia(V)) / max(relevancia de todas)

`w` se lee de `CRBRO_SYNAPSE`; `0` o ausente = apagado. No se toca nada más: ni
qué chunk habla por la neurona, ni las etiquetas de confianza.

## Brazos

| brazo | `w` |
|---|---|
| control | 0 |
| A | 0.05 |
| B | 0.10 |

## Datos

1. **Benchmark ciego congelado** (`benchmarks/retrieval`, 48 consultas + 14
   distractores). Su fixture no tiene sinapsis: los tres brazos deben dar
   exactamente lo mismo. Es la prueba de que la función es inerte donde debe.
2. **Búsqueda de elemento conocido sobre una copia del cerebro de referencia**
   (restaurada de una copia de seguridad; 1.200 neuronas, 143 sinapsis reales).
   Las consultas se generan por regla, sin intervención humana: de cada neurona
   con 3 o más entradas vivas se toma una de cada 5 entradas (en orden de
   fichero); la consulta son sus 3 palabras distintas más largas de 6+ letras; la
   respuesta esperada es esa entrada (por `entry_id`). Se descartan las entradas
   con menos de 3 palabras así. Este conjunto tiene fuga de vocabulario por
   construcción, así que sus cifras absolutas no significan nada: **solo cuenta
   la diferencia entre brazos**, que comparten la misma fuga.
   Además se informa, aparte, del subconjunto de consultas cuya neurona esperada
   tiene al menos una sinapsis — el único sitio donde el mecanismo puede actuar.

## Métricas

recall@1, recall@3 y MRR a nivel de entrada (solo el resultado principal de cada
neurona, sin contar `also_matched`), con `limit: 10`, motor léxico
(`CRBRO_SEMANTIC=0`) y `CRBRO_RECENCY` en su valor por defecto.

## Regla de decisión

Se **adopta** (y se enciende por defecto con el `w` ganador) solo si, en el
conjunto 2, algún brazo cumple las tres a la vez frente al control:

- recall@3 sube **al menos 1,0 punto porcentual**,
- recall@1 **no baja**,
- MRR **no baja**,

y en el conjunto 1 los tres brazos son idénticos.

En cualquier otro caso se **descarta**: el código del mecanismo se elimina del
motor (no se deja dormido detrás de una variable), y quedan en el repo este
pre-registro, el script y `results.json` para que nadie lo vuelva a intentar a
ciegas. Un resultado nulo es un resultado.

## Lo que este experimento no puede decir

Que las sinapsis «no sirven». Sirven para el mapa global, para el calor y para
navegar entre neuronas; aquí solo se mide si deben mover el ranking de una
búsqueda por texto, con este mecanismo y sobre este cerebro.
