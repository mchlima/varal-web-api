/**
 * TEST ONLY write route used by the idempotency tests (CA-01.06): creates a unit and its audit row
 * in the transaction opened by the idempotency interceptor. Never ships.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import { Body, Controller, Module, Post } from '@nestjs/common';
import { z } from 'zod';

import { AuditService } from '../../src/audit/audit.service.js';
import { requireOrganizationId } from '../../src/context/request-context.js';
import { AppError } from '../../src/errors/app-error.js';
import { Idempotent } from '../../src/idempotency/idempotent.decorator.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';

const CreateUnitBody = z.object({
  name: z.string().min(1),
  /** Keeps the transaction open, to test concurrent requests with the same key. */
  delayMs: z.number().int().min(0).max(2_000).optional(),
  /** Fails after creating the unit: `client` → 4xx, `server` → 5xx. */
  fail: z.enum(['client', 'server']).optional(),
});

@Controller('test/units')
class UnitsWriteTestController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @Idempotent()
  async create(
    @Body({ schema: CreateUnitBody }) body: z.infer<typeof CreateUnitBody>,
  ): Promise<{ id: string; name: string }> {
    return this.prisma.transaction(async (tx) => {
      const unit = await tx.unit.create({
        data: { organizationId: requireOrganizationId(), name: body.name },
        select: { id: true, name: true },
      });
      await this.audit.record(tx, {
        action: 'unit.created',
        entityType: 'unit',
        entityId: unit.id,
        after: unit,
      });
      if (body.delayMs) {
        await sleep(body.delayMs);
      }
      if (body.fail === 'client') {
        throw new AppError('UNIT_REJECTED', 422, 'Unidade recusada.');
      }
      if (body.fail === 'server') {
        throw new Error('database exploded');
      }
      return unit;
    });
  }
}

@Module({ controllers: [UnitsWriteTestController] })
export class IdempotencyTestModule {}
