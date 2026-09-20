# Resultado: descartado

Medido el 2026-09-20 según [PREREGISTRO.md](PREREGISTRO.md) (commit `aab5f40`,
anterior a cualquier código). Cifras completas en [results.json](results.json).

| brazo | `w` | recall@1 | recall@3 | MRR | solo neuronas con sinapsis: r@1 · r@3 · MRR |
|---|---|---|---|---|---|
| control | 0 | 80,73 % | 86,41 % | 0,8391 | 81,12 % · 85,25 % · 0,8343 |
| A | 0,05 | 80,73 % | 86,26 % | 0,8387 | 81,12 % · 85,25 % · 0,8343 |
| B | 0,10 | 80,57 % | 86,41 % | 0,8378 | 81,42 % · 85,55 % · 0,8365 |

633 consultas de elemento conocido sobre una copia del cerebro de referencia
(1.199 neuronas, 143 sinapsis), 339 de ellas sobre neuronas que tienen alguna
sinapsis. El benchmark ciego congelado da lo mismo en los tres brazos
(71 % · 77 % · 0,744): el mecanismo era inerte donde debía.

La regla pedía +1,0 punto en recall@3 sin bajar recall@1 ni MRR. El mayor
movimiento fue de 0,15 puntos, y en el brazo B recall@1 y MRR bajan. Incluso
mirando solo las neuronas con sinapsis —el único sitio donde el mecanismo
puede actuar— la mejora máxima es de 0,3 puntos: una consulta de 339.

**Decisión: descartado.** El mecanismo se ha eliminado del motor. Existió
únicamente en el commit `69917ce`, detrás de `CRBRO_SYNAPSE`; para reproducir
la medición hay que situarse en ese commit:

    git checkout 69917ce && npm run build
    node benchmarks/synapse-activation/run.mjs <copia.json.gz>

## Por qué, probablemente

Las sinapsis de este cerebro son casi todas temporales («escritas en la misma
sesión»): dicen que dos temas se trabajaron el mismo día, no que respondan a la
misma pregunta. Y una búsqueda por texto que ya encuentra la entrada en primer
lugar el 81 % de las veces deja poco margen a una señal tan indirecta. Si algún
día las sinapsis se crean por contenido y no por coincidencia de sesión, el
experimento merece repetirse — con este mismo pre-registro.
