import { z } from 'zod';

import { PermissionSchema } from '../admin/rbac/permissions.js';
import { SubscriptionStatusSchema } from '../openapi/enum-schemas.js';
import { StationSummarySchema } from '../units/units.schemas.js';
import { NewPasswordSchema, PASSWORD_MAX_LENGTH } from './password-hasher.js';

/** Typed password of a login: any non-empty string (the minimum applies only to new passwords). */
const LoginPasswordSchema = z.string().min(1).max(PASSWORD_MAX_LENGTH);
const EmailSchema = z.email().max(254);

export const OwnerLoginRequestSchema = z
  .object({ email: EmailSchema, password: LoginPasswordSchema })
  .meta({ id: 'OwnerLoginRequest' });

export const StaffLoginRequestSchema = z
  .object({
    accessCode: z
      .string()
      .min(1)
      .max(16)
      .meta({
        description: 'Código do estabelecimento (6 caracteres), o mesmo do link `/e/{code}`.',
        examples: ['ESPT26'],
      }),
    username: z.string().min(1).max(64),
    password: LoginPasswordSchema,
  })
  .meta({ id: 'StaffLoginRequest' });

export const AdminLoginRequestSchema = z
  .object({ email: EmailSchema, password: LoginPasswordSchema })
  .meta({ id: 'AdminLoginRequest' });

export const ForgotPasswordRequestSchema = z
  .object({ email: EmailSchema })
  .meta({ id: 'ForgotPasswordRequest' });

/** RN-01.03: the same message whether or not the e-mail exists. */
export const FORGOT_PASSWORD_MESSAGE =
  'Se este e-mail estiver cadastrado, enviamos um link para definir uma nova senha. Confira também a caixa de spam.';

export const ForgotPasswordResponseSchema = z
  .object({ message: z.string() })
  .meta({ id: 'ForgotPasswordResponse' });

export const ResetPasswordRequestSchema = z
  .object({
    token: z
      .string()
      .min(20)
      .max(200)
      .meta({ description: 'Token do link (fragmento `#token=`).' }),
    password: NewPasswordSchema,
  })
  .meta({ id: 'ResetPasswordRequest' });

export const ChangePasswordRequestSchema = z
  .object({ currentPassword: LoginPasswordSchema, newPassword: NewPasswordSchema })
  .meta({ id: 'ChangePasswordRequest' });

export const AccessCodeOrganizationSchema = z
  .object({ organizationName: z.string() })
  .meta({ id: 'AccessCodeOrganization' });

export const AccessCodeParamSchema = z.string().min(1).max(16);

export const SessionInfoSchema = z
  .object({
    id: z.uuid(),
    deviceId: z.uuid(),
    /** When the access token (cookie) expires; the app renews before or on the first 401. */
    accessTokenExpiresAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().meta({ description: 'Fim da sessão se não for renovada.' }),
  })
  .meta({ id: 'SessionInfo' });

export const PanelUnitSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    /** Owners open any station of the unit. */
    allStations: z.boolean(),
    /**
     * Stations released to the staff member in this unit (`staff_unit_permissions.station_ids`,
     * only the active stations of the unit); empty for the owner, who opens any station.
     */
    stationIds: z.array(z.uuid()),
    stations: z.array(StationSummarySchema).meta({
      description:
        'Estações que o usuário pode abrir nesta unidade, ativas e em ordem: todas para o dono, as liberadas para o colaborador.',
    }),
    canOperateCash: z.boolean(),
    lateAfterMinutes: z.int().meta({
      description: 'Minutos a partir dos quais um item aparece como atrasado (spec 03, seção 3).',
    }),
  })
  .meta({ id: 'PanelUnit' });

export const PanelImpersonationSchema = z
  .object({
    id: z.uuid(),
    adminName: z.string(),
    startedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().nullable().meta({
      deprecated: true,
      description:
        'Sempre `null`: o "entrar como" não tem prazo e dura até o admin encerrar (RN-02.17).',
    }),
  })
  .meta({
    id: 'PanelImpersonation',
    description:
      '"Entrar como" (spec 02, seção 7): "Você está acessando como {organização} — {admin}". "Encerrar acesso" é o `POST /auth/logout`.',
  });

export const PanelMeSchema = z
  .object({
    subject: z.object({
      type: z.enum(['owner', 'staff']),
      id: z.uuid(),
      name: z.string(),
      email: z.string().nullable(),
      username: z.string().nullable(),
    }),
    organization: z.object({
      id: z.uuid(),
      name: z.string(),
      accessCode: z.string(),
      subscriptionStatus: SubscriptionStatusSchema,
      suspendedReason: z.string().nullable().meta({
        description:
          'Motivo da suspensão ou do cancelamento, para a faixa do painel do dono (RN-02.12).',
      }),
    }),
    units: z.array(PanelUnitSchema),
    session: SessionInfoSchema,
    impersonation: PanelImpersonationSchema.nullable().meta({
      description:
        'Preenchido quando a sessão é um "entrar como" da equipe do Varal: o app mostra a faixa fixa em todas as telas (RN-02.19).',
    }),
  })
  .meta({ id: 'PanelMe', description: 'Perfil, organização, unidades e estações permitidas.' });

export const AdminMeSchema = z
  .object({
    admin: z.object({ id: z.uuid(), name: z.string(), email: z.string() }),
    roles: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        isSystem: z.boolean(),
        systemKey: z.string().nullable(),
      }),
    ),
    permissions: z.array(PermissionSchema).meta({
      description:
        'Permissões efetivas (RN-02.02): o app esconde as ações sem permissão (RN-02.01).',
    }),
    session: SessionInfoSchema,
  })
  .meta({ id: 'AdminMe' });

export type PanelMe = z.infer<typeof PanelMeSchema>;
export type AdminMe = z.infer<typeof AdminMeSchema>;
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

export const ImpersonationExchangeRequestSchema = z
  .object({
    token: z
      .string()
      .min(20)
      .max(200)
      .meta({ description: 'Token do link de uso único (fragmento `#token=` de `/entrar-como`).' }),
  })
  .meta({ id: 'ImpersonationExchangeRequest' });
