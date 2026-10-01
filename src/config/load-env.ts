import { config } from 'dotenv';

/**
 * Loads `.env.local` (per worktree, RN-01.07) and then `.env` into `process.env`.
 * Values already present in the environment win, and so does the first file that defines a key.
 * Production reads only the real environment.
 */
export function loadEnvFiles(): void {
  if (process.env.NODE_ENV === 'production') {
    return;
  }
  config({ path: ['.env.local', '.env'], quiet: true });
}
