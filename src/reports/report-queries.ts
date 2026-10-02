import { Prisma } from '../generated/prisma/client.js';
import type { TenantDb } from '../prisma/prisma.service.js';

/*
 * Aggregated SQL of the reports (spec 07, section 3), shared by the shift report and the history so
 * both always show the same numbers. Raw SQL is NOT filtered by the tenant extension: every table
 * below is filtered by `organization_id` by hand (spec 01, section 6).
 *
 * Values come from the copy of what was sold (RN-04.18, RN-07.05): `order_items.unit_price_cents`
 * plus `order_item_modifiers.price_delta_cents`, times the quantity; never from the menu.
 */

/** Totals of one shift (RN-07.01 to RN-07.04), in cents. */
export interface ShiftTotals {
  shiftId: string;
  tabCount: number;
  canceledTabCount: number;
  salesCents: number;
  discountsCents: number;
  onCreditCents: number;
  wasteCents: number;
  wasteQuantity: number;
  consumedQuantity: number;
  receivedSalesCents: number;
  receivedSettlementsCents: number;
  receivedCents: number;
  cashDifferenceCents: number;
}

export type PeriodTotals = Omit<
  ShiftTotals,
  'shiftId' | 'canceledTabCount' | 'consumedQuantity'
> & {
  shiftCount: number;
};

interface ShiftTotalsRow {
  shift_id: string;
  tab_count: number;
  canceled_tab_count: number;
  sales: bigint;
  discounts: bigint;
  on_credit: bigint;
  waste: bigint;
  waste_quantity: bigint;
  consumed_quantity: bigint;
  received_sales: bigint;
  received_settlements: bigint;
  cash_difference: bigint;
}

/**
 * One row per shift selected by `shifts` (a `SELECT id FROM shifts …` of the organization).
 *
 * - Sale (RN-07.01): total after discount of the tabs `paid`, `on_credit`, `settled`; the discount
 *   is an amount up to the subtotal or a percentage rounded down (RN-05.03).
 * - Received (RN-07.02): payments not reversed whose `shift_id` is the shift, sales and
 *   settlements apart.
 * - On credit (RN-07.03): for tabs put on credit (`on_credit` or `settled`), the total minus the
 *   payments made before (not settlements; those can no longer be reversed, spec 06).
 * - Waste (RN-07.04): canceled lines with `wasted`, of any tab of the shift.
 * - Cash difference (CA-07.04): `difference_cents` recorded when each register closed.
 */
function perShiftSql(organizationId: string, shifts: Prisma.Sql): Prisma.Sql {
  const org = organizationId;
  return Prisma.sql`
    WITH s AS (${shifts}),
    lines AS (
      SELECT oi.tab_id, oi.quantity, oi.canceled_at, oi.wasted,
             (oi.unit_price_cents + COALESCE(m.delta, 0))::bigint * oi.quantity AS value
      FROM order_items oi
      JOIN tabs t ON t.id = oi.tab_id AND t.organization_id = ${org}::uuid
      JOIN s ON s.id = t.shift_id
      LEFT JOIN LATERAL (
        SELECT SUM(om.price_delta_cents) AS delta FROM order_item_modifiers om
        WHERE om.organization_id = ${org}::uuid AND om.order_item_id = oi.id
      ) m ON true
      WHERE oi.organization_id = ${org}::uuid
    ),
    tab_lines AS (
      SELECT t.id, t.shift_id, t.status, t.discount_type, t.discount_value,
             COALESCE(SUM(l.value) FILTER (WHERE l.canceled_at IS NULL), 0)::bigint AS subtotal,
             COALESCE(SUM(l.quantity) FILTER (WHERE l.canceled_at IS NULL), 0)::bigint AS quantity,
             COALESCE(SUM(l.value) FILTER (WHERE l.canceled_at IS NOT NULL AND l.wasted), 0)::bigint AS waste,
             COALESCE(SUM(l.quantity) FILTER (WHERE l.canceled_at IS NOT NULL AND l.wasted), 0)::bigint AS waste_quantity
      FROM tabs t
      JOIN s ON s.id = t.shift_id
      LEFT JOIN lines l ON l.tab_id = t.id
      WHERE t.organization_id = ${org}::uuid
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
               WHERE p.organization_id = ${org}::uuid AND p.tab_id = tl.id
                 AND p.reversed_at IS NULL AND NOT p.is_credit_settlement
             ), 0)::bigint AS paid_before_credit
      FROM tab_lines tl
    ),
    by_shift AS (
      SELECT shift_id,
             COUNT(*) FILTER (WHERE status IN ('paid', 'on_credit', 'settled'))::int AS tab_count,
             COUNT(*) FILTER (WHERE status = 'canceled')::int AS canceled_tab_count,
             COALESCE(SUM(subtotal - discount) FILTER (WHERE status IN ('paid', 'on_credit', 'settled')), 0)::bigint AS sales,
             COALESCE(SUM(discount) FILTER (WHERE status IN ('paid', 'on_credit', 'settled')), 0)::bigint AS discounts,
             COALESCE(SUM(subtotal - discount - paid_before_credit) FILTER (WHERE status IN ('on_credit', 'settled')), 0)::bigint AS on_credit,
             COALESCE(SUM(waste), 0)::bigint AS waste,
             COALESCE(SUM(waste_quantity), 0)::bigint AS waste_quantity,
             COALESCE(SUM(quantity) FILTER (WHERE status IN ('paid', 'on_credit', 'settled')), 0)::bigint AS consumed_quantity
      FROM tab_totals GROUP BY shift_id
    ),
    received AS (
      SELECT p.shift_id,
             COALESCE(SUM(p.amount_cents) FILTER (WHERE NOT p.is_credit_settlement), 0)::bigint AS sales,
             COALESCE(SUM(p.amount_cents) FILTER (WHERE p.is_credit_settlement), 0)::bigint AS settlements
      FROM payments p
      JOIN s ON s.id = p.shift_id
      WHERE p.organization_id = ${org}::uuid AND p.reversed_at IS NULL
      GROUP BY p.shift_id
    ),
    cash AS (
      SELECT cr.shift_id, COALESCE(SUM(c.difference_cents), 0)::bigint AS difference
      FROM cash_registers cr
      JOIN s ON s.id = cr.shift_id
      JOIN cash_register_counts c ON c.cash_register_id = cr.id AND c.organization_id = ${org}::uuid
      WHERE cr.organization_id = ${org}::uuid
      GROUP BY cr.shift_id
    )
    SELECT s.id AS shift_id,
           COALESCE(b.tab_count, 0) AS tab_count,
           COALESCE(b.canceled_tab_count, 0) AS canceled_tab_count,
           COALESCE(b.sales, 0) AS sales,
           COALESCE(b.discounts, 0) AS discounts,
           COALESCE(b.on_credit, 0) AS on_credit,
           COALESCE(b.waste, 0) AS waste,
           COALESCE(b.waste_quantity, 0) AS waste_quantity,
           COALESCE(b.consumed_quantity, 0) AS consumed_quantity,
           COALESCE(r.sales, 0) AS received_sales,
           COALESCE(r.settlements, 0) AS received_settlements,
           COALESCE(c.difference, 0) AS cash_difference
    FROM s
    LEFT JOIN by_shift b ON b.shift_id = s.id
    LEFT JOIN received r ON r.shift_id = s.id
    LEFT JOIN cash c ON c.shift_id = s.id`;
}

function toTotals(row: ShiftTotalsRow): ShiftTotals {
  const receivedSalesCents = Number(row.received_sales);
  const receivedSettlementsCents = Number(row.received_settlements);
  return {
    shiftId: row.shift_id,
    tabCount: row.tab_count,
    canceledTabCount: row.canceled_tab_count,
    salesCents: Number(row.sales),
    discountsCents: Number(row.discounts),
    onCreditCents: Number(row.on_credit),
    wasteCents: Number(row.waste),
    wasteQuantity: Number(row.waste_quantity),
    consumedQuantity: Number(row.consumed_quantity),
    receivedSalesCents,
    receivedSettlementsCents,
    receivedCents: receivedSalesCents + receivedSettlementsCents,
    cashDifferenceCents: Number(row.cash_difference),
  };
}

/** Totals of the given shifts of the organization, in no particular order. */
export async function totalsOfShifts(
  db: TenantDb,
  organizationId: string,
  shiftIds: readonly string[],
): Promise<Map<string, ShiftTotals>> {
  if (shiftIds.length === 0) {
    return new Map();
  }
  const ids = shiftIds.map((id) => Prisma.sql`${id}::uuid`);
  const shifts = Prisma.sql`SELECT id FROM shifts WHERE organization_id = ${organizationId}::uuid AND id IN (${Prisma.join(ids)})`;
  const rows = await db.$queryRaw<ShiftTotalsRow[]>(perShiftSql(organizationId, shifts));
  return new Map(rows.map((row) => [row.shift_id, toTotals(row)]));
}

/** Filters of the history (spec 07, section 5): period by opening, unit and type. */
export interface ShiftFilter {
  unitId: string | null;
  type: 'direct_sale' | 'contracted' | null;
  start: Date;
  end: Date;
}

export function filteredShiftsSql(organizationId: string, filter: ShiftFilter): Prisma.Sql {
  return Prisma.sql`
    SELECT id FROM shifts
    WHERE organization_id = ${organizationId}::uuid
      AND opened_at >= ${filter.start} AND opened_at < ${filter.end}
      ${filter.unitId === null ? Prisma.empty : Prisma.sql`AND unit_id = ${filter.unitId}::uuid`}
      ${filter.type === null ? Prisma.empty : Prisma.sql`AND type = ${filter.type}::"shift_type"`}`;
}

/** Totals of the whole period, summed in the database (not only the page). */
export async function totalsOfPeriod(
  db: TenantDb,
  organizationId: string,
  filter: ShiftFilter,
): Promise<PeriodTotals> {
  const perShift = perShiftSql(organizationId, filteredShiftsSql(organizationId, filter));
  const [row] = await db.$queryRaw<
    {
      shift_count: number;
      tab_count: bigint;
      sales: bigint;
      discounts: bigint;
      on_credit: bigint;
      waste: bigint;
      waste_quantity: bigint;
      received_sales: bigint;
      received_settlements: bigint;
      cash_difference: bigint;
    }[]
  >(Prisma.sql`
    SELECT COUNT(*)::int AS shift_count,
           COALESCE(SUM(tab_count), 0)::bigint AS tab_count,
           COALESCE(SUM(sales), 0)::bigint AS sales,
           COALESCE(SUM(discounts), 0)::bigint AS discounts,
           COALESCE(SUM(on_credit), 0)::bigint AS on_credit,
           COALESCE(SUM(waste), 0)::bigint AS waste,
           COALESCE(SUM(waste_quantity), 0)::bigint AS waste_quantity,
           COALESCE(SUM(received_sales), 0)::bigint AS received_sales,
           COALESCE(SUM(received_settlements), 0)::bigint AS received_settlements,
           COALESCE(SUM(cash_difference), 0)::bigint AS cash_difference
    FROM (${perShift}) per_shift`);
  const receivedSalesCents = Number(row?.received_sales ?? 0);
  const receivedSettlementsCents = Number(row?.received_settlements ?? 0);
  return {
    shiftCount: row?.shift_count ?? 0,
    tabCount: Number(row?.tab_count ?? 0),
    salesCents: Number(row?.sales ?? 0),
    discountsCents: Number(row?.discounts ?? 0),
    onCreditCents: Number(row?.on_credit ?? 0),
    wasteCents: Number(row?.waste ?? 0),
    wasteQuantity: Number(row?.waste_quantity ?? 0),
    receivedSalesCents,
    receivedSettlementsCents,
    receivedCents: receivedSalesCents + receivedSettlementsCents,
    cashDifferenceCents: Number(row?.cash_difference ?? 0),
  };
}
