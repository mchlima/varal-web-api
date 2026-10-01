import { z } from 'zod';

/** Path ids of the admin routes (UUID v7). An invalid id is `VALIDATION_FAILED` (400). */
export const IdParamSchema = z.uuid({ error: 'Identificador inválido.' });

/** Free text of a reason (status changes RN-02.11, "entrar como" RN-02.17). */
export function reasonSchema(min: number) {
  return z
    .string({ error: 'Informe o motivo.' })
    .trim()
    .min(min, { error: `O motivo precisa ter pelo menos ${min} caracteres.` })
    .max(500, { error: 'O motivo pode ter no máximo 500 caracteres.' });
}

export const PersonNameSchema = z
  .string({ error: 'Informe o nome.' })
  .trim()
  .min(2, { error: 'O nome precisa ter pelo menos 2 caracteres.' })
  .max(120, { error: 'O nome pode ter no máximo 120 caracteres.' });

/** E-mail of owners and admins: trimmed and lowercase (spec 01, section 12). */
export const EmailInputSchema = z
  .string({ error: 'Informe o e-mail.' })
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: 'E-mail inválido.' }).max(254, { error: 'E-mail longo demais.' }));

/** Optional `from`/`to` instants of the list filters (ISO 8601 with offset). */
export const InstantFilterSchema = z.iso
  .datetime({ offset: true, error: 'Use data e hora ISO 8601 (ex.: 2026-10-01T00:00:00-03:00).' })
  .optional();

/** `?search=` of lists: trimmed; empty means no filter. */
export const SearchSchema = z.string().trim().max(120).optional();

/** `?flag=true|false` of lists (query strings have no booleans). */
export const QueryFlagSchema = z.enum(['true', 'false']).optional();

export function flagOf(value: 'true' | 'false' | undefined): boolean | undefined {
  return value === undefined ? undefined : value === 'true';
}
