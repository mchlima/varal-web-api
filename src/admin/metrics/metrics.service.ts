import { Injectable } from '@nestjs/common';

import { startOfDayInSaoPaulo, TIME_ZONE, todayInSaoPaulo } from '../../common/time.js';
import { AppError } from '../../errors/app-error.js';
import { SubscriptionStatus } from '../../generated/prisma/enums.js';
import { PlatformPrismaService } from '../../prisma/platform-prisma.service.js';
import type { MetricsOverview, OrganizationUsage } from './metrics.schemas.js';

/** Default period of the metrics: the last 30 days (spec 02, section 6). */
export const DEFAULT_PERIOD_DAYS = 30;
const MAX_PERIOD_DAYS = 366;

export interface MetricsPeriod {
  from: Temporal.PlainDate;
  /** Inclusive. */
  to: Temporal.PlainDate;
  /** Instants of the period in São Paulo: `[start, end)`. */
  start: Date;
  end: Date;
}

/** Operational totals of one organization in a period (specs 04 to 06). */
interface OperationalTotals {
  /** Pairs (unit, day of operation) with a cash register opened in the period (spec 02, section 6). */
  operationDays: number;
  tabs: number;
  soldCents: number;
}

const NO_TOTALS: OperationalTotals = { operationDays: 0, tabs: 0, soldCents: 0 };

function totalsOf(map: Map<string, OperationalTotals>, organizationId: string): OperationalTotals {
  let totals = map.get(organizationId);
  if (!totals) {
    totals = { ...NO_TOTALS };
    map.set(organizationId, totals);
  }
  return totals;
}

/** `?from=&to=` in São Paulo days (default: the last 30 days, today included). */
export function resolvePeriod(
  input: { from?: string | undefined; to?: string | undefined },
  today = todayInSaoPaulo(),
): MetricsPeriod {
  const to = input.to === undefined ? today : Temporal.PlainDate.from(input.to);
  const from =
    input.from === undefined
      ? to.subtract({ days: DEFAULT_PERIOD_DAYS - 1 })
      : Temporal.PlainDate.from(input.from);
  const days = from.until(to, { largestUnit: 'days' }).days + 1;
  if (days < 1 || days > MAX_PERIOD_DAYS) {
    throw AppError.of('VALIDATION_FAILED', {
      details: {
        fields: [
          {
            path: 'from',
            message: `O período precisa ter de 1 a ${MAX_PERIOD_DAYS} dias, com o início antes do fim.`,
          },
        ],
      },
    });
  }
  return {
    from,
    to,
    start: startOfDayInSaoPaulo(from),
    end: startOfDayInSaoPaulo(to.add({ days: 1 })),
  };
}

/** Mondays of the weeks that touch the period (buckets of "dias de operação por semana"). */
export function weekStarts(period: MetricsPeriod): Temporal.PlainDate[] {
  const weeks: Temporal.PlainDate[] = [];
  let monday = period.from.subtract({ days: period.from.dayOfWeek - 1 });
  while (Temporal.PlainDate.compare(monday, period.to) <= 0) {
    weeks.push(monday);
    monday = monday.add({ weeks: 1 });
  }
  return weeks;
}

/**
 * Usage metrics (spec 02, section 6), computed from existing data only (no table of their own).
 *
 * Days of operation, tabs and sales come from specs 04 to 06 ({@link operationalTotals}): pairs
 * (unit, day of operation) with a cash register session in the period (they replace the shifts,
 * 2026-10-02), organizations with a register opened in it, tabs paid, on credit or settled in it (by
 * the day of operation they were closed, `closed_business_date`) and the sum of their totals.
 */
@Injectable()
export class MetricsService {
  constructor(private readonly platform: PlatformPrismaService) {}

  async overview(period: MetricsPeriod): Promise<MetricsOverview> {
    const [byStatus, totals, closedByWeek] = await Promise.all([
      this.platform.organization.groupBy({ by: ['subscriptionStatus'], _count: { _all: true } }),
      this.operationalTotals(period),
      this.operationDaysByWeek(period),
    ]);
    const organizationsByStatus = Object.fromEntries(
      Object.values(SubscriptionStatus).map((status) => [
        status,
        byStatus.find((row) => row.subscriptionStatus === status)?._count._all ?? 0,
      ]),
    ) as Record<SubscriptionStatus, number>;
    const all = [...totals.values()];
    const tabs = all.reduce((sum, item) => sum + item.tabs, 0);
    const soldCents = all.reduce((sum, item) => sum + item.soldCents, 0);
    return {
      period: this.periodOut(period),
      organizationsByStatus,
      // Organizations with at least one cash register opened in the period (spec 02, section 6).
      activeOrganizations: all.filter((item) => item.operationDays > 0).length,
      operationDays: {
        total: all.reduce((sum, item) => sum + item.operationDays, 0),
        // Days of operation per week (Monday of the day).
        byWeek: weekStarts(period).map((weekStart) => ({
          weekStart: weekStart.toString(),
          count: closedByWeek.get(weekStart.toString()) ?? 0,
        })),
      },
      tabs,
      soldCents,
      averageTicketCents: tabs === 0 ? 0 : Math.round(soldCents / tabs),
    };
  }

  async organizations(
    period: MetricsPeriod,
    sort: 'name' | 'operationDays' | 'tabs' | 'soldCents' | 'lastAccessAt',
    order: 'asc' | 'desc',
  ): Promise<{ period: ReturnType<MetricsService['periodOut']>; data: OrganizationUsage[] }> {
    const [organizations, totals, lastAccess] = await Promise.all([
      this.platform.organization.findMany({
        select: { id: true, name: true, subscriptionStatus: true },
      }),
      this.operationalTotals(period),
      // Last login or session renewal of anyone of the organization, not counting "entrar como".
      this.platform.session.groupBy({
        by: ['organizationId'],
        where: { organizationId: { not: null }, impersonationId: null },
        _max: { lastUsedAt: true },
      }),
    ]);
    const lastAccessBy = new Map(
      lastAccess.map((row) => [row.organizationId, row._max.lastUsedAt ?? null]),
    );
    const data: OrganizationUsage[] = organizations.map((organization) => {
      const item = totals.get(organization.id) ?? NO_TOTALS;
      return {
        organizationId: organization.id,
        name: organization.name,
        subscriptionStatus: organization.subscriptionStatus,
        operationDays: item.operationDays,
        tabs: item.tabs,
        soldCents: item.soldCents,
        lastAccessAt: lastAccessBy.get(organization.id)?.toISOString() ?? null,
      };
    });
    const direction = order === 'asc' ? 1 : -1;
    data.sort((a, b) => {
      const byKey = compareUsage(a, b, sort);
      return byKey === 0 ? a.name.localeCompare(b.name, 'pt-BR') : byKey * direction;
    });
    return { period: this.periodOut(period), data };
  }

  private periodOut(period: MetricsPeriod) {
    return {
      from: period.from.toString(),
      to: period.to.toString(),
      timeZone: TIME_ZONE as 'America/Sao_Paulo',
    };
  }

  /**
   * Per organization, in `[period.start, period.end)`. Raw SQL over every organization (platform
   * client, spec 02). The total of a tab is computed as in RN-04.14 and RN-05.03: lines not
   * canceled with their modifiers, minus the discount (an amount up to the subtotal, or a
   * percentage rounded down), never from the current menu prices.
   */
  private async operationalTotals(period: MetricsPeriod): Promise<Map<string, OperationalTotals>> {
    const from = period.from.toString();
    const to = period.to.toString();
    const [days, sold] = await Promise.all([
      this.platform.$queryRaw<{ organization_id: string; count: number }[]>`
        SELECT organization_id, COUNT(DISTINCT (unit_id, business_date))::int AS count
        FROM cash_register_sessions
        WHERE business_date BETWEEN ${from}::date AND ${to}::date
        GROUP BY organization_id`,
      this.platform.$queryRaw<{ organization_id: string; tabs: number; sold_cents: bigint }[]>`
        WITH totals AS (
          SELECT t.organization_id, t.discount_type, t.discount_value,
                 COALESCE(SUM((oi.unit_price_cents + COALESCE(m.delta, 0)) * oi.quantity)
                   FILTER (WHERE oi.canceled_at IS NULL), 0)::bigint AS subtotal
          FROM tabs t
          LEFT JOIN order_items oi ON oi.tab_id = t.id
          LEFT JOIN (
            SELECT order_item_id, SUM(price_delta_cents) AS delta
            FROM order_item_modifiers GROUP BY order_item_id
          ) m ON m.order_item_id = oi.id
          WHERE t.status IN ('paid', 'on_credit', 'settled')
            AND t.closed_business_date BETWEEN ${from}::date AND ${to}::date
          GROUP BY t.id
        )
        SELECT organization_id, COUNT(*)::int AS tabs,
               COALESCE(SUM(subtotal - LEAST(subtotal, CASE discount_type
                 WHEN 'amount' THEN discount_value::bigint
                 WHEN 'percent' THEN subtotal * discount_value / 100
                 ELSE 0 END)), 0)::bigint AS sold_cents
        FROM totals GROUP BY organization_id`,
    ]);
    const map = new Map<string, OperationalTotals>();
    for (const row of days) {
      totalsOf(map, row.organization_id).operationDays = row.count;
    }
    for (const row of sold) {
      const totals = totalsOf(map, row.organization_id);
      totals.tabs = row.tabs;
      totals.soldCents = Number(row.sold_cents);
    }
    return map;
  }

  /** Days of operation per week of the period, by the Monday of the day of operation. */
  private async operationDaysByWeek(period: MetricsPeriod): Promise<Map<string, number>> {
    const rows = await this.platform.$queryRaw<{ week_start: string; count: number }[]>`
      SELECT to_char(date_trunc('week', business_date), 'YYYY-MM-DD') AS week_start,
             COUNT(DISTINCT (unit_id, business_date))::int AS count
      FROM cash_register_sessions
      WHERE business_date BETWEEN ${period.from.toString()}::date AND ${period.to.toString()}::date
      GROUP BY 1`;
    return new Map(rows.map((row) => [row.week_start, row.count]));
  }
}

function compareUsage(
  a: OrganizationUsage,
  b: OrganizationUsage,
  sort: 'name' | 'operationDays' | 'tabs' | 'soldCents' | 'lastAccessAt',
): number {
  switch (sort) {
    case 'name':
      return a.name.localeCompare(b.name, 'pt-BR');
    case 'lastAccessAt':
      // Never accessed sorts as the oldest.
      return (a.lastAccessAt ?? '').localeCompare(b.lastAccessAt ?? '');
    default:
      return a[sort] - b[sort];
  }
}
