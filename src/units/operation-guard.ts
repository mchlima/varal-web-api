import { Injectable } from '@nestjs/common';

import { requireOrganizationId } from '../context/request-context.js';
import type { TenantDb } from '../prisma/prisma.service.js';
import { setupError } from './setup-errors.js';

/** Tabs that are still being served (RN-04.07): they pass from one day to the next. */
export const OPEN_TAB_STATUSES = ['open', 'closing'] as const;

/**
 * What blocks the setup of a unit while it operates (spec 03, RN-03.02 and RN-03.07; CA-03.03):
 * an open cash register (spec 05), items still in preparation and tabs still open.
 */
@Injectable()
export class OperationGuard {
  async hasOpenCashRegister(db: TenantDb, unitId: string): Promise<boolean> {
    return (await db.cashRegisterSession.count({ where: { unitId, status: 'open' } })) > 0;
  }

  /**
   * Locks the unit row, the same lock opening a cash register takes (spec 05), so a register never
   * opens in the middle of a setup change. Raw SQL is not filtered by the tenant scope: the
   * organization is added by hand.
   */
  async lockUnit(db: TenantDb, unitId: string): Promise<void> {
    await db.$queryRaw`
      SELECT id FROM units WHERE id = ${unitId}::uuid AND organization_id = ${requireOrganizationId()}::uuid
      FOR UPDATE`;
  }

  /** `CASH_REGISTER_OPEN` (409) when a register of the unit is open. Locks the unit first. */
  async assertNoOpenCashRegister(db: TenantDb, unitId: string): Promise<void> {
    await this.lockUnit(db, unitId);
    if (await this.hasOpenCashRegister(db, unitId)) {
      throw setupError('CASH_REGISTER_OPEN');
    }
  }

  /**
   * RN-03.07 (CA-03.03): no open register and no item in a non-final stage of a tab that is still
   * open (`ITEMS_IN_PROGRESS`, with the count in `details.itemCount`).
   */
  async assertCanChangeFlow(db: TenantDb, unitId: string): Promise<void> {
    await this.assertNoOpenCashRegister(db, unitId);
    const itemCount = await db.orderItem.count({
      where: {
        unitId,
        canceledAt: null,
        stage: { isFinal: false },
        tab: { status: { in: [...OPEN_TAB_STATUSES] } },
      },
    });
    if (itemCount > 0) {
      throw setupError('ITEMS_IN_PROGRESS', { itemCount });
    }
  }

  /** RN-03.02: a unit is not deactivated with an open register nor with open tabs. */
  async assertCanDeactivate(db: TenantDb, unitId: string): Promise<void> {
    await this.assertNoOpenCashRegister(db, unitId);
    const tabCount = await db.tab.count({
      where: { unitId, status: { in: [...OPEN_TAB_STATUSES] } },
    });
    if (tabCount > 0) {
      throw setupError('UNIT_HAS_OPEN_TABS', { tabCount });
    }
  }
}
