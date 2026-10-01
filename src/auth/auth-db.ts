import type { Prisma } from '../generated/prisma/client.js';

/**
 * Database handle used by the authentication: the unscoped client or one of its transactions.
 * Authentication looks subjects up before the organization is known, so it uses
 * `PlatformPrismaService` (spec 01, section 6) and filters by hand.
 */
export type AuthDb = Prisma.TransactionClient;
