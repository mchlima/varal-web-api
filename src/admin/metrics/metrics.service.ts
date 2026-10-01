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

/** Operational totals of one organization in a period (shifts and tabs, specs 04 to 06). */
interface OperationalTotals {
  shifts: number;
  tabs: number;
  soldCents: number;
}

const NO_TOTALS: OperationalTotals = { shifts: 0, tabs: 0, soldCents: 0 };

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

/** Mondays of the weeks that touch the period (buckets of "turnos por semana"). */
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
 * Shifts, tabs and sales come from specs 04 to 06, which do not exist yet: {@link operationalTotals}
 * is the single place to fill then (shifts closed in the period, tabs paid, on credit or settled in
 * the period and the sum of their totals, per organization, filtering `closed_at`/`paid_at` in
 * `[start, end)`). Until then those numbers are zero.
 */
@Injectable()
export class MetricsService {
  constructor(private readonly platform: PlatformPrismaService) {}

  async overview(period: MetricsPeriod): Promise<MetricsOverview> {
    const [byStatus, totals] = await Promise.all([
      this.platform.organization.groupBy({ by: ['subscriptionStatus'], _count: { _all: true } }),
      this.operationalTotals(period),
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
      // Organizations with at least one shift opened in the period (spec 04).
      activeOrganizations: all.filter((item) => item.shifts > 0).length,
      shifts: {
        total: all.reduce((sum, item) => sum + item.shifts, 0),
        // Shifts closed per week (spec 04); zero until shifts exist.
        byWeek: weekStarts(period).map((weekStart) => ({
          weekStart: weekStart.toString(),
          count: 0,
        })),
      },
      tabs,
      soldCents,
      averageTicketCents: tabs === 0 ? 0 : Math.round(soldCents / tabs),
    };
  }

  async organizations(
    period: MetricsPeriod,
    sort: 'name' | 'shifts' | 'tabs' | 'soldCents' | 'lastAccessAt',
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
        shifts: item.shifts,
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

  /** Spec 04 to 06 fill this: per organization, in `[period.start, period.end)`. */
  private operationalTotals(_period: MetricsPeriod): Promise<Map<string, OperationalTotals>> {
    return Promise.resolve(new Map<string, OperationalTotals>());
  }
}

function compareUsage(
  a: OrganizationUsage,
  b: OrganizationUsage,
  sort: 'name' | 'shifts' | 'tabs' | 'soldCents' | 'lastAccessAt',
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
