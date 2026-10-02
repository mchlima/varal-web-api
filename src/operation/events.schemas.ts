import { z } from 'zod';

import { ExpectedVersionSchema } from '../units/units.schemas.js';
import {
  ActorRefSchema,
  AgreementModalitySchema,
  ContractedEventStatusSchema,
  PlainDateSchema,
} from './operation.schemas.js';

/*
 * Contracts of the contracted events (spec 04, section 3.3). Days (`startsOn`, `endsOn`) as
 * `AAAA-MM-DD`; money in cents.
 */

const DayInputSchema = z.iso.date({ error: 'Use o formato AAAA-MM-DD.' });

export const ContractedEventSchema = z
  .object({
    id: z.uuid(),
    unitId: z.uuid(),
    contractorName: z.string(),
    startsOn: PlainDateSchema,
    endsOn: PlainDateSchema.nullable().meta({
      description: 'Data final (eventos de mais de um dia).',
    }),
    priceList: z
      .object({ id: z.uuid(), name: z.string() })
      .nullable()
      .meta({ description: 'Tabela de preço do evento; `null` = "Normal" (RN-04.32).' }),
    modality: AgreementModalitySchema,
    agreedAmountCents: z.int().nullable(),
    agreedQuantity: z.int().nullable().meta({
      description: 'Quantidade combinada, comparada com o consumo no relatório (spec 07).',
    }),
    limits: z.string().nullable(),
    notes: z.string().nullable(),
    status: ContractedEventStatusSchema,
    startedAt: z.iso.datetime().nullable(),
    startedBy: ActorRefSchema.nullable(),
    finishedAt: z.iso.datetime().nullable(),
    finishedBy: ActorRefSchema.nullable(),
    canceledAt: z.iso.datetime().nullable(),
    version: z.int(),
  })
  .meta({
    id: 'ContractedEvent',
    description:
      'Evento contratado (spec 04, seção 3.3): contratante, datas, acordo informativo (RN-04.05) e tabela de preço.',
  });

export type ContractedEventDto = z.infer<typeof ContractedEventSchema>;

export const ContractedEventListSchema = z
  .object({ data: z.array(ContractedEventSchema) })
  .meta({ id: 'ContractedEventList' });

const ContractorNameSchema = z
  .string()
  .trim()
  .min(1, { message: 'Informe o nome do contratante.' })
  .max(60, { message: 'Use no máximo 60 caracteres.' });

const AgreementFields = {
  modality: AgreementModalitySchema,
  agreedAmountCents: z.int().min(0).max(100_000_000).nullable().optional(),
  agreedQuantity: z.int().min(1).max(1_000_000).nullable().optional(),
  limits: z
    .string()
    .trim()
    .max(200, { message: 'Use no máximo 200 caracteres.' })
    .nullish()
    .meta({ description: 'Limites em texto livre (ex.: "500 espetos", "das 18h às 23h").' }),
  notes: z.string().trim().max(500, { message: 'Use no máximo 500 caracteres.' }).nullish(),
};

function checkDates(
  value: { startsOn?: string | undefined; endsOn?: string | null | undefined },
  ctx: z.RefinementCtx,
): void {
  if (
    value.startsOn !== undefined &&
    value.endsOn !== undefined &&
    value.endsOn !== null &&
    value.endsOn < value.startsOn
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['endsOn'],
      message: 'A data final precisa ser igual ou depois da data do evento.',
    });
  }
}

export const CreateContractedEventRequestSchema = z
  .object({
    contractorName: ContractorNameSchema,
    startsOn: DayInputSchema,
    endsOn: DayInputSchema.nullish(),
    priceListId: z.uuid().nullish().meta({
      description: 'Tabela de preço ativa da unidade; sem ela, "Normal".',
    }),
    ...AgreementFields,
  })
  .superRefine(checkDates)
  .meta({ id: 'CreateContractedEventRequest', description: 'Cadastro do evento (RN-04.05).' });

export type CreateContractedEventRequest = z.infer<typeof CreateContractedEventRequestSchema>;

export const UpdateContractedEventRequestSchema = z
  .object({
    contractorName: ContractorNameSchema.optional(),
    startsOn: DayInputSchema.optional(),
    endsOn: DayInputSchema.nullish(),
    priceListId: z.uuid().nullish().meta({
      description:
        '`null` volta para "Normal". Num evento em andamento, vale para itens novos (RN-04.37).',
    }),
    modality: AgreementModalitySchema.optional(),
    agreedAmountCents: AgreementFields.agreedAmountCents,
    agreedQuantity: AgreementFields.agreedQuantity,
    limits: AgreementFields.limits,
    notes: AgreementFields.notes,
    version: ExpectedVersionSchema.optional(),
  })
  .superRefine(checkDates)
  .meta({
    id: 'UpdateContractedEventRequest',
    description: 'Edição do acordo e da tabela até o evento ser encerrado (RN-04.37).',
  });

export type UpdateContractedEventRequest = z.infer<typeof UpdateContractedEventRequestSchema>;

export const ContractedEventActionRequestSchema = z
  .object({ version: ExpectedVersionSchema.optional() })
  .meta({ id: 'ContractedEventActionRequest' });

const EVENT_STATUS_LIST = new RegExp(
  `^(${ContractedEventStatusSchema.options.join('|')})(,(${ContractedEventStatusSchema.options.join('|')}))*$`,
);

/** Unnamed: query schemas never carry `.meta({ id })`. */
export const ContractedEventListQuerySchema = z.object({
  status: z
    .string()
    .regex(EVENT_STATUS_LIST, {
      message: `Use situações separadas por vírgula: ${ContractedEventStatusSchema.options.join(', ')}.`,
    })
    .optional()
    .meta({
      description: 'Situações (`ContractedEventStatus`) separadas por vírgula; padrão: todas.',
    }),
  from: DayInputSchema.optional().meta({
    description: 'Eventos que terminam neste dia ou depois (AAAA-MM-DD).',
  }),
  to: DayInputSchema.optional().meta({
    description: 'Eventos que começam neste dia ou antes (AAAA-MM-DD).',
  }),
});

export type ContractedEventListQuery = z.infer<typeof ContractedEventListQuerySchema>;
