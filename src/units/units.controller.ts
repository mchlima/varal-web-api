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
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { z } from 'zod';

import { PanelAuth } from '../auth/auth.decorators.js';
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

const SETUP_BLOCKED_DOC =
  '`CASH_REGISTER_OPEN` (caixa aberto) ou `ITEMS_IN_PROGRESS` (itens em preparo), CA-03.03; `VERSION_CONFLICT`; nomes repetidos (`*_NAME_TAKEN`); `STATION_KIND_REQUIRED` ou `STATION_IN_USE`. Mudar só os limites de tempo é permitido com caixa aberto (RN-03.25).';

/**
 * Units, stations and workflow (spec 03, sections 3 and 4). Owner only, except reading the workflow:
 * the counter and the stations of the unit need its stages (phase 5 adjustment).
 */
@ApiTags('units')
@Controller()
export class UnitsController {
  constructor(
    private readonly units: UnitsService,
    private readonly stations: StationsService,
    private readonly workflow: WorkflowService,
  ) {}

  @OwnerOnly()
  @Get('units')
  @ApiOperation({ summary: 'Unidades da organização (ativas e inativas)' })
  @ApiOkResponse({ standardSchema: UnitPageSchema })
  listUnits(
    @Query({ schema: PaginationQuerySchema }) query: PaginationQuery,
  ): Promise<Page<UnitDto>> {
    return this.units.list(query);
  }

  @OwnerOnly()
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

  @OwnerOnly()
  @Patch('units/:id')
  @ApiOperation({
    summary:
      'Renomeia, ativa ou desativa a unidade e ajusta o atraso padrão das estações novas (RN-03.25)',
  })
  @ApiOkResponse({ standardSchema: UnitSchema })
  @NotFoundResponse()
  @ApiConflictResponse({
    description:
      '`CASH_REGISTER_OPEN` ou `UNIT_HAS_OPEN_TABS` (RN-03.02), `LAST_ACTIVE_UNIT` (RN-03.01), `UNIT_NAME_TAKEN` ou `VERSION_CONFLICT`.',
    standardSchema: ErrorResponseSchema,
  })
  updateUnit(
    @Param('id', IdPipe) id: string,
    @Body({ schema: UpdateUnitRequestSchema }) body: z.infer<typeof UpdateUnitRequestSchema>,
  ): Promise<UnitDto> {
    return this.units.update(id, body);
  }

  @OwnerOnly()
  @Get('units/:id/stations')
  @ApiOperation({ summary: 'Estações da unidade' })
  @ApiOkResponse({ standardSchema: StationListSchema })
  @NotFoundResponse()
  async listStations(@Param('id', IdPipe) id: string): Promise<{ data: StationDto[] }> {
    return { data: await this.stations.list(id) };
  }

  @OwnerOnly()
  @Post('units/:id/stations')
  @Idempotent()
  @ApiOperation({
    summary: 'Cria uma estação na unidade; as de fila com limites de atenção e atraso (RN-03.25)',
  })
  @ApiCreatedResponse({ standardSchema: StationSchema })
  @NotFoundResponse()
  @ApiConflictResponse({ description: SETUP_BLOCKED_DOC, standardSchema: ErrorResponseSchema })
  @ApiBadRequestResponse({
    description: '`INVALID_TIME_LIMITS` (CA-03.12) ou `VALIDATION_FAILED`.',
    standardSchema: ErrorResponseSchema,
  })
  createStation(
    @Param('id', IdPipe) id: string,
    @Body({ schema: CreateStationRequestSchema }) body: z.infer<typeof CreateStationRequestSchema>,
  ): Promise<StationDto> {
    return this.stations.create(id, body);
  }

  @OwnerOnly()
  @Patch('stations/:id')
  @ApiOperation({
    summary: 'Altera uma estação (nome, tipo, ordem, ativa, limites de atenção e atraso)',
  })
  @ApiOkResponse({ standardSchema: StationSchema })
  @NotFoundResponse()
  @ApiConflictResponse({ description: SETUP_BLOCKED_DOC, standardSchema: ErrorResponseSchema })
  @ApiBadRequestResponse({
    description: '`INVALID_TIME_LIMITS` (CA-03.12) ou `VALIDATION_FAILED`.',
    standardSchema: ErrorResponseSchema,
  })
  updateStation(
    @Param('id', IdPipe) id: string,
    @Body({ schema: UpdateStationRequestSchema }) body: z.infer<typeof UpdateStationRequestSchema>,
  ): Promise<StationDto> {
    return this.stations.update(id, body);
  }

  @PanelAuth()
  @Get('units/:id/workflow')
  @ApiOperation({
    summary:
      'Fluxo de etapas da unidade: dono e colaboradores da unidade (leitura; só o dono altera)',
  })
  @ApiOkResponse({ standardSchema: WorkflowSchema })
  @NotFoundResponse()
  @ApiForbiddenResponse({
    description: '`FORBIDDEN`: colaborador sem acesso à unidade.',
    standardSchema: ErrorResponseSchema,
  })
  getWorkflow(@Param('id', IdPipe) id: string): Promise<WorkflowDto> {
    return this.workflow.get(id);
  }

  @OwnerOnly()
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
    description:
      '`CASH_REGISTER_OPEN` ou `ITEMS_IN_PROGRESS` (CA-03.03, RN-03.07) ou `VERSION_CONFLICT`.',
    standardSchema: ErrorResponseSchema,
  })
  saveWorkflow(
    @Param('id', IdPipe) id: string,
    @Body({ schema: PutWorkflowRequestSchema }) body: z.infer<typeof PutWorkflowRequestSchema>,
  ): Promise<WorkflowDto> {
    return this.workflow.save(id, body);
  }
}
