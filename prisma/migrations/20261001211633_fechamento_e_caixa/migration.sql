-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('pix', 'cash', 'credit_card', 'debit_card');

-- CreateEnum
CREATE TYPE "cash_register_status" AS ENUM ('open', 'closed');

-- CreateEnum
CREATE TYPE "cash_movement_type" AS ENUM ('withdrawal', 'deposit');

-- CreateTable
CREATE TABLE "cash_registers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "cash_register_status" NOT NULL DEFAULT 'open',
    "opening_float_cents" INTEGER NOT NULL,
    "opened_by_type" "actor_type" NOT NULL,
    "opened_by_id" UUID,
    "opened_at" TIMESTAMPTZ(3) NOT NULL,
    "closed_by_type" "actor_type",
    "closed_by_id" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "closing_note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cash_registers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_movements" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "cash_register_id" UUID NOT NULL,
    "type" "cash_movement_type" NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by_type" "actor_type" NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_register_counts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "cash_register_id" UUID NOT NULL,
    "method" "payment_method" NOT NULL,
    "expected_cents" INTEGER NOT NULL,
    "informed_cents" INTEGER NOT NULL,
    "difference_cents" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_register_counts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "tab_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "cash_register_id" UUID NOT NULL,
    "method" "payment_method" NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "tendered_cents" INTEGER,
    "change_cents" INTEGER,
    "is_credit_settlement" BOOLEAN NOT NULL DEFAULT false,
    "received_by_type" "actor_type" NOT NULL,
    "received_by_id" UUID,
    "reversed_at" TIMESTAMPTZ(3),
    "reversed_by_type" "actor_type",
    "reversed_by_id" UUID,
    "reversal_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cash_registers_organization_id_shift_id_status_idx" ON "cash_registers"("organization_id", "shift_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "cash_registers_organization_id_id_key" ON "cash_registers"("organization_id", "id");

-- CreateIndex
CREATE INDEX "cash_movements_organization_id_cash_register_id_idx" ON "cash_movements"("organization_id", "cash_register_id");

-- CreateIndex
CREATE INDEX "cash_register_counts_organization_id_cash_register_id_idx" ON "cash_register_counts"("organization_id", "cash_register_id");

-- CreateIndex
CREATE UNIQUE INDEX "cash_register_counts_cash_register_id_method_key" ON "cash_register_counts"("cash_register_id", "method");

-- CreateIndex
CREATE INDEX "payments_organization_id_tab_id_idx" ON "payments"("organization_id", "tab_id");

-- CreateIndex
CREATE INDEX "payments_organization_id_cash_register_id_idx" ON "payments"("organization_id", "cash_register_id");

-- AddForeignKey
ALTER TABLE "cash_registers" ADD CONSTRAINT "cash_registers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_registers" ADD CONSTRAINT "cash_registers_organization_id_shift_id_fkey" FOREIGN KEY ("organization_id", "shift_id") REFERENCES "shifts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_registers" ADD CONSTRAINT "cash_registers_organization_id_unit_id_fkey" FOREIGN KEY ("organization_id", "unit_id") REFERENCES "units"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_organization_id_cash_register_id_fkey" FOREIGN KEY ("organization_id", "cash_register_id") REFERENCES "cash_registers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_register_counts" ADD CONSTRAINT "cash_register_counts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_register_counts" ADD CONSTRAINT "cash_register_counts_organization_id_cash_register_id_fkey" FOREIGN KEY ("organization_id", "cash_register_id") REFERENCES "cash_registers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_organization_id_tab_id_fkey" FOREIGN KEY ("organization_id", "tab_id") REFERENCES "tabs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_organization_id_shift_id_fkey" FOREIGN KEY ("organization_id", "shift_id") REFERENCES "shifts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_organization_id_cash_register_id_fkey" FOREIGN KEY ("organization_id", "cash_register_id") REFERENCES "cash_registers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------------------------
-- Rules Prisma cannot express (spec 05; listed next to each model in schema.prisma)
-- ---------------------------------------------------------------------------------------------

-- RN-05.17: name with 1 to 40 characters, unique in the shift (ignoring case); float >= 0.
ALTER TABLE "cash_registers" ADD CONSTRAINT "cash_registers_name_check"
    CHECK (char_length("name") BETWEEN 1 AND 40);
CREATE UNIQUE INDEX "cash_registers_shift_id_name_key" ON "cash_registers" ("shift_id", lower("name"));
ALTER TABLE "cash_registers" ADD CONSTRAINT "cash_registers_opening_float_cents_check"
    CHECK ("opening_float_cents" >= 0);
-- RN-05.21: closed once, with who and when.
ALTER TABLE "cash_registers" ADD CONSTRAINT "cash_registers_closed_check"
    CHECK (("status" = 'closed') = ("closed_at" IS NOT NULL)
        AND ("closed_at" IS NULL) = ("closed_by_type" IS NULL)
        AND ("closing_note" IS NULL OR char_length("closing_note") BETWEEN 1 AND 500));

-- RN-05.18: amount > 0 and a reason.
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_amount_cents_check" CHECK ("amount_cents" > 0);
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_reason_check"
    CHECK (char_length("reason") BETWEEN 1 AND 140);

-- RN-05.20: difference = informed - expected.
ALTER TABLE "cash_register_counts" ADD CONSTRAINT "cash_register_counts_informed_cents_check"
    CHECK ("informed_cents" >= 0);
ALTER TABLE "cash_register_counts" ADD CONSTRAINT "cash_register_counts_difference_check"
    CHECK ("difference_cents" = "informed_cents" - "expected_cents");

-- RN-05.08, RN-05.09: applied amount > 0; only cash has tendered and change, tendered = applied + change.
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_cents_check" CHECK ("amount_cents" > 0);
ALTER TABLE "payments" ADD CONSTRAINT "payments_cash_check"
    CHECK (("method" = 'cash') = ("tendered_cents" IS NOT NULL)
        AND ("tendered_cents" IS NULL) = ("change_cents" IS NULL)
        AND ("change_cents" IS NULL OR ("change_cents" >= 0
            AND "tendered_cents" = "amount_cents" + "change_cents")));
-- RN-05.13, RN-05.15: a reversal keeps the payment, with when, who and why.
ALTER TABLE "payments" ADD CONSTRAINT "payments_reversal_check"
    CHECK (("reversed_at" IS NULL) = ("reversed_by_type" IS NULL)
        AND ("reversed_at" IS NULL) = ("reversal_reason" IS NULL)
        AND ("reversal_reason" IS NULL OR char_length("reversal_reason") BETWEEN 1 AND 140));
