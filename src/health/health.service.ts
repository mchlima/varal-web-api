import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import type { HealthResponse } from './health.schemas.js';

const DB_CHECK_TIMEOUT_MS = 3_000;

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(private readonly prisma: PrismaService) {}

  async check(): Promise<HealthResponse> {
    return { status: 'ok', db: (await this.isDatabaseUp()) ? 'ok' : 'unavailable' };
  }

  /** Never throws: a database failure must not take the health endpoint down. */
  private async isDatabaseUp(): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('database check timed out'));
        }, DB_CHECK_TIMEOUT_MS);
      });
      await Promise.race([this.prisma.db.$queryRaw`SELECT 1`, timeout]);
      return true;
    } catch (error) {
      this.logger.warn(
        `Database check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
