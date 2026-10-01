import { HttpStatus } from '@nestjs/common';

interface ErrorDefinition {
  status: HttpStatus;
  /** Default message in pt-BR, safe to show to the user (spec 01, section 5). */
  message: string;
}

/**
 * Generic error codes shared by every module (spec 01, section 5). Codes are stable and in English;
 * modules add their own codes (e.g. `TAB_ALREADY_CLOSED`) next to their rules.
 */
export const ERROR_CODES = {
  VALIDATION_FAILED: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Alguns dados enviados são inválidos.',
  },
  BAD_REQUEST: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Não foi possível entender a requisição.',
  },
  UNAUTHENTICATED: {
    status: HttpStatus.UNAUTHORIZED,
    message: 'Sua sessão expirou. Entre novamente.',
  },
  FORBIDDEN: {
    status: HttpStatus.FORBIDDEN,
    message: 'Você não tem permissão para fazer isso.',
  },
  NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    message: 'Não encontramos o que você procurou.',
  },
  METHOD_NOT_ALLOWED: {
    status: HttpStatus.METHOD_NOT_ALLOWED,
    message: 'Esta operação não é permitida aqui.',
  },
  CONFLICT: {
    status: HttpStatus.CONFLICT,
    message: 'Não foi possível concluir por causa de uma mudança feita antes.',
  },
  ALREADY_EXISTS: {
    status: HttpStatus.CONFLICT,
    message: 'Já existe um cadastro com esses dados.',
  },
  VERSION_CONFLICT: {
    status: HttpStatus.CONFLICT,
    message: 'Outro aparelho alterou este registro antes. Confira e tente de novo.',
  },
  IDEMPOTENCY_KEY_REUSED: {
    status: HttpStatus.CONFLICT,
    message: 'Esta chave de envio já foi usada em outra requisição.',
  },
  IDEMPOTENCY_REQUEST_IN_PROGRESS: {
    status: HttpStatus.CONFLICT,
    message: 'Esta ação ainda está sendo processada. Aguarde um instante.',
  },
  PAYLOAD_TOO_LARGE: {
    status: HttpStatus.PAYLOAD_TOO_LARGE,
    message: 'Os dados enviados são grandes demais.',
  },
  RATE_LIMITED: {
    status: HttpStatus.TOO_MANY_REQUESTS,
    message: 'Muitas tentativas. Aguarde um pouco e tente de novo.',
  },
  INTERNAL_ERROR: {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    message: 'Ocorreu um erro inesperado. Tente de novo em instantes.',
  },
  SERVICE_UNAVAILABLE: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    message: 'O serviço está indisponível no momento. Tente de novo em instantes.',
  },
} as const satisfies Record<string, ErrorDefinition>;

export type ErrorCode = keyof typeof ERROR_CODES;

export const ERROR_CODE_VALUES = Object.keys(ERROR_CODES) as [ErrorCode, ...ErrorCode[]];

/** Generic code used when a framework exception (e.g. an unknown route) carries only a status. */
export function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 405:
      return 'METHOD_NOT_ALLOWED';
    case 409:
      return 'CONFLICT';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 429:
      return 'RATE_LIMITED';
    case 503:
      return 'SERVICE_UNAVAILABLE';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST';
  }
}
