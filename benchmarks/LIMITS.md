# Límites: lo que NO afirmamos, y por qué

La otra mitad de un benchmark honesto es la lista de lo que sería fácil
proclamar y no se puede medir de forma creíble. Se documenta para no caer en
ello — ni en el README, ni en la web.

## Afirmaciones que no hacemos

1. **«Trabajas N% más rápido» / «te ahorra N horas».** Es productividad humana:
   exigiría un estudio con usuarios reales, n inalcanzable y confounds sin
   control. No se afirma en ningún sitio.

2. **«El asistente te conoce» / calidad de la personalización.** Un juez mediría
   sensaciones. No es un número.

3. **«Nunca repite un error» / «nunca pierde nada».** Son negativos universales:
   solo se pueden falsar, no probar. La forma medible existe (ver abajo,
   benchmarks agénticos) y da una tasa acotada, jamás un «nunca».

4. **Comparativas propias contra mem0 / Letta / Zep.** Hacerla justa —cada
   sistema con su configuración óptima— es un proyecto de investigación; hacerla
   injusta invita al desmentido. Si algún día hay comparativa, será enlazando
   mediciones de terceros, no cifras nuestras.

5. **«La fusión de equipo nunca pierde datos.»** Es una propiedad del código:
   pertenece a la suite de tests (139 en verde), no a un benchmark. Publicarla
   como número sería teatro.

6. **Telemetría de clientes como «evidencia».** No es un experimento controlado
   y tiene problema de privacidad. Nunca.

## Los benchmarks agénticos (pendientes, no falsos)

Lo determinista de `benchmarks/` mide componentes. La afirmación insignia —«una
sesión nueva no vuelve a preguntar lo que ya sabe»— necesita un agente real, y
está diseñada pero no construida. Cuando se haga, estas trampas la gobiernan:

- **Efecto del modelo subyacente:** todo resultado fija modelo + versión de
  Claude Code. Las conductas de prompt (la dieta, la carta) pueden no transferir
  a modelos pequeños; se dice.
- **Contaminación entre brazos — el riesgo número uno aquí:** CRBRO tiene hooks
  SessionStart/Stop/PreCompact y ahora SubagentStart. El brazo baseline debe
  correr con `--strict-mcp-config` (nada de CRBRO), un `HOME` limpio por celda, y
  el CLAUDE.md global excluido — o Card Zero y el Orquestador correrían en el
  baseline y lo envenenarían. En un benchmark de memoria, la contaminación entre
  sesiones **es el producto funcionando cuando no debe**.
- **El eje de seguridad de una memoria:** el modo de fallo no es «no ayudó», es
  «usó un valor viejo con confianza». La tasa de valor-equivocado va en la misma
  tabla que el ahorro, siempre. (Se siembra con hechos retirados vía
  `crbro_revise` — de paso es el test de regresión del bug de recall de la 1.9.)
- **Cherry-picking:** la lista de tareas se congela en git antes del primer run;
  cada tanda incluye tareas donde CRBRO no debería ganar; el titular es el
  agregado con su rango, nunca el pico.

## La frase-paraguas honesta

Lo que todo esto permite decir, calcando la corrección pública de Ponytail:

> CRBRO ayuda mucho donde hay algo que recordar, nada donde no lo hay, no
> responde con más seguridad de la que merece — y esto es lo que cuesta.
