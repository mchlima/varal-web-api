import { z } from 'zod';

import { ExpectedVersionSchema } from '../units/units.schemas.js';
import { digitsOf, isValidCpf, isValidPhone } from './credit-rules.js';
import { PaymentSchema, TabSummarySchema } from './operation.schemas.js';

/*
 * Contracts of spec 06 (fiado): customers, putting a tab on credit and the receivables. Money in
 * integer cents (`…Cents`); dates in ISO 8601 (UTC).
 */

// ------------------------------------------------------------------------------------------------
// Customers (spec 06, section 3)
// ------------------------------------------------------------------------------------------------

export const CustomerSchema = z
  .object({
    id: z.uuid(),
    unitId: z.uuid(),
    name: z.string().meta({ description: '"Cliente removido" depois da remoção (RN-06.03).' }),
    phone: z.string().nullable().meta({ description: 'Só dígitos, com DDD (RN-06.01).' }),
    cpf: z.string().nullable().meta({ description: 'Só dígitos (RN-06.01).' }),
    reference: z.string().nullable().meta({
      description: 'Referência para diferenciar homônimos (ex.: "apto 42, bloco B").',
    }),
    note: z.string().nullable(),
    removedAt: z.iso.datetime().nullable().meta({
      description: 'Removido a pedido (LGPD): nome e dados apagados, comandas mantidas (RN-06.03).',
    }),
    createdAt: z.iso.datetime(),
    version: z.int(),
  })
  .meta({
    id: 'Customer',
    description:
      'Cliente do fiado, por unidade (RN-06.01). Na busca, aparece com os dados de identificação que tiver, para não confundir homônimos (RN-06.02).',
  });

export type CustomerDto = z.infer<typeof CustomerSchema>;

const NameSchema = z
  .string()
  .trim()
  .min(1, { message: 'Informe o nome do cliente.' })
  .max(60, { message: 'Use no máximo 60 caracteres.' });

/** Empty string clears an optional field (same as null). */
function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max, { message: `Use no máximo ${max} caracteres.` })
    .nullable()
    .optional();
}

const PhoneSchema = z
  .string()
  .max(20, { message: 'Telefone inválido.' })
  .refine((value) => digitsOf(value) === '' || isValidPhone(digitsOf(value)), {
    message: 'Informe um telefone com DDD, como (11) 98765-4321.',
  })
  .nullable()
  .optional()
  .meta({
    description:
      'Telefone com DDD; pontuação é ignorada e fica guardado só com dígitos. Único na unidade (RN-06.02).',
  });

const CpfSchema = z
  .string()
  .max(20, { message: 'CPF inválido.' })
  .refine((value) => digitsOf(value) === '' || isValidCpf(digitsOf(value)), {
    message: 'CPF inválido.',
  })
  .nullable()
  .optional()
  .meta({
    description:
      'CPF validado pelos dígitos verificadores, guardado só com dígitos; único na unidade (RN-06.02).',
  });

const CustomerFieldsShape = {
  phone: PhoneSchema,
  cpf: CpfSchema,
  reference: optionalText(60).meta({ description: 'Até 60 caracteres (RN-06.01).' }),
  note: optionalText(140).meta({ description: 'Observação, até 140 caracteres (RN-06.01).' }),
};

export const CreateCustomerRequestSchema = z
  .object({
    name: NameSchema.meta({ description: 'Obrigatório, até 60 caracteres.' }),
    ...CustomerFieldsShape,
  })
  .meta({
    id: 'CreateCustomerRequest',
    description: 'Cadastro (também o rápido, no pendurar): só o nome é obrigatório (CA-06.06).',
  });

export type CreateCustomerRequest = z.infer<typeof CreateCustomerRequestSchema>;

export const UpdateCustomerRequestSchema = z
  .object({
    name: NameSchema.optional(),
    ...CustomerFieldsShape,
    version: ExpectedVersionSchema.optional(),
  })
  .meta({
    id: 'UpdateCustomerRequest',
    description: 'Campos ausentes não mudam; `null` ou texto vazio apaga um dado opcional.',
  });

export type UpdateCustomerRequest = z.infer<typeof UpdateCustomerRequestSchema>;

/** `?q=`: unnamed (query schemas never carry `.meta({ id })`). */
export const CustomerListQuerySchema = z.object({
  q: z.string().trim().max(60).optional().meta({
    description:
      'Busca por nome, telefone, CPF ou referência (RN-06.02); vazio lista todos. Removidos não aparecem.',
  }),
  limit: z.coerce.number().int().min(1).max(100).default(50).meta({
    description: 'Quantidade máxima de resultados (1 a 100, padrão 50), em ordem de nome.',
  }),
});

export type CustomerListQuery = z.infer<typeof CustomerListQuerySchema>;

export const CustomerListSchema = z
  .object({ data: z.array(CustomerSchema) })
  .meta({ id: 'CustomerList' });

// ------------------------------------------------------------------------------------------------
// Put on credit (spec 06, section 4)
// ------------------------------------------------------------------------------------------------

export const PutOnCreditRequestSchema = z
  .object({
    customerId: z.uuid().optional().meta({
      description:
        'Cliente da unidade (RN-06.05). Opcional só no turno contratado `consumption_billed`: sem ele, a comanda vai para o cliente com o nome do contratante, criado se preciso (RN-06.08).',
    }),
    version: z.int().min(0).optional().meta({
      description: 'Versão da comanda que o aparelho tem (opcional; `TAB_CHANGED`).',
    }),
  })
  .meta({ id: 'PutOnCreditRequest' });

export type PutOnCreditRequest = z.infer<typeof PutOnCreditRequestSchema>;

// ------------------------------------------------------------------------------------------------
// Receivables (spec 06, sections 5 and 8)
// ------------------------------------------------------------------------------------------------

export const CustomerReceivableSchema = z
  .object({
    customer: CustomerSchema,
    balanceCents: z.int().meta({ description: 'Soma dos saldos das comandas penduradas.' }),
    tabCount: z.int(),
    oldestCreditAt: z.iso.datetime(),
  })
  .meta({ id: 'CustomerReceivable' });

export const ReceivablesSchema = z
  .object({
    unitId: z.uuid(),
    totalCents: z.int().meta({ description: 'Total a receber da unidade.' }),
    tabs: z.array(TabSummarySchema).meta({
      description:
        'Comandas `on_credit` da unidade, mais antigas primeiro (`creditAt`), com cliente e saldo (`balanceCents`).',
    }),
    customers: z.array(CustomerReceivableSchema).meta({
      description: 'Totais por cliente, maior saldo primeiro.',
    }),
  })
  .meta({ id: 'Receivables', description: 'Valores a receber da unidade (spec 06, seção 7).' });

export type ReceivablesDto = z.infer<typeof ReceivablesSchema>;

export const CustomerDetailSchema = CustomerSchema.extend({
  balanceCents: z.int().meta({ description: 'Total a receber do cliente.' }),
  tabs: z.array(TabSummarySchema).meta({
    description: 'Comandas penduradas e quitadas do cliente, mais recentes primeiro.',
  }),
  settlements: z.array(PaymentSchema).meta({
    description: 'Histórico de quitações (`isCreditSettlement`), inclusive estornadas.',
  }),
}).meta({ id: 'CustomerDetail', description: 'Cliente com o fiado e o histórico de quitações.' });

export type CustomerDetailDto = z.infer<typeof CustomerDetailSchema>;
