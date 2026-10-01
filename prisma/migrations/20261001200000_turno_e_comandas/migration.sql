-- CreateEnum
CREATE TYPE "shift_type" AS ENUM ('direct_sale', 'contracted');

-- CreateEnum
CREATE TYPE "shift_status" AS ENUM ('open', 'closed');

-- CreateEnum
CREATE TYPE "agreement_modality" AS ENUM ('fixed_fee', 'per_quantity', 'consumption_billed', 'other');

-- CreateEnum
CREATE TYPE "tab_mode" AS ENUM ('pay_first', 'open_tab');

-- CreateEnum
CREATE TYPE "tab_status" AS ENUM ('open', 'closing', 'paid', 'on_credit', 'settled', 'canceled');

-- CreateEnum
CREATE TYPE "discount_type" AS ENUM ('amount', 'percent');

-- CreateEnum
CREATE TYPE "order_status" AS ENUM ('sent', 'completed');

-- CreateTable
CREATE TABLE "shifts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "type" "shift_type" NOT NULL,
    "status" "shift_status" NOT NULL DEFAULT 'open',
    "opened_by_type" "actor_type" NOT NULL,
    "opened_by_id" UUID,
    "opened_at" TIMESTAMPTZ(3) NOT NULL,
    "closed_by_type" "actor_type",
    "closed_by_id" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "next_tab_number" INTEGER NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_agreements" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "contractor_name" TEXT NOT NULL,
    "modality" "agreement_modality" NOT NULL,
    "agreed_amount_cents" INTEGER,
    "agreed_quantity" INTEGER,
    "limits" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "shift_agreements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_prices" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "shift_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tabs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "customer_name" TEXT NOT NULL,
    "mode" "tab_mode" NOT NULL,
    "status" "tab_status" NOT NULL,
    "discount_type" "discount_type",
    "discount_value" INTEGER,
    "discount_reason" TEXT,
    "opened_by_type" "actor_type" NOT NULL,
    "opened_by_id" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tabs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "tab_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "number_in_tab" INTEGER NOT NULL,
    "status" "order_status" NOT NULL DEFAULT 'sent',
    "created_by_type" "actor_type" NOT NULL,
    "created_by_id" UUID,
    "sent_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "tab_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "product_name" TEXT NOT NULL,
    "unit_price_cents" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "note" TEXT,
    "position" INTEGER NOT NULL,
    "prep_station_id" UUID NOT NULL,
    "stage_id" UUID NOT NULL,
    "station_id" UUID,
    "stage_entered_at" TIMESTAMPTZ(3) NOT NULL,
    "canceled_at" TIMESTAMPTZ(3),
    "canceled_by_type" "actor_type",
    "canceled_by_id" UUID,
    "cancel_reason" TEXT,
    "wasted" BOOLEAN NOT NULL DEFAULT false,
    "split_from_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_item_modifiers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "modifier_id" UUID NOT NULL,
    "group_name" TEXT NOT NULL,
    "modifier_name" TEXT NOT NULL,
    "price_delta_cents" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_item_modifiers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shifts_organization_id_unit_id_opened_at_idx" ON "shifts"("organization_id", "unit_id", "opened_at");

-- CreateIndex
CREATE UNIQUE INDEX "shifts_organization_id_id_key" ON "shifts"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "shift_agreements_organization_id_shift_id_key" ON "shift_agreements"("organization_id", "shift_id");

-- CreateIndex
CREATE INDEX "shift_prices_organization_id_shift_id_idx" ON "shift_prices"("organization_id", "shift_id");

-- CreateIndex
CREATE UNIQUE INDEX "shift_prices_shift_id_product_id_key" ON "shift_prices"("shift_id", "product_id");

-- CreateIndex
CREATE INDEX "tabs_organization_id_shift_id_status_idx" ON "tabs"("organization_id", "shift_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "tabs_shift_id_number_key" ON "tabs"("shift_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "tabs_organization_id_id_key" ON "tabs"("organization_id", "id");

-- CreateIndex
CREATE INDEX "orders_organization_id_tab_id_idx" ON "orders"("organization_id", "tab_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_tab_id_number_in_tab_key" ON "orders"("tab_id", "number_in_tab");

-- CreateIndex
CREATE UNIQUE INDEX "orders_organization_id_id_key" ON "orders"("organization_id", "id");

-- CreateIndex
CREATE INDEX "order_items_organization_id_order_id_idx" ON "order_items"("organization_id", "order_id");

-- CreateIndex
CREATE INDEX "order_items_organization_id_tab_id_idx" ON "order_items"("organization_id", "tab_id");

-- CreateIndex
CREATE INDEX "order_items_organization_id_station_id_idx" ON "order_items"("organization_id", "station_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_items_organization_id_id_key" ON "order_items"("organization_id", "id");

-- CreateIndex
CREATE INDEX "order_item_modifiers_organization_id_order_item_id_idx" ON "order_item_modifiers"("organization_id", "order_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_stages_organization_id_unit_id_id_key" ON "workflow_stages"("organization_id", "unit_id", "id");

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_organization_id_unit_id_fkey" FOREIGN KEY ("organization_id", "unit_id") REFERENCES "units"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_agreements" ADD CONSTRAINT "shift_agreements_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_agreements" ADD CONSTRAINT "shift_agreements_organization_id_shift_id_fkey" FOREIGN KEY ("organization_id", "shift_id") REFERENCES "shifts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_prices" ADD CONSTRAINT "shift_prices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_prices" ADD CONSTRAINT "shift_prices_organization_id_shift_id_fkey" FOREIGN KEY ("organization_id", "shift_id") REFERENCES "shifts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_prices" ADD CONSTRAINT "shift_prices_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tabs" ADD CONSTRAINT "tabs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tabs" ADD CONSTRAINT "tabs_organization_id_shift_id_fkey" FOREIGN KEY ("organization_id", "shift_id") REFERENCES "shifts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tabs" ADD CONSTRAINT "tabs_organization_id_unit_id_fkey" FOREIGN KEY ("organization_id", "unit_id") REFERENCES "units"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_organization_id_tab_id_fkey" FOREIGN KEY ("organization_id", "tab_id") REFERENCES "tabs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_organization_id_shift_id_fkey" FOREIGN KEY ("organization_id", "shift_id") REFERENCES "shifts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_organization_id_order_id_fkey" FOREIGN KEY ("organization_id", "order_id") REFERENCES "orders"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_organization_id_tab_id_fkey" FOREIGN KEY ("organization_id", "tab_id") REFERENCES "tabs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_organization_id_unit_id_fkey" FOREIGN KEY ("organization_id", "unit_id") REFERENCES "units"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_organization_id_unit_id_stage_id_fkey" FOREIGN KEY ("organization_id", "unit_id", "stage_id") REFERENCES "workflow_stages"("organization_id", "unit_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_organization_id_unit_id_prep_station_id_fkey" FOREIGN KEY ("organization_id", "unit_id", "prep_station_id") REFERENCES "stations"("organization_id", "unit_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_organization_id_unit_id_station_id_fkey" FOREIGN KEY ("organization_id", "unit_id", "station_id") REFERENCES "stations"("organization_id", "unit_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_organization_id_split_from_id_fkey" FOREIGN KEY ("organization_id", "split_from_id") REFERENCES "order_items"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_modifiers" ADD CONSTRAINT "order_item_modifiers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_modifiers" ADD CONSTRAINT "order_item_modifiers_organization_id_order_item_id_fkey" FOREIGN KEY ("organization_id", "order_item_id") REFERENCES "order_items"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------------------------
-- Rules Prisma cannot express (spec 04; listed next to each model in schema.prisma)
-- ---------------------------------------------------------------------------------------------

-- RN-04.01, CA-04.01: at most one open shift per unit.
CREATE UNIQUE INDEX "shifts_unit_id_open_key" ON "shifts" ("unit_id") WHERE "status" = 'open';
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_next_tab_number_check" CHECK ("next_tab_number" >= 1);
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_closed_check"
    CHECK (("status" = 'closed') = ("closed_at" IS NOT NULL));

-- RN-04.05: amounts and quantities of the agreement.
ALTER TABLE "shift_agreements" ADD CONSTRAINT "shift_agreements_amount_check"
    CHECK ("agreed_amount_cents" IS NULL OR "agreed_amount_cents" >= 0);
ALTER TABLE "shift_agreements" ADD CONSTRAINT "shift_agreements_quantity_check"
    CHECK ("agreed_quantity" IS NULL OR "agreed_quantity" >= 1);

-- RN-04.06: prices of the shift in cents, zero or more.
ALTER TABLE "shift_prices" ADD CONSTRAINT "shift_prices_price_cents_check" CHECK ("price_cents" >= 0);

-- RN-04.09, RN-04.10: number from 1; customer name with 1 to 40 characters.
ALTER TABLE "tabs" ADD CONSTRAINT "tabs_number_check" CHECK ("number" >= 1);
ALTER TABLE "tabs" ADD CONSTRAINT "tabs_customer_name_check"
    CHECK (char_length("customer_name") BETWEEN 1 AND 40);
-- Spec 05: discount type and value go together.
ALTER TABLE "tabs" ADD CONSTRAINT "tabs_discount_check"
    CHECK (("discount_type" IS NULL) = ("discount_value" IS NULL)
        AND ("discount_value" IS NULL OR "discount_value" >= 0));

ALTER TABLE "orders" ADD CONSTRAINT "orders_number_in_tab_check" CHECK ("number_in_tab" >= 1);
ALTER TABLE "orders" ADD CONSTRAINT "orders_completed_check"
    CHECK (("status" = 'completed') = ("completed_at" IS NOT NULL));

-- RN-04.16: quantity from 1 to 99 and note up to 140 characters; RN-04.25: reason up to 140.
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_quantity_check" CHECK ("quantity" BETWEEN 1 AND 99);
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_unit_price_cents_check" CHECK ("unit_price_cents" >= 0);
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_note_check"
    CHECK ("note" IS NULL OR char_length("note") <= 140);
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_cancel_check"
    CHECK (("canceled_at" IS NULL) = ("cancel_reason" IS NULL)
        AND ("cancel_reason" IS NULL OR char_length("cancel_reason") BETWEEN 1 AND 140)
        AND ("canceled_at" IS NULL OR "station_id" IS NULL));

ALTER TABLE "order_item_modifiers" ADD CONSTRAINT "order_item_modifiers_price_delta_cents_check"
    CHECK ("price_delta_cents" >= 0);
