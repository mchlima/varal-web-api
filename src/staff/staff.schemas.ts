import { z } from 'zod';

import { NewPasswordSchema } from '../auth/password-hasher.js';
import { pageSchema } from '../common/pagination.js';
import { StationSummarySchema } from '../units/units.schemas.js';

/** Spec 01, section 12: letters, digits, dot and underscore; unique per organization ignoring case. */
export const UsernameSchema = z
  .string()
  .trim()
  .min(3, { message: 'O usuário precisa ter pelo menos 3 caracteres.' })
  .max(32, { message: 'O usuário pode ter no máximo 32 caracteres.' })
  .regex(/^[A-Za-z0-9._]+$/, { message: 'Use só letras, números, ponto e sublinhado.' })
  .meta({ description: 'Letras, números, ponto e sublinhado (3 a 32); único na organização.' });

const StaffNameSchema = z
  .string()
  .trim()
  .min(1, { message: 'Informe o nome.' })
  .max(80, { message: 'Use no máximo 80 caracteres.' });

const OptionalEmailSchema = z
  .email({ message: 'E-mail inválido.' })
  .max(254)
  .toLowerCase()
  .nullable();

export const StaffUnitPermissionSchema = z
  .object({
    unitId: z.uuid(),
    unitName: z.string(),
    stationIds: z.array(z.uuid()),
    stations: z
      .array(StationSummarySchema)
      .meta({ description: 'Estações liberadas, ativas, em ordem de exibição.' }),
    canOperateCash: z.boolean(),
  })
  .meta({ id: 'StaffUnitPermission' });

export const StaffMemberSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    username: z.string(),
    email: z.string().nullable(),
    active: z.boolean(),
    hasPassword: z.boolean(),
    permissions: z.array(StaffUnitPermissionSchema),
  })
  .meta({ id: 'StaffMember' });

export type StaffMemberDto = z.infer<typeof StaffMemberSchema>;

export const StaffMemberPageSchema = pageSchema('StaffMemberPage', StaffMemberSchema);

export const StaffPermissionInputSchema = z
  .object({
    unitId: z.uuid(),
    stationIds: z
      .array(z.uuid())
      .max(50)
      .default([])
      .meta({ description: 'Estações ativas desta unidade que o colaborador pode abrir.' }),
    canOperateCash: z.boolean().default(false),
  })
  .meta({ id: 'StaffPermissionInput' });

export const CreateStaffMemberRequestSchema = z
  .object({
    name: StaffNameSchema,
    username: UsernameSchema,
    password: NewPasswordSchema,
    email: OptionalEmailSchema.optional(),
    permissions: z.array(StaffPermissionInputSchema).max(100).default([]),
  })
  .meta({ id: 'CreateStaffMemberRequest' });

export const UpdateStaffMemberRequestSchema = z
  .object({
    name: StaffNameSchema.optional(),
    username: UsernameSchema.optional(),
    email: OptionalEmailSchema.optional(),
    active: z.boolean().optional().meta({
      description: 'Desativar encerra as sessões do colaborador na hora (RN-03.17).',
    }),
  })
  .meta({ id: 'UpdateStaffMemberRequest' });

export const PutStaffPermissionsRequestSchema = z
  .object({
    units: z
      .array(StaffPermissionInputSchema)
      .max(100)
      .meta({ description: 'Todas as unidades liberadas (substitui as atuais).' }),
  })
  .meta({ id: 'PutStaffPermissionsRequest' });

export const StaffPasswordResetRequestSchema = z
  .object({
    sendEmail: z
      .boolean()
      .default(false)
      .meta({ description: 'Também envia o link por e-mail, se o colaborador tiver e-mail.' }),
  })
  .meta({ id: 'StaffPasswordResetRequest' });

export const StaffPasswordResetResponseSchema = z
  .object({
    link: z.url().meta({ description: 'Link de uso único (1 hora) para copiar.' }),
    expiresAt: z.iso.datetime(),
    emailSent: z.boolean(),
    whatsappUrl: z.url().meta({
      description: '`https://wa.me/?text=` com a mensagem e o link (RN-03.18).',
    }),
  })
  .meta({ id: 'StaffPasswordResetResponse' });

export type StaffPasswordResetResponse = z.infer<typeof StaffPasswordResetResponseSchema>;

export const SetStaffPasswordRequestSchema = z
  .object({ password: NewPasswordSchema })
  .meta({ id: 'SetStaffPasswordRequest' });

export const OrganizationAccessSchema = z
  .object({
    accessCode: z.string().meta({ examples: ['ESPT26'] }),
    link: z.url().meta({ description: 'Link de acesso da equipe (`/e/{code}`).' }),
    qrSvg: z.string().meta({
      description:
        'QR code do link em SVG (escalável; mostre grande para escanear de outro celular).',
    }),
  })
  .meta({ id: 'OrganizationAccess' });

export type OrganizationAccess = z.infer<typeof OrganizationAccessSchema>;
