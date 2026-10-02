import { z } from 'zod';

import { pageSchema } from '../common/pagination.js';
import type { Station, Unit, WorkflowStage } from '../generated/prisma/client.js';
import { StationKind, WorkflowStageTarget } from '../generated/prisma/enums.js';
import { MAX_STAGES, WORKFLOW_ISSUE_CODES } from './workflow-rules.js';

/** Names of units, stations, stages, categories, products and modifiers. */
export const NameSchema = z
  .string()
  .trim()
  .min(1, { message: 'Informe o nome.' })
  .max(60, { message: 'Use no máximo 60 caracteres.' });

export const SortOrderSchema = z
  .int()
  .min(1)
  .max(10_000)
  .meta({ description: 'Posição na lista (1 é o primeiro).' });

/** Expected version of the record (optimistic concurrency, `VERSION_CONFLICT`). */
export const ExpectedVersionSchema = z.int().min(0).meta({
  description:
    'Versão que o app tem do registro. Se outro aparelho alterou antes, a API responde 409 `VERSION_CONFLICT` com `details.currentVersion`. Opcional.',
});

/** Spec 03, section 3: from 1 to 240 minutes, default 15. */
export const LateAfterMinutesSchema = z.int().min(1).max(240).meta({
  description:
    'Padrão do atraso das estações novas da unidade, em minutos (1 a 240); a atenção nasce na metade (RN-03.25).',
});

/** RN-03.25: limits of a `queue` station (attention < delay; checked by the service). */
const StationAttentionSchema = z.int().min(1).max(239).meta({
  description:
    'Minutos desde o envio do pedido a partir dos quais o cartão fica em atenção (RN-03.25); de 1 até o atraso − 1.',
});

const StationLateSchema = z.int().min(2).max(240).meta({
  description:
    'Minutos desde o envio do pedido a partir dos quais o cartão fica atrasado (RN-03.25), até 240.',
});

// ------------------------------------------------------------------------------------------------
// Enums
// ------------------------------------------------------------------------------------------------

export const StationKindSchema = z.enum(StationKind).meta({
  id: 'StationKind',
  description:
    '`counter`: balcão de pedidos (abre comandas, lança pedidos, recebe); `queue`: fila de itens das etapas ligadas a ela (spec 03, seção 4.1).',
});

export const WorkflowStageTargetSchema = z.enum(WorkflowStageTarget).meta({
  id: 'WorkflowStageTarget',
  description:
    '`product_station`: a estação de preparo do produto; `fixed_station`: uma estação escolhida; `none`: etapa final, o item sai das filas (spec 03, seção 4.2).',
});

export const WorkflowIssueCodeSchema = z.enum(WORKFLOW_ISSUE_CODES).meta({
  id: 'WorkflowIssueCode',
  description:
    'Problema de um fluxo recusado com `INVALID_WORKFLOW` (`details.issues`, RN-03.05 e RN-03.06).',
});

export const WorkflowIssueSchema = z
  .object({
    code: WorkflowIssueCodeSchema,
    index: z
      .int()
      .nullable()
      .meta({ description: 'Posição da etapa no corpo (a partir de 0); `null` = o fluxo todo.' }),
    message: z.string(),
  })
  .meta({ id: 'WorkflowIssue' });

// ------------------------------------------------------------------------------------------------
// Units
// ------------------------------------------------------------------------------------------------

export const UnitSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    active: z.boolean(),
    lateAfterMinutes: z.int(),
    version: z.int().meta({ description: 'Versão da configuração (unidade, estações e fluxo).' }),
    menuVersion: z.int().meta({ description: 'Versão do cardápio (`menu.updated`).' }),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Unit' });

export type UnitDto = z.infer<typeof UnitSchema>;

export const UnitPageSchema = pageSchema('UnitPage', UnitSchema);

export const CreateUnitRequestSchema = z
  .object({ name: NameSchema, lateAfterMinutes: LateAfterMinutesSchema.default(15) })
  .meta({ id: 'CreateUnitRequest' });

export const UpdateUnitRequestSchema = z
  .object({
    name: NameSchema.optional(),
    active: z.boolean().optional(),
    lateAfterMinutes: LateAfterMinutesSchema.optional(),
    version: ExpectedVersionSchema.optional(),
  })
  .meta({ id: 'UpdateUnitRequest' });

export function toUnitDto(unit: Unit): UnitDto {
  return {
    id: unit.id,
    name: unit.name,
    active: unit.active,
    lateAfterMinutes: unit.lateAfterMinutes,
    version: unit.version,
    menuVersion: unit.menuVersion,
    createdAt: unit.createdAt.toISOString(),
  };
}

// ------------------------------------------------------------------------------------------------
// Stations
// ------------------------------------------------------------------------------------------------

export const StationSchema = z
  .object({
    id: z.uuid(),
    unitId: z.uuid(),
    name: z.string(),
    kind: StationKindSchema,
    sortOrder: z.int(),
    active: z.boolean(),
    attentionAfterMinutes: z.int().nullable().meta({
      description: 'Limite de atenção (RN-03.25); só nas estações `queue`, `null` no balcão.',
    }),
    lateAfterMinutes: z.int().nullable().meta({
      description: 'Limite de atraso (RN-03.25); só nas estações `queue`, `null` no balcão.',
    }),
  })
  .meta({ id: 'Station' });

export type StationDto = z.infer<typeof StationSchema>;

/** A station as shown to who opens it (`/auth/me`, staff permissions). */
export const StationSummarySchema = z
  .object({ id: z.uuid(), name: z.string(), kind: StationKindSchema })
  .meta({ id: 'StationSummary' });

export const StationListSchema = z
  .object({ data: z.array(StationSchema) })
  .meta({ id: 'StationList' });

export const CreateStationRequestSchema = z
  .object({
    name: NameSchema,
    kind: StationKindSchema,
    sortOrder: SortOrderSchema.optional(),
    attentionAfterMinutes: StationAttentionSchema.optional(),
    lateAfterMinutes: StationLateSchema.optional().meta({
      description:
        'Só em `queue`. Sem os limites, a estação recebe o atraso padrão da unidade e a atenção na metade (RN-03.25).',
    }),
  })
  .meta({ id: 'CreateStationRequest' });

export const UpdateStationRequestSchema = z
  .object({
    name: NameSchema.optional(),
    kind: StationKindSchema.optional(),
    sortOrder: SortOrderSchema.optional(),
    active: z.boolean().optional(),
    attentionAfterMinutes: StationAttentionSchema.optional(),
    lateAfterMinutes: StationLateSchema.optional(),
  })
  .meta({
    id: 'UpdateStationRequest',
    description:
      'Mudar só os limites de tempo é permitido com caixa aberto e vale na hora para os cartões (RN-03.25); as demais mudanças seguem a RN-03.07.',
  });

export function toStationDto(station: Station): StationDto {
  return {
    id: station.id,
    unitId: station.unitId,
    name: station.name,
    kind: station.kind,
    sortOrder: station.sortOrder,
    active: station.active,
    attentionAfterMinutes: station.attentionAfterMinutes,
    lateAfterMinutes: station.lateAfterMinutes,
  };
}

// ------------------------------------------------------------------------------------------------
// Workflow
// ------------------------------------------------------------------------------------------------

export const WorkflowStageSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    sortOrder: z.int(),
    target: WorkflowStageTargetSchema,
    stationId: z
      .uuid()
      .nullable()
      .meta({ description: 'Só em `fixed_station`: a estação em que o item aparece.' }),
    isFinal: z.boolean(),
  })
  .meta({ id: 'WorkflowStage' });

export const WorkflowSchema = z
  .object({
    unitId: z.uuid(),
    version: z.int().meta({ description: 'Versão da unidade (envie no `PUT` para conferência).' }),
    stages: z.array(WorkflowStageSchema),
  })
  .meta({ id: 'Workflow' });

export type WorkflowDto = z.infer<typeof WorkflowSchema>;

export const PutWorkflowRequestSchema = z
  .object({
    version: ExpectedVersionSchema.optional(),
    stages: z
      .array(
        z.object({
          id: z.uuid().optional().meta({
            description:
              'Id de uma etapa atual, para mantê-la (itens já pedidos apontam para ela). Sem id, cria uma etapa nova; etapas atuais fora da lista são arquivadas.',
          }),
          name: NameSchema,
          target: WorkflowStageTargetSchema,
          stationId: z.uuid().nullable().optional(),
        }),
      )
      .max(MAX_STAGES * 2)
      .meta({
        description: `Etapas na ordem do fluxo: de 2 a ${MAX_STAGES}, a última com destino \`none\` (RN-03.05).`,
      }),
  })
  .meta({ id: 'PutWorkflowRequest' });

export function toWorkflowStageDto(stage: WorkflowStage): WorkflowDto['stages'][number] {
  return {
    id: stage.id,
    name: stage.name,
    sortOrder: stage.sortOrder,
    target: stage.target,
    stationId: stage.stationId,
    isFinal: stage.isFinal,
  };
}

export const unitContractSchemas: readonly z.ZodType[] = [
  StationKindSchema,
  WorkflowStageTargetSchema,
  WorkflowIssueCodeSchema,
  WorkflowIssueSchema,
];
