import { describe, expect, it } from 'vitest';

import { canonicalJson, hashRequest } from './request-hash.js';

describe('request fingerprint (spec 01, section 5)', () => {
  it('ignores key order', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,1]},"b":1}',
    );
    expect(hashRequest('POST', '/x', { a: 1, b: 2 })).toBe(
      hashRequest('post', '/x', { b: 2, a: 1 }),
    );
  });

  it('changes with the method, the path or the body', () => {
    const base = hashRequest('POST', '/api/v1/tabs', { name: 'A' });
    expect(hashRequest('PATCH', '/api/v1/tabs', { name: 'A' })).not.toBe(base);
    expect(hashRequest('POST', '/api/v1/orders', { name: 'A' })).not.toBe(base);
    expect(hashRequest('POST', '/api/v1/tabs', { name: 'B' })).not.toBe(base);
  });
});
