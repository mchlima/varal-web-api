import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ErrorResponseSchema } from '../errors/error-response.schema.js';
import { IdPipe, NotFoundResponse, OwnerOnly } from '../units/unit-access.js';
import {
  type ShiftHistoryDto,
  type ShiftHistoryQuery,
  ShiftHistoryQuerySchema,
  ShiftHistorySchema,
  type ShiftReportDto,
  ShiftReportSchema,
} from './reports.schemas.js';
import { ReportsService } from './reports.service.js';

/**
 * Reports (spec 07): only in the owner's panel; staff get 403 (RN-07.07, CA-07.06). The platform
 * admin sees them only in "entrar como", where the session acts as the owner (spec 02).
 */
@ApiTags('reports')
@OwnerOnly()
@Controller()
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('shifts/:id/report')
  @ApiOperation({
    summary:
      'Relatório do turno: resumo, por produto, por forma de pagamento, por colaborador, caixas, fiado, cancelamentos e perdas, acordo; parcial com o turno aberto (spec 07, seção 4; CA-07.01 a CA-07.05)',
  })
  @ApiOkResponse({ standardSchema: ShiftReportSchema })
  @NotFoundResponse()
  shiftReport(@Param('id', IdPipe) id: string): Promise<ShiftReportDto> {
    return this.reports.shiftReport(id);
  }

  @Get('reports/shifts')
  @ApiOperation({
    summary:
      'Histórico de turnos por unidade (ou todas), período e tipo, mais recentes primeiro, com os totais do período (spec 07, seção 5; CA-07.04)',
  })
  @ApiOkResponse({ standardSchema: ShiftHistorySchema })
  @NotFoundResponse()
  @ApiBadRequestResponse({
    description: '`VALIDATION_FAILED`: datas, período de 1 a 366 dias ou cursor inválido.',
    standardSchema: ErrorResponseSchema,
  })
  history(
    @Query({ schema: ShiftHistoryQuerySchema }) query: ShiftHistoryQuery,
  ): Promise<ShiftHistoryDto> {
    return this.reports.history(query);
  }
}
