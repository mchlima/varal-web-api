import { z } from 'zod';

import { AppError } from '../errors/app-error.js';

/**
 * Error codes of the authentication (spec 01, section 7). Messages in pt-BR, safe to show.
 * Published in the OpenAPI as `AuthErrorCode`.
 */
export const AUTH_ERRORS = {
  /** Same answer for unknown user, wrong password, inactive user or no password yet (section 7.3). */
  INVALID_CREDENTIALS: { status: 401, message: 'E-mail ou senha incorretos.' },
  INVALID_STAFF_CREDENTIALS: {
    status: 401,
    message: 'Código do estabelecimento, usuário ou senha incorretos.',
  },
  /** 10 wrong attempts in a row lock the identifier for 15 minutes (section 7.3). */
  LOGIN_TEMPORARILY_LOCKED: {
    status: 429,
    message: 'Muitas tentativas erradas. Aguarde 15 minutos e tente de novo.',
  },
  INVALID_PASSWORD_TOKEN: {
    status: 400,
    message: 'Este link é inválido, já foi usado ou expirou. Peça um novo link.',
  },
  WRONG_CURRENT_PASSWORD: { status: 400, message: 'A senha atual está incorreta.' },
  /** RN-01.02: at most 3 reset links per user per hour. */
  PASSWORD_RESET_LIMIT_REACHED: {
    status: 429,
    message:
      'Já foram gerados 3 links de redefinição na última hora. Aguarde um pouco e tente de novo.',
  },
  /** RN-03.16: a staff member without any active unit cannot log in (right password). */
  STAFF_WITHOUT_UNIT: {
    status: 403,
    message: 'Você ainda não tem acesso a nenhuma unidade. Fale com o responsável pela barraca.',
  },
  /** "Entrar como" (spec 02, section 7): the one-time link was used, expired or is not yours. */
  INVALID_IMPERSONATION_TOKEN: {
    status: 400,
    message:
      'Este link de acesso de suporte é inválido, já foi usado ou expirou. Gere outro no admin.',
  },
  /** Actions of the owner's own account that the Varal team never does in an "entrar como". */
  NOT_ALLOWED_DURING_IMPERSONATION: {
    status: 403,
    message: 'Esta ação não está disponível durante um acesso de suporte.',
  },
  DEVICE_ID_REQUIRED: {
    status: 400,
    message: 'O identificador do aparelho (X-Device-Id) é obrigatório para entrar.',
  },
} as const satisfies Record<string, { status: number; message: string }>;

export type AuthErrorCode = keyof typeof AUTH_ERRORS;

export function authError(code: AuthErrorCode, details: Record<string, unknown> = {}): AppError {
  const { status, message } = AUTH_ERRORS[code];
  return new AppError(code, status, message, details);
}

export const AuthErrorCodeSchema = z
  .enum(Object.keys(AUTH_ERRORS) as [AuthErrorCode, ...AuthErrorCode[]])
  .meta({
    id: 'AuthErrorCode',
    description: 'Códigos de erro da autenticação (spec 01, seção 7).',
  });
