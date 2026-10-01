/**
 * TEST ONLY routes that exercise the infrastructure of phase 1a (errors, request context and tenant
 * isolation over HTTP). They live under `test/`, are mounted only by the tests and never ship.
 */
import { Body, Controller, Get, HttpException, Module, Param, Post } from '@nestjs/common';
import { z } from 'zod';

import { getRequestContext } from '../../src/context/request-context.js';
import { AppError } from '../../src/errors/app-error.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';

const ValidatedBody = z.object({
  name: z.string().min(2),
  quantity: z.number().int().positive(),
});

@Controller('test')
class InfrastructureTestController {
  @Get('context')
  context(): unknown {
    return getRequestContext() ?? null;
  }

  @Get('errors/app')
  appError(): never {
    throw new AppError('TAB_ALREADY_CLOSED', 409, 'Esta comanda já foi fechada.', { tabId: 'x' });
  }

  @Get('errors/http/:status')
  httpError(@Param('status') status: string): never {
    throw new HttpException('English framework message', Number(status));
  }

  @Get('errors/crash')
  crash(): never {
    throw new Error('internal secret at /srv/app/db.ts');
  }

  @Post('errors/validate')
  validate(@Body({ schema: ValidatedBody }) body: z.infer<typeof ValidatedBody>): unknown {
    return body;
  }
}

@Controller('test/units')
class UnitsReadTestController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(':id')
  async get(@Param('id') id: string): Promise<{ id: string; name: string }> {
    const unit = await this.prisma.db.unit.findUnique({
      where: { id },
      select: { id: true, name: true },
    });
    if (!unit) {
      throw AppError.of('NOT_FOUND');
    }
    return unit;
  }
}

@Module({ controllers: [InfrastructureTestController, UnitsReadTestController] })
export class InfrastructureTestModule {}
