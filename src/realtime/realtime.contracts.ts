import { z } from 'zod';

import { SESSION_REVOCATION_REASONS } from '../auth/auth-events.js';
import { defineEvent } from '../openapi/define-event.js';

/*
 * Contracts of the real-time channel (spec 01, section 10; RN-01.10). Every payload is a zod schema
 * published in `components.schemas` of the OpenAPI, so the app generates its types from it.
 */

/** Socket.IO path (spec 01, section 10). */
export const REALTIME_PATH = '/ws';

/** Events the client sends (with an acknowledgement callback). */
export const CLIENT_EVENTS = {
  joinRoom: 'rooms.join',
  leaveRoom: 'rooms.leave',
} as const;

// ------------------------------------------------------------------------------------------------
// Errors
// ------------------------------------------------------------------------------------------------

/**
 * Error codes of the real-time channel. They arrive in `connect_error` (`err.data`, an
 * `ErrorResponse`) or in the acknowledgement of `rooms.join` / `rooms.leave`.
 */
export const REALTIME_ERRORS = {
  /** No access cookie, invalid or expired token, admin token, revoked session or other device. */
  UNAUTHENTICATED: 'Sua sessão expirou. Entre novamente.',
  /** The handshake must send `auth.deviceId` (UUID of the device, spec 01, section 7.2). */
  DEVICE_ID_REQUIRED: 'O identificador do aparelho (deviceId) é obrigatório para conectar.',
  /** The room does not exist, is of another organization or the user has no access to it. */
  ROOM_FORBIDDEN: 'Você não tem acesso a esta sala.',
  VALIDATION_FAILED: 'Alguns dados enviados são inválidos.',
  INTERNAL_ERROR: 'Ocorreu um erro inesperado. Tente de novo em instantes.',
} as const;

export type RealtimeErrorCode = keyof typeof REALTIME_ERRORS;

export const RealtimeErrorCodeSchema = z
  .enum(Object.keys(REALTIME_ERRORS) as [RealtimeErrorCode, ...RealtimeErrorCode[]])
  .meta({
    id: 'RealtimeErrorCode',
    description:
      'Códigos de erro do tempo real (`/ws`): em `connect_error` (`err.data`, um `ErrorResponse`) e na resposta de `rooms.join`/`rooms.leave`.',
  });

/** `ErrorResponse` body of a real-time error (spec 01, section 5). */
export function realtimeErrorBody(code: RealtimeErrorCode): {
  error: { code: RealtimeErrorCode; message: string; details: Record<string, never> };
} {
  return { error: { code, message: REALTIME_ERRORS[code], details: {} } };
}

/** Error passed to `next()` of the handshake middleware: the client gets it in `connect_error`. */
export class RealtimeConnectError extends Error {
  readonly data: ReturnType<typeof realtimeErrorBody>;

  constructor(readonly code: RealtimeErrorCode) {
    super(code);
    this.name = 'RealtimeConnectError';
    this.data = realtimeErrorBody(code);
  }
}

// ------------------------------------------------------------------------------------------------
// Rooms requested by the client
// ------------------------------------------------------------------------------------------------

export const RealtimeRoomRequestSchema = z
  .object({
    room: z.string().meta({
      description: 'Sala `unit:{unitId}` ou `station:{stationId}`.',
      examples: ['station:01922f2c-7a3b-7c00-8000-0000000000e1'],
    }),
  })
  .meta({
    id: 'RealtimeRoomRequest',
    description:
      'Corpo de `rooms.join` e `rooms.leave` (cliente → servidor, com callback de confirmação).',
  });

export const RealtimeRoomAckSchema = z
  .discriminatedUnion('ok', [
    z.object({
      ok: z.literal(true),
      rooms: z
        .array(z.string())
        .meta({ description: 'Salas `unit:` e `station:` em que o aparelho está agora.' }),
    }),
    z.object({
      ok: z.literal(false),
      error: z.object({
        code: RealtimeErrorCodeSchema,
        message: z.string(),
        details: z.record(z.string(), z.unknown()),
      }),
    }),
  ])
  .meta({
    id: 'RealtimeRoomAck',
    description: 'Resposta (callback) de `rooms.join` e `rooms.leave`.',
  });

export type RealtimeRoomAck = z.infer<typeof RealtimeRoomAckSchema>;

// ------------------------------------------------------------------------------------------------
// Events of a unit (envelope for the business modules)
// ------------------------------------------------------------------------------------------------

/** Event of a unit or station room, as emitted by {@link RealtimeService}. */
export interface RealtimeEventDefinition<TType extends string, TData extends z.ZodType> {
  type: TType;
  data: TData;
  /** Envelope schema, named `Event…` in the OpenAPI. */
  schema: z.ZodType<RealtimeEnvelope<TType, z.infer<TData>>>;
}

/** Envelope of every event of a unit or station (spec 01, section 10). */
export interface RealtimeEnvelope<TType extends string = string, TData = unknown> {
  type: TType;
  organizationId: string;
  unitId: string;
  /** ISO 8601 (UTC). */
  occurredAt: string;
  /** Version of the resource; the app ignores events older than the state it has. */
  version: number;
  data: TData;
}

/**
 * Defines an event of the unit and station rooms (specs 03, 04 and 05, e.g. `order.created` as
 * `EventOrderCreated`). The Socket.IO event name is `type`; the payload is the envelope
 * `{ type, organizationId, unitId, occurredAt, version, data }` (spec 01, section 10). List the
 * returned `schema` in `contractSchemas` (src/openapi/contract-schemas.ts) to publish it (RN-01.10).
 */
export function defineRealtimeEvent<TType extends string, TData extends z.ZodType>(
  id: `Event${string}`,
  type: TType,
  data: TData,
  description?: string,
): RealtimeEventDefinition<TType, TData> {
  const schema = z.object({
    type: z.literal(type),
    organizationId: z.uuid(),
    unitId: z.uuid(),
    occurredAt: z.iso.datetime(),
    version: z.int().min(0).meta({
      description:
        'Versão do recurso. O app ignora eventos com versão menor que a do estado que já tem.',
    }),
    data,
  });
  const named = defineEvent(id, description ? schema.meta({ description }) : schema);
  return {
    type,
    data,
    schema: named as unknown as z.ZodType<RealtimeEnvelope<TType, z.infer<TData>>>,
  };
}

// ------------------------------------------------------------------------------------------------
// Events of the session (sent only to the sockets of that session)
// ------------------------------------------------------------------------------------------------

export const SESSION_EVENTS = {
  revoked: 'session.revoked',
  expired: 'session.expired',
  accessChanged: 'session.access_changed',
} as const;

export const SessionRevocationReasonSchema = z.enum(SESSION_REVOCATION_REASONS).meta({
  id: 'SessionRevocationReason',
  description: 'Por que a sessão foi encerrada.',
});

export const EventSessionRevokedSchema = defineEvent(
  'EventSessionRevoked',
  z
    .object({
      type: z.literal(SESSION_EVENTS.revoked),
      occurredAt: z.iso.datetime(),
      data: z.object({ reason: SessionRevocationReasonSchema }),
    })
    .meta({
      description:
        'A sessão foi encerrada (logout, troca ou redefinição de senha, desativação, novo login no aparelho). O servidor desconecta o socket logo depois; o app volta para o login (CA-01.05).',
    }),
);

export type EventSessionRevoked = z.infer<typeof EventSessionRevokedSchema>;

export const EventSessionExpiredSchema = defineEvent(
  'EventSessionExpired',
  z
    .object({
      type: z.literal(SESSION_EVENTS.expired),
      occurredAt: z.iso.datetime(),
      data: z.object({
        expiredAt: z.iso.datetime().meta({ description: 'Fim do token de acesso do socket.' }),
      }),
    })
    .meta({
      description:
        'O token de acesso usado na conexão venceu. O servidor desconecta o socket logo depois; o app renova a sessão por REST (`POST /auth/refresh`) e reconecta.',
    }),
);

export type EventSessionExpired = z.infer<typeof EventSessionExpiredSchema>;

/** Why the server asks a socket to reconnect with fresh rooms (spec 03; spec 01, section 10). */
export const ACCESS_CHANGE_REASONS = [
  'permissions_changed',
  'unit_changed',
  'stations_changed',
] as const;

export type AccessChangeReason = (typeof ACCESS_CHANGE_REASONS)[number];

export const AccessChangeReasonSchema = z.enum(ACCESS_CHANGE_REASONS).meta({
  id: 'AccessChangeReason',
  description:
    '`permissions_changed`: o dono mudou as permissões do colaborador; `unit_changed`: unidade criada, ativada ou desativada; `stations_changed`: estação criada, ativada, desativada ou com tipo trocado.',
});

export const EventSessionAccessChangedSchema = defineEvent(
  'EventSessionAccessChanged',
  z
    .object({
      type: z.literal(SESSION_EVENTS.accessChanged),
      occurredAt: z.iso.datetime(),
      data: z.object({ reason: AccessChangeReasonSchema }),
    })
    .meta({
      description:
        'As unidades ou estações que o usuário acessa mudaram. A sessão continua válida: o servidor desconecta o socket logo depois, e o app busca `GET /auth/me` e reconecta (`socket.connect()`), entrando nas salas do novo acesso (spec 01, seção 10; spec 03).',
    }),
);

export type EventSessionAccessChanged = z.infer<typeof EventSessionAccessChangedSchema>;

/** Contract schemas of the real-time channel, listed in `contractSchemas`. */
export const realtimeContractSchemas: readonly z.ZodType[] = [
  RealtimeErrorCodeSchema,
  RealtimeRoomRequestSchema,
  RealtimeRoomAckSchema,
  SessionRevocationReasonSchema,
  EventSessionRevokedSchema,
  EventSessionExpiredSchema,
  AccessChangeReasonSchema,
  EventSessionAccessChangedSchema,
];
