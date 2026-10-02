-- Fase 7.5 (plano de desenvolvimento, "Migração de dados"): o turno sai e entram os caixas da
-- unidade com aberturas de caixa, o dia de operação, as tabelas de preço e os eventos contratados.
--
-- Migration de EXPANSÃO: nenhum valor histórico muda. Pagamentos, movimentos e conferências mantêm
-- os valores e passam a apontar para a abertura de caixa (a tabela `cash_registers` antiga,
-- renomeada); as tabelas `shifts`, `shift_agreements` e `shift_prices` e as colunas `shift_id`
-- ficam (só leitura) até a migration de contração da versão seguinte (passo 7 do plano).
-- A conferência dos totais antes e depois é feita por `scripts/verify-migration.ts`.
--
-- Tudo numa transação: se qualquer passo falhar, o banco fica como estava.

BEGIN;

-- UUID v7 gerado no SQL (o PostgreSQL 17 não tem uuidv7()): 48 bits de milissegundos de `ts` e o
-- resto aleatório, com a versão 7. Função temporária desta sessão.
CREATE FUNCTION pg_temp.uuid_v7(ts timestamptz) RETURNS uuid
LANGUAGE sql VOLATILE AS $$
  SELECT encode(
    set_bit(set_bit(
      overlay(uuid_send(gen_random_uuid())
              PLACING substring(int8send(floor(extract(epoch FROM ts) * 1000)::bigint) FROM 3)
              FROM 1 FOR 6),
      52, 1), 53, 1), 'hex')::uuid
$$;

-- Dia do turno: data da abertura no fuso de São Paulo (spec 07, decisões; plano, passo 1).
CREATE FUNCTION pg_temp.sp_day(ts timestamptz) RETURNS date
LANGUAGE sql IMMUTABLE AS $$ SELECT (ts AT TIME ZONE 'America/Sao_Paulo')::date $$;

CREATE TYPE "contracted_event_status" AS ENUM ('scheduled', 'in_progress', 'finished', 'canceled');

-- ---------------------------------------------------------------------------------------------
-- 1. Caixas: `cash_registers` (um caixa por turno) vira `cash_register_sessions` (abertura de
--    caixa) e as colunas `cash_register_id` dos filhos viram `cash_register_session_id`.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "cash_registers" RENAME TO "cash_register_sessions";
ALTER TABLE "cash_register_sessions" RENAME CONSTRAINT "cash_registers_pkey" TO "cash_register_sessions_pkey";
ALTER TABLE "cash_register_sessions" RENAME CONSTRAINT "cash_registers_organization_id_fkey" TO "cash_register_sessions_organization_id_fkey";
ALTER TABLE "cash_register_sessions" RENAME CONSTRAINT "cash_registers_organization_id_unit_id_fkey" TO "cash_register_sessions_organization_id_unit_id_fkey";
ALTER TABLE "cash_register_sessions" RENAME CONSTRAINT "cash_registers_organization_id_shift_id_fkey" TO "cash_register_sessions_organization_id_shift_id_fkey";
ALTER TABLE "cash_register_sessions" RENAME CONSTRAINT "cash_registers_opening_float_cents_check" TO "cash_register_sessions_opening_float_cents_check";
ALTER TABLE "cash_register_sessions" RENAME CONSTRAINT "cash_registers_closed_check" TO "cash_register_sessions_closed_check";
ALTER INDEX "cash_registers_organization_id_id_key" RENAME TO "cash_register_sessions_organization_id_id_key";
DROP INDEX "cash_registers_organization_id_shift_id_status_idx";

ALTER TABLE "payments" RENAME COLUMN "cash_register_id" TO "cash_register_session_id";
ALTER TABLE "payments" RENAME CONSTRAINT "payments_organization_id_cash_register_id_fkey" TO "payments_organization_id_cash_register_session_id_fkey";
ALTER INDEX "payments_organization_id_cash_register_id_idx" RENAME TO "payments_organization_id_cash_register_session_id_idx";

ALTER TABLE "cash_movements" RENAME COLUMN "cash_register_id" TO "cash_register_session_id";
ALTER TABLE "cash_movements" RENAME CONSTRAINT "cash_movements_organization_id_cash_register_id_fkey" TO "cash_movements_organization_id_cash_register_session_id_fkey";
ALTER INDEX "cash_movements_organization_id_cash_register_id_idx" RENAME TO "cash_movements_organization_id_cash_register_session_id_idx";

ALTER TABLE "cash_register_counts" RENAME COLUMN "cash_register_id" TO "cash_register_session_id";
ALTER TABLE "cash_register_counts" RENAME CONSTRAINT "cash_register_counts_organization_id_cash_register_id_fkey" TO "cash_register_counts_organization_id_cash_register_session_fkey";
ALTER INDEX "cash_register_counts_organization_id_cash_register_id_idx" RENAME TO "cash_register_counts_organization_id_cash_register_session__idx";
ALTER INDEX "cash_register_counts_cash_register_id_method_key" RENAME TO "cash_register_counts_cash_register_session_id_method_key";

ALTER TABLE "cash_register_sessions"
    ADD COLUMN "cash_register_id" UUID,
    ADD COLUMN "business_date" DATE,
    ADD COLUMN "pending_tabs_count" INTEGER,
    ADD COLUMN "pending_tabs_total_cents" INTEGER,
    ALTER COLUMN "shift_id" DROP NOT NULL;

-- Caixas cadastrados da unidade (spec 05, seção 5.1).
CREATE TABLE "cash_registers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cash_registers_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------------------------
-- 2. Tabelas de preço (spec 03, seção 5.3) e eventos contratados (spec 04, seção 3.3).
-- ---------------------------------------------------------------------------------------------

CREATE TABLE "price_lists" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "price_lists_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "product_prices" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "price_list_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_prices_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "contracted_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "contractor_name" TEXT NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE,
    "price_list_id" UUID,
    "modality" "agreement_modality" NOT NULL,
    "agreed_amount_cents" INTEGER,
    "agreed_quantity" INTEGER,
    "limits" TEXT,
    "notes" TEXT,
    "status" "contracted_event_status" NOT NULL DEFAULT 'scheduled',
    "started_at" TIMESTAMPTZ(3),
    "started_by_type" "actor_type",
    "started_by_id" UUID,
    "finished_at" TIMESTAMPTZ(3),
    "finished_by_type" "actor_type",
    "finished_by_id" UUID,
    "canceled_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "contracted_events_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------------------------
-- 3. Colunas novas: dia de operação, tabela vigente, limites das estações, evento, tabela usada.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "units"
    ADD COLUMN "business_date" DATE,
    ADD COLUMN "current_price_list_id" UUID,
    ADD COLUMN "next_tab_number" INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN "operation_version" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "stations"
    ADD COLUMN "attention_after_minutes" INTEGER,
    ADD COLUMN "late_after_minutes" INTEGER;

ALTER TABLE "tabs"
    ADD COLUMN "business_date" DATE,
    ADD COLUMN "closed_business_date" DATE,
    ADD COLUMN "event_id" UUID,
    ALTER COLUMN "shift_id" DROP NOT NULL;

ALTER TABLE "orders" ALTER COLUMN "shift_id" DROP NOT NULL;

ALTER TABLE "order_items"
    ADD COLUMN "canceled_business_date" DATE,
    ADD COLUMN "price_list_id" UUID;

ALTER TABLE "payments" ALTER COLUMN "shift_id" DROP NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- 4. Dados (plano, fase 7.5, passos 1 a 5). Nenhum valor em centavos é alterado.
-- ---------------------------------------------------------------------------------------------

-- Passo 1: os nomes distintos das aberturas de cada unidade (sem diferenciar maiúsculas) viram os
-- caixas cadastrados, na ordem do primeiro uso, com a grafia da primeira abertura.
INSERT INTO "cash_registers" ("id", "organization_id", "unit_id", "name", "sort_order", "active", "version", "created_at", "updated_at")
SELECT pg_temp.uuid_v7(n.first_opened_at), n.organization_id, n.unit_id, n.name,
       row_number() OVER (PARTITION BY n.unit_id ORDER BY n.first_opened_at, n.lower_name),
       true, 0, n.first_opened_at, CURRENT_TIMESTAMP
FROM (
    SELECT DISTINCT ON (s.unit_id, lower(s.name))
           s.organization_id, s.unit_id, s.name, lower(s.name) AS lower_name, s.opened_at AS first_opened_at
    FROM "cash_register_sessions" s
    ORDER BY s.unit_id, lower(s.name), s.opened_at, s.id
) n;

-- Unidade sem nenhum caixa ganha o "Caixa 1" (spec 03, RN-03.03).
INSERT INTO "cash_registers" ("id", "organization_id", "unit_id", "name", "sort_order", "active", "version", "created_at", "updated_at")
SELECT pg_temp.uuid_v7(CURRENT_TIMESTAMP), u.organization_id, u.id, 'Caixa 1', 1, true, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "units" u
WHERE NOT EXISTS (SELECT 1 FROM "cash_registers" r WHERE r.unit_id = u.id);

-- Cada abertura aponta para o seu caixa e recebe o dia do turno; as fechadas, pendentes zerados.
UPDATE "cash_register_sessions" s
SET "cash_register_id" = r.id
FROM "cash_registers" r
WHERE r.organization_id = s.organization_id AND r.unit_id = s.unit_id AND lower(r.name) = lower(s.name);

UPDATE "cash_register_sessions" s
SET "business_date" = pg_temp.sp_day(sh.opened_at)
FROM "shifts" sh
WHERE sh.id = s.shift_id AND sh.organization_id = s.organization_id;

UPDATE "cash_register_sessions"
SET "pending_tabs_count" = 0, "pending_tabs_total_cents" = 0
WHERE "status" = 'closed';

-- Passo 2: comandas e itens recebem o dia do turno; a unidade, o dia e a numeração do último turno.
UPDATE "tabs" t
SET "business_date" = pg_temp.sp_day(sh.opened_at),
    "closed_business_date" = CASE WHEN t.status IN ('open', 'closing') THEN NULL
                                  ELSE pg_temp.sp_day(sh.opened_at) END
FROM "shifts" sh
WHERE sh.id = t.shift_id AND sh.organization_id = t.organization_id;

UPDATE "order_items" oi
SET "canceled_business_date" = t.business_date
FROM "tabs" t
WHERE t.id = oi.tab_id AND t.organization_id = oi.organization_id AND oi.canceled_at IS NOT NULL;

UPDATE "units" u
SET "business_date" = pg_temp.sp_day(last.opened_at),
    "next_tab_number" = last.next_tab_number
FROM (
    SELECT DISTINCT ON (unit_id) unit_id, organization_id, opened_at, next_tab_number
    FROM "shifts"
    ORDER BY unit_id, opened_at DESC, id DESC
) last
WHERE last.unit_id = u.id AND last.organization_id = u.organization_id;

-- Passo 3: cada turno com preços vira uma tabela de preço inativa, chamada pelo contratante ou
-- "Preços de dd/mm/aaaa" (até 30 caracteres, nunca "Normal", numerada se repetir na unidade).
-- A do turno aberto fica ativa e vigente (passo 5).
CREATE TEMP TABLE "migrated_price_lists" AS
SELECT b.shift_id, b.organization_id, b.unit_id, b.shift_status, b.opened_at, b.price_list_id,
       CASE WHEN b.rn = 1 THEN b.base ELSE b.base || ' (' || b.rn || ')' END AS name,
       b.sort_order
FROM (
    SELECT n.*,
           row_number() OVER (PARTITION BY n.unit_id, lower(n.base) ORDER BY n.opened_at, n.shift_id) AS rn,
           row_number() OVER (PARTITION BY n.unit_id ORDER BY n.opened_at, n.shift_id) AS sort_order
    FROM (
        SELECT sh.id AS shift_id, sh.organization_id, sh.unit_id, sh.status AS shift_status,
               sh.opened_at, pg_temp.uuid_v7(sh.opened_at) AS price_list_id,
               CASE WHEN lower(left(btrim(COALESCE(NULLIF(btrim(a.contractor_name), ''),
                                   'Preços de ' || to_char(pg_temp.sp_day(sh.opened_at), 'DD/MM/YYYY'))), 24)) = 'normal'
                    THEN 'Normal (turno)'
                    ELSE btrim(left(btrim(COALESCE(NULLIF(btrim(a.contractor_name), ''),
                                   'Preços de ' || to_char(pg_temp.sp_day(sh.opened_at), 'DD/MM/YYYY'))), 24))
               END AS base
        FROM "shifts" sh
        LEFT JOIN "shift_agreements" a ON a.shift_id = sh.id AND a.organization_id = sh.organization_id
        WHERE EXISTS (SELECT 1 FROM "shift_prices" p WHERE p.shift_id = sh.id AND p.organization_id = sh.organization_id)
    ) n
) b;

INSERT INTO "price_lists" ("id", "organization_id", "unit_id", "name", "sort_order", "active", "version", "created_at", "updated_at")
SELECT m.price_list_id, m.organization_id, m.unit_id, m.name, m.sort_order, m.shift_status = 'open', 0, m.opened_at, CURRENT_TIMESTAMP
FROM "migrated_price_lists" m;

INSERT INTO "product_prices" ("id", "organization_id", "price_list_id", "product_id", "price_cents", "created_at", "updated_at")
SELECT pg_temp.uuid_v7(p.created_at), p.organization_id, m.price_list_id, p.product_id, p.price_cents, p.created_at, CURRENT_TIMESTAMP
FROM "shift_prices" p
JOIN "migrated_price_lists" m ON m.shift_id = p.shift_id AND m.organization_id = p.organization_id;

-- Itens vendidos com o preço do turno guardam a tabela (RN-04.18); o preço gravado não muda.
UPDATE "order_items" oi
SET "price_list_id" = m.price_list_id
FROM "tabs" t
JOIN "migrated_price_lists" m ON m.shift_id = t.shift_id AND m.organization_id = t.organization_id
JOIN "shift_prices" p ON p.shift_id = t.shift_id AND p.organization_id = t.organization_id
WHERE oi.tab_id = t.id AND oi.organization_id = t.organization_id
  AND p.product_id = oi.product_id AND p.price_cents = oi.unit_price_cents;

UPDATE "units" u
SET "current_price_list_id" = m.price_list_id
FROM "migrated_price_lists" m
WHERE m.unit_id = u.id AND m.organization_id = u.organization_id AND m.shift_status = 'open';

-- Passo 4: cada turno contratado vira um evento encerrado (o turno aberto, em andamento, passo 5),
-- com o acordo e a tabela do passo 3; as comandas do turno ficam ligadas a ele.
CREATE TEMP TABLE "migrated_events" AS
SELECT sh.id AS shift_id, sh.organization_id, pg_temp.uuid_v7(sh.opened_at) AS event_id
FROM "shifts" sh
JOIN "shift_agreements" a ON a.shift_id = sh.id AND a.organization_id = sh.organization_id;

INSERT INTO "contracted_events" (
    "id", "organization_id", "unit_id", "contractor_name", "starts_on", "ends_on", "price_list_id",
    "modality", "agreed_amount_cents", "agreed_quantity", "limits", "notes", "status",
    "started_at", "started_by_type", "started_by_id", "finished_at", "finished_by_type", "finished_by_id",
    "canceled_at", "version", "created_at", "updated_at")
SELECT e.event_id, sh.organization_id, sh.unit_id, left(btrim(a.contractor_name), 60),
       pg_temp.sp_day(sh.opened_at), NULL, pl.price_list_id,
       a.modality, a.agreed_amount_cents, a.agreed_quantity, a.limits, a.notes,
       (CASE WHEN sh.status = 'open' THEN 'in_progress' ELSE 'finished' END)::"contracted_event_status",
       sh.opened_at, sh.opened_by_type, sh.opened_by_id, sh.closed_at, sh.closed_by_type, sh.closed_by_id,
       NULL, 0, a.created_at, CURRENT_TIMESTAMP
FROM "migrated_events" e
JOIN "shifts" sh ON sh.id = e.shift_id AND sh.organization_id = e.organization_id
JOIN "shift_agreements" a ON a.shift_id = sh.id AND a.organization_id = sh.organization_id
LEFT JOIN "migrated_price_lists" pl ON pl.shift_id = sh.id AND pl.organization_id = sh.organization_id;

UPDATE "tabs" t
SET "event_id" = e.event_id
FROM "migrated_events" e
WHERE e.shift_id = t.shift_id AND e.organization_id = t.organization_id;

-- Estações de fila recebem o atraso da unidade e a atenção na metade (RN-03.25). O atraso mínimo
-- de uma estação é 2, porque a atenção vai de 1 até o atraso − 1.
UPDATE "stations" s
SET "late_after_minutes" = GREATEST(2, u.late_after_minutes),
    "attention_after_minutes" = GREATEST(1, GREATEST(2, u.late_after_minutes) / 2)
FROM "units" u
WHERE u.id = s.unit_id AND u.organization_id = s.organization_id AND s.kind = 'queue';

DROP TABLE "migrated_events";
DROP TABLE "migrated_price_lists";

-- ---------------------------------------------------------------------------------------------
-- 5. Restrições, índices e chaves (depois dos dados).
-- ---------------------------------------------------------------------------------------------

-- A abertura não tem mais nome próprio: o nome é o do caixa cadastrado.
DROP INDEX "cash_registers_shift_id_name_key";
ALTER TABLE "cash_register_sessions" DROP CONSTRAINT "cash_registers_name_check";
ALTER TABLE "cash_register_sessions"
    DROP COLUMN "name",
    ALTER COLUMN "cash_register_id" SET NOT NULL,
    ALTER COLUMN "business_date" SET NOT NULL;

ALTER TABLE "tabs" ALTER COLUMN "business_date" SET NOT NULL;

-- O número único por turno dá lugar ao único entre as comandas em aberto da unidade (RN-04.09).
DROP INDEX "tabs_shift_id_number_key";
DROP INDEX "tabs_organization_id_shift_id_status_idx";
DROP INDEX "payments_organization_id_shift_id_idx";

CREATE UNIQUE INDEX "cash_registers_organization_id_unit_id_id_key" ON "cash_registers"("organization_id", "unit_id", "id");
CREATE INDEX "cash_registers_organization_id_unit_id_idx" ON "cash_registers"("organization_id", "unit_id");
CREATE INDEX "cash_register_sessions_organization_id_unit_id_status_idx" ON "cash_register_sessions"("organization_id", "unit_id", "status");
CREATE INDEX "cash_register_sessions_organization_id_unit_id_business_dat_idx" ON "cash_register_sessions"("organization_id", "unit_id", "business_date");
CREATE INDEX "cash_register_sessions_organization_id_cash_register_id_idx" ON "cash_register_sessions"("organization_id", "cash_register_id");
CREATE INDEX "price_lists_organization_id_unit_id_idx" ON "price_lists"("organization_id", "unit_id");
CREATE UNIQUE INDEX "price_lists_organization_id_id_key" ON "price_lists"("organization_id", "id");
CREATE UNIQUE INDEX "price_lists_organization_id_unit_id_id_key" ON "price_lists"("organization_id", "unit_id", "id");
CREATE INDEX "product_prices_organization_id_price_list_id_idx" ON "product_prices"("organization_id", "price_list_id");
CREATE INDEX "product_prices_organization_id_product_id_idx" ON "product_prices"("organization_id", "product_id");
CREATE UNIQUE INDEX "product_prices_price_list_id_product_id_key" ON "product_prices"("price_list_id", "product_id");
CREATE INDEX "contracted_events_organization_id_unit_id_starts_on_idx" ON "contracted_events"("organization_id", "unit_id", "starts_on");
CREATE UNIQUE INDEX "contracted_events_organization_id_id_key" ON "contracted_events"("organization_id", "id");
CREATE INDEX "order_items_organization_id_unit_id_canceled_business_date_idx" ON "order_items"("organization_id", "unit_id", "canceled_business_date");
CREATE INDEX "tabs_organization_id_unit_id_business_date_idx" ON "tabs"("organization_id", "unit_id", "business_date");
CREATE INDEX "tabs_organization_id_unit_id_closed_business_date_idx" ON "tabs"("organization_id", "unit_id", "closed_business_date");
CREATE INDEX "tabs_organization_id_event_id_idx" ON "tabs"("organization_id", "event_id");

ALTER TABLE "cash_registers" ADD CONSTRAINT "cash_registers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cash_registers" ADD CONSTRAINT "cash_registers_organization_id_unit_id_fkey" FOREIGN KEY ("organization_id", "unit_id") REFERENCES "units"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cash_register_sessions" ADD CONSTRAINT "cash_register_sessions_organization_id_unit_id_cash_regist_fkey" FOREIGN KEY ("organization_id", "unit_id", "cash_register_id") REFERENCES "cash_registers"("organization_id", "unit_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_organization_id_unit_id_fkey" FOREIGN KEY ("organization_id", "unit_id") REFERENCES "units"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_organization_id_price_list_id_fkey" FOREIGN KEY ("organization_id", "price_list_id") REFERENCES "price_lists"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "contracted_events" ADD CONSTRAINT "contracted_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "contracted_events" ADD CONSTRAINT "contracted_events_organization_id_unit_id_fkey" FOREIGN KEY ("organization_id", "unit_id") REFERENCES "units"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "contracted_events" ADD CONSTRAINT "contracted_events_organization_id_unit_id_price_list_id_fkey" FOREIGN KEY ("organization_id", "unit_id", "price_list_id") REFERENCES "price_lists"("organization_id", "unit_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tabs" ADD CONSTRAINT "tabs_organization_id_event_id_fkey" FOREIGN KEY ("organization_id", "event_id") REFERENCES "contracted_events"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_organization_id_price_list_id_fkey" FOREIGN KEY ("organization_id", "price_list_id") REFERENCES "price_lists"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- Regras que o Prisma não expressa (listadas junto de cada modelo no schema.prisma)
-- ---------------------------------------------------------------------------------------------

-- RN-04.29, RN-04.06: numeração do dia e tabela vigente da mesma unidade (nula = "Normal").
ALTER TABLE "units" ADD CONSTRAINT "units_next_tab_number_check" CHECK ("next_tab_number" >= 1);
ALTER TABLE "units" ADD CONSTRAINT "units_current_price_list_fkey"
    FOREIGN KEY ("organization_id", "id", "current_price_list_id")
    REFERENCES "price_lists" ("organization_id", "unit_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RN-03.25: limites só nas estações de fila, com 1 <= atenção < atraso <= 240.
ALTER TABLE "stations" ADD CONSTRAINT "stations_time_limits_check"
    CHECK (("kind" = 'queue') = ("late_after_minutes" IS NOT NULL)
        AND ("late_after_minutes" IS NULL) = ("attention_after_minutes" IS NULL)
        AND ("late_after_minutes" IS NULL
             OR ("attention_after_minutes" >= 1
                 AND "attention_after_minutes" < "late_after_minutes"
                 AND "late_after_minutes" <= 240)));

-- RN-05.17: nome do caixa com 1 a 40 caracteres, único na unidade (sem diferenciar maiúsculas).
ALTER TABLE "cash_registers" ADD CONSTRAINT "cash_registers_name_check"
    CHECK (char_length("name") BETWEEN 1 AND 40);
CREATE UNIQUE INDEX "cash_registers_unit_id_name_key" ON "cash_registers" ("unit_id", lower("name"));

-- RN-05.23: no máximo uma abertura em andamento por caixa; RN-05.28: pendentes nunca negativos.
CREATE UNIQUE INDEX "cash_register_sessions_cash_register_id_open_key"
    ON "cash_register_sessions" ("cash_register_id") WHERE "status" = 'open';
ALTER TABLE "cash_register_sessions" ADD CONSTRAINT "cash_register_sessions_pending_check"
    CHECK (("pending_tabs_count" IS NULL OR "pending_tabs_count" >= 0)
        AND ("pending_tabs_total_cents" IS NULL OR "pending_tabs_total_cents" >= 0));

-- RN-03.20: nome de 1 a 30 caracteres, "Normal" reservado, único na unidade.
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_name_check"
    CHECK (char_length("name") BETWEEN 1 AND 30 AND lower("name") <> 'normal');
CREATE UNIQUE INDEX "price_lists_unit_id_name_key" ON "price_lists" ("unit_id", lower("name"));

-- RN-03.21: preço por tabela maior ou igual a zero.
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_price_cents_check" CHECK ("price_cents" >= 0);

-- RN-04.05, RN-04.35: contratante de 1 a 60 caracteres, datas em ordem, um evento em andamento por unidade.
ALTER TABLE "contracted_events" ADD CONSTRAINT "contracted_events_contractor_name_check"
    CHECK (char_length("contractor_name") BETWEEN 1 AND 60);
ALTER TABLE "contracted_events" ADD CONSTRAINT "contracted_events_dates_check"
    CHECK ("ends_on" IS NULL OR "ends_on" >= "starts_on");
ALTER TABLE "contracted_events" ADD CONSTRAINT "contracted_events_amount_check"
    CHECK ("agreed_amount_cents" IS NULL OR "agreed_amount_cents" >= 0);
ALTER TABLE "contracted_events" ADD CONSTRAINT "contracted_events_quantity_check"
    CHECK ("agreed_quantity" IS NULL OR "agreed_quantity" >= 1);
CREATE UNIQUE INDEX "contracted_events_unit_id_in_progress_key"
    ON "contracted_events" ("unit_id") WHERE "status" = 'in_progress';

-- RN-04.09: entre as comandas em aberto da unidade, o número nunca se repete.
CREATE UNIQUE INDEX "tabs_unit_id_open_number_key" ON "tabs" ("unit_id", "number")
    WHERE "status" IN ('open', 'closing');
-- RN-04.38: a comanda guarda o dia em que saiu de `open`/`closing`, e só então.
ALTER TABLE "tabs" ADD CONSTRAINT "tabs_closed_business_date_check"
    CHECK (("status" IN ('open', 'closing')) = ("closed_business_date" IS NULL));

-- RN-04.30: o item cancelado guarda o dia de operação do cancelamento.
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_canceled_business_date_check"
    CHECK (("canceled_at" IS NULL) = ("canceled_business_date" IS NULL));

COMMIT;
