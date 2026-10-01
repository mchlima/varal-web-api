import { parseArgs } from 'node:util';

import { type LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { z } from 'zod';

import { NewPlatformAdminSchema, PlatformAdminsService } from '../admin/platform-admins.service.js';
import { runWithContext, systemContext } from '../context/request-context.js';
import { AppError } from '../errors/app-error.js';
import { CliModule } from './cli.module.js';

export const USAGE = `Cria um admin da plataforma e envia o convite por e-mail (vale 7 dias).

Uso:
  node dist/cli/create-platform-admin.js --name "Nome" --email pessoa@exemplo.com [--role "Papel"]
  pnpm admin:create -- --name "Nome" --email pessoa@exemplo.com [--role "Papel"]   (desenvolvimento)

--role  Nome do papel (ex.: "Super admin", "Suporte"). Sem ele, o admin recebe Super admin se ainda
        não houver nenhum Super admin ativo (primeiro admin); senão fica sem papel, para receber um
        na tela de usuários do admin.

O e-mail é enfileirado no banco e enviado pelo worker da API em execução.
Em produção: docker exec varal-api node dist/cli/create-platform-admin.js --name ... --email ...`;

/** Exit codes: 0 created, 1 refused or failed, 2 invalid arguments. */
export const EXIT = { ok: 0, failed: 1, usage: 2 } as const;

export interface CliOutput {
  out(line: string): void;
  err(line: string): void;
}

const consoleOutput: CliOutput = {
  out: (line) => {
    console.log(line);
  },
  err: (line) => {
    console.error(line);
  },
};

/**
 * `create-platform-admin`: first access to the admin in production (and a way back in if every
 * admin is lost). The admin is created active without a password; the invite (spec 01, section 7.4)
 * lets them set it. The first admin gets Super admin (RN-02.05); `--role` chooses another role. The
 * output never has the token or the link.
 */
export async function createPlatformAdminCommand(
  argv: string[],
  output: CliOutput = consoleOutput,
  options: { logger?: LogLevel[] | false } = {},
): Promise<number> {
  let values: {
    name?: string | undefined;
    email?: string | undefined;
    role?: string | undefined;
    help?: boolean | undefined;
  };
  try {
    // `pnpm admin:create -- --name ...` passes the `--` along.
    const args = argv[0] === '--' ? argv.slice(1) : argv;
    ({ values } = parseArgs({
      args,
      options: {
        name: { type: 'string' },
        email: { type: 'string' },
        role: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    output.err(`Argumentos inválidos: ${error instanceof Error ? error.message : String(error)}`);
    output.err(USAGE);
    return EXIT.usage;
  }
  if (values.help) {
    output.out(USAGE);
    return EXIT.ok;
  }

  const parsed = NewPlatformAdminSchema.safeParse({ name: values.name, email: values.email });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      output.err(`--${issue.path.join('.')}: ${issue.message}`);
    }
    output.err(USAGE);
    return EXIT.usage;
  }

  const app = await NestFactory.createApplicationContext(CliModule, {
    logger: options.logger ?? ['error', 'warn'],
    abortOnError: false,
  });
  try {
    const admins = app.get(PlatformAdminsService);
    // Outside a request: the audit actor is `system` (spec 01, section 8), with `source: cli`.
    const created = await runWithContext(
      systemContext({ requestId: `cli-${crypto.randomUUID()}` }),
      async () => {
        const roleIds = await admins.resolveCliRoles(values.role);
        return admins.create(parsed.data, { roleIds }, { source: 'cli' });
      },
    );
    output.out(`Admin da plataforma criado: ${created.name} <${created.email}>.`);
    output.out(
      created.roleNames.length > 0
        ? `Papel: ${created.roleNames.join(', ')}.`
        : 'Sem papel: atribua um papel na tela de usuários do admin.',
    );
    output.out(`Convite enviado para ${created.email}.`);
    return EXIT.ok;
  } catch (error) {
    if (error instanceof AppError) {
      const { message, details } = error.toResponse().error;
      const fields = Array.isArray(details.fields)
        ? (details.fields as { path: string; message: string }[])
        : [];
      output.err(
        fields.length > 0
          ? `Não foi possível criar o admin: ${fields.map((field) => `--${field.path}: ${field.message}`).join(' ')}`
          : `Não foi possível criar o admin: ${message}`,
      );
    } else if (error instanceof z.ZodError) {
      output.err(`Dados inválidos: ${error.issues.map((issue) => issue.message).join(' ')}`);
    } else {
      output.err(
        `Erro ao criar o admin: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return EXIT.failed;
  } finally {
    // Stops pg-boss and closes the database pools, so the process ends on its own.
    await app.close();
  }
}
