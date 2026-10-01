import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { z } from 'zod';

import { type Page, PaginationQuerySchema, type PaginationQuery } from '../common/pagination.js';
import { ErrorResponseSchema } from '../errors/error-response.schema.js';
import { Idempotent } from '../idempotency/idempotent.decorator.js';
import { StationsService } from './stations.service.js';
import { IdPipe, NotFoundResponse, OwnerOnly } from './unit-access.js';
import {
  CreateStationRequestSchema,
  CreateUnitRequestSchema,
  PutWorkflowRequestSchema,
  type StationDto,
  StationListSchema,
  StationSchema,
  type UnitDto,
  UnitPageSchema,
  UnitSchema,
  UpdateStationRequestSchema,
  UpdateUnitRequestSchema,
  type WorkflowDto,
  WorkflowSchema,
} from './units.schemas.js';
import { UnitsService } from './units.service.js';
import { WorkflowService } from './workflow.service.js';

const SHIFT_OPEN_DOC =
  '`SHIFT_OPEN`: a unidade está com turno aberto (CA-03.03); `VERSION_CONFLICT`; nomes repetidos (`*_NAME_TAKEN`); `STATION_KIND_REQUIRED` ou `STATION_IN_USE`.';

/** Units, stations and workflow (spec 03, sections 3 and 4). Owner only. */
@ApiTags('units')
@OwnerOnly()
@Controller()
export class UnitsController {
  constructor(
    private readonly units: UnitsService,
    private readonly stations: StationsService,
    private readonly workflow: WorkflowService,
  ) {}

  @Get('units')
  @ApiOperation({ summary: 'Unidades da organização (ativas e inativas)' })
  @ApiOkResponse({ standardSchema: UnitPageSchema })
  listUnits(
    @Query({ schema: PaginationQuerySchema }) query: PaginationQuery,
  ): Promise<Page<UnitDto>> {
    return this.units.list(query);
  }

  @Post('units')
  @Idempotent()
  @ApiOperation({
    summary: 'Cria uma unidade com o template padrão de estações e fluxo (RN-03.03)',
  })
  @ApiCreatedResponse({ standardSchema: UnitSchema })
  @ApiConflictResponse({ description: '`UNIT_NAME_TAKEN`.', standardSchema: ErrorResponseSchema })
  createUnit(
    @Body({ schema: CreateUnitRequestSchema }) body: z.infer<typeof CreateUnitRequestSchema>,
  ): Promise<UnitDto> {
    return this.units.create(body);
  }

  @Patch('units/:id')
  @ApiOperation({ summary: 'Renomeia, ativa ou desativa a unidade e ajusta o tempo de atraso' })
  @ApiOkResponse({ standardSchema: UnitSchema })
  @NotFoundResponse()
  @ApiConflictResponse({
    description:
      '`SHIFT_OPEN` (RN-03.02), `LAST_ACTIVE_UNIT` (RN-03.01), `UNIT_NAME_TAKEN` ou `VERSION_CONFLICT`.',
    standardSchema: ErrorResponseSchema,
  })
  updateUnit(
    @Param('id', IdPipe) id: string,
    @Body({ schema: UpdateUnitRequestSchema }) body: z.infer<typeof UpdateUnitRequestSchema>,
  ): Promise<UnitDto> {
    return this.units.update(id, body);
  }

  @Get('units/:id/stations')
  @ApiOperation({ summary: 'Estações da unidade' })
  @ApiOkResponse({ standardSchema: StationListSchema })
  @NotFoundResponse()
  async listStations(@Param('id', IdPipe) id: string): Promise<{ data: StationDto[] }> {
    return { data: await this.stations.list(id) };
  }

  @Post('units/:id/stations')
  @Idempotent()
  @ApiOperation({ summary: 'Cria uma estação na unidade' })
  @ApiCreatedResponse({ standardSchema: StationSchema })
  @NotFoundResponse()
  @ApiConflictResponse({ description: SHIFT_OPEN_DOC, standardSchema: ErrorResponseSchema })
  createStation(
    @Param('id', IdPipe) id: string,
    @Body({ schema: CreateStationRequestSchema }) body: z.infer<typeof CreateStationRequestSchema>,
  ): Promise<StationDto> {
    return this.stations.create(id, body);
  }

  @Patch('stations/:id')
  @ApiOperation({ summary: 'Altera uma estação (nome, tipo, ordem, ativa)' })
  @ApiOkResponse({ standardSchema: StationSchema })
  @NotFoundResponse()
  @ApiConflictResponse({ description: SHIFT_OPEN_DOC, standardSchema: ErrorResponseSchema })
  updateStation(
    @Param('id', IdPipe) id: string,
    @Body({ schema: UpdateStationRequestSchema }) body: z.infer<typeof UpdateStationRequestSchema>,
  ): Promise<StationDto> {
    return this.stations.update(id, body);
  }

  @Get('units/:id/workflow')
  @ApiOperation({ summary: 'Fluxo de etapas da unidade' })
  @ApiOkResponse({ standardSchema: WorkflowSchema })
  @NotFoundResponse()
  getWorkflow(@Param('id', IdPipe) id: string): Promise<WorkflowDto> {
    return this.workflow.get(id);
  }

  @Put('units/:id/workflow')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Salva o fluxo completo de uma vez (RN-03.05 a RN-03.07)',
  })
  @ApiOkResponse({ standardSchema: WorkflowSchema })
  @NotFoundResponse()
  @ApiBadRequestResponse({
    description:
      '`INVALID_WORKFLOW` com `details.issues: WorkflowIssue[]` (CA-03.02), `INVALID_REFERENCE` ou `VALIDATION_FAILED`.',
    standardSchema: ErrorResponseSchema,
  })
  @ApiConflictResponse({
    description: '`SHIFT_OPEN` (CA-03.03) ou `VERSION_CONFLICT`.',
    standardSchema: ErrorResponseSchema,
  })
  saveWorkflow(
    @Param('id', IdPipe) id: string,
    @Body({ schema: PutWorkflowRequestSchema }) body: z.infer<typeof PutWorkflowRequestSchema>,
  ): Promise<WorkflowDto> {
    return this.workflow.save(id, body);
  }
}
