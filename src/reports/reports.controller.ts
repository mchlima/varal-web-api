import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ErrorResponseSchema } from '../errors/error-response.schema.js';
import { IdPipe, NotFoundResponse, OwnerOnly } from '../units/unit-access.js';
import {
  type DayHistoryDto,
  DayHistorySchema,
  type EventHistoryDto,
  type EventHistoryQuery,
  EventHistoryQuerySchema,
  EventHistorySchema,
  type EventReportDto,
  EventReportSchema,
  type HistoryQuery,
  HistoryQuerySchema,
  type PeriodQuery,
  PeriodQuerySchema,
  type SessionHistoryDto,
  type SessionHistoryQuery,
  SessionHistoryQuerySchema,
  SessionHistorySchema,
  type SessionReportDto,
  SessionReportSchema,
  type SummaryReportDto,
  SummaryReportSchema,
} from './reports.schemas.js';
import { ReportsService } from './reports.service.js';

function InvalidPeriod(): MethodDecorator {
  return ApiBadRequestResponse({
    description: '`VALIDATION_FAILED`: datas, período de 1 a 366 dias ou cursor inválido.',
    standardSchema: ErrorResponseSchema,
  });
}

/**
 * Reports (spec 07): only in the owner's panel, the cash register report included; staff get 403
 * (RN-07.07, CA-07.06), even when they operate cash. The platform admin sees them only in "entrar
 * como", where the session acts as the owner (spec 02).
 */
@ApiTags('reports')
@OwnerOnly()
@Controller()
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('reports/summary')
  @ApiOperation({
    summary:
      'Relatório do dia ou do período (sem `unitId`, todas as unidades): resumo, por produto (e por tabela), por forma, por colaborador, caixas, fiado, cancelamentos e perdas, eventos (spec 07, seção 4)',
  })
  @ApiOkResponse({ standardSchema: SummaryReportSchema })
  @NotFoundResponse()
  @InvalidPeriod()
  summary(@Query({ schema: PeriodQuerySchema }) query: PeriodQuery): Promise<SummaryReportDto> {
    return this.reports.summary(query);
  }

  @Get('reports/days')
  @ApiOperation({
    summary:
      'Histórico por dia de operação e unidade, mais recentes primeiro, com os totais do período (spec 07, seção 7)',
  })
  @ApiOkResponse({ standardSchema: DayHistorySchema })
  @NotFoundResponse()
  @InvalidPeriod()
  days(@Query({ schema: HistoryQuerySchema }) query: HistoryQuery): Promise<DayHistoryDto> {
    return this.reports.days(query);
  }

  @Get('reports/cash-sessions')
  @ApiOperation({
    summary:
      'Histórico de aberturas de caixa, mais recentes primeiro, com os totais do período (spec 07, seção 7)',
  })
  @ApiOkResponse({ standardSchema: SessionHistorySchema })
  @NotFoundResponse()
  @InvalidPeriod()
  cashSessions(
    @Query({ schema: SessionHistoryQuerySchema }) query: SessionHistoryQuery,
  ): Promise<SessionHistoryDto> {
    return this.reports.cashSessions(query);
  }

  @Get('reports/events')
  @ApiOperation({
    summary: 'Histórico de eventos com consumo contra o combinado (spec 07, seção 7)',
  })
  @ApiOkResponse({ standardSchema: EventHistorySchema })
  @NotFoundResponse()
  @InvalidPeriod()
  events(
    @Query({ schema: EventHistoryQuerySchema }) query: EventHistoryQuery,
  ): Promise<EventHistoryDto> {
    return this.reports.events(query);
  }

  @Get('cash-register-sessions/:id/report')
  @ApiOperation({
    summary:
      'Relatório do caixa: fundo, pagamentos por forma (vendas e quitações), estornos, movimentos, esperado, informado, diferença e pendentes (spec 07, seção 5; RN-07.09)',
  })
  @ApiOkResponse({ standardSchema: SessionReportSchema })
  @NotFoundResponse()
  sessionReport(@Param('id', IdPipe) id: string): Promise<SessionReportDto> {
    return this.reports.sessionReport(id);
  }

  @Get('events/:id/report')
  @ApiOperation({
    summary:
      'Relatório do evento: comandas ligadas a ele de qualquer dia, venda, recebido, pendurado, por produto, perdas e o acordo (spec 07, seção 6; RN-07.10)',
  })
  @ApiOkResponse({ standardSchema: EventReportSchema })
  @NotFoundResponse()
  eventReport(@Param('id', IdPipe) id: string): Promise<EventReportDto> {
    return this.reports.eventReport(id);
  }
}
