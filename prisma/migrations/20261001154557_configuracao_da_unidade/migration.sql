-- CreateEnum
CREATE TYPE "station_kind" AS ENUM ('counter', 'queue');

-- CreateEnum
CREATE TYPE "workflow_stage_target" AS ENUM ('product_station', 'fixed_station', 'none');

-- AlterTable
ALTER TABLE "units" ADD COLUMN     "menu_version" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "stations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "station_kind" NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_stages" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "target" "workflow_stage_target" NOT NULL,
    "station_id" UUID,
    "is_final" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "workflow_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "default_station_id" UUID NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price_cents" INTEGER NOT NULL,
    "station_id" UUID,
    "sort_order" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sold_out" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "modifier_groups" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "min_choices" INTEGER NOT NULL,
    "max_choices" INTEGER NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "modifier_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "modifiers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "modifier_group_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "price_delta_cents" INTEGER NOT NULL DEFAULT 0,
    "sort_order" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "modifiers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stations_organization_id_unit_id_idx" ON "stations"("organization_id", "unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "stations_organization_id_unit_id_id_key" ON "stations"("organization_id", "unit_id", "id");

-- CreateIndex
CREATE INDEX "workflow_stages_organization_id_unit_id_idx" ON "workflow_stages"("organization_id", "unit_id");

-- CreateIndex
CREATE INDEX "categories_organization_id_unit_id_idx" ON "categories"("organization_id", "unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "categories_organization_id_unit_id_id_key" ON "categories"("organization_id", "unit_id", "id");

-- CreateIndex
CREATE INDEX "products_organization_id_unit_id_idx" ON "products"("organization_id", "unit_id");

-- CreateIndex
CREATE INDEX "products_organization_id_category_id_idx" ON "products"("organization_id", "category_id");

-- CreateIndex
CREATE UNIQUE INDEX "products_organization_id_id_key" ON "products"("organization_id", "id");

-- CreateIndex
CREATE INDEX "modifier_groups_organization_id_product_id_idx" ON "modifier_groups"("organization_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "modifier_groups_organization_id_id_key" ON "modifier_groups"("organization_id", "id");

-- CreateIndex
CREATE INDEX "modifiers_organization_id_modifier_group_id_idx" ON "modifiers"("organization_id", "modifier_group_id");

-- AddForeignKey
ALTER TABLE "stations" ADD CONSTRAINT "stations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stations" ADD CONSTRAINT "stations_organization_id_unit_id_fkey" FOREIGN KEY ("organization_id", "unit_id") REFERENCES "units"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_stages" ADD CONSTRAINT "workflow_stages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_stages" ADD CONSTRAINT "workflow_stages_organization_id_unit_id_fkey" FOREIGN KEY ("organization_id", "unit_id") REFERENCES "units"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_stages" ADD CONSTRAINT "workflow_stages_organization_id_unit_id_station_id_fkey" FOREIGN KEY ("organization_id", "unit_id", "station_id") REFERENCES "stations"("organization_id", "unit_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_organization_id_unit_id_fkey" FOREIGN KEY ("organization_id", "unit_id") REFERENCES "units"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_organization_id_unit_id_default_station_id_fkey" FOREIGN KEY ("organization_id", "unit_id", "default_station_id") REFERENCES "stations"("organization_id", "unit_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_organization_id_unit_id_fkey" FOREIGN KEY ("organization_id", "unit_id") REFERENCES "units"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_organization_id_unit_id_category_id_fkey" FOREIGN KEY ("organization_id", "unit_id", "category_id") REFERENCES "categories"("organization_id", "unit_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_organization_id_unit_id_station_id_fkey" FOREIGN KEY ("organization_id", "unit_id", "station_id") REFERENCES "stations"("organization_id", "unit_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modifier_groups" ADD CONSTRAINT "modifier_groups_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modifier_groups" ADD CONSTRAINT "modifier_groups_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modifiers" ADD CONSTRAINT "modifiers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modifiers" ADD CONSTRAINT "modifiers_organization_id_modifier_group_id_fkey" FOREIGN KEY ("organization_id", "modifier_group_id") REFERENCES "modifier_groups"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- Rules Prisma cannot express (spec 03; listed next to each model in schema.prisma)
-- ---------------------------------------------------------------------------------------------

-- Spec 03, section 3: late_after_minutes from 1 to 240.
ALTER TABLE "units" ADD CONSTRAINT "units_late_after_minutes_check"
    CHECK ("late_after_minutes" BETWEEN 1 AND 240);

-- Spec 03, section 7: station names are unique in the unit, ignoring case.
CREATE UNIQUE INDEX "stations_unit_id_lower_name_key" ON "stations" ("unit_id", lower("name"));

-- Spec 03, section 7: one active stage per position; archived stages keep their old position.
CREATE UNIQUE INDEX "workflow_stages_unit_id_sort_order_key" ON "workflow_stages" ("unit_id", "sort_order")
    WHERE "archived_at" IS NULL;
-- Spec 03, section 4.2: only `fixed_station` names a station; the final stage is the `none` one.
ALTER TABLE "workflow_stages" ADD CONSTRAINT "workflow_stages_station_check"
    CHECK (("target" = 'fixed_station') = ("station_id" IS NOT NULL));
ALTER TABLE "workflow_stages" ADD CONSTRAINT "workflow_stages_is_final_check"
    CHECK ("is_final" = ("target" = 'none'));

-- Spec 03, section 5.1: category names are unique in the unit, ignoring case.
CREATE UNIQUE INDEX "categories_unit_id_lower_name_key" ON "categories" ("unit_id", lower("name"));

-- RN-03.09: price >= 0; spec 03, section 5.1: description up to 120 characters.
ALTER TABLE "products" ADD CONSTRAINT "products_price_cents_check" CHECK ("price_cents" >= 0);
ALTER TABLE "products" ADD CONSTRAINT "products_description_length_check"
    CHECK ("description" IS NULL OR char_length("description") <= 120);

-- RN-03.13: 0 <= min <= max and max >= 1.
ALTER TABLE "modifier_groups" ADD CONSTRAINT "modifier_groups_choices_check"
    CHECK ("min_choices" >= 0 AND "max_choices" >= 1 AND "min_choices" <= "max_choices");

-- Spec 03, section 5.2: a modifier adds to the price (zero allowed), never subtracts.
ALTER TABLE "modifiers" ADD CONSTRAINT "modifiers_price_delta_cents_check"
    CHECK ("price_delta_cents" >= 0);
