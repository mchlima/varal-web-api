import { describe, expect, it } from 'vitest';

import {
  decodeCursor,
  decodeKeysetCursor,
  encodeCursor,
  encodeKeysetCursor,
  KeysetPaginationQuerySchema,
  pageArgs,
  PaginationQuerySchema,
  toPage,
} from './pagination.js';

const ID = '01922f2c-7a3b-7c00-8000-000000000001';

describe('cursor pagination (spec 01, section 5)', () => {
  it('round-trips an opaque cursor', () => {
    const cursor = encodeCursor(ID);
    expect(cursor).not.toContain(ID);
    expect(decodeCursor(cursor)).toBe(ID);
  });

  it.each(['', 'abc', encodeCursor('not-a-uuid'), Buffer.from(ID).toString('base64url')])(
    'rejects a cursor it did not produce: %j',
    (cursor) => {
      expect(decodeCursor(cursor)).toBeNull();
    },
  );

  it('parses ?limit=&cursor= with defaults and bounds', () => {
    expect(PaginationQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(PaginationQuerySchema.parse({ limit: '10', cursor: encodeCursor(ID) }).limit).toBe(10);
    expect(PaginationQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(PaginationQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(PaginationQuerySchema.safeParse({ cursor: 'garbage' }).success).toBe(false);
  });

  it('builds Prisma args ordered by id with one extra row', () => {
    expect(pageArgs({ limit: 2 })).toEqual({ where: {}, orderBy: { id: 'asc' }, take: 3 });
    expect(pageArgs({ limit: 2, cursor: encodeCursor(ID) }, 'desc')).toEqual({
      where: { id: { lt: ID } },
      orderBy: { id: 'desc' },
      take: 3,
    });
  });

  it('rejects an invalid cursor with VALIDATION_FAILED', () => {
    expect(() => pageArgs({ limit: 2, cursor: 'x' })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }) as Error,
    );
  });

  it('returns nextCursor only when there is another page', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(toPage(rows, 2)).toEqual({ data: rows.slice(0, 2), nextCursor: encodeCursor('b') });
    expect(toPage(rows, 3)).toEqual({ data: rows, nextCursor: null });
  });
});

describe('keyset cursor (lists ordered by name or date)', () => {
  it('round-trips the key and the id', () => {
    const cursor = encodeKeysetCursor('Dona Márcia', ID);
    expect(cursor).not.toContain(ID);
    expect(decodeKeysetCursor(cursor)).toEqual({ key: 'Dona Márcia', id: ID });
    expect(KeysetPaginationQuerySchema.parse({ cursor, limit: '5' })).toEqual({ cursor, limit: 5 });
  });

  it.each([
    '',
    encodeCursor(ID),
    Buffer.from('k1:not json').toString('base64url'),
    Buffer.from('k1:["a","not-a-uuid"]').toString('base64url'),
    Buffer.from('k1:[1,"x"]').toString('base64url'),
  ])('rejects a cursor it did not produce: %j', (cursor) => {
    expect(decodeKeysetCursor(cursor)).toBeNull();
    expect(KeysetPaginationQuerySchema.safeParse({ cursor }).success).toBe(false);
  });
});
