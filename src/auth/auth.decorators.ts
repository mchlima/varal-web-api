import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiUnauthorizedResponse } from '@nestjs/swagger';

import { DEVICE_ID_HEADER } from '../context/request-context.middleware.js';

import { ErrorResponseSchema } from '../errors/error-response.schema.js';

export const IS_PUBLIC = Symbol('IS_PUBLIC');
export const ADMIN_AREA = Symbol('ADMIN_AREA');

/** Names of the cookie security schemes in the OpenAPI document (see openapi.ts). */
export const PANEL_SECURITY_SCHEME = 'panelSession';
export const ADMIN_SECURITY_SCHEME = 'adminSession';

/**
 * Route open without a session (login, refresh, health…). Every other route requires the session
 * of its area: the platform admin under `/api/v1/admin`, the panel everywhere else.
 */
export function Public(): MethodDecorator & ClassDecorator {
  return SetMetadata(IS_PUBLIC, true);
}

/** Documents the panel session cookie and the 401 of a protected panel route. */
export function PanelAuth(): MethodDecorator & ClassDecorator {
  return applyDecorators(
    ApiCookieAuth(PANEL_SECURITY_SCHEME),
    ApiUnauthorizedResponse({
      description: '`UNAUTHENTICATED`: sem sessão do app ou sessão encerrada.',
      standardSchema: ErrorResponseSchema,
    }),
  );
}

/**
 * Marks a controller of the platform admin (CA-01.04): only the admin session is accepted. Routes
 * under `/api/v1/admin` are admin routes even without it; this makes it explicit.
 */
export function AdminArea(): MethodDecorator & ClassDecorator {
  return SetMetadata(ADMIN_AREA, true);
}

/** Documents the admin session cookie and the 401 of a protected admin route. */
export function AdminAuth(): MethodDecorator & ClassDecorator {
  return applyDecorators(
    ApiCookieAuth(ADMIN_SECURITY_SCHEME),
    ApiUnauthorizedResponse({
      description: '`UNAUTHENTICATED`: sem sessão do admin ou sessão encerrada.',
      standardSchema: ErrorResponseSchema,
    }),
  );
}

export const DEVICE_HEADER_DOC = {
  name: DEVICE_ID_HEADER,
  required: true,
  description:
    'UUID guardado no aparelho; obrigatório no login e gravado na sessão (spec 01, seção 7.2).',
  schema: { type: 'string', format: 'uuid' },
} as const;

export const LOGIN_LOCK_DOC =
  '`LOGIN_TEMPORARILY_LOCKED` (10 senhas erradas seguidas bloqueiam o identificador por 15 min) ou `RATE_LIMITED`.';

export function LoginResponses(): MethodDecorator {
  return applyDecorators(
    ApiHeader(DEVICE_HEADER_DOC),
    ApiUnauthorizedResponse({
      description: 'Credenciais inválidas: sempre a mesma resposta, exista ou não o usuário.',
      standardSchema: ErrorResponseSchema,
    }),
  );
}
