import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
import { ErrorResponseSchema } from '../errors/error-response.schema.js';
import { Idempotent } from '../idempotency/idempotent.decorator.js';
import { IdPipe, NotFoundResponse } from '../units/unit-access.js';
import {
  AdvanceItemRequestSchema,
  BackItemRequestSchema,
  CancelItemRequestSchema,
  CancelTabRequestSchema,
  CreateOrderRequestSchema,
  CreateTabRequestSchema,
  CurrentShiftSchema,
  type ItemChangeDto,
  ItemChangeSchema,
  OpenShiftRequestSchema,
  type OrderDto,
  OrderSchema,
  PutShiftPricesRequestSchema,
  type ShiftDto,
  ShiftSchema,
  type StationQueueDto,
  StationQueueSchema,
  TabActionRequestSchema,
  type TabDto,
  TabListQuerySchema,
  type TabListQuery,
  TabListSchema,
  TabSchema,
  type TabSummaryDto,
  tabStatusesOf,
} from './operation.schemas.js';
import { OrderItemsService } from './order-items.service.js';
import { ShiftsService } from './shifts.service.js';
import { TabsService } from './tabs.service.js';

function Forbidden(description: string): MethodDecorator {
  return ApiForbiddenResponse({
    description: `\`FORBIDDEN\`: ${description}`,
    standardSchema: ErrorResponseSchema,
  });
}

function Conflict(description: string): MethodDecorator {
  return ApiConflictResponse({ description, standardSchema: ErrorResponseSchema });
}

const ITEM_CONFLICTS =
  '`ITEM_CHANGED` (outro aparelho mudou o item antes: `details.item` traz o estado atual, CA-04.05), `ITEM_CANCELED`, `SHIFT_CLOSED`';

/**
 * Operation of a unit (spec 04): shifts, tabs, orders, items and station queues. Panel session
 * (owner or staff); permissions by unit and station are checked by the services.
 */
@ApiTags('operation')
@PanelAuth()
@Controller()
export class OperationController {
  constructor(
    private readonly shifts: ShiftsService,
    private readonly tabs: TabsService,
    private readonly items: OrderItemsService,
  ) {}

  // ---------------------------------------------------------------------------------------------
  // Shifts
  // ---------------------------------------------------------------------------------------------

  @Post('units/:id/shifts')
  @Idempotent()
  @ApiOperation({
    summary:
      'Abre o turno da unidade, com tipo, acordo e preços (dono ou quem opera caixa, RN-04.02)',
  })
  @ApiCreatedResponse({ standardSchema: ShiftSchema })
  @NotFoundResponse()
  @Forbidden('só o dono ou quem opera o caixa na unidade.')
  @Conflict(
    '`SHIFT_ALREADY_OPEN` (CA-04.01), `UNIT_INACTIVE`, `ORGANIZATION_SUSPENDED` ou `ORGANIZATION_CANCELED` (CA-02.05).',
  )
  @ApiBadRequestResponse({
    description:
      '`INVALID_SHIFT_PRICE` ou `VALIDATION_FAILED` (acordo obrigatório no turno contratado).',
    standardSchema: ErrorResponseSchema,
  })
  openShift(
    @Param('id', IdPipe) id: string,
    @Body({ schema: OpenShiftRequestSchema }) body: z.infer<typeof OpenShiftRequestSchema>,
  ): Promise<ShiftDto> {
    return this.shifts.open(id, body);
  }

  @Get('units/:id/shifts/current')
  @ApiOperation({ summary: 'Turno aberto da unidade, com acordo e preços' })
  @ApiOkResponse({ standardSchema: CurrentShiftSchema })
  @NotFoundResponse()
  @Forbidden('colaborador sem acesso à unidade.')
  async currentShift(@Param('id', IdPipe) id: string): Promise<{ shift: ShiftDto | null }> {
    return { shift: await this.shifts.current(id) };
  }

  @Put('shifts/:id/prices')
  @Idempotent()
  @ApiOperation({ summary: 'Substitui a tabela de preços do turno aberto (RN-04.06)' })
  @ApiOkResponse({ standardSchema: ShiftSchema })
  @NotFoundResponse()
  @Forbidden('só o dono ou quem opera o caixa na unidade.')
  @Conflict('`SHIFT_CLOSED` ou `VERSION_CONFLICT`.')
  @ApiBadRequestResponse({
    description: '`INVALID_SHIFT_PRICE` ou `VALIDATION_FAILED`.',
    standardSchema: ErrorResponseSchema,
  })
  updatePrices(
    @Param('id', IdPipe) id: string,
    @Body({ schema: PutShiftPricesRequestSchema })
    body: z.infer<typeof PutShiftPricesRequestSchema>,
  ): Promise<ShiftDto> {
    return this.shifts.updatePrices(id, body);
  }

  @Post('shifts/:id/close')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Fecha o turno (RN-04.07): recusa com a lista de pendências; itens ainda em preparo vão à etapa final (RN-04.08)',
  })
  @ApiOkResponse({ standardSchema: ShiftSchema })
  @NotFoundResponse()
  @Forbidden('só o dono ou quem opera o caixa na unidade.')
  @Conflict(
    '`SHIFT_HAS_PENDING_ITEMS` com `details` no formato `ShiftPendingItems` (CA-04.09) ou `SHIFT_CLOSED`.',
  )
  closeShift(@Param('id', IdPipe) id: string): Promise<ShiftDto> {
    return this.shifts.close(id);
  }

  // ---------------------------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------------------------

  @Get('shifts/:id/tabs')
  @ApiOperation({ summary: 'Varal: comandas do turno com totais e resumo dos itens, por número' })
  @ApiOkResponse({ standardSchema: TabListSchema })
  @NotFoundResponse()
  @Forbidden('colaborador sem acesso à unidade.')
  async listTabs(
    @Param('id', IdPipe) id: string,
    @Query({ schema: TabListQuerySchema }) query: TabListQuery,
  ): Promise<{ data: TabSummaryDto[] }> {
    return { data: await this.tabs.list(id, tabStatusesOf(query)) };
  }

  @Post('shifts/:id/tabs')
  @Idempotent()
  @ApiOperation({ summary: 'Abre uma comanda aberta com o próximo número do turno (RN-04.09)' })
  @ApiCreatedResponse({ standardSchema: TabSchema })
  @NotFoundResponse()
  @Forbidden('é preciso ter acesso ao balcão da unidade.')
  @Conflict('`SHIFT_CLOSED`.')
  createTab(
    @Param('id', IdPipe) id: string,
    @Body({ schema: CreateTabRequestSchema }) body: z.infer<typeof CreateTabRequestSchema>,
  ): Promise<TabDto> {
    return this.tabs.create(id, body.customerName);
  }

  @Get('tabs/:id')
  @ApiOperation({ summary: 'Comanda com pedidos, itens e totais' })
  @ApiOkResponse({ standardSchema: TabSchema })
  @NotFoundResponse()
  @Forbidden('colaborador sem acesso à unidade.')
  getTab(@Param('id', IdPipe) id: string): Promise<TabDto> {
    return this.tabs.get(id);
  }

  @Post('tabs/:id/orders')
  @Idempotent()
  @ApiOperation({
    summary:
      'Envia um pedido à comanda aberta: 1 a 50 itens, cada item vai à estação de preparo (RN-04.16 a RN-04.19)',
  })
  @ApiCreatedResponse({ standardSchema: OrderSchema })
  @NotFoundResponse()
  @Forbidden('é preciso ter acesso ao balcão da unidade.')
  @Conflict(
    '`ORDER_REJECTED` com `details` no formato `OrderRejectedDetails` (CA-04.06, CA-03.06), `TAB_NOT_OPEN` (RN-04.13), `TAB_CLOSED` ou `SHIFT_CLOSED`.',
  )
  createOrder(
    @Param('id', IdPipe) id: string,
    @Body({ schema: CreateOrderRequestSchema }) body: z.infer<typeof CreateOrderRequestSchema>,
  ): Promise<OrderDto> {
    return this.tabs.createOrder(id, body);
  }

  @Post('tabs/:id/request-bill')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Pede a conta: `open` → `closing` (RN-04.12)' })
  @ApiOkResponse({ standardSchema: TabSchema })
  @NotFoundResponse()
  @Forbidden('é preciso ter acesso ao balcão da unidade.')
  @Conflict('`TAB_NOT_OPEN`, `TAB_CLOSED`, `TAB_CHANGED` ou `SHIFT_CLOSED`.')
  requestBill(
    @Param('id', IdPipe) id: string,
    @Body({ schema: TabActionRequestSchema }) body: z.infer<typeof TabActionRequestSchema>,
  ): Promise<TabDto> {
    return this.tabs.requestBill(id, body.version);
  }

  @Post('tabs/:id/reopen')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reabre a comanda: `closing` → `open` (RN-04.12)' })
  @ApiOkResponse({ standardSchema: TabSchema })
  @NotFoundResponse()
  @Forbidden('é preciso ter acesso ao balcão da unidade.')
  @Conflict('`TAB_NOT_CLOSING`, `TAB_CLOSED`, `TAB_CHANGED` ou `SHIFT_CLOSED`.')
  reopen(
    @Param('id', IdPipe) id: string,
    @Body({ schema: TabActionRequestSchema }) body: z.infer<typeof TabActionRequestSchema>,
  ): Promise<TabDto> {
    return this.tabs.reopen(id, body.version);
  }

  @Post('tabs/:id/cancel')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancela a comanda quando todos os itens já foram cancelados (RN-04.12)',
  })
  @ApiOkResponse({ standardSchema: TabSchema })
  @NotFoundResponse()
  @Forbidden('é preciso ter acesso ao balcão da unidade.')
  @Conflict(
    '`TAB_HAS_ACTIVE_ITEMS` (`details.itemIds`), `TAB_CLOSED`, `TAB_CHANGED` ou `SHIFT_CLOSED`.',
  )
  cancelTab(
    @Param('id', IdPipe) id: string,
    @Body({ schema: CancelTabRequestSchema }) body: z.infer<typeof CancelTabRequestSchema>,
  ): Promise<TabDto> {
    return this.tabs.cancel(id, body);
  }

  // ---------------------------------------------------------------------------------------------
  // Items and stations
  // ---------------------------------------------------------------------------------------------

  @Get('stations/:id/queue')
  @ApiOperation({ summary: 'Fila da estação: itens nela, do pedido mais antigo para o mais novo' })
  @ApiOkResponse({ standardSchema: StationQueueSchema })
  @NotFoundResponse()
  @Forbidden('colaborador sem acesso à estação.')
  queue(@Param('id', IdPipe) id: string): Promise<StationQueueDto> {
    return this.items.queue(id);
  }

  @Post('order-items/:id/advance')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Avança o item para a próxima etapa; `quantity` avança só parte, dividindo a linha (RN-04.20, RN-04.21, RN-04.24)',
  })
  @ApiOkResponse({ standardSchema: ItemChangeSchema })
  @NotFoundResponse()
  @Forbidden('sem acesso à estação do item (o balcão só registra a entrega, RN-04.21).')
  @Conflict(`${ITEM_CONFLICTS} ou \`ITEM_IN_FINAL_STAGE\`.`)
  @ApiBadRequestResponse({
    description: '`INVALID_QUANTITY`.',
    standardSchema: ErrorResponseSchema,
  })
  advance(
    @Param('id', IdPipe) id: string,
    @Body({ schema: AdvanceItemRequestSchema }) body: z.infer<typeof AdvanceItemRequestSchema>,
  ): Promise<ItemChangeDto> {
    return this.items.advance(id, body);
  }

  @Post('order-items/:id/back')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Volta o item para a etapa anterior, com auditoria (RN-04.22)' })
  @ApiOkResponse({ standardSchema: ItemChangeSchema })
  @NotFoundResponse()
  @Forbidden('sem acesso à estação do item.')
  @Conflict(`${ITEM_CONFLICTS}, \`ITEM_IN_FINAL_STAGE\` ou \`NO_PREVIOUS_STAGE\`.`)
  back(
    @Param('id', IdPipe) id: string,
    @Body({ schema: BackItemRequestSchema }) body: z.infer<typeof BackItemRequestSchema>,
  ): Promise<ItemChangeDto> {
    return this.items.back(id, body);
  }

  @Post('order-items/:id/cancel')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Cancela o item ou parte dele, com motivo; perda depois da primeira etapa (RN-04.25 a RN-04.28)',
  })
  @ApiOkResponse({ standardSchema: ItemChangeSchema })
  @NotFoundResponse()
  @Forbidden('sem acesso ao balcão nem à estação do item.')
  @Conflict(`${ITEM_CONFLICTS} ou \`TAB_CLOSED\` (RN-04.28).`)
  @ApiBadRequestResponse({
    description: '`INVALID_QUANTITY` ou `VALIDATION_FAILED` (motivo obrigatório).',
    standardSchema: ErrorResponseSchema,
  })
  cancelItem(
    @Param('id', IdPipe) id: string,
    @Body({ schema: CancelItemRequestSchema }) body: z.infer<typeof CancelItemRequestSchema>,
  ): Promise<ItemChangeDto> {
    return this.items.cancel(id, body);
  }
}
