import { describe, expect, it } from 'vitest';

import { diffChanges, REDACTED } from './changes.js';

describe('diffChanges (spec 01, section 8: only changed fields)', () => {
  it('keeps only the fields that changed', () => {
    expect(
      diffChanges(
        { id: 'u1', name: 'Barraca', active: true, lateAfterMinutes: 15 },
        { id: 'u1', name: 'Barraca da Praça', active: true, lateAfterMinutes: 20 },
      ),
    ).toEqual({
      before: { name: 'Barraca', lateAfterMinutes: 15 },
      after: { name: 'Barraca da Praça', lateAfterMinutes: 20 },
    });
  });

  it('ignores createdAt and updatedAt', () => {
    const changes = diffChanges(
      { name: 'A', updatedAt: new Date('2026-10-01T10:00:00Z') },
      { name: 'A', updatedAt: new Date('2026-10-01T11:00:00Z') },
    );
    expect(changes).toEqual({ before: {}, after: {} });
  });

  it('compares dates, arrays and objects by value and stores dates as ISO 8601', () => {
    const changes = diffChanges(
      { stationIds: ['a', 'b'], closedAt: new Date('2026-10-01T10:00:00Z'), meta: { x: 1 } },
      { stationIds: ['a', 'b'], closedAt: new Date('2026-10-01T12:00:00Z'), meta: { x: 1 } },
    );
    expect(changes).toEqual({
      before: { closedAt: '2026-10-01T10:00:00.000Z' },
      after: { closedAt: '2026-10-01T12:00:00.000Z' },
    });
  });

  it('records every field on creation and on removal', () => {
    expect(diffChanges(null, { name: 'A', active: true })).toEqual({
      before: null,
      after: { name: 'A', active: true },
    });
    expect(diffChanges({ name: 'A' }, null)).toEqual({ before: { name: 'A' }, after: null });
  });

  it('never stores secrets, only that they changed', () => {
    expect(diffChanges({ passwordHash: 'old' }, { passwordHash: 'new' })).toEqual({
      before: { passwordHash: REDACTED },
      after: { passwordHash: REDACTED },
    });
    expect(diffChanges({ passwordHash: null }, { passwordHash: 'new' })).toEqual({
      before: { passwordHash: null },
      after: { passwordHash: REDACTED },
    });
  });
});
