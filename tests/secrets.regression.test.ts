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
