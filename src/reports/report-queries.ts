import { Prisma } from '../generated/prisma/client.js';
import type { TenantDb } from '../prisma/prisma.service.js';

/*
 * Aggregated SQL of the reports (spec 07, section 3), shared by the day/period report, the cash
 * register session report, the event report and the histories, so they always show the same
 * numbers (and by scripts/verify-migration.ts). Raw SQL is NOT filtered by the tenant extension:
 * every table below is filtered by `organization_id` by hand (spec 01, section 6).
 *
 * Values come from the copy of what was sold (RN-04.18, RN-07.05): `order_items.unit_price_cents`
 * plus `order_item_modifiers.price_delta_cents`, times the quantity; never from the menu.
 */

/** Totals of a group (a day of a unit, a session or an event), in cents. */
export interface ReportTotals {
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

export interface DayTotals extends ReportTotals {
  unitId: string;
  /** Day of operation, `AAAA-MM-DD`. */
  businessDate: string;
}

/** What runs raw SQL: the tenant client, or a plain client in scripts. */
export type RawDb = Pick<TenantDb, '$queryRaw'>;

export const EMPTY_TOTALS: ReportTotals = {
  tabCount: 0,
  canceledTabCount: 0,
  salesCents: 0,
  discountsCents: 0,
  onCreditCents: 0,
  wasteCents: 0,
  wasteQuantity: 0,
  consumedQuantity: 0,
  receivedSalesCents: 0,
  receivedSettlementsCents: 0,
  receivedCents: 0,
  cashDifferenceCents: 0,
};

/**
 * What a report counts, as four selections of `(id, grp)` rows of the organization: the tabs that
 * may count as a sale (RN-07.01, RN-07.03), the canceled items that may be waste (RN-07.04), the
 * payments received (RN-07.02) and the sessions whose differences count (RN-07.08). `grp` is the
 * group of the row (text).
 */
interface Scope {
  tabs: Prisma.Sql;
  waste: Prisma.Sql;
  payments: Prisma.Sql;
  sessions: Prisma.Sql;
}

const NONE = Prisma.sql`SELECT NULL::uuid AS id, NULL::text AS grp WHERE false`;

interface TotalsRow {
  grp: string;
  tab_count: number;
  canceled_tab_count: number;
  sales: bigint;
  discounts: bigint;
  on_credit: bigint;
  consumed_quantity: bigint;
  waste: bigint;
  waste_quantity: bigint;
  received_sales: bigint;
  received_settlements: bigint;
  cash_difference: bigint;
}

/**
 * - Sale (RN-07.01): total after discount of the tabs `paid`, `on_credit`, `settled` of the scope;
 *   the discount is an amount up to the subtotal or a percentage rounded down (RN-05.03).
 * - On credit (RN-07.03): for tabs put on credit (`on_credit` or `settled`), the total minus the
 *   payments made before (not settlements; those can no longer be reversed, spec 06).
 * - Waste (RN-07.04): canceled lines marked `wasted`.
 * - Received (RN-07.02): payments not reversed, sales and settlements apart.
 * - Cash difference (RN-07.08): `difference_cents` recorded when each session closed.
 */
function totalsSql(org: string, scope: Scope): Prisma.Sql {
  return Prisma.sql`
    WITH tab_scope AS (${scope.tabs}),
    lines AS (
      SELECT oi.tab_id, oi.quantity, oi.canceled_at,
             (oi.unit_price_cents + COALESCE(m.delta, 0))::bigint * oi.quantity AS value
      FROM order_items oi
      JOIN tab_scope ts ON ts.id = oi.tab_id
      LEFT JOIN LATERAL (
        SELECT SUM(om.price_delta_cents) AS delta FROM order_item_modifiers om
        WHERE om.organization_id = ${org}::uuid AND om.order_item_id = oi.id
      ) m ON true
      WHERE oi.organization_id = ${org}::uuid
    ),
    tab_lines AS (
      SELECT t.id, ts.grp, t.status, t.discount_type, t.discount_value,
             COALESCE(SUM(l.value) FILTER (WHERE l.canceled_at IS NULL), 0)::bigint AS subtotal,
             COALESCE(SUM(l.quantity) FILTER (WHERE l.canceled_at IS NULL), 0)::bigint AS quantity
      FROM tabs t
      JOIN tab_scope ts ON ts.id = t.id
      LEFT JOIN lines l ON l.tab_id = t.id
      WHERE t.organization_id = ${org}::uuid
      GROUP BY t.id, ts.grp
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
    by_tabs AS (
      SELECT grp,
             COUNT(*) FILTER (WHERE status IN ('paid', 'on_credit', 'settled'))::int AS tab_count,
             COUNT(*) FILTER (WHERE status = 'canceled')::int AS canceled_tab_count,
             COALESCE(SUM(subtotal - discount) FILTER (WHERE status IN ('paid', 'on_credit', 'settled')), 0)::bigint AS sales,
             COALESCE(SUM(discount) FILTER (WHERE status IN ('paid', 'on_credit', 'settled')), 0)::bigint AS discounts,
             COALESCE(SUM(subtotal - discount - paid_before_credit) FILTER (WHERE status IN ('on_credit', 'settled')), 0)::bigint AS on_credit,
             COALESCE(SUM(quantity) FILTER (WHERE status IN ('paid', 'on_credit', 'settled')), 0)::bigint AS consumed_quantity
      FROM tab_totals GROUP BY grp
    ),
    waste AS (
      SELECT ws.grp,
             COALESCE(SUM((oi.unit_price_cents + COALESCE(m.delta, 0))::bigint * oi.quantity), 0)::bigint AS value,
             COALESCE(SUM(oi.quantity), 0)::bigint AS quantity
      FROM (${scope.waste}) ws
      JOIN order_items oi ON oi.id = ws.id AND oi.organization_id = ${org}::uuid
      LEFT JOIN LATERAL (
        SELECT SUM(om.price_delta_cents) AS delta FROM order_item_modifiers om
        WHERE om.organization_id = ${org}::uuid AND om.order_item_id = oi.id
      ) m ON true
      WHERE oi.canceled_at IS NOT NULL AND oi.wasted
      GROUP BY ws.grp
    ),
    received AS (
      SELECT ps.grp,
             COALESCE(SUM(p.amount_cents) FILTER (WHERE NOT p.is_credit_settlement), 0)::bigint AS sales,
             COALESCE(SUM(p.amount_cents) FILTER (WHERE p.is_credit_settlement), 0)::bigint AS settlements
      FROM (${scope.payments}) ps
      JOIN payments p ON p.id = ps.id AND p.organization_id = ${org}::uuid
      WHERE p.reversed_at IS NULL
      GROUP BY ps.grp
    ),
    session_scope AS (${scope.sessions}),
    cash AS (
      SELECT ss.grp, COALESCE(SUM(c.difference_cents), 0)::bigint AS difference
      FROM session_scope ss
      JOIN cash_register_counts c ON c.cash_register_session_id = ss.id AND c.organization_id = ${org}::uuid
      GROUP BY ss.grp
    ),
    groups AS (
      SELECT grp FROM by_tabs
      UNION SELECT grp FROM waste
      UNION SELECT grp FROM received
      UNION SELECT grp FROM session_scope
    )
    SELECT g.grp,
           COALESCE(b.tab_count, 0) AS tab_count,
           COALESCE(b.canceled_tab_count, 0) AS canceled_tab_count,
           COALESCE(b.sales, 0) AS sales,
           COALESCE(b.discounts, 0) AS discounts,
           COALESCE(b.on_credit, 0) AS on_credit,
           COALESCE(b.consumed_quantity, 0) AS consumed_quantity,
           COALESCE(w.value, 0) AS waste,
           COALESCE(w.quantity, 0) AS waste_quantity,
           COALESCE(r.sales, 0) AS received_sales,
           COALESCE(r.settlements, 0) AS received_settlements,
           COALESCE(c.difference, 0) AS cash_difference
    FROM groups g
    LEFT JOIN by_tabs b ON b.grp = g.grp
    LEFT JOIN waste w ON w.grp = g.grp
    LEFT JOIN received r ON r.grp = g.grp
    LEFT JOIN cash c ON c.grp = g.grp
    WHERE g.grp IS NOT NULL`;
}

function toTotals(row: TotalsRow): ReportTotals {
  const receivedSalesCents = Number(row.received_sales);
  const receivedSettlementsCents = Number(row.received_settlements);
  return {
    tabCount: row.tab_count,
    canceledTabCount: row.canceled_tab_count,
    salesCents: Number(row.sales),
    discountsCents: Number(row.discounts),
    onCreditCents: Number(row.on_credit),
    consumedQuantity: Number(row.consumed_quantity),
    wasteCents: Number(row.waste),
    wasteQuantity: Number(row.waste_quantity),
    receivedSalesCents,
    receivedSettlementsCents,
    receivedCents: receivedSalesCents + receivedSettlementsCents,
    cashDifferenceCents: Number(row.cash_difference),
  };
}

async function aggregate(db: RawDb, org: string, scope: Scope): Promise<Map<string, ReportTotals>> {
  const rows = await db.$queryRaw<TotalsRow[]>(totalsSql(org, scope));
  return new Map(rows.map((row) => [row.grp, toTotals(row)]));
}

export function sumTotals(rows: readonly ReportTotals[]): ReportTotals {
  const total = { ...EMPTY_TOTALS };
  for (const row of rows) {
    for (const key of Object.keys(total) as (keyof ReportTotals)[]) {
      total[key] += row[key];
    }
  }
  return total;
}

/** Days of operation of a period (`from`/`to` inclusive), of one unit or all of them. */
export interface DayFilter {
  unitId: string | null;
  from: Temporal.PlainDate;
  to: Temporal.PlainDate;
}

/**
 * Totals per unit and day of operation (spec 07, section 4; RN-07.01 to RN-07.04, RN-07.08): tabs
 * by the day they were closed (`closed_business_date`), waste by the day of the cancellation,
 * received and differences by the day of the session. One row per day with any of them or with a
 * session, newest first.
 */
export async function dayTotals(db: RawDb, org: string, filter: DayFilter): Promise<DayTotals[]> {
  const from = filter.from.toString();
  const to = filter.to.toString();
  const unit = (column: string) =>
    filter.unitId === null
      ? Prisma.empty
      : Prisma.sql`AND ${Prisma.raw(column)} = ${filter.unitId}::uuid`;
  const scope: Scope = {
    tabs: Prisma.sql`
      SELECT id, unit_id::text || '|' || closed_business_date::text AS grp FROM tabs
      WHERE organization_id = ${org}::uuid
        AND closed_business_date BETWEEN ${from}::date AND ${to}::date ${unit('unit_id')}`,
    waste: Prisma.sql`
      SELECT id, unit_id::text || '|' || canceled_business_date::text AS grp FROM order_items
      WHERE organization_id = ${org}::uuid AND wasted
        AND canceled_business_date BETWEEN ${from}::date AND ${to}::date ${unit('unit_id')}`,
    payments: Prisma.sql`
      SELECT p.id, s.unit_id::text || '|' || s.business_date::text AS grp
      FROM payments p
      JOIN cash_register_sessions s ON s.id = p.cash_register_session_id AND s.organization_id = ${org}::uuid
      WHERE p.organization_id = ${org}::uuid
        AND s.business_date BETWEEN ${from}::date AND ${to}::date ${unit('s.unit_id')}`,
    sessions: Prisma.sql`
      SELECT id, unit_id::text || '|' || business_date::text AS grp FROM cash_register_sessions
      WHERE organization_id = ${org}::uuid
        AND business_date BETWEEN ${from}::date AND ${to}::date ${unit('unit_id')}`,
  };
  const totals = await aggregate(db, org, scope);
  return [...totals.entries()]
    .map(([grp, row]) => {
      const [unitId = '', businessDate = ''] = grp.split('|');
      return { unitId, businessDate, ...row };
    })
    .sort(
      (a, b) => b.businessDate.localeCompare(a.businessDate) || a.unitId.localeCompare(b.unitId),
    );
}

/**
 * Totals of cash register sessions (spec 07, section 5; RN-07.09): only the money that passed
 * through each session (received and difference); no sale.
 */
export async function sessionTotals(
  db: RawDb,
  org: string,
  sessionIds: readonly string[],
): Promise<Map<string, ReportTotals>> {
  if (sessionIds.length === 0) {
    return new Map();
  }
  const ids = Prisma.join(sessionIds.map((id) => Prisma.sql`${id}::uuid`));
  const totals = await aggregate(db, org, {
    tabs: NONE,
    waste: NONE,
    payments: Prisma.sql`
      SELECT id, cash_register_session_id::text AS grp FROM payments
      WHERE organization_id = ${org}::uuid AND cash_register_session_id IN (${ids})`,
    sessions: Prisma.sql`
      SELECT id, id::text AS grp FROM cash_register_sessions
      WHERE organization_id = ${org}::uuid AND id IN (${ids})`,
  });
  return new Map(sessionIds.map((id) => [id, totals.get(id) ?? { ...EMPTY_TOTALS }]));
}

/**
 * Totals of contracted events (spec 07, section 6; RN-07.10): the tabs tied to each event, of any
 * day, the payments of those tabs in any session and their waste.
 */
export async function eventTotals(
  db: RawDb,
  org: string,
  eventIds: readonly string[],
): Promise<Map<string, ReportTotals>> {
  if (eventIds.length === 0) {
    return new Map();
  }
  const ids = Prisma.join(eventIds.map((id) => Prisma.sql`${id}::uuid`));
  const totals = await aggregate(db, org, {
    tabs: Prisma.sql`
      SELECT id, event_id::text AS grp FROM tabs
      WHERE organization_id = ${org}::uuid AND event_id IN (${ids})`,
    waste: Prisma.sql`
      SELECT oi.id, t.event_id::text AS grp FROM order_items oi
      JOIN tabs t ON t.id = oi.tab_id AND t.organization_id = ${org}::uuid
      WHERE oi.organization_id = ${org}::uuid AND t.event_id IN (${ids})`,
    payments: Prisma.sql`
      SELECT p.id, t.event_id::text AS grp FROM payments p
      JOIN tabs t ON t.id = p.tab_id AND t.organization_id = ${org}::uuid
      WHERE p.organization_id = ${org}::uuid AND t.event_id IN (${ids})`,
    sessions: NONE,
  });
  return new Map(eventIds.map((id) => [id, totals.get(id) ?? { ...EMPTY_TOTALS }]));
}
