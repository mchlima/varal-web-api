-- CreateEnum
CREATE TYPE "subscription_status" AS ENUM ('pilot', 'active', 'suspended', 'canceled');

-- CreateEnum
CREATE TYPE "subject_type" AS ENUM ('owner', 'staff', 'platform_admin');

-- CreateEnum
CREATE TYPE "actor_type" AS ENUM ('owner', 'staff', 'platform_admin', 'system');

-- CreateEnum
CREATE TYPE "password_token_purpose" AS ENUM ('invite', 'reset');

-- CreateEnum
CREATE TYPE "email_type" AS ENUM ('owner_invite', 'owner_password_reset', 'staff_password_reset', 'admin_invite', 'admin_password_reset');

-- CreateEnum
CREATE TYPE "email_status" AS ENUM ('queued', 'sent', 'failed');

-- CreateEnum
CREATE TYPE "idempotency_status" AS ENUM ('in_progress', 'completed');

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "access_code" TEXT NOT NULL,
    "subscription_status" "subscription_status" NOT NULL DEFAULT 'pilot',
    "suspended_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "units" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "late_after_minutes" INTEGER NOT NULL DEFAULT 15,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT,
    "email_verified_at" TIMESTAMPTZ(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_members" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "password_hash" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "staff_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_unit_permissions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "staff_member_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "station_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    "can_operate_cash" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "staff_unit_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_admins" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "platform_admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "subject_type" "subject_type" NOT NULL,
    "subject_id" UUID NOT NULL,
    "organization_id" UUID,
    "device_id" UUID NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "last_used_at" TIMESTAMPTZ(3),
    "user_agent" TEXT,
    "ip" TEXT,
    "impersonation_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_tokens" (
    "id" UUID NOT NULL,
    "subject_type" "subject_type" NOT NULL,
    "subject_id" UUID NOT NULL,
    "purpose" "password_token_purpose" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "password_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "actor_type" "actor_type" NOT NULL,
    "actor_id" UUID,
    "impersonator_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID,
    "changes" JSONB NOT NULL DEFAULT '{}',
    "device_id" UUID,
    "ip" TEXT,
    "request_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_logs" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "to" TEXT NOT NULL,
    "type" "email_type" NOT NULL,
    "status" "email_status" NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "email_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL,
    "key" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "organization_id" UUID,
    "request_hash" TEXT NOT NULL,
    "status" "idempotency_status" NOT NULL DEFAULT 'in_progress',
    "status_code" INTEGER,
    "response" JSONB,
    "locked_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_access_code_key" ON "organizations"("access_code");

-- CreateIndex
CREATE UNIQUE INDEX "units_organization_id_name_key" ON "units"("organization_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "units_organization_id_id_key" ON "units"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_organization_id_idx" ON "users"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "staff_members_organization_id_id_key" ON "staff_members"("organization_id", "id");

-- CreateIndex
CREATE INDEX "staff_unit_permissions_organization_id_unit_id_idx" ON "staff_unit_permissions"("organization_id", "unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "staff_unit_permissions_staff_member_id_unit_id_key" ON "staff_unit_permissions"("staff_member_id", "unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_admins_email_key" ON "platform_admins"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_refresh_token_hash_key" ON "sessions"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "sessions_subject_type_subject_id_idx" ON "sessions"("subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "sessions_organization_id_idx" ON "sessions"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "password_tokens_token_hash_key" ON "password_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_tokens_subject_type_subject_id_purpose_idx" ON "password_tokens"("subject_type", "subject_id", "purpose");

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_created_at_idx" ON "audit_logs"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "email_logs_organization_id_created_at_idx" ON "email_logs"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "email_logs_created_at_idx" ON "email_logs"("created_at");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_subject_id_key_key" ON "idempotency_keys"("subject_id", "key");

-- AddForeignKey
ALTER TABLE "units" ADD CONSTRAINT "units_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_members" ADD CONSTRAINT "staff_members_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_unit_permissions" ADD CONSTRAINT "staff_unit_permissions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_unit_permissions" ADD CONSTRAINT "staff_unit_permissions_organization_id_staff_member_id_fkey" FOREIGN KEY ("organization_id", "staff_member_id") REFERENCES "staff_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_unit_permissions" ADD CONSTRAINT "staff_unit_permissions_organization_id_unit_id_fkey" FOREIGN KEY ("organization_id", "unit_id") REFERENCES "units"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- Written by hand: constraints that the Prisma schema cannot express (listed in schema.prisma).
-- ---------------------------------------------------------------------------------------------

-- Access code: 6 uppercase alphanumerics without ambiguous characters (no 0/O, 1/I), spec 01, 7.1.
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_access_code_check"
    CHECK ("access_code" ~ '^[2-9A-HJ-NP-Z]{6}$');

-- E-mails are stored in lowercase; the unique index is therefore case-insensitive (spec 01, 12).
ALTER TABLE "users" ADD CONSTRAINT "users_email_lowercase_check" CHECK ("email" = lower("email"));
ALTER TABLE "platform_admins" ADD CONSTRAINT "platform_admins_email_lowercase_check"
    CHECK ("email" = lower("email"));

-- Username: letters, digits, dot and underscore; unique per organization ignoring case (spec 01, 12).
ALTER TABLE "staff_members" ADD CONSTRAINT "staff_members_username_check"
    CHECK ("username" ~ '^[A-Za-z0-9._]+$');
CREATE UNIQUE INDEX "staff_members_organization_id_username_key"
    ON "staff_members" ("organization_id", lower("username"));

-- The audit log is insert-only (spec 01, section 8): UPDATE and DELETE are rejected.
CREATE FUNCTION "audit_logs_reject_change"() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_logs is insert-only (spec 01, section 8)';
END;
$$;

CREATE TRIGGER "audit_logs_insert_only"
    BEFORE UPDATE OR DELETE ON "audit_logs"
    FOR EACH ROW EXECUTE FUNCTION "audit_logs_reject_change"();
