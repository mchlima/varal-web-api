import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';

import { AdminArea, AdminAuth } from '../../auth/auth.decorators.js';
import { RequirePermission } from '../rbac/require-permission.js';
import {
  MetricsOverviewSchema,
  MetricsPeriodQuerySchema,
  OrganizationUsageListSchema,
  OrganizationUsageQuerySchema,
} from './metrics.schemas.js';
import { MetricsService, resolvePeriod } from './metrics.service.js';

/** Usage metrics (spec 02, section 6), in Brasília time. */
@ApiTags('admin-metrics')
@AdminArea()
@AdminAuth()
@RequirePermission('metrics:read')
@Controller('admin/metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Indicadores do período (padrão: últimos 30 dias)' })
  @ApiOkResponse({ standardSchema: MetricsOverviewSchema })
  overview(
    @Query({ schema: MetricsPeriodQuerySchema }) query: z.infer<typeof MetricsPeriodQuerySchema>,
  ): Promise<z.infer<typeof MetricsOverviewSchema>> {
    return this.metrics.overview(resolvePeriod(query));
  }

  @Get('organizations')
  @ApiOperation({ summary: 'Uso por organização no período, ordenável' })
  @ApiOkResponse({ standardSchema: OrganizationUsageListSchema })
  organizations(
    @Query({ schema: OrganizationUsageQuerySchema })
    query: z.infer<typeof OrganizationUsageQuerySchema>,
  ): Promise<z.infer<typeof OrganizationUsageListSchema>> {
    return this.metrics.organizations(resolvePeriod(query), query.sort, query.order);
  }
}
