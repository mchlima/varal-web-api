import type { z } from 'zod';

/**
 * Names a real-time event payload schema. Events are published in `components.schemas`
 * with the `Event` prefix, e.g. `EventOrderCreated` (RN-01.10).
 *
 * In its own file (re-exported by `contract-schemas.ts`) so event modules can use it without an
 * import cycle with the list of contract schemas.
 */
export function defineEvent<T extends z.ZodType>(id: `Event${string}`, schema: T): T {
  return schema.meta({ id });
}
