import { Injectable } from '@nestjs/common';

import { AppError } from '../errors/app-error.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService, type TenantDb } from '../prisma/prisma.service.js';
import { IDEMPOTENCY_LOCK_TIMEOUT_MS, IDEMPOTENCY_TTL_MS } from './idempotency.constants.js';

export interface IdempotencyRequest {
  key: string;
  /** The logged-in subject: keys are unique per subject, never shared between users. */
  subjectId: string;
  organizationId: string | null;
  requestHash: string;
}

export type IdempotencyClaim =
  { kind: 'claimed'; id: string } | { kind: 'replay'; statusCode: number; response: unknown };

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** JSON-safe copy of a response body (`undefined` for an empty body). */
function toStoredJson(body: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return body === undefined
    ? Prisma.DbNull
    : (JSON.parse(JSON.stringify(body)) as Prisma.InputJsonValue);
}

/**
 * Storage of `Idempotency-Key` (spec 01, section 5; CA-01.06). The flow, driven by the interceptor:
 *
 * 1. {@link claim} (own short transaction): first use of the key inserts an `in_progress` row; a
 *    repeated key replays the stored response, or fails with 409 when the body differs
 *    (`IDEMPOTENCY_KEY_REUSED`) or the first request is still running (`IDEMPOTENCY_REQUEST_IN_PROGRESS`).
 * 2. {@link complete} inside the transaction of the action, so the action and the stored response
 *    commit together: a retry can never run the action twice.
 * 3. On failure the action rolls back; 4xx responses are stored ({@link storeError}) so a retry gets
 *    the same answer, 5xx release the key ({@link release}) so the retry runs again.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  async claim(
    request: IdempotencyRequest,
    now = new Date(),
    retried = false,
  ): Promise<IdempotencyClaim> {
    // Outside any ambient transaction: the claim must be visible to concurrent requests right away.
    const db = this.prisma.client;
    const expiresAt = new Date(now.getTime() + IDEMPOTENCY_TTL_MS);
    const fresh = {
      requestHash: request.requestHash,
      organizationId: request.organizationId,
      status: 'in_progress',
      statusCode: null,
      response: Prisma.DbNull,
      lockedAt: now,
      expiresAt,
    } as const;

    try {
      const created = await db.idempotencyKey.create({
        data: { key: request.key, subjectId: request.subjectId, ...fresh },
        select: { id: true },
      });
      return { kind: 'claimed', id: created.id };
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
    }

    // Take over an expired key, or an abandoned attempt of the same request.
    const [taken] = await db.idempotencyKey.updateManyAndReturn({
      where: {
        subjectId: request.subjectId,
        key: request.key,
        OR: [
          { expiresAt: { lte: now } },
          {
            status: 'in_progress',
            requestHash: request.requestHash,
            lockedAt: { lt: new Date(now.getTime() - IDEMPOTENCY_LOCK_TIMEOUT_MS) },
          },
        ],
      },
      data: fresh,
      select: { id: true },
    });
    if (taken) {
      return { kind: 'claimed', id: taken.id };
    }

    const existing = await db.idempotencyKey.findUnique({
      where: { subjectId_key: { subjectId: request.subjectId, key: request.key } },
    });
    if (!existing) {
      // Purged between the two queries: try once more from the start.
      if (retried) {
        throw AppError.of('IDEMPOTENCY_REQUEST_IN_PROGRESS');
      }
      return this.claim(request, now, true);
    }
    if (existing.requestHash !== request.requestHash) {
      throw AppError.of('IDEMPOTENCY_KEY_REUSED');
    }
    if (existing.status === 'in_progress' || existing.statusCode === null) {
      throw AppError.of('IDEMPOTENCY_REQUEST_IN_PROGRESS');
    }
    return {
      kind: 'replay',
      statusCode: existing.statusCode,
      response: existing.response ?? undefined,
    };
  }

  /** Stores the successful response in the transaction of the action. */
  async complete(tx: TenantDb, id: string, statusCode: number, body: unknown): Promise<void> {
    await tx.idempotencyKey.update({
      where: { id },
      data: { status: 'completed', statusCode, response: toStoredJson(body) },
    });
  }

  /** Stores a 4xx error response, after the action rolled back. */
  async storeError(id: string, statusCode: number, body: unknown): Promise<void> {
    await this.prisma.client.idempotencyKey.update({
      where: { id },
      data: { status: 'completed', statusCode, response: toStoredJson(body) },
    });
  }

  /** Frees the key after an unexpected (5xx) failure, so a retry runs the action again. */
  async release(id: string): Promise<void> {
    await this.prisma.client.idempotencyKey.deleteMany({ where: { id, status: 'in_progress' } });
  }

  /**
   * Removes keys past their 24 h. Not scheduled yet: the pg-boss job that calls it daily arrives
   * with the e-mail queue (phase 1b). Expired keys are already ignored by {@link claim}.
   */
  async purgeExpired(now = new Date()): Promise<number> {
    const { count } = await this.prisma.client.idempotencyKey.deleteMany({
      where: { expiresAt: { lte: now } },
    });
    return count;
  }
}
