import { AppError } from '../errors/app-error.js';

type Where = Record<string, unknown>;

/**
 * The part of a Prisma model delegate the helper needs. Any model with an integer `version`
 * column fits (tabs and order items, spec 04).
 */
export interface VersionedDelegate<Row> {
  updateManyAndReturn(args: { where: Where; data: Where }): PromiseLike<Row[]>;
  findFirst(args: {
    where: Where;
    select: { version: true };
  }): PromiseLike<{ version: number } | null>;
}

export interface VersionedUpdate {
  /** Identifies the record, e.g. `{ id }`. The tenant client adds the organization. */
  where: Where;
  /** The version the client last saw. */
  expectedVersion: number;
  /** Fields to change; `version` is incremented by the helper. */
  data: Where;
  /** Builds the 409 of a module (e.g. `ITEM_CHANGED`, spec 04); default `VERSION_CONFLICT`. */
  onConflict?: (currentVersion: number) => AppError;
}

/**
 * Optimistic concurrency (spec 01; AGENTS.md rule 4): updates only when `version` still equals
 * `expectedVersion`, incrementing it in the same statement. Another device changed the record
 * first → 409 `VERSION_CONFLICT` with `details.currentVersion`; record missing (or of another
 * organization) → 404.
 */
export async function updateWithVersion<Row>(
  delegate: VersionedDelegate<Row>,
  { where, expectedVersion, data, onConflict }: VersionedUpdate,
): Promise<Row> {
  const [updated] = await delegate.updateManyAndReturn({
    where: { AND: [where, { version: expectedVersion }] },
    data: { ...data, version: { increment: 1 } },
  });
  if (updated !== undefined) {
    return updated;
  }
  const current = await delegate.findFirst({ where, select: { version: true } });
  if (current === null) {
    throw AppError.of('NOT_FOUND');
  }
  throw (
    onConflict?.(current.version) ??
    AppError.of('VERSION_CONFLICT', { details: { currentVersion: current.version } })
  );
}
