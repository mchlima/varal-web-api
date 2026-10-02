/**
 * Conferência da migração da fase 7.5 (plano de desenvolvimento, "Migração de dados", passo 6).
 *
 * 1. Antes da migração, com o banco ainda no formato de turnos:
 *      node --import @swc-node/register/esm-register scripts/verify-migration.ts snapshot antes.json
 *    calcula, para cada turno, os totais do relatório do turno (venda, recebido de vendas e de
 *    quitações, pendurado, descontos, perdas, comandas e diferença de caixa) e, para cada caixa do
 *    turno, o recebido e a diferença, com o SQL do relatório antigo.
 * 2. Depois de `pnpm db:deploy`:
 *      node --import @swc-node/register/esm-register scripts/verify-migration.ts compare antes.json
 *    recalcula os mesmos números pelo relatório do dia (somando os turnos de cada unidade e dia) e
 *    pelo relatório de cada abertura de caixa, com as consultas da API (src/reports), e lista toda
 *    diferença. Sai com código 1 se houver alguma.
 *
 * Usa DATABASE_URL (ou o primeiro argumento depois do arquivo). Só lê: nunca escreve no banco.
 * A migração só vai para produção com este script sem diferenças no banco de desenvolvimento
 * restaurado do `pg_dump` de produção.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import pg from 'pg';

/** Totals compared, in cents (quantities for counts). */
export interface ComparedTotals {
  tabCount: number;
  salesCents: number;
  discountsCents: number;
  onCreditCents: number;
  wasteCents: number;
  wasteQuantity: number;
  receivedSalesCents: number;
  receivedSettlementsCents: number;
  cashDifferenceCents: number;
}

interface ShiftSnapshot extends ComparedTotals {
  shiftId: string;
  organizationId: string;
  unitId: string;
  /** São Paulo day of the opening: the day of operation after the migration. */
  day: string;
}

interface RegisterSnapshot {
  /** Same id after the migration (the table is renamed to `cash_register_sessions`). */
  id: string;
  organizationId: string;
  shiftId: string;
  receivedSalesCents: number;
  receivedSettlementsCents: number;
  cashDifferenceCents: number;
  paymentCount: number;
}

interface Snapshot {
  takenAt: string;
  shifts: ShiftSnapshot[];
  registers: RegisterSnapshot[];
  /** Sums over the whole database, to catch rows that no shift or day groups. */
  global: { payments: number; paymentsCents: number; movementsCents: number; counts: number };
}

const KEYS: readonly (keyof ComparedTotals)[] = [
  'tabCount',
  'salesCents',
  'discountsCents',
  'onCreditCents',
  'wasteCents',
  'wasteQuantity',
  'receivedSalesCents',
  'receivedSettlementsCents',
  'cashDifferenceCents',
];

/**
 * The aggregated SQL of the shift report before phase 7.5 (src/reports/report-queries.ts at
 * v0.6.0), over every shift of every organization, with `organization_id` matched in every join.
 */
const OLD_PER_SHIFT_SQL = `
  WITH s AS (SELECT id, organization_id, unit_id, opened_at FROM shifts),
  lines AS (
    SELECT oi.tab_id, oi.quantity, oi.canceled_at, oi.wasted,
           (oi.unit_price_cents + COALESCE(m.delta, 0))::bigint * oi.quantity AS value
    FROM order_items oi
    JOIN tabs t ON t.id = oi.tab_id AND t.organization_id = oi.organization_id
    LEFT JOIN LATERAL (
      SELECT SUM(om.price_delta_cents) AS delta FROM order_item_modifiers om
      WHERE om.organization_id = oi.organization_id AND om.order_item_id = oi.id
    ) m ON true
  ),
  tab_lines AS (
    SELECT t.id, t.shift_id, t.status, t.discount_type, t.discount_value, t.organization_id,
           COALESCE(SUM(l.value) FILTER (WHERE l.canceled_at IS NULL), 0)::bigint AS subtotal,
           COALESCE(SUM(l.value) FILTER (WHERE l.canceled_at IS NOT NULL AND l.wasted), 0)::bigint AS waste,
           COALESCE(SUM(l.quantity) FILTER (WHERE l.canceled_at IS NOT NULL AND l.wasted), 0)::bigint AS waste_quantity
    FROM tabs t
    LEFT JOIN lines l ON l.tab_id = t.id
    GROUP BY t.id
  ),
  tab_totals AS (
    SELECT tl.*,
           GREATEST(0, LEAST(tl.subtotal, CASE tl.discount_type
             WHEN 'amount' THEN tl.discount_value::bigint
             WHEN 'percent' THEN tl.subtotal * tl.discount_value / 100
             ELSE 0 END)) AS discount,
           COALESCE((
             SELECT SUM(p.amount_cents) FROM payments p
             WHERE p.organization_id = tl.organization_id AND p.tab_id = tl.id
               AND p.reversed_at IS NULL AND NOT p.is_credit_settlement
           ), 0)::bigint AS paid_before_credit
    FROM tab_lines tl
  ),
  by_shift AS (
    SELECT shift_id,
           COUNT(*) FILTER (WHERE status IN ('paid', 'on_credit', 'settled'))::int AS tab_count,
           COALESCE(SUM(subtotal - discount) FILTER (WHERE status IN ('paid', 'on_credit', 'settled')), 0)::bigint AS sales,
           COALESCE(SUM(discount) FILTER (WHERE status IN ('paid', 'on_credit', 'settled')), 0)::bigint AS discounts,
           COALESCE(SUM(subtotal - discount - paid_before_credit) FILTER (WHERE status IN ('on_credit', 'settled')), 0)::bigint AS on_credit,
           COALESCE(SUM(waste), 0)::bigint AS waste,
           COALESCE(SUM(waste_quantity), 0)::bigint AS waste_quantity
    FROM tab_totals GROUP BY shift_id
  ),
  received AS (
    SELECT p.shift_id,
           COALESCE(SUM(p.amount_cents) FILTER (WHERE NOT p.is_credit_settlement), 0)::bigint AS sales,
           COALESCE(SUM(p.amount_cents) FILTER (WHERE p.is_credit_settlement), 0)::bigint AS settlements
    FROM payments p WHERE p.reversed_at IS NULL GROUP BY p.shift_id
  ),
  cash AS (
    SELECT cr.shift_id, COALESCE(SUM(c.difference_cents), 0)::bigint AS difference
    FROM cash_registers cr
    JOIN cash_register_counts c ON c.cash_register_id = cr.id AND c.organization_id = cr.organization_id
    GROUP BY cr.shift_id
  )
  SELECT s.id AS shift_id, s.organization_id, s.unit_id,
         to_char((s.opened_at AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') AS day,
         COALESCE(b.tab_count, 0) AS tab_count,
         COALESCE(b.sales, 0) AS sales, COALESCE(b.discounts, 0) AS discounts,
         COALESCE(b.on_credit, 0) AS on_credit, COALESCE(b.waste, 0) AS waste,
         COALESCE(b.waste_quantity, 0) AS waste_quantity,
         COALESCE(r.sales, 0) AS received_sales, COALESCE(r.settlements, 0) AS received_settlements,
         COALESCE(c.difference, 0) AS cash_difference
  FROM s
  LEFT JOIN by_shift b ON b.shift_id = s.id
  LEFT JOIN received r ON r.shift_id = s.id
  LEFT JOIN cash c ON c.shift_id = s.id
  ORDER BY s.organization_id, s.opened_at`;

const OLD_PER_REGISTER_SQL = `
  SELECT cr.id, cr.organization_id, cr.shift_id,
         COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.organization_id = cr.organization_id
                   AND p.cash_register_id = cr.id AND p.reversed_at IS NULL AND NOT p.is_credit_settlement), 0)::bigint AS received_sales,
         COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.organization_id = cr.organization_id
                   AND p.cash_register_id = cr.id AND p.reversed_at IS NULL AND p.is_credit_settlement), 0)::bigint AS received_settlements,
         COALESCE((SELECT SUM(c.difference_cents) FROM cash_register_counts c WHERE c.organization_id = cr.organization_id
                   AND c.cash_register_id = cr.id), 0)::bigint AS cash_difference,
         (SELECT COUNT(*) FROM payments p WHERE p.organization_id = cr.organization_id AND p.cash_register_id = cr.id)::int AS payment_count
  FROM cash_registers cr ORDER BY cr.id`;

const GLOBAL_SQL = (paymentRegister: string, movementRegister: string) => `
  SELECT (SELECT COUNT(*) FROM payments WHERE ${paymentRegister} IS NOT NULL)::int AS payments,
         (SELECT COALESCE(SUM(amount_cents), 0) FROM payments WHERE reversed_at IS NULL)::bigint AS payments_cents,
         (SELECT COALESCE(SUM(CASE type WHEN 'deposit' THEN amount_cents ELSE -amount_cents END), 0)
            FROM cash_movements WHERE ${movementRegister} IS NOT NULL)::bigint AS movements_cents,
         (SELECT COUNT(*) FROM cash_register_counts)::int AS counts`;

type Big = string | number | bigint | null;

interface OldShiftRow {
  shift_id: string;
  organization_id: string;
  unit_id: string;
  day: string;
  tab_count: Big;
  sales: Big;
  discounts: Big;
  on_credit: Big;
  waste: Big;
  waste_quantity: Big;
  received_sales: Big;
  received_settlements: Big;
  cash_difference: Big;
}

interface OldRegisterRow {
  id: string;
  organization_id: string;
  shift_id: string;
  received_sales: Big;
  received_settlements: Big;
  cash_difference: Big;
  payment_count: Big;
}

interface GlobalRow {
  payments: Big;
  payments_cents: Big;
  movements_cents: Big;
  counts: Big;
}

function num(value: unknown): number {
  return Number(value ?? 0);
}

async function snapshot(client: pg.Client): Promise<Snapshot> {
  const legacy = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'cash_registers' AND column_name = 'shift_id'`,
  );
  if (legacy.rowCount === 0) {
    throw new Error('O banco já está migrado: rode o snapshot antes de `pnpm db:deploy`.');
  }
  const shifts = await client.query<OldShiftRow>(OLD_PER_SHIFT_SQL);
  const registers = await client.query<OldRegisterRow>(OLD_PER_REGISTER_SQL);
  const [global] = (
    await client.query<GlobalRow>(GLOBAL_SQL('cash_register_id', 'cash_register_id'))
  ).rows;
  return {
    takenAt: new Date().toISOString(),
    shifts: shifts.rows.map((row) => ({
      shiftId: row.shift_id,
      organizationId: row.organization_id,
      unitId: row.unit_id,
      day: row.day,
      tabCount: num(row.tab_count),
      salesCents: num(row.sales),
      discountsCents: num(row.discounts),
      onCreditCents: num(row.on_credit),
      wasteCents: num(row.waste),
      wasteQuantity: num(row.waste_quantity),
      receivedSalesCents: num(row.received_sales),
      receivedSettlementsCents: num(row.received_settlements),
      cashDifferenceCents: num(row.cash_difference),
    })),
    registers: registers.rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      shiftId: row.shift_id,
      receivedSalesCents: num(row.received_sales),
      receivedSettlementsCents: num(row.received_settlements),
      cashDifferenceCents: num(row.cash_difference),
      paymentCount: num(row.payment_count),
    })),
    global: {
      payments: num(global?.payments),
      paymentsCents: num(global?.payments_cents),
      movementsCents: num(global?.movements_cents),
      counts: num(global?.counts),
    },
  };
}

async function compare(databaseUrl: string, before: Snapshot): Promise<string[]> {
  const { PrismaClient } = await import('../src/generated/prisma/client.js');
  const { createPgAdapter } = await import('../src/prisma/platform-prisma.service.js');
  const { dayTotals, sessionTotals } = await import('../src/reports/report-queries.js');
  const prisma = new PrismaClient({ adapter: createPgAdapter(databaseUrl) });
  const problems: string[] = [];
  try {
    // Days: the sum of the shifts of each (organization, unit, day) against the day report.
    const groups = new Map<
      string,
      { org: string; unit: string; day: string; totals: ComparedTotals }
    >();
    for (const shift of before.shifts) {
      const key = `${shift.organizationId}|${shift.unitId}|${shift.day}`;
      const group = groups.get(key) ?? {
        org: shift.organizationId,
        unit: shift.unitId,
        day: shift.day,
        totals: Object.fromEntries(KEYS.map((k) => [k, 0])) as unknown as ComparedTotals,
      };
      for (const k of KEYS) {
        group.totals[k] += shift[k];
      }
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      const day = Temporal.PlainDate.from(group.day);
      const rows = await dayTotals(prisma, group.org, { unitId: group.unit, from: day, to: day });
      const after = rows[0];
      for (const k of KEYS) {
        const a = after?.[k] ?? 0;
        if (a !== group.totals[k]) {
          problems.push(
            `dia ${group.day} unidade ${group.unit}: ${k} antes ${group.totals[k]}, depois ${a}`,
          );
        }
      }
    }
    // Sessions: same id, same money.
    const byOrg = new Map<string, RegisterSnapshot[]>();
    for (const register of before.registers) {
      byOrg.set(register.organizationId, [...(byOrg.get(register.organizationId) ?? []), register]);
    }
    for (const [org, registers] of byOrg) {
      const after = await sessionTotals(
        prisma,
        org,
        registers.map((register) => register.id),
      );
      for (const register of registers) {
        const row = after.get(register.id);
        if (!row) {
          problems.push(`abertura ${register.id}: não encontrada depois da migração`);
          continue;
        }
        for (const k of [
          'receivedSalesCents',
          'receivedSettlementsCents',
          'cashDifferenceCents',
        ] as const) {
          if (row[k] !== register[k]) {
            problems.push(`abertura ${register.id}: ${k} antes ${register[k]}, depois ${row[k]}`);
          }
        }
      }
    }
    const [global] = await prisma.$queryRawUnsafe<
      { payments: number; payments_cents: bigint; movements_cents: bigint; counts: number }[]
    >(GLOBAL_SQL('cash_register_session_id', 'cash_register_session_id'));
    const globalAfter = {
      payments: num(global?.payments),
      paymentsCents: num(global?.payments_cents),
      movementsCents: num(global?.movements_cents),
      counts: num(global?.counts),
    };
    for (const k of ['payments', 'paymentsCents', 'movementsCents', 'counts'] as const) {
      if (globalAfter[k] !== before.global[k]) {
        problems.push(`total geral ${k}: antes ${before.global[k]}, depois ${globalAfter[k]}`);
      }
    }
    console.log(
      `Conferidos ${before.shifts.length} turnos em ${groups.size} dias de operação e ` +
        `${before.registers.length} aberturas de caixa.`,
    );
  } finally {
    await prisma.$disconnect();
  }
  return problems;
}

if (import.meta.main) {
  const { loadEnvFiles } = await import('../src/config/load-env.js');
  loadEnvFiles();
  const [command, file, url] = process.argv.slice(2);
  const databaseUrl = url ?? process.env.DATABASE_URL;
  if ((command !== 'snapshot' && command !== 'compare') || !file || !databaseUrl) {
    console.error('Uso: verify-migration.ts snapshot|compare <arquivo.json> [DATABASE_URL]');
    process.exit(2);
  }
  if (command === 'snapshot') {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const result = await snapshot(client);
      writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
      console.log(
        `Snapshot: ${result.shifts.length} turnos e ${result.registers.length} caixas em ${file}.`,
      );
    } finally {
      await client.end();
    }
  } else {
    const before = JSON.parse(readFileSync(file, 'utf8')) as Snapshot;
    const problems = await compare(databaseUrl, before);
    if (problems.length > 0) {
      console.error(`${problems.length} diferença(s):\n${problems.join('\n')}`);
      process.exit(1);
    }
    console.log('Sem diferenças: os relatórios do dia e dos caixas batem com os dos turnos.');
  }
}
