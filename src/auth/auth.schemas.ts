import { z } from 'zod';

import { SubscriptionStatusSchema } from '../openapi/enum-schemas.js';
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
    /** Stations released to the staff member in this unit (`staff_unit_permissions.station_ids`). */
    stationIds: z.array(z.uuid()),
    canOperateCash: z.boolean(),
  })
  .meta({ id: 'PanelUnit' });

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
    }),
    units: z.array(PanelUnitSchema),
    session: SessionInfoSchema,
  })
  .meta({ id: 'PanelMe', description: 'Perfil, organização, unidades e estações permitidas.' });

export const AdminMeSchema = z
  .object({
    admin: z.object({ id: z.uuid(), name: z.string(), email: z.string() }),
    session: SessionInfoSchema,
  })
  .meta({ id: 'AdminMe' });

export type PanelMe = z.infer<typeof PanelMeSchema>;
export type AdminMe = z.infer<typeof AdminMeSchema>;
export type SessionInfo = z.infer<typeof SessionInfoSchema>;
