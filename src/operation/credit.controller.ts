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

import { PanelAuth } from '../auth/auth.decorators.js';
import { ErrorResponseSchema } from '../errors/error-response.schema.js';
import { Idempotent } from '../idempotency/idempotent.decorator.js';
import { IdPipe, NotFoundResponse } from '../units/unit-access.js';
import {
  type CreateCustomerRequest,
  CreateCustomerRequestSchema,
  type CustomerDetailDto,
  CustomerDetailSchema,
  type CustomerDto,
  type CustomerListDto,
  CustomerListSchema,
  type CustomerListQuery,
  CustomerListQuerySchema,
  CustomerSchema,
  type PutOnCreditRequest,
  PutOnCreditRequestSchema,
  type ReceivablesDto,
  ReceivablesSchema,
  type UpdateCustomerRequest,
  UpdateCustomerRequestSchema,
} from './credit.schemas.js';
import { CreditService } from './credit.service.js';
import { type TabDto, TabSchema } from './operation.schemas.js';

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
const OWNER = 'só o dono edita e remove clientes.';
const UNIQUE = '`CUSTOMER_PHONE_TAKEN` ou `CUSTOMER_CPF_TAKEN` (RN-06.02, CA-06.06)';

/**
 * Fiado (spec 06): customers, putting a tab on credit and the receivables. Settling is
 * `POST /tabs/{id}/payments` (spec 05) on a tab `on_credit`. Panel session; permissions by unit
 * are checked by the service.
 */
@ApiTags('credit')
@PanelAuth()
@Controller()
export class CreditController {
  constructor(private readonly credit: CreditService) {}

  @Get('units/:id/customers')
  @ApiOperation({
    summary:
      'Busca clientes da unidade por nome, telefone, CPF ou referência, com os dados de identificação, paginada por cursor em ordem de nome (RN-06.02, CA-06.04)',
  })
  @ApiOkResponse({ standardSchema: CustomerListSchema })
  @NotFoundResponse()
  @Forbidden(COUNTER)
  async list(
    @Param('id', IdPipe) id: string,
    @Query({ schema: CustomerListQuerySchema }) query: CustomerListQuery,
  ): Promise<CustomerListDto> {
    return this.credit.list(id, query);
  }

  @Post('units/:id/customers')
  @Idempotent()
  @ApiOperation({
    summary:
      'Cadastra cliente na unidade; só o nome é obrigatório, telefone e CPF únicos na unidade (RN-06.01, RN-06.02)',
  })
  @ApiCreatedResponse({ standardSchema: CustomerSchema })
  @NotFoundResponse()
  @Forbidden(COUNTER)
  @Conflict(`${UNIQUE}.`)
  @BadRequest('`VALIDATION_FAILED` (telefone com DDD, CPF pelos dígitos verificadores).')
  create(
    @Param('id', IdPipe) id: string,
    @Body({ schema: CreateCustomerRequestSchema }) body: CreateCustomerRequest,
  ): Promise<CustomerDto> {
    return this.credit.create(id, body);
  }

  @Get('customers/:id')
  @ApiOperation({
    summary: 'Cliente com as comandas penduradas e quitadas, o saldo e o histórico de quitações',
  })
  @ApiOkResponse({ standardSchema: CustomerDetailSchema })
  @NotFoundResponse()
  @Forbidden(COUNTER)
  detail(@Param('id', IdPipe) id: string): Promise<CustomerDetailDto> {
    return this.credit.detail(id);
  }

  @Patch('customers/:id')
  @Idempotent()
  @ApiOperation({ summary: 'Edita cliente (dono); `null` apaga um dado opcional' })
  @ApiOkResponse({ standardSchema: CustomerSchema })
  @NotFoundResponse()
  @Forbidden(OWNER)
  @Conflict(`${UNIQUE}, \`CUSTOMER_REMOVED\` ou \`CUSTOMER_CHANGED\`.`)
  @BadRequest('`VALIDATION_FAILED`.')
  update(
    @Param('id', IdPipe) id: string,
    @Body({ schema: UpdateCustomerRequestSchema }) body: UpdateCustomerRequest,
  ): Promise<CustomerDto> {
    return this.credit.update(id, body);
  }

  @Delete('customers/:id')
  @Idempotent()
  @ApiOperation({
    summary:
      'Remove o cliente a pedido (LGPD): apaga nome e dados, mantém as comandas; recusado com valor a receber (RN-06.03, CA-06.05)',
  })
  @ApiOkResponse({ standardSchema: CustomerSchema })
  @NotFoundResponse()
  @Forbidden(OWNER)
  @Conflict('`CUSTOMER_HAS_RECEIVABLE` (`details.balanceCents`) ou `CUSTOMER_REMOVED`.')
  remove(@Param('id', IdPipe) id: string): Promise<CustomerDto> {
    return this.credit.remove(id);
  }

  @Post('tabs/:id/put-on-credit')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Pendura a comanda em `closing` num cliente da unidade: vai a `on_credit` com o saldo (RN-06.04 a RN-06.08, CA-06.01, CA-06.02)',
  })
  @ApiOkResponse({ standardSchema: TabSchema })
  @NotFoundResponse()
  @Forbidden(COUNTER)
  @Conflict(
    '`TAB_NOT_CLOSING` (CA-06.02), `TAB_CLOSED`, `TAB_NOTHING_TO_PAY`, `TAB_CHANGED` ou `SHIFT_CLOSED`.',
  )
  @BadRequest('`INVALID_CUSTOMER`, `CUSTOMER_REQUIRED` ou `VALIDATION_FAILED`.')
  putOnCredit(
    @Param('id', IdPipe) id: string,
    @Body({ schema: PutOnCreditRequestSchema }) body: PutOnCreditRequest,
  ): Promise<TabDto> {
    return this.credit.putOnCredit(id, body);
  }

  @Get('units/:id/receivables')
  @ApiOperation({
    summary:
      'Valores a receber da unidade: comandas `on_credit` mais antigas primeiro, com cliente, data e saldo, e totais por cliente',
  })
  @ApiOkResponse({ standardSchema: ReceivablesSchema })
  @NotFoundResponse()
  @Forbidden('é preciso ter acesso ao balcão ou operar o caixa da unidade.')
  receivables(@Param('id', IdPipe) id: string): Promise<ReceivablesDto> {
    return this.credit.receivables(id);
  }
}
