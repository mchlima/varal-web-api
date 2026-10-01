import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

// Same precedence as src/config/load-env.ts (kept self-contained: this file also runs in the
// production image, where only the real environment counts).
if (process.env.NODE_ENV !== 'production') {
  config({ path: ['.env.local', '.env'], quiet: true });
}

// The npm `latest` tag of the CLI points to Prisma 8 RC; this project pins 7.10.0 (plan, section 5).
process.env.PRISMA_HIDE_UPDATE_MESSAGE ??= '1';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Optional for `prisma generate`; required by `migrate dev` / `migrate deploy`.
    url: process.env.DATABASE_URL,
  },
});
