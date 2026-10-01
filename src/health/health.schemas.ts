import { z } from 'zod';

export const HealthResponseSchema = z
  .object({
    status: z.literal('ok'),
    db: z.enum(['ok', 'unavailable']),
  })
  .meta({ id: 'HealthResponse' });

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
