import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { AuditService } from '../audit/audit.service.js';
import { PasswordLinkService } from '../auth/password-link.service.js';
import { AppError } from '../errors/app-error.js';
import { Prisma } from '../generated/prisma/client.js';
import { PlatformPrismaService } from '../prisma/platform-prisma.service.js';

/** Name and e-mail of a new platform admin (spec 02, `platform_admins`). E-mail always lowercase. */
export const NewPlatformAdminSchema = z.object({
  name: z
    .string({ error: 'Informe o nome.' })
    .trim()
    .min(2, { error: 'O nome precisa ter pelo menos 2 caracteres.' })
    .max(120, { error: 'O nome pode ter no máximo 120 caracteres.' }),
  email: z
    .string({ error: 'Informe o e-mail.' })
    .trim()
    .toLowerCase()
    .pipe(z.email({ error: 'E-mail inválido.' }).max(254, { error: 'E-mail longo demais.' })),
});

export type NewPlatformAdmin = z.infer<typeof NewPlatformAdminSchema>;

export interface CreatedPlatformAdmin {
  id: string;
  name: string;
  email: string;
  inviteExpiresAt: Date;
}

const EMAIL_TAKEN_MESSAGE = 'Já existe um admin da plataforma com este e-mail.';

/**
 * Platform admin users (spec 02). For now only the creation used by the command line
 * (`src/cli/create-platform-admin.ts`), for the first access to the admin; `POST /admin/users`
 * (phase 3) will reuse it, with the roles of RBAC.
 */
@Injectable()
export class PlatformAdminsService {
  constructor(
    private readonly platform: PlatformPrismaService,
    private readonly passwordLinks: PasswordLinkService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Creates an active admin without a password and, in the same transaction, the invite (7 days) with
   * its `admin_invite` e-mail queued (spec 01, sections 7.4 and 9) and the audit row (section 8).
   * Throws `ALREADY_EXISTS` (409) when the e-mail is taken. The invite link is never returned.
   * `source` goes to the audit metadata (e.g. `cli`), to tell where a system action came from.
   */
  async create(
    input: NewPlatformAdmin,
    options: { source?: string } = {},
  ): Promise<CreatedPlatformAdmin> {
    const { name, email } = NewPlatformAdminSchema.parse(input);
    try {
      return await this.platform.$transaction(async (tx) => {
        const existing = await tx.platformAdmin.findUnique({
          where: { email },
          select: { id: true },
        });
        if (existing) {
          throw AppError.of('ALREADY_EXISTS', { message: EMAIL_TAKEN_MESSAGE });
        }
        const admin = await tx.platformAdmin.create({
          data: { name, email, active: true, passwordHash: null },
        });
        await this.audit.record(tx, {
          action: 'platform_admin.created',
          entityType: 'platform_admin',
          entityId: admin.id,
          organizationId: null,
          after: { name: admin.name, email: admin.email, active: admin.active },
          ...(options.source ? { metadata: { source: options.source } } : {}),
        });
        const invite = await this.passwordLinks.issueAdminInvite(tx, admin.id);
        return {
          id: admin.id,
          name: admin.name,
          email: admin.email,
          inviteExpiresAt: invite.expiresAt,
        };
      });
    } catch (error) {
      // Two creations racing for the same e-mail: the unique index decides.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw AppError.of('ALREADY_EXISTS', { message: EMAIL_TAKEN_MESSAGE });
      }
      throw error;
    }
  }
}
