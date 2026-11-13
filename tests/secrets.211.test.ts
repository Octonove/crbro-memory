// 2.11 redaction: the whole private key, and the label-without-separator forms
// that passed in 2.10 ("PASS value", "la contraseña value ("), without new noise.
import { describe, it, expect } from 'vitest';
import { redact, secretKinds } from '../src/engine/secrets.js';
import * as hook from '../hooks/crbro-lifecycle.mjs';

// Synthetic values, assembled so no full key sits in the source.
const J = (...p: string[]) => p.join('');
const BODY1 = J('MIIEowIBAAKCAQEA', 'u1SU1LfVLPHCozMxH2Mo');
const BODY2 = J('4lgOEePzNm0tRgeL', 'ezV6ffAt0gunVTLw7onLRnrq0');

describe('private key block (G7)', () => {
  it('consumes the body through the END line', () => {
    const t = `antes\n-----BEGIN RSA PRIVATE KEY-----\n${BODY1}\n${BODY2}==\n-----END RSA PRIVATE KEY-----\ndespués`;
    const r = redact(t);
    expect(r.text).toBe('antes\n[REDACTED: private key block]\ndespués');
  });

  it('without an END line, consumes the base64 body and stops at prose', () => {
    const t = `-----BEGIN OPENSSH PRIVATE KEY-----\n${BODY1}${BODY2}\n${J('djEAAA', 'AABG5vbmU=')}\n\nY después prosa normal.`;
    const r = redact(t);
    expect(r.text).not.toContain(BODY1);
    expect(r.text).not.toContain('djEAAA');
    expect(r.text).toContain('Y después prosa normal.');
  });

  it('a public key is not a private key', () => {
    expect(secretKinds('-----BEGIN PUBLIC KEY----- es pública y puede ir en el repo')).toEqual([]);
  });
});

describe('label without separator (INFORME §2 row 6)', () => {
  const cazar: Array<[string, string]> = [
    ['USER admin PASS ' + J('Xy7kk', '22Wq') + ' para el panel', J('Xy7kk', '22Wq')],
    ['usuario admin pass ' + J('Xy7#k', 'k22w') + ' para el panel', J('Xy7#k', 'k22w')],
    ['la contraseña ' + J('Rf7kk', '22Wz') + ' (la del panel)', J('Rf7kk', '22Wz')],
    ['user admin pass: ' + J('Hunter', '2024x') + ' ok', J('Hunter', '2024x')],
  ];
  for (const [t, v] of cazar) {
    it(`redacts the value in «${t.slice(0, 22)}…» and keeps the label`, () => {
      const r = redact(t);
      expect(r.text).not.toContain(v);
      expect(r.found).toContain('password');
      expect(r.text).toMatch(/(?:PASS|pass|contraseña):? \[REDACTED: password\]/);
    });
  }

  const prosa = [
    'pass userId42 to the helper function and return early',
    'pass user_id2 as the second param',
    'pass $TOKEN2abc to the script',
    'PASS  tests/keychain.test.ts (12 tests) 40ms',
    'pass: completed en la última corrida',
    'Decisión clave: mantener el plan de octubre',
    'Dato clave: 4-oct-2026 es la fecha de corte',
    'la clave del éxito es la constancia',
    'la contraseña debe tener al menos 12 caracteres',
    'password reset: el enlace caduca en 24 horas',
    // Two shapes the 2.10 filter flagged on a real brain (made-up values).
    'ACCESOS: SSH con CLAVE, no contrasena: key_filename=~/.ssh/id_ejemplo, host.ejemplo:65002',
    '(2) Reset contraseña = Supabase Auth built-in. (3) WELCOME = arreglado.',
  ];
  for (const t of prosa) {
    it(`leaves prose alone: «${t.slice(0, 30)}…»`, () => {
      expect(secretKinds(t)).toEqual([]);
    });
  }

  it('the 2.9.1 labelled forms still work', () => {
    expect(secretKinds('password: correcthorsebattery')).toContain('password');
    expect(secretKinds('contraseña: reformas2026')).toContain('password');
  });
});

describe('the hook copy redacts the same way', () => {
  it('gives identical output on the new cases', () => {
    const t = `-----BEGIN EC PRIVATE KEY-----\n${BODY1}\n-----END EC PRIVATE KEY-----\nPASS ${J('Xy7kk', '22Wq')} y pass ${J('Xy7#k', 'k22w')}`;
    expect(hook.redact(t)).toBe(redact(t).text);
  });
});
