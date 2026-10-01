import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

// Same precedence as src/config/load-env.ts (kept self-contained: this file also runs in the
// production image, where only the real environment counts).
if (process.env.NODE_ENV !== 'production') {
  config({ path: ['.env.local', '.env'], quiet: true });
}

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
