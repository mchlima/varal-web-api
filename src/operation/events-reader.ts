import { isoDateOf } from '../common/time.js';
import { AppError } from '../errors/app-error.js';
import type { ContractedEvent, Prisma } from '../generated/prisma/client.js';
import type { TenantDb } from '../prisma/prisma.service.js';
import type { ContractedEventDto } from './events.schemas.js';

export const eventInclude = {
  priceList: { select: { id: true, name: true } },
} satisfies Prisma.ContractedEventInclude;

export type EventRow = ContractedEvent & { priceList: { id: string; name: string } | null };

export function toEventDto(row: EventRow): ContractedEventDto {
  const actor = (type: ContractedEvent['startedByType'], id: string | null) =>
    type === null ? null : { type, id };
  return {
    id: row.id,
    unitId: row.unitId,
    contractorName: row.contractorName,
    startsOn: isoDateOf(row.startsOn),
    endsOn: row.endsOn === null ? null : isoDateOf(row.endsOn),
    priceList: row.priceList,
    modality: row.modality,
    agreedAmountCents: row.agreedAmountCents,
    agreedQuantity: row.agreedQuantity,
    limits: row.limits,
    notes: row.notes,
    status: row.status,
    startedAt: row.startedAt?.toISOString() ?? null,
    startedBy: actor(row.startedByType, row.startedById),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    finishedBy: actor(row.finishedByType, row.finishedById),
    canceledAt: row.canceledAt?.toISOString() ?? null,
    version: row.version,
  };
}

export async function loadEvent(db: TenantDb, id: string): Promise<ContractedEventDto> {
  const row = await db.contractedEvent.findUnique({ where: { id }, include: eventInclude });
  if (!row) {
    throw AppError.of('NOT_FOUND');
  }
  return toEventDto(row);
}
