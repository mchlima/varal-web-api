import { describe, expect, it } from 'vitest';

import { AppError } from '../errors/app-error.js';
import { updateWithVersion, type VersionedDelegate } from './versioned-update.js';

interface Row {
  id: string;
  status: string;
  version: number;
}

type Where = Record<string, unknown>;

/** In-memory delegate with the semantics of `UPDATE ... WHERE id = $1 AND version = $2`. */
function fakeDelegate(rows: Row[]): VersionedDelegate<Row> & { rows: Row[] } {
  const matches = (row: Row, where: Where): boolean => {
    if (Array.isArray(where.AND)) {
      return (where.AND as Where[]).every((part) => matches(row, part));
    }
    return Object.entries(where).every(([key, value]) => row[key as keyof Row] === value);
  };
  return {
    rows,
    updateManyAndReturn({ where, data }) {
      const updated = rows.filter((row) => matches(row, where));
      for (const row of updated) {
        Object.assign(row, { ...data, version: row.version + 1 });
      }
      return Promise.resolve(updated.map((row) => ({ ...row })));
    },
    findFirst({ where }) {
      const row = rows.find((candidate) => matches(candidate, where));
      return Promise.resolve(row ? { version: row.version } : null);
    },
  };
}

describe('updateWithVersion (optimistic concurrency, AGENTS.md rule 4)', () => {
  it('updates and increments the version when it matches', async () => {
    const delegate = fakeDelegate([{ id: 't1', status: 'open', version: 3 }]);
    await expect(
      updateWithVersion(delegate, {
        where: { id: 't1' },
        expectedVersion: 3,
        data: { status: 'closed' },
      }),
    ).resolves.toEqual({ id: 't1', status: 'closed', version: 4 });
  });

  it('answers 409 VERSION_CONFLICT with the current version when another device changed it first', async () => {
    const delegate = fakeDelegate([{ id: 't1', status: 'open', version: 5 }]);
    const attempt = updateWithVersion(delegate, {
      where: { id: 't1' },
      expectedVersion: 4,
      data: { status: 'closed' },
    });
    await expect(attempt).rejects.toBeInstanceOf(AppError);
    await expect(attempt).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { currentVersion: 5 },
    });
    expect(delegate.rows[0]).toEqual({ id: 't1', status: 'open', version: 5 });
  });

  it('lets a module use its own conflict code (e.g. ITEM_CHANGED, spec 04)', async () => {
    const delegate = fakeDelegate([{ id: 'i1', status: 'prep', version: 2 }]);
    await expect(
      updateWithVersion(delegate, {
        where: { id: 'i1' },
        expectedVersion: 1,
        data: { status: 'ready' },
        onConflict: (currentVersion) =>
          new AppError('ITEM_CHANGED', 409, 'Outro aparelho mudou este item.', { currentVersion }),
      }),
    ).rejects.toMatchObject({ code: 'ITEM_CHANGED', details: { currentVersion: 2 } });
  });

  it('answers 404 when the record does not exist (or belongs to another organization)', async () => {
    await expect(
      updateWithVersion(fakeDelegate([]), { where: { id: 'x' }, expectedVersion: 1, data: {} }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
