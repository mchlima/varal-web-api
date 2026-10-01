import { z } from 'zod';

import { AppError } from '../errors/app-error.js';

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

const CURSOR_PREFIX = 'v1:';
const uuidSchema = z.uuid();

/** Opaque cursor: base64url of the last id of the page (UUID v7, so ordered by creation). */
export function encodeCursor(id: string): string {
  return Buffer.from(`${CURSOR_PREFIX}${id}`, 'utf8').toString('base64url');
}

/** Returns the id inside a cursor, or `null` when the cursor was not produced by {@link encodeCursor}. */
export function decodeCursor(cursor: string): string | null {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!decoded.startsWith(CURSOR_PREFIX)) {
    return null;
  }
  const id = decoded.slice(CURSOR_PREFIX.length);
  return uuidSchema.safeParse(id).success ? id : null;
}

/**
 * Query of every paginated list (spec 01, section 5): `?limit=50&cursor=...`.
 * Use with `@Query({ schema: PaginationQuerySchema })`.
 */
export const PaginationQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_LIMIT)
      .default(DEFAULT_PAGE_LIMIT)
      .meta({
        description: `Itens por página (1 a ${MAX_PAGE_LIMIT}, padrão ${DEFAULT_PAGE_LIMIT}).`,
      }),
    cursor: z
      .string()
      .refine((value) => decodeCursor(value) !== null, { message: 'Cursor inválido.' })
      .optional()
      .meta({ description: 'Valor de `nextCursor` da página anterior. Opaco: não monte à mão.' }),
  })
  .meta({ id: 'PaginationQuery' });

export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export interface Page<T> {
  data: T[];
  /** Cursor of the next page; `null` on the last page. */
  nextCursor: string | null;
}

/**
 * Response schema of a paginated list, named `<id>` in the OpenAPI document, e.g.
 * `pageSchema('UnitPage', UnitSchema)` → `{ data: Unit[], nextCursor: string | null }`.
 */
export function pageSchema<T extends z.ZodType>(id: string, item: T) {
  return z
    .object({
      data: z.array(item),
      nextCursor: z
        .string()
        .nullable()
        .meta({ description: 'Cursor da próxima página; `null` na última.' }),
    })
    .meta({ id });
}

export type SortDirection = 'asc' | 'desc';

/**
 * Prisma arguments for one page ordered by id (UUID v7 = creation order). Fetches one extra row to
 * know whether there is a next page. Merge `where` with the filters of the list:
 *
 * ```ts
 * const args = pageArgs(query);
 * const rows = await prisma.db.unit.findMany({ ...args, where: { AND: [filters, args.where] } });
 * return toPage(rows, query.limit);
 * ```
 */
export function pageArgs(query: PaginationQuery, direction: SortDirection = 'asc') {
  const after = query.cursor === undefined ? null : decodeCursor(query.cursor);
  if (query.cursor !== undefined && after === null) {
    throw AppError.of('VALIDATION_FAILED', {
      details: { fields: [{ path: 'cursor', message: 'Cursor inválido.' }] },
    });
  }
  return {
    where: after === null ? {} : { id: direction === 'asc' ? { gt: after } : { lt: after } },
    orderBy: { id: direction },
    take: query.limit + 1,
  } as const;
}

/** Cuts the extra row fetched by {@link pageArgs} and builds `{ data, nextCursor }`. */
export function toPage<T extends { id: string }>(rows: T[], limit: number): Page<T> {
  const data = rows.slice(0, limit);
  const last = data.at(-1);
  return { data, nextCursor: rows.length > limit && last ? encodeCursor(last.id) : null };
}
