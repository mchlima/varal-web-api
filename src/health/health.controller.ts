import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { Public } from '../auth/auth.decorators.js';
import { type HealthResponse, HealthResponseSchema } from './health.schemas.js';
import { HealthService } from './health.service.js';

@ApiTags('health')
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @ApiOkResponse({
    description: 'API is up; `db` reports the database status.',
    standardSchema: HealthResponseSchema,
  })
  check(): Promise<HealthResponse> {
    return this.health.check();
  }
}
