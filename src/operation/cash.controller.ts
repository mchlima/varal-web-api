import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
import {
  CashMovementRequestSchema,
  type CashRegisterDetailDto,
  CashRegisterDetailSchema,
  type CashRegisterDto,
  CashRegisterListSchema,
  CashRegisterSchema,
  CloseCashRegisterRequestSchema,
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
  '`NO_CASH_REGISTER_OPEN` (CA-05.08), `CASH_REGISTER_REQUIRED` (`details.cashRegisters`), `CASH_REGISTER_CLOSED`, `PAYMENT_EXCEEDS_BALANCE` (CA-05.03), `TAB_NOTHING_TO_PAY`, `TAB_CHANGED` ou `SHIFT_CLOSED`';

/**
 * Closing of tabs and cash registers (spec 05): discounts, payments, reversals, "paga antes" and
 * cash registers. Panel session; permissions by unit are checked by the services.
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
    '`TAB_PAYMENTS_EXCEED_TOTAL` (o total ficaria menor que o já pago), `TAB_PAID`, `TAB_CLOSED`, `TAB_CHANGED` ou `SHIFT_CLOSED`.',
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
  @Conflict(
    '`TAB_PAID`, `TAB_CLOSED`, `TAB_PAYMENTS_EXCEED_TOTAL`, `TAB_CHANGED` ou `SHIFT_CLOSED`.',
  )
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
      'Registra um pagamento da comanda em `closing`: Pix e cartões até o saldo, dinheiro com troco; com saldo zero a comanda fica `paid` (RN-05.04 a RN-05.10). Em `on_credit` é quitação de fiado, em qualquer turno aberto da unidade, parcial ou total; com saldo zero fica `settled` (RN-06.09 a RN-06.11)',
  })
  @ApiCreatedResponse({ standardSchema: PaymentResultSchema })
  @NotFoundResponse()
  @Forbidden(COUNTER)
  @Conflict(
    `${PAYMENT_CONFLICTS}, \`TAB_NOT_CLOSING\` (RN-05.07), \`NO_SHIFT_OPEN\` (quitação, RN-06.09) ou \`TAB_CLOSED\`.`,
  )
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
      'Estorna um pagamento, com motivo, com turno e caixa abertos; comanda paga volta a `closing` (RN-05.13 a RN-05.15) e quitada volta a `on_credit` (RN-06.12)',
  })
  @ApiOkResponse({ standardSchema: PaymentResultSchema })
  @NotFoundResponse()
  @Forbidden(COUNTER)
  @Conflict('`PAYMENT_ALREADY_REVERSED`, `CASH_REGISTER_CLOSED`, `TAB_CLOSED` ou `SHIFT_CLOSED`.')
  reverse(
    @Param('id', IdPipe) id: string,
    @Body({ schema: ReversePaymentRequestSchema })
    body: z.infer<typeof ReversePaymentRequestSchema>,
  ): Promise<PaymentResultDto> {
    return this.payments.reverse(id, body.reason);
  }

  @Post('shifts/:id/tabs/pay-first')
  @Idempotent()
  @ApiOperation({
    summary:
      'Comanda paga antes: comanda, pedido e pagamentos numa operação; nasce `paid` e só então o pedido vai às estações (RN-05.12, CA-04.10)',
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
  // Cash registers
  // ---------------------------------------------------------------------------------------------

  @Post('shifts/:id/cash-registers')
  @Idempotent()
  @ApiOperation({
    summary:
      'Abre um caixa no turno com fundo de troco; vários podem ficar abertos (RN-05.16, RN-05.17)',
  })
  @ApiCreatedResponse({ standardSchema: CashRegisterSchema })
  @NotFoundResponse()
  @Forbidden(CASH)
  @Conflict('`CASH_REGISTER_NAME_TAKEN` ou `SHIFT_CLOSED`.')
  openRegister(
    @Param('id', IdPipe) id: string,
    @Body({ schema: OpenCashRegisterRequestSchema })
    body: z.infer<typeof OpenCashRegisterRequestSchema>,
  ): Promise<CashRegisterDto> {
    return this.registers.open(id, body);
  }

  @Get('shifts/:id/cash-registers')
  @ApiOperation({ summary: 'Caixas do turno com o esperado por forma de pagamento' })
  @ApiOkResponse({ standardSchema: CashRegisterListSchema })
  @NotFoundResponse()
  @Forbidden('só o balcão e quem opera o caixa na unidade.')
  async listRegisters(@Param('id', IdPipe) id: string): Promise<{ data: CashRegisterDto[] }> {
    return { data: await this.registers.list(id) };
  }

  @Get('cash-registers/:id')
  @ApiOperation({ summary: 'Caixa com movimentos, pagamentos e esperado por forma' })
  @ApiOkResponse({ standardSchema: CashRegisterDetailSchema })
  @NotFoundResponse()
  @Forbidden(CASH)
  getRegister(@Param('id', IdPipe) id: string): Promise<CashRegisterDetailDto> {
    return this.registers.detail(id);
  }

  @Post('cash-registers/:id/movements')
  @Idempotent()
  @ApiOperation({
    summary:
      'Sangria (`withdrawal`, até o dinheiro esperado) ou suprimento (`deposit`), com motivo (RN-05.18)',
  })
  @ApiCreatedResponse({ standardSchema: CashRegisterDetailSchema })
  @NotFoundResponse()
  @Forbidden(CASH)
  @Conflict('`WITHDRAWAL_EXCEEDS_CASH`, `CASH_REGISTER_CLOSED` ou `VERSION_CONFLICT`.')
  move(
    @Param('id', IdPipe) id: string,
    @Body({ schema: CashMovementRequestSchema }) body: z.infer<typeof CashMovementRequestSchema>,
  ): Promise<CashRegisterDetailDto> {
    return this.registers.move(id, body);
  }

  @Post('cash-registers/:id/close')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Fecha o caixa com o valor conferido de cada forma; diferença exige observação (RN-05.20, RN-05.21, CA-05.07)',
  })
  @ApiOkResponse({ standardSchema: CashRegisterSchema })
  @NotFoundResponse()
  @Forbidden(CASH)
  @Conflict('`CASH_REGISTER_CLOSED` ou `VERSION_CONFLICT`.')
  @BadRequest(
    '`CLOSING_NOTE_REQUIRED` (`details.counts` com as diferenças) ou `VALIDATION_FAILED`.',
  )
  closeRegister(
    @Param('id', IdPipe) id: string,
    @Body({ schema: CloseCashRegisterRequestSchema })
    body: z.infer<typeof CloseCashRegisterRequestSchema>,
  ): Promise<CashRegisterDto> {
    return this.registers.close(id, body);
  }
}
