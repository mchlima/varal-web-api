-- Relatórios (spec 07) e busca paginada de clientes (spec 06). Só índices; nenhuma tabela nova.
--
-- Prisma também propõe apagar "tabs_customer_unit_fkey" e "customers_organization_id_unit_id_id_key",
-- criados à mão na migration do fiado e fora do schema.prisma: eles ficam.

-- DropIndex (coberto pelo índice novo, que começa pelas mesmas colunas)
DROP INDEX "customers_organization_id_unit_id_idx";

-- CreateIndex: busca em ordem de nome, paginada por (name, id) (RN-06.02)
CREATE INDEX "customers_organization_id_unit_id_name_id_idx" ON "customers"("organization_id", "unit_id", "name", "id");

-- CreateIndex: recebido no turno, vendas e quitações (RN-07.02)
CREATE INDEX "payments_organization_id_shift_id_idx" ON "payments"("organization_id", "shift_id");

-- CreateIndex: histórico de turnos de todas as unidades por período (spec 07, seção 5)
CREATE INDEX "shifts_organization_id_opened_at_idx" ON "shifts"("organization_id", "opened_at");
