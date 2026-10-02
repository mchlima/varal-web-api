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
import { ErrorResponseSchema } from '../errors/error-response.schema.js';
import { Idempotent } from '../idempotency/idempotent.decorator.js';
import { IdPipe, NotFoundResponse } from '../units/unit-access.js';
import {
  ContractedEventActionRequestSchema,
  type ContractedEventDto,
  type ContractedEventListQuery,
  ContractedEventListQuerySchema,
  ContractedEventListSchema,
  ContractedEventSchema,
  CreateContractedEventRequestSchema,
  UpdateContractedEventRequestSchema,
} from './events.schemas.js';
import { EventsService } from './events.service.js';
import {
  AdvanceItemRequestSchema,
  AdvanceOrderRequestSchema,
  type AdvanceOrderResultDto,
  AdvanceOrderResultSchema,
  BackItemRequestSchema,
  CancelItemRequestSchema,
  CancelTabRequestSchema,
  CreateOrderRequestSchema,
  CreateTabRequestSchema,
  type ItemChangeDto,
  ItemChangeSchema,
  type OrderDto,
  OrderSchema,
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
import { TabsService } from './tabs.service.js';
import {
  PutCurrentPriceListRequestSchema,
  type UnitOperationDto,
  UnitOperationSchema,
} from './unit-operation.schemas.js';
import { UnitOperationService } from './unit-operation.service.js';

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
  '`ITEM_CHANGED` (outro aparelho mudou o item antes: `details.item` traz o estado atual, CA-04.05), `ITEM_CANCELED`';

const NO_REGISTER = '`NO_CASH_REGISTER_OPEN` (sem caixa aberto na unidade, RN-04.02, CA-04.01)';

/**
 * Operation of a unit (spec 04): the operation snapshot, the current price list, contracted
 * events, tabs, orders, items and station queues. Panel session (owner or staff); permissions by
 * unit and station are checked by the services.
 */
@ApiTags('operation')
@PanelAuth()
@Controller()
export class OperationController {
  constructor(
    private readonly operation: UnitOperationService,
    private readonly contractedEvents: EventsService,
    private readonly tabs: TabsService,
    private readonly items: OrderItemsService,
  ) {}

  // ---------------------------------------------------------------------------------------------
  // Operation of the unit (spec 04, section 3)
  // ---------------------------------------------------------------------------------------------

  @Get('units/:id/operation')
  @ApiOperation({
    summary:
      'Situação da operação: dia de operação, caixas e aberturas, tabela vigente e efetiva, evento em andamento e de hoje, comandas em aberto, `staleTabs` (RN-01.28) e itens em preparo',
  })
  @ApiOkResponse({ standardSchema: UnitOperationSchema })
  @NotFoundResponse()
  @Forbidden('colaborador sem acesso à unidade.')
  getOperation(@Param('id', IdPipe) id: string): Promise<UnitOperationDto> {
    return this.operation.get(id);
  }

  @Put('units/:id/current-price-list')
  @Idempotent()
  @ApiOperation({
    summary:
      'Troca a tabela vigente (`priceListId` ou `null` para "Normal"), com ou sem caixa aberto (RN-04.31); vale para itens novos',
  })
  @ApiOkResponse({ standardSchema: UnitOperationSchema })
  @NotFoundResponse()
  @Forbidden('só o dono ou quem opera o caixa na unidade (RN-04.31).')
  @Conflict(
    '`EVENT_IN_PROGRESS` (a tabela é a do evento, RN-04.32, CA-04.14) ou `VERSION_CONFLICT`.',
  )
  @ApiBadRequestResponse({
    description: '`INVALID_PRICE_LIST` (inexistente, de outra unidade ou inativa).',
    standardSchema: ErrorResponseSchema,
  })
  setCurrentPriceList(
    @Param('id', IdPipe) id: string,
    @Body({ schema: PutCurrentPriceListRequestSchema })
    body: z.infer<typeof PutCurrentPriceListRequestSchema>,
  ): Promise<UnitOperationDto> {
    return this.operation.setCurrentPriceList(id, body);
  }

  // ---------------------------------------------------------------------------------------------
  // Contracted events (spec 04, section 3.3)
  // ---------------------------------------------------------------------------------------------

  @Get('units/:id/events')
  @ApiOperation({
    summary:
      'Eventos contratados da unidade: em andamento, agendados (mais próximos primeiro) e encerrados',
  })
  @ApiOkResponse({ standardSchema: ContractedEventListSchema })
  @NotFoundResponse()
  @Forbidden('só o dono ou quem opera o caixa na unidade.')
  async listEvents(
    @Param('id', IdPipe) id: string,
    @Query({ schema: ContractedEventListQuerySchema }) query: ContractedEventListQuery,
  ): Promise<{ data: ContractedEventDto[] }> {
    return { data: await this.contractedEvents.list(id, query) };
  }

  @Post('units/:id/events')
  @Idempotent()
  @ApiOperation({ summary: 'Cadastra um evento contratado (dono; RN-04.05)' })
  @ApiCreatedResponse({ standardSchema: ContractedEventSchema })
  @NotFoundResponse()
  @Forbidden('só o dono cadastra eventos.')
  @ApiBadRequestResponse({
    description: '`INVALID_PRICE_LIST` ou `VALIDATION_FAILED`.',
    standardSchema: ErrorResponseSchema,
  })
  createEvent(
    @Param('id', IdPipe) id: string,
    @Body({ schema: CreateContractedEventRequestSchema })
    body: z.infer<typeof CreateContractedEventRequestSchema>,
  ): Promise<ContractedEventDto> {
    return this.contractedEvents.create(id, body);
  }

  @Get('events/:id')
  @ApiOperation({ summary: 'Detalhe do evento contratado' })
  @ApiOkResponse({ standardSchema: ContractedEventSchema })
  @NotFoundResponse()
  @Forbidden('só o dono ou quem opera o caixa na unidade.')
  getEvent(@Param('id', IdPipe) id: string): Promise<ContractedEventDto> {
    return this.contractedEvents.get(id);
  }

  @Patch('events/:id')
  @ApiOperation({
    summary: 'Edita o evento: acordo e tabela de preço até ele ser encerrado (dono; RN-04.37)',
  })
  @ApiOkResponse({ standardSchema: ContractedEventSchema })
  @NotFoundResponse()
  @Forbidden('só o dono edita eventos.')
  @Conflict('`EVENT_CLOSED` ou `VERSION_CONFLICT`.')
  @ApiBadRequestResponse({
    description: '`INVALID_PRICE_LIST` ou `VALIDATION_FAILED`.',
    standardSchema: ErrorResponseSchema,
  })
  updateEvent(
    @Param('id', IdPipe) id: string,
    @Body({ schema: UpdateContractedEventRequestSchema })
    body: z.infer<typeof UpdateContractedEventRequestSchema>,
  ): Promise<ContractedEventDto> {
    return this.contractedEvents.update(id, body);
  }

  @Post('events/:id/start')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Inicia o evento: comandas novas ficam ligadas a ele e usam a tabela dele (RN-04.34 a RN-04.36)',
  })
  @ApiOkResponse({ standardSchema: ContractedEventSchema })
  @NotFoundResponse()
  @Forbidden('só o dono ou quem opera o caixa na unidade.')
  @Conflict('`EVENT_ALREADY_IN_PROGRESS` (CA-04.15), `EVENT_NOT_SCHEDULED` ou `VERSION_CONFLICT`.')
  startEvent(
    @Param('id', IdPipe) id: string,
    @Body({ schema: ContractedEventActionRequestSchema })
    body: z.infer<typeof ContractedEventActionRequestSchema>,
  ): Promise<ContractedEventDto> {
    return this.contractedEvents.start(id, body.version);
  }

  @Post('events/:id/finish')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Encerra o evento em andamento (RN-04.34)' })
  @ApiOkResponse({ standardSchema: ContractedEventSchema })
  @NotFoundResponse()
  @Forbidden('só o dono ou quem opera o caixa na unidade.')
  @Conflict('`EVENT_NOT_IN_PROGRESS` ou `VERSION_CONFLICT`.')
  finishEvent(
    @Param('id', IdPipe) id: string,
    @Body({ schema: ContractedEventActionRequestSchema })
    body: z.infer<typeof ContractedEventActionRequestSchema>,
  ): Promise<ContractedEventDto> {
    return this.contractedEvents.finish(id, body.version);
  }

  @Post('events/:id/cancel')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancela um evento agendado (dono; RN-04.34)' })
  @ApiOkResponse({ standardSchema: ContractedEventSchema })
  @NotFoundResponse()
  @Forbidden('só o dono cancela eventos.')
  @Conflict('`EVENT_NOT_SCHEDULED` ou `VERSION_CONFLICT`.')
  cancelEvent(
    @Param('id', IdPipe) id: string,
    @Body({ schema: ContractedEventActionRequestSchema })
    body: z.infer<typeof ContractedEventActionRequestSchema>,
  ): Promise<ContractedEventDto> {
    return this.contractedEvents.cancel(id, body.version);
  }

  // ---------------------------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------------------------

  @Get('units/:id/tabs')
  @ApiOperation({
    summary:
      'Varal: comandas em aberto da unidade, de qualquer dia, com totais e resumo dos itens (as fechadas só do dia de operação atual)',
  })
  @ApiOkResponse({ standardSchema: TabListSchema })
  @NotFoundResponse()
  @Forbidden('colaborador sem acesso à unidade.')
  async listTabs(
    @Param('id', IdPipe) id: string,
    @Query({ schema: TabListQuerySchema }) query: TabListQuery,
  ): Promise<{ data: TabSummaryDto[] }> {
    return { data: await this.tabs.list(id, tabStatusesOf(query)) };
  }

  @Post('units/:id/tabs')
  @Idempotent()
  @ApiOperation({
    summary:
      'Abre uma comanda aberta com o próximo número do dia, ligada ao evento em andamento (RN-04.02, RN-04.09, RN-04.36)',
  })
  @ApiCreatedResponse({ standardSchema: TabSchema })
  @NotFoundResponse()
  @Forbidden('é preciso ter acesso ao balcão da unidade.')
  @Conflict(`${NO_REGISTER}.`)
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
    `\`ORDER_REJECTED\` com \`details\` no formato \`OrderRejectedDetails\` (CA-04.06, CA-03.06), \`TAB_NOT_OPEN\` (RN-04.13), \`TAB_CLOSED\` ou ${NO_REGISTER}.`,
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
  @Conflict('`TAB_NOT_OPEN`, `TAB_CLOSED` ou `TAB_CHANGED`.')
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
  @Conflict('`TAB_NOT_CLOSING`, `TAB_CLOSED` ou `TAB_CHANGED`.')
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
    '`TAB_HAS_ACTIVE_ITEMS` (`details.itemIds`), `TAB_HAS_PAYMENTS`, `TAB_CLOSED` ou `TAB_CHANGED`.',
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
  @ApiOperation({
    summary:
      'Fila da estação (KDS): um cartão por pedido, do mais antigo para o mais novo, com as linhas da estação (RN-04.40 a RN-04.45)',
  })
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

  @Post('orders/:id/advance')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Avança o pedido inteiro na estação: todas as linhas dele na estação (e etapa) vão à próxima etapa, tudo ou nada (RN-04.39, CA-04.17)',
  })
  @ApiOkResponse({ standardSchema: AdvanceOrderResultSchema })
  @NotFoundResponse()
  @Forbidden('sem acesso à estação.')
  @Conflict(
    '`ITEM_CHANGED` (alguma linha mudou ou faltou: `details.items` traz as linhas atuais), `ITEM_NOT_AT_STATION` ou `ITEM_IN_FINAL_STAGE`.',
  )
  advanceOrder(
    @Param('id', IdPipe) id: string,
    @Body({ schema: AdvanceOrderRequestSchema }) body: z.infer<typeof AdvanceOrderRequestSchema>,
  ): Promise<AdvanceOrderResultDto> {
    return this.items.advanceOrder(id, body);
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
