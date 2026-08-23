// ─── Regressions from the 1.11 adversarial review ────────────────
//
// Three secret-pattern findings, each confirmed by an executed test in the
// review, each fixed and pinned here so it cannot come back.

import { describe, it, expect } from 'vitest';
import { redact, secretKinds } from '../src/engine/secrets.js';

describe('redact does not eat legitimate prose around a secret', () => {
  it('keeps the words after a key when two patterns overlap the same span', () => {
    const r = redact('la clave es AIzaSyC3xK9mP2qR7tV4wX1yZ8aB5cD6eF7gH8i guárdala en la bóveda');
    expect(r.text).toContain('guárdala en la bóveda');
    expect(r.text).toContain('[REDACTED:');
    expect(r.text).not.toContain('AIzaSy');
  });

  it('keeps the trailing sentence for a labelled OpenAI/Anthropic key', () => {
    const r = redact('password = sk-ant-abcdefghij0123456789klmnop y no la compartas jamás');
    expect(r.text).toContain('y no la compartas jamás');
    expect(r.text).not.toContain('sk-ant-');
  });
});

describe('password (prose) needs a real digit, not just emphasis', () => {
  it('does not redact an emphatic sentence with no digit', () => {
    expect(secretKinds('la clave es importante para el SEO de la página')).toEqual([]);
    expect(secretKinds('the password is essential! keep it in mind')).toEqual([]);
  });
  it('still catches a real prose password', () => {
    expect(secretKinds('la contraseña es Muñoz2024Reformas')).toContain('password (prose)');
  });
});

describe('generic API key/secret does not swallow filesystem paths', () => {
  it('leaves a path to where a key lives alone', () => {
    expect(secretKinds('secret: /etc/ssl/private/servers/keystore/main')).toEqual([]);
    expect(secretKinds('access_key: /var/lib/data/some/very/long/path/here')).toEqual([]);
  });
  it('leaves an all-alpha placeholder alone', () => {
    expect(secretKinds('token: your-api-token-goes-here-for-the-demo')).toEqual([]);
  });
  it('still catches a real token-shaped value', () => {
    expect(secretKinds('api_key=9f8e7d6c5b4a39281706f5e4d3c2b1a0abcd')).toContain('generic API key/secret');
  });
});

describe('the four misses from the first security benchmark, now caught', () => {
  it('AWS secret key stated in prose (40 base64 chars, mixed case + digit)', () => {
    expect(secretKinds('el secret access key vale wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'))
      .toContain('AWS secret key');
  });
  it('but not a label with no value, nor a path after the label', () => {
    expect(secretKinds('el secret access key está guardado en la bóveda DPAPI')).toEqual([]);
    expect(secretKinds('el secret key vive en /etc/ssl/private/server.pem del VPS')).toEqual([]);
  });

  it('Spanish prose password with a qualifier between label and copula', () => {
    expect(secretKinds('la contraseña de WP-Admin es Muñoz2024$Reformas! no la pierdas'))
      .toContain('password (prose)');
  });
  it('but not a qualified phrase with no digit in the value', () => {
    expect(secretKinds('la clave del éxito es la constancia y el enfoque')).toEqual([]);
  });

  it('a credential dictated in two pieces', () => {
    expect(secretKinds('el token empieza por ghp_ y sigue con 1234567890abcdefghijklmnopqrstuvwxyzAB'))
      .toContain('split credential');
  });
  it('but not prose about where something begins, with no token tail', () => {
    expect(secretKinds('el token empieza por gh y sigue con el resto que te dije por teléfono')).toEqual([]);
  });

  it('Twilio SID and a labelled hex auth token', () => {
    const kinds = secretKinds('ACb1234567890abcdef1234567890abcdef con su auth token 0123456789abcdef0123456789abcdef');
    expect(kinds).toContain('Twilio account SID');
    expect(kinds).toContain('auth token (hex)');
  });
  it('but not the words "auth token" in ordinary prose', () => {
    expect(secretKinds('auth token caducado desde marzo, renuévalo en el panel')).toEqual([]);
  });
});
