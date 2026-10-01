-- AlterTable
ALTER TABLE "tabs" ADD COLUMN     "credit_at" TIMESTAMPTZ(3),
ADD COLUMN     "customer_id" UUID,
ADD COLUMN     "settled_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "cpf" TEXT,
    "reference" TEXT,
    "note" TEXT,
    "anonymized_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customers_organization_id_unit_id_idx" ON "customers"("organization_id", "unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "customers_organization_id_id_key" ON "customers"("organization_id", "id");

-- CreateIndex
CREATE INDEX "tabs_organization_id_unit_id_status_idx" ON "tabs"("organization_id", "unit_id", "status");

-- CreateIndex
CREATE INDEX "tabs_organization_id_customer_id_idx" ON "tabs"("organization_id", "customer_id");

-- AddForeignKey
ALTER TABLE "tabs" ADD CONSTRAINT "tabs_organization_id_customer_id_fkey" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "customers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_organization_id_unit_id_fkey" FOREIGN KEY ("organization_id", "unit_id") REFERENCES "units"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- Rules Prisma cannot express (spec 06; listed next to each model in schema.prisma)
-- ---------------------------------------------------------------------------------------------

-- RN-06.01: name 1..60; phone with DDD (10 or 11 digits); CPF 11 digits; reference <= 60; note <= 140.
ALTER TABLE "customers" ADD CONSTRAINT "customers_name_check"
    CHECK (char_length("name") BETWEEN 1 AND 60);
ALTER TABLE "customers" ADD CONSTRAINT "customers_phone_check"
    CHECK ("phone" IS NULL OR "phone" ~ '^[1-9][0-9]{9,10}$');
ALTER TABLE "customers" ADD CONSTRAINT "customers_cpf_check"
    CHECK ("cpf" IS NULL OR "cpf" ~ '^[0-9]{11}$');
ALTER TABLE "customers" ADD CONSTRAINT "customers_reference_check"
    CHECK ("reference" IS NULL OR char_length("reference") BETWEEN 1 AND 60);
ALTER TABLE "customers" ADD CONSTRAINT "customers_note_check"
    CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 140);
-- RN-06.03: a removed customer keeps no personal data.
ALTER TABLE "customers" ADD CONSTRAINT "customers_anonymized_check"
    CHECK ("anonymized_at" IS NULL OR ("name" = 'Cliente removido' AND "phone" IS NULL
        AND "cpf" IS NULL AND "reference" IS NULL AND "note" IS NULL));
-- RN-06.02: phone and CPF unique in the unit, among the customers not removed.
CREATE UNIQUE INDEX "customers_unit_id_phone_key" ON "customers" ("unit_id", "phone")
    WHERE "phone" IS NOT NULL AND "anonymized_at" IS NULL;
CREATE UNIQUE INDEX "customers_unit_id_cpf_key" ON "customers" ("unit_id", "cpf")
    WHERE "cpf" IS NOT NULL AND "anonymized_at" IS NULL;

-- RN-06.05: the customer of a tab is of the same unit.
CREATE UNIQUE INDEX "customers_organization_id_unit_id_id_key" ON "customers" ("organization_id", "unit_id", "id");
ALTER TABLE "tabs" ADD CONSTRAINT "tabs_customer_unit_fkey" FOREIGN KEY ("organization_id", "unit_id", "customer_id")
    REFERENCES "customers" ("organization_id", "unit_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- RN-06.05, RN-06.10: a tab on credit or settled has its customer and when it was put on credit;
-- `settled_at` only while settled.
ALTER TABLE "tabs" ADD CONSTRAINT "tabs_credit_check"
    CHECK (("status" NOT IN ('on_credit', 'settled') OR ("customer_id" IS NOT NULL AND "credit_at" IS NOT NULL))
        AND (("status" = 'settled') = ("settled_at" IS NOT NULL)));
