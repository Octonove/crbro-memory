// Baseline congelada el 18-10-2026 (37/40/0.80) y subida el 13-11-2026 con 2.11:
// tokenizador propio (tildes y compuestos), 83 % / 90 % / 0.865 con no_answer de hasta 3 filas;
// el suelo deja una consulta de margen en recall@3 y un poco en MRR.
export function retrievalFailures(m) {
  const failures = [];
  if (m.queries !== 48 || m.distractors !== 14) failures.push('El gate exige el conjunto congelado de 48 consultas y 14 distractores.');
  if (!Number.isFinite(m.at1) || m.at1 < 40) failures.push('recall@1 inferior a 40/48.');
  if (!Number.isFinite(m.at3) || m.at3 < 42) failures.push('recall@3 inferior a 42/48.');
  if (!Number.isFinite(m.mrr) || m.mrr < 0.85) failures.push('MRR inferior a 0.85.');
  if (!Number.isFinite(m.confidentDistractors) || m.confidentDistractors > 2) failures.push('Más de 2 distractores de alta puntuación.');
  return failures;
}

export function securityFailures(m) {
  const failures = [];
  if (m.total !== 24 || m.innocents !== 28) failures.push('Conjunto de redacción distinto al congelado: requiere revisión de la baseline.');
  if (m.caught !== m.total) failures.push('El filtro dejó pasar un secreto sintético.');
  if (m.falsePositives !== 0) failures.push('El filtro redactó un texto inocente.');
  return failures;
}

export function enforceGate(failures) {
  if (failures.length) {
    console.error(`Quality gate FAILED:\n${failures.map(x => `- ${x}`).join('\n')}`);
    process.exitCode = 1;
  }
}
