-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "previous_refresh_token_hash" TEXT,
ADD COLUMN     "refreshed_at" TIMESTAMPTZ(3),
ADD COLUMN     "revoked_reason" TEXT;

-- CreateTable
CREATE TABLE "login_throttles" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "last_failed_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "login_throttles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "login_throttles_key_key" ON "login_throttles"("key");

-- CreateIndex
CREATE INDEX "login_throttles_last_failed_at_idx" ON "login_throttles"("last_failed_at");

-- CreateIndex
CREATE INDEX "password_tokens_created_at_idx" ON "password_tokens"("created_at");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");
