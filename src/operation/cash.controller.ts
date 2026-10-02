import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
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
import { CashRegistersService } from './cash-registers.service.js';
import { OwnerOnly } from '../units/unit-access.js';
import {
  CashMovementRequestSchema,
  type CashRegisterDto,
  CashRegisterListSchema,
  CashRegisterSchema,
  type CashRegisterSessionDetailDto,
  CashRegisterSessionDetailSchema,
  CloseCashRegisterRequestSchema,
  type ClosePreviewDto,
  ClosePreviewSchema,
  CreateCashRegisterRequestSchema,
  UpdateCashRegisterRequestSchema,
  CreatePaymentRequestSchema,
  OpenCashRegisterRequestSchema,
  PayFirstRequestSchema,
  type PaymentResultDto,
  PaymentResultSchema,
  PutDiscountRequestSchema,
  RemoveDiscountRequestSchema,
  ReversePaymentRequestSchema,
} from './cash.schemas.js';
import { type TabDto, TabSchema } from './operation.schemas.js';
import { PaymentsService } from './payments.service.js';

function Forbidden(description: string): MethodDecorator {
  return ApiForbiddenResponse({
    description: `\`FORBIDDEN\`: ${description}`,
    standardSchema: ErrorResponseSchema,
  });
}

function Conflict(description: string): MethodDecorator {
  return ApiConflictResponse({ description, standardSchema: ErrorResponseSchema });
}

function BadRequest(description: string): MethodDecorator {
  return ApiBadRequestResponse({ description, standardSchema: ErrorResponseSchema });
}

const COUNTER = 'é preciso ter acesso ao balcão da unidade.';
const CASH = 'só o dono ou quem opera o caixa na unidade (RN-05.16).';
const PAYMENT_CONFLICTS =
  '`NO_CASH_REGISTER_OPEN` (CA-05.08), `CASH_REGISTER_REQUIRED` (`details` no formato `CashRegisterRequiredDetails`), `CASH_REGISTER_CLOSED`, `PAYMENT_EXCEEDS_BALANCE` (CA-05.03), `TAB_NOTHING_TO_PAY` ou `TAB_CHANGED`';

/**
 * Closing of tabs and cash registers (spec 05): discounts, payments, reversals, "paga antes",
 * cash registers of the unit and their sessions. Panel session; permissions by unit are checked by
 * the services.
 */
@ApiTags('cash')
@PanelAuth()
@Controller()
export class CashController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly registers: CashRegistersService,
  ) {}

  // ---------------------------------------------------------------------------------------------
  // Discount
  // ---------------------------------------------------------------------------------------------

  @Put('tabs/:id/discount')
  @Idempotent()
  @ApiOperation({
    summary:
      'Aplica ou substitui o desconto da comanda em `open` ou `closing`: valor ou percentual, com motivo (RN-05.01 a RN-05.03)',
  })
  @ApiOkResponse({ standardSchema: TabSchema })
  @NotFoundResponse()
  @Forbidden(COUNTER)
  @Conflict(
    '`TAB_PAYMENTS_EXCEED_TOTAL` (o total ficaria menor que o já pago), `TAB_PAID`, `TAB_CLOSED` ou `TAB_CHANGED`.',
  )
  @BadRequest('`VALIDATION_FAILED` (percentual de 1 a 100, motivo obrigatório).')
  setDiscount(
    @Param('id', IdPipe) id: string,
    @Body({ schema: PutDiscountRequestSchema }) body: z.infer<typeof PutDiscountRequestSchema>,
  ): Promise<TabDto> {
    return this.payments.setDiscount(id, body);
  }

  @Delete('tabs/:id/discount')
  @Idempotent()
  @ApiOperation({ summary: 'Remove o desconto da comanda, com motivo (RN-05.01)' })
  @ApiOkResponse({ standardSchema: TabSchema })
  @NotFoundResponse()
  @Forbidden(COUNTER)
  @Conflict('`TAB_PAID`, `TAB_CLOSED`, `TAB_PAYMENTS_EXCEED_TOTAL` ou `TAB_CHANGED`.')
  removeDiscount(
    @Param('id', IdPipe) id: string,
    @Body({ schema: RemoveDiscountRequestSchema })
    body: z.infer<typeof RemoveDiscountRequestSchema>,
  ): Promise<TabDto> {
    return this.payments.removeDiscount(id, body);
  }

  // ---------------------------------------------------------------------------------------------
  // Payments
  // ---------------------------------------------------------------------------------------------

  @Post('tabs/:id/payments')
  @Idempotent()
  @ApiOperation({
    summary:
      'Registra um pagamento da comanda em `closing` na abertura de um caixa aberto da unidade: Pix e cartões até o saldo, dinheiro com troco; com saldo zero a comanda fica `paid` (RN-05.04 a RN-05.10). Em `on_credit` é quitação de fiado, em qualquer caixa aberto da unidade, parcial ou total; com saldo zero fica `settled` (RN-06.09 a RN-06.11)',
  })
  @ApiCreatedResponse({ standardSchema: PaymentResultSchema })
  @NotFoundResponse()
  @Forbidden(COUNTER)
  @Conflict(`${PAYMENT_CONFLICTS}, \`TAB_NOT_CLOSING\` (RN-05.07) ou \`TAB_CLOSED\`.`)
  @BadRequest('`INVALID_CASH_REGISTER` ou `VALIDATION_FAILED`.')
  pay(
    @Param('id', IdPipe) id: string,
    @Body({ schema: CreatePaymentRequestSchema }) body: z.infer<typeof CreatePaymentRequestSchema>,
  ): Promise<PaymentResultDto> {
    return this.payments.pay(id, body);
  }

  @Post('payments/:id/reverse')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Estorna um pagamento, com motivo, enquanto a abertura de caixa dele estiver em andamento; comanda paga volta a `closing` (RN-05.13 a RN-05.15) e quitada volta a `on_credit` (RN-06.12)',
  })
  @ApiOkResponse({ standardSchema: PaymentResultSchema })
  @NotFoundResponse()
  @Forbidden(COUNTER)
  @Conflict(
    '`PAYMENT_ALREADY_REVERSED`, `CASH_REGISTER_CLOSED` (abertura já fechada, CA-05.13) ou `TAB_CLOSED`.',
  )
  reverse(
    @Param('id', IdPipe) id: string,
    @Body({ schema: ReversePaymentRequestSchema })
    body: z.infer<typeof ReversePaymentRequestSchema>,
  ): Promise<PaymentResultDto> {
    return this.payments.reverse(id, body.reason);
  }

  @Post('units/:id/tabs/pay-first')
  @Idempotent()
  @ApiOperation({
    summary:
      'Comanda paga antes: comanda, pedido e pagamentos numa operação, com caixa aberto; nasce `paid` e só então o pedido vai às estações (RN-05.12, CA-04.10)',
  })
  @ApiCreatedResponse({ standardSchema: TabSchema })
  @NotFoundResponse()
  @Forbidden(COUNTER)
  @Conflict(
    `\`PAYMENT_INSUFFICIENT\` (nada é gravado, CA-05.09), \`ORDER_REJECTED\`, ${PAYMENT_CONFLICTS}.`,
  )
  @BadRequest('`INVALID_CASH_REGISTER` ou `VALIDATION_FAILED`.')
  payFirst(
    @Param('id', IdPipe) id: string,
    @Body({ schema: PayFirstRequestSchema }) body: z.infer<typeof PayFirstRequestSchema>,
  ): Promise<TabDto> {
    return this.payments.payFirst(id, body);
  }

  // ---------------------------------------------------------------------------------------------
  // Cash registers of the unit and their sessions (spec 05, section 5)
  // ---------------------------------------------------------------------------------------------

  @Get('units/:id/cash-registers')
  @ApiOperation({
    summary:
      'Caixas da unidade, cada um com a abertura em andamento (responsável, desde quando, esperado por forma) ou a última fechada',
  })
  @ApiOkResponse({ standardSchema: CashRegisterListSchema })
  @NotFoundResponse()
  @Forbidden('só o balcão e quem opera o caixa na unidade.')
  async listRegisters(@Param('id', IdPipe) id: string): Promise<{ data: CashRegisterDto[] }> {
    return { data: await this.registers.list(id) };
  }

  @Post('units/:id/cash-registers')
  @OwnerOnly()
  @Idempotent()
  @ApiOperation({ summary: 'Cadastra um caixa na unidade (dono; RN-05.17, RN-05.27)' })
  @ApiCreatedResponse({ standardSchema: CashRegisterSchema })
  @NotFoundResponse()
  @Conflict('`CASH_REGISTER_NAME_TAKEN`.')
  createRegister(
    @Param('id', IdPipe) id: string,
    @Body({ schema: CreateCashRegisterRequestSchema })
    body: z.infer<typeof CreateCashRegisterRequestSchema>,
  ): Promise<CashRegisterDto> {
    return this.registers.create(id, body);
  }

  @Patch('cash-registers/:id')
  @OwnerOnly()
  @ApiOperation({ summary: 'Renomeia, ordena, ativa ou desativa um caixa (dono; RN-05.27)' })
  @ApiOkResponse({ standardSchema: CashRegisterSchema })
  @NotFoundResponse()
  @Conflict(
    '`CASH_REGISTER_OPEN`, `LAST_ACTIVE_CASH_REGISTER` (CA-05.14), `CASH_REGISTER_NAME_TAKEN` ou `VERSION_CONFLICT`.',
  )
  updateRegister(
    @Param('id', IdPipe) id: string,
    @Body({ schema: UpdateCashRegisterRequestSchema })
    body: z.infer<typeof UpdateCashRegisterRequestSchema>,
  ): Promise<CashRegisterDto> {
    return this.registers.update(id, body);
  }

  @Post('cash-registers/:id/open')
  @Idempotent()
  @ApiOperation({
    summary:
      'Abre o caixa com fundo de troco: cria uma abertura; o primeiro caixa de um dia novo muda o dia de operação e reinicia a numeração (RN-05.23 a RN-05.25, RN-04.29)',
  })
  @ApiCreatedResponse({ standardSchema: CashRegisterSchema })
  @NotFoundResponse()
  @Forbidden(CASH)
  @Conflict(
    '`CASH_REGISTER_ALREADY_OPEN` (CA-05.10), `CASH_REGISTER_INACTIVE`, `UNIT_INACTIVE`, `ORGANIZATION_SUSPENDED` ou `ORGANIZATION_CANCELED` (CA-02.05), `EVENT_ALREADY_IN_PROGRESS` ou `EVENT_NOT_SCHEDULED` (com `startEventId`).',
  )
  openRegister(
    @Param('id', IdPipe) id: string,
    @Body({ schema: OpenCashRegisterRequestSchema })
    body: z.infer<typeof OpenCashRegisterRequestSchema>,
  ): Promise<CashRegisterDto> {
    return this.registers.open(id, body);
  }

  @Get('cash-register-sessions/:id')
  @ApiOperation({ summary: 'Abertura de caixa com movimentos, pagamentos e esperado por forma' })
  @ApiOkResponse({ standardSchema: CashRegisterSessionDetailSchema })
  @NotFoundResponse()
  @Forbidden(CASH)
  getSession(@Param('id', IdPipe) id: string): Promise<CashRegisterSessionDetailDto> {
    return this.registers.detail(id);
  }

  @Post('cash-register-sessions/:id/movements')
  @Idempotent()
  @ApiOperation({
    summary:
      'Sangria (`withdrawal`, até o dinheiro esperado) ou suprimento (`deposit`), com motivo (RN-05.18)',
  })
  @ApiCreatedResponse({ standardSchema: CashRegisterSessionDetailSchema })
  @NotFoundResponse()
  @Forbidden(CASH)
  @Conflict('`WITHDRAWAL_EXCEEDS_CASH`, `CASH_REGISTER_CLOSED` ou `VERSION_CONFLICT`.')
  move(
    @Param('id', IdPipe) id: string,
    @Body({ schema: CashMovementRequestSchema }) body: z.infer<typeof CashMovementRequestSchema>,
  ): Promise<CashRegisterSessionDetailDto> {
    return this.registers.move(id, body);
  }

  @Get('cash-register-sessions/:id/close-preview')
  @ApiOperation({
    summary:
      'Prévia do fechamento: esperado por forma, comandas que seguem abertas e, no último caixa aberto, itens em preparo e evento em andamento (RN-05.28, RN-05.29)',
  })
  @ApiOkResponse({ standardSchema: ClosePreviewSchema })
  @NotFoundResponse()
  @Forbidden(CASH)
  closePreview(@Param('id', IdPipe) id: string): Promise<ClosePreviewDto> {
    return this.registers.closePreview(id);
  }

  @Post('cash-register-sessions/:id/close')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Fecha a abertura com o valor conferido de cada forma; diferença exige observação; comandas abertas não impedem e ficam como pendentes; no último caixa, encerra o preparo pendente e, se pedido, o evento (RN-05.20, RN-05.21, RN-05.28, RN-05.29)',
  })
  @ApiOkResponse({ standardSchema: CashRegisterSchema })
  @NotFoundResponse()
  @Forbidden(CASH)
  @Conflict('`CASH_REGISTER_CLOSED` ou `VERSION_CONFLICT`.')
  @BadRequest(
    '`CLOSING_NOTE_REQUIRED` (`details.counts` com as diferenças, CA-05.07) ou `VALIDATION_FAILED`.',
  )
  closeRegister(
    @Param('id', IdPipe) id: string,
    @Body({ schema: CloseCashRegisterRequestSchema })
    body: z.infer<typeof CloseCashRegisterRequestSchema>,
  ): Promise<CashRegisterDto> {
    return this.registers.close(id, body);
  }
}
