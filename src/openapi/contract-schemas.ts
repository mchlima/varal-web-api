import type { z } from 'zod';

/**
 * Names a real-time event payload schema. Events are published in `components.schemas`
 * with the `Event` prefix, e.g. `EventOrderCreated` (RN-01.10).
 */
export function defineEvent<T extends z.ZodType>(id: `Event${string}`, schema: T): T {
  return schema.meta({ id });
}

/**
 * Schemas that must appear in `components.schemas` even when no route references them:
 * state enums (`TabStatus`, `OrderStatus`…) and real-time event payloads (RN-01.10).
 * Each one is named with `.meta({ id })` (or {@link defineEvent}). Business enums arrive in phase 1.
 */
export const contractSchemas: readonly z.ZodType[] = [];
