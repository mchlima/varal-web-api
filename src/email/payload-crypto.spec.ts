import { describe, expect, it } from 'vitest';

import { PayloadCipher } from './payload-crypto.js';

describe('PayloadCipher', () => {
  const cipher = new PayloadCipher('s'.repeat(40));
  const value = { to: 'dono@teste.local', link: 'http://x/definir-senha#token=segredo' };

  it('round-trips and hides the content', () => {
    const encrypted = cipher.encrypt(value);
    expect(encrypted).not.toContain('segredo');
    expect(encrypted).not.toContain('dono@');
    expect(cipher.decrypt(encrypted)).toEqual(value);
    expect(cipher.encrypt(value)).not.toBe(encrypted);
  });

  it('refuses changed payloads and other secrets', () => {
    const encrypted = cipher.encrypt(value);
    const [version, iv, tag, data = ''] = encrypted.split('.');
    const flipped = `${data.slice(0, -2)}${data.endsWith('A') ? 'B' : 'A'}${data.slice(-1)}`;
    expect(() => cipher.decrypt([version, iv, tag, flipped].join('.'))).toThrow();
    expect(() => new PayloadCipher('o'.repeat(40)).decrypt(encrypted)).toThrow();
    expect(() => cipher.decrypt('v2.a.b.c')).toThrow();
  });
});
