import { setTimeout as sleep } from 'node:timers/promises';

import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { type Db, fromPrisma, PgBoss, type Queue } from 'pg-boss';

import { APP_ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';

/** pg-boss uses 3 of the 10 connections of Varal; the API pool has the other 7 (plan 2.1). */
export const PG_BOSS_POOL_MAX = 3;
export const PG_BOSS_SCHEMA = 'pgboss';

const RETRY_START_MIN_MS = 1_000;
const RETRY_START_MAX_MS = 30_000;
const READY_TIMEOUT_MS = 10_000;

/**
 * Optional provider (boolean, default `true`). `false` makes a producer-only pg-boss, for command
 * line tools that only enqueue jobs (`src/cli`): no workers, no cron schedules, no supervision, so
 * the jobs are processed by the workers of the running API.
 */
export const PG_BOSS_WORKERS = Symbol('PG_BOSS_WORKERS');

/** A queue and how its jobs are processed, registered by the modules in `onModuleInit`. */
export interface QueueDefinition {
  name: string;
  options: Omit<Queue, 'name'>;
  /** Cron (in America/Sao_Paulo) that sends one job to this queue, if any. */
  schedule?: string;
  /** Registers the worker once pg-boss is running. */
  work?: (boss: PgBoss) => Promise<unknown>;
}

/** Anything that can run raw SQL in a Prisma transaction (both clients and their transactions). */
export interface RawSqlTransaction {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

export class JobsUnavailableError extends Error {
  override name = 'JobsUnavailableError';
}

/**
 * pg-boss 12 inside the API (plan 2.1; spec 01, section 9).
 *
 * - Starts at bootstrap and stops at shutdown. The start runs in the background and is retried with
 *   a growing wait, so the API still boots (and `/health` answers) while the database is down.
 * - Queues are created with `createQueue` once pg-boss is up; then cron schedules and workers.
 * - {@link sendInTransaction} enqueues through a Prisma transaction (`fromPrisma`), so a job exists
 *   only if the action that created it commits.
 */
@Injectable()
export class PgBossService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('PgBoss');
  private readonly boss: PgBoss;
  private readonly definitions: QueueDefinition[] = [];
  private readonly abort = new AbortController();
  private readyPromise: Promise<void> | undefined;
  private started = false;

  constructor(
    @Inject(APP_ENV) env: Env,
    @Optional() @Inject(PG_BOSS_WORKERS) private readonly workers = true,
  ) {
    this.boss = new PgBoss({
      connectionString: env.DATABASE_URL,
      max: PG_BOSS_POOL_MAX,
      schema: PG_BOSS_SCHEMA,
      application_name: workers ? 'varal-api-jobs' : 'varal-cli-jobs',
      connectionTimeoutMillis: 2_000,
      ...(workers ? {} : { supervise: false, schedule: false }),
    });
    // Without a listener an 'error' event would crash the process.
    this.boss.on('error', (error: Error) => {
      this.logger.error(error.message, error.stack);
    });
  }

  /** Called by the modules (in `onModuleInit`) before the bootstrap. */
  register(definition: QueueDefinition): void {
    if (this.readyPromise) {
      throw new Error(`Queue ${definition.name} registered after pg-boss started`);
    }
    this.definitions.push(definition);
  }

  onApplicationBootstrap(): void {
    this.readyPromise = this.startWithRetry();
    // Failures are logged and retried inside; nothing to handle here.
    this.readyPromise.catch(() => undefined);
  }

  async onApplicationShutdown(): Promise<void> {
    this.abort.abort();
    await this.readyPromise?.catch(() => undefined);
    if (this.started) {
      await this.boss.stop({ graceful: true, timeout: 10_000 });
      this.started = false;
    }
  }

  /** Resolves when pg-boss is running with every queue created; rejects after `timeoutMs`. */
  async whenReady(timeoutMs = READY_TIMEOUT_MS): Promise<PgBoss> {
    if (!this.readyPromise) {
      throw new JobsUnavailableError('pg-boss has not been started (application not bootstrapped)');
    }
    if (!this.started) {
      const timeout = sleep(timeoutMs, 'timeout' as const, { ref: false });
      const result = await Promise.race([this.readyPromise.then(() => 'ready' as const), timeout]);
      if (result === 'timeout' || !this.isRunning()) {
        throw new JobsUnavailableError('pg-boss is not running');
      }
    }
    return this.boss;
  }

  /** True once pg-boss started and created the queues. */
  isRunning(): boolean {
    return this.started;
  }

  /**
   * Enqueues a job in the transaction of the action (plan 2.1): pg-boss writes the job row through
   * the Prisma transaction, so the job and the action commit or roll back together.
   */
  async sendInTransaction(
    tx: RawSqlTransaction,
    queue: string,
    data: object,
    options: Parameters<PgBoss['send']>[2] = {},
  ): Promise<string> {
    const boss = await this.whenReady();
    const db: Db = fromPrisma(tx);
    const id = await boss.send(queue, data, { ...options, db });
    if (id === null) {
      throw new Error(`pg-boss did not create the job in ${queue}`);
    }
    return id;
  }

  private async startWithRetry(): Promise<void> {
    let wait = RETRY_START_MIN_MS;
    while (!this.abort.signal.aborted) {
      try {
        await this.boss.start();
        this.started = true;
        await this.setUpQueues();
        this.logger.log(`pg-boss started (${this.definitions.length} queues)`);
        return;
      } catch (error) {
        this.logger.warn(
          `pg-boss could not start (${error instanceof Error ? error.message : String(error)}); retrying in ${wait / 1000} s`,
        );
        // A failed start may leave timers or the pool half-open: stop cleans them up.
        this.started = false;
        await this.boss.stop({ graceful: false }).catch(() => undefined);
        try {
          await sleep(wait, undefined, { signal: this.abort.signal });
        } catch {
          return;
        }
        wait = Math.min(wait * 2, RETRY_START_MAX_MS);
      }
    }
  }

  private async setUpQueues(): Promise<void> {
    for (const definition of this.definitions) {
      const existing = await this.boss.getQueue(definition.name);
      if (existing) {
        await this.boss.updateQueue(definition.name, definition.options);
      } else {
        await this.boss.createQueue(definition.name, definition.options);
      }
      if (!this.workers) {
        // Producer only: the queue exists, the running API schedules and processes it.
        continue;
      }
      if (definition.schedule) {
        await this.boss.schedule(definition.name, definition.schedule, null, {
          tz: 'America/Sao_Paulo',
        });
      }
      if (definition.work) {
        await definition.work(this.boss);
      }
    }
  }
}
