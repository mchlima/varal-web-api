import { AsyncLocalStorage } from 'node:async_hooks';

import { Injectable, Logger } from '@nestjs/common';
import type { ITXClientDenyList } from '@prisma/client/runtime/client';

import { currentOrganizationId } from '../context/request-context.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { PlatformPrismaService } from './platform-prisma.service.js';
import { tenantScope } from './tenant-scope.extension.js';

export function createTenantClient(
  base: PrismaClient,
  getOrganizationId: () => string | null = currentOrganizationId,
) {
  return base.$extends(tenantScope(getOrganizationId));
}

export type TenantPrismaClient = ReturnType<typeof createTenantClient>;

/** A tenant client or a transaction opened from it: what services use to query (`prisma.db`). */
export type TenantDb = Omit<TenantPrismaClient, ITXClientDenyList>;

interface AmbientTransaction {
  tx: TenantDb;
  /** Callbacks to run once the outermost transaction commits (see {@link PrismaService.afterCommit}). */
  afterCommit: (() => void)[];
}

/**
 * Ambient transaction: lets an interceptor (idempotency) and the services of the same request share
 * one database transaction without passing `tx` through every call.
 */
const ambientTransaction = new AsyncLocalStorage<AmbientTransaction>();

export interface TransactionOptions {
  /** Milliseconds; Prisma's default is 5 s. */
  timeout?: number;
}

/**
 * Database access for the API, filtered by organization (spec 01, section 6).
 *
 * Every query on a tenant model (TENANT_MODELS) gets the organization of the request context in
 * `where` and `data`, and fails without one. Non-tenant models (audit, sessions…) pass through.
 *
 * - `prisma.db`: the current ambient transaction, if any, otherwise the client. Use it for queries.
 * - `prisma.transaction(fn)`: opens a transaction, or joins the ambient one (e.g. the transaction
 *   the idempotency interceptor opened for this request), so the action, its audit row and the
 *   stored idempotent response commit together.
 * - `prisma.afterCommit(fn)`: runs `fn` only after the ambient transaction commits (never when it
 *   rolls back); outside a transaction it runs at once. Real-time events use it (spec 01, section 10).
 * - Raw SQL (`$queryRaw`, `$executeRaw`) is NOT filtered: add `organization_id = ${organizationId}`
 *   by hand, and point it out in the PR.
 */
@Injectable()
export class PrismaService {
  readonly client: TenantPrismaClient;
  private readonly logger = new Logger('PrismaService');

  constructor(platform: PlatformPrismaService) {
    this.client = createTenantClient(platform);
  }

  get db(): TenantDb {
    return ambientTransaction.getStore()?.tx ?? this.client;
  }

  /** True inside {@link transaction} (or a transaction it joined). */
  get inTransaction(): boolean {
    return ambientTransaction.getStore() !== undefined;
  }

  async transaction<T>(
    fn: (tx: TenantDb) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    const ambient = ambientTransaction.getStore();
    if (ambient) {
      return fn(ambient.tx);
    }
    const afterCommit: (() => void)[] = [];
    const result = await this.client.$transaction(
      (tx) => ambientTransaction.run({ tx, afterCommit }, () => fn(tx)),
      options.timeout === undefined ? undefined : { timeout: options.timeout },
    );
    for (const callback of afterCommit) {
      this.runSafely(callback);
    }
    return result;
  }

  /**
   * Runs `callback` after the ambient transaction commits; it is dropped if the transaction rolls
   * back. Outside a transaction it runs at once. A failing callback is logged and never fails the
   * request, which already committed.
   */
  afterCommit(callback: () => void): void {
    const ambient = ambientTransaction.getStore();
    if (ambient) {
      ambient.afterCommit.push(callback);
      return;
    }
    this.runSafely(callback);
  }

  private runSafely(callback: () => void): void {
    try {
      callback();
    } catch (error) {
      this.logger.error(
        'after-commit callback failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
