-- CreateEnum
CREATE TYPE "announcement_audience_type" AS ENUM ('all', 'by_status', 'selected');

-- CreateEnum
CREATE TYPE "announcement_status" AS ENUM ('draft', 'scheduled', 'published', 'archived');

-- CreateEnum
CREATE TYPE "impersonation_ended_by" AS ENUM ('admin', 'expired');

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "impersonation_id" UUID;

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "system_key" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "permission" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_admin_roles" (
    "id" UUID NOT NULL,
    "platform_admin_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_admin_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_admin_permissions" (
    "id" UUID NOT NULL,
    "platform_admin_id" UUID NOT NULL,
    "permission" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_admin_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcements" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "audience_type" "announcement_audience_type" NOT NULL,
    "audience_statuses" "subscription_status"[] DEFAULT ARRAY[]::"subscription_status"[],
    "status" "announcement_status" NOT NULL DEFAULT 'draft',
    "publish_at" TIMESTAMPTZ(3),
    "published_at" TIMESTAMPTZ(3),
    "archived_at" TIMESTAMPTZ(3),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcement_targets" (
    "id" UUID NOT NULL,
    "announcement_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "announcement_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcement_reads" (
    "id" UUID NOT NULL,
    "announcement_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "read_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "announcement_reads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "impersonation_sessions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "platform_admin_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "ended_at" TIMESTAMPTZ(3),
    "ended_by" "impersonation_ended_by",
    "handoff_token_hash" TEXT,
    "handoff_expires_at" TIMESTAMPTZ(3),
    "handoff_used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "impersonation_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "roles_system_key_key" ON "roles"("system_key");

-- CreateIndex
CREATE UNIQUE INDEX "role_permissions_role_id_permission_key" ON "role_permissions"("role_id", "permission");

-- CreateIndex
CREATE INDEX "platform_admin_roles_role_id_idx" ON "platform_admin_roles"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_admin_roles_platform_admin_id_role_id_key" ON "platform_admin_roles"("platform_admin_id", "role_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_admin_permissions_platform_admin_id_permission_key" ON "platform_admin_permissions"("platform_admin_id", "permission");

-- CreateIndex
CREATE INDEX "announcements_status_publish_at_idx" ON "announcements"("status", "publish_at");

-- CreateIndex
CREATE INDEX "announcement_targets_organization_id_idx" ON "announcement_targets"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "announcement_targets_announcement_id_organization_id_key" ON "announcement_targets"("announcement_id", "organization_id");

-- CreateIndex
CREATE INDEX "announcement_reads_organization_id_announcement_id_idx" ON "announcement_reads"("organization_id", "announcement_id");

-- CreateIndex
CREATE UNIQUE INDEX "announcement_reads_announcement_id_user_id_key" ON "announcement_reads"("announcement_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "impersonation_sessions_handoff_token_hash_key" ON "impersonation_sessions"("handoff_token_hash");

-- CreateIndex
CREATE INDEX "impersonation_sessions_organization_id_started_at_idx" ON "impersonation_sessions"("organization_id", "started_at");

-- CreateIndex
CREATE INDEX "impersonation_sessions_platform_admin_id_idx" ON "impersonation_sessions"("platform_admin_id");

-- CreateIndex
CREATE INDEX "impersonation_sessions_expires_at_idx" ON "impersonation_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "sessions_impersonation_id_idx" ON "sessions"("impersonation_id");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_impersonation_id_fkey" FOREIGN KEY ("impersonation_id") REFERENCES "impersonation_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_admin_roles" ADD CONSTRAINT "platform_admin_roles_platform_admin_id_fkey" FOREIGN KEY ("platform_admin_id") REFERENCES "platform_admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_admin_roles" ADD CONSTRAINT "platform_admin_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_admin_permissions" ADD CONSTRAINT "platform_admin_permissions_platform_admin_id_fkey" FOREIGN KEY ("platform_admin_id") REFERENCES "platform_admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "platform_admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_targets" ADD CONSTRAINT "announcement_targets_announcement_id_fkey" FOREIGN KEY ("announcement_id") REFERENCES "announcements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_targets" ADD CONSTRAINT "announcement_targets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_reads" ADD CONSTRAINT "announcement_reads_announcement_id_fkey" FOREIGN KEY ("announcement_id") REFERENCES "announcements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_reads" ADD CONSTRAINT "announcement_reads_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_reads" ADD CONSTRAINT "announcement_reads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_platform_admin_id_fkey" FOREIGN KEY ("platform_admin_id") REFERENCES "platform_admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------------------------
-- Written by hand: constraints the Prisma schema cannot express and the data of RBAC (spec 02).
-- ---------------------------------------------------------------------------------------------

-- Permission keys look like `resource:action` (catalog in src/admin/rbac/permissions.ts, RN-02.03).
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_check"
    CHECK ("permission" ~ '^[a-z.]+:[a-z]+$');
ALTER TABLE "platform_admin_permissions" ADD CONSTRAINT "platform_admin_permissions_permission_check"
    CHECK ("permission" ~ '^[a-z.]+:[a-z]+$');

-- RN-02.13: title up to 80 characters, body up to 2,000.
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_title_check"
    CHECK (char_length("title") BETWEEN 1 AND 80);
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_body_check"
    CHECK (char_length("body") BETWEEN 1 AND 2000);

-- RN-02.17: the reason of an "entrar como" has at least 10 characters.
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_reason_check"
    CHECK (char_length("reason") >= 10);

-- UUID v7 for the rows inserted below (PostgreSQL 17 has no uuidv7(); the app generates ids
-- elsewhere). Dropped at the end of this migration.
CREATE FUNCTION "varal_tmp_uuid_v7"() RETURNS uuid
    LANGUAGE sql VOLATILE AS $$
    SELECT encode(
        set_bit(set_bit(overlay(uuid_send(gen_random_uuid())
            PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
            FROM 1 FOR 6), 52, 1), 53, 1),
        'hex')::uuid;
$$;

-- System roles (RN-02.04, table of spec 02, section 3.2). Super admin has every permission of the
-- catalog, computed in code (including permissions created later), so it has no role_permissions.
-- Idempotent: an existing role with the same key is kept as it is.
INSERT INTO "roles" ("id", "name", "description", "is_system", "system_key", "updated_at") VALUES
    ("varal_tmp_uuid_v7"(), 'Super admin', 'Todas as permissões, inclusive as criadas depois.', true, 'super_admin', CURRENT_TIMESTAMP),
    ("varal_tmp_uuid_v7"(), 'Suporte', 'Cria e acompanha organizações, comunicados e o "entrar como".', true, 'support', CURRENT_TIMESTAMP),
    ("varal_tmp_uuid_v7"(), 'Financeiro', 'Situação da assinatura, suspensão e reativação.', true, 'finance', CURRENT_TIMESTAMP),
    ("varal_tmp_uuid_v7"(), 'Leitura', 'Só consulta organizações, comunicados e métricas.', true, 'read_only', CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;

INSERT INTO "role_permissions" ("id", "role_id", "permission")
SELECT "varal_tmp_uuid_v7"(), r."id", p."permission"
FROM "roles" r
JOIN (VALUES
    ('support', 'organizations:read'),
    ('support', 'organizations:create'),
    ('support', 'organizations:update'),
    ('support', 'announcements:read'),
    ('support', 'announcements:manage'),
    ('support', 'metrics:read'),
    ('support', 'impersonation:use'),
    ('support', 'emails:read'),
    ('finance', 'organizations:read'),
    ('finance', 'organizations:suspend'),
    ('finance', 'subscriptions:update'),
    ('finance', 'announcements:read'),
    ('finance', 'metrics:read'),
    ('read_only', 'organizations:read'),
    ('read_only', 'announcements:read'),
    ('read_only', 'metrics:read')
) AS p("system_key", "permission") ON p."system_key" = r."system_key"
ON CONFLICT DO NOTHING;

-- Admins created before RBAC (the first admin, made with `create-platform-admin`) get Super admin,
-- so RN-02.05 (at least one active Super admin) holds from the start.
INSERT INTO "platform_admin_roles" ("id", "platform_admin_id", "role_id")
SELECT "varal_tmp_uuid_v7"(), a."id", r."id"
FROM "platform_admins" a
CROSS JOIN "roles" r
WHERE r."system_key" = 'super_admin'
  AND NOT EXISTS (SELECT 1 FROM "platform_admin_roles" x WHERE x."platform_admin_id" = a."id")
ON CONFLICT DO NOTHING;

DROP FUNCTION "varal_tmp_uuid_v7"();
