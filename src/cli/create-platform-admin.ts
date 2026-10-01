/**
 * Entry point of `node dist/cli/create-platform-admin.js --name "Nome" --email pessoa@exemplo.com`
 * (dev: `pnpm admin:create -- ...`). See `create-platform-admin.command.ts` and the README.
 */
import 'reflect-metadata';

import { loadEnvFiles } from '../config/load-env.js';
import { createPlatformAdminCommand } from './create-platform-admin.command.js';

loadEnvFiles();
process.exitCode = await createPlatformAdminCommand(process.argv.slice(2));
