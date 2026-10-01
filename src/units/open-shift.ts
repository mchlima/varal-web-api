import { Injectable } from '@nestjs/common';

import type { TenantDb } from '../prisma/prisma.service.js';
import { setupError } from './setup-errors.js';

/**
 * Whether a unit has an open shift (RN-03.02, RN-03.07; CA-03.03). Shifts arrive with spec 04:
 * until then no unit has one, and this default answers `false`. Spec 04 replaces the provider
 * (`{ provide: OpenShiftChecker, useClass: ShiftsOpenShiftChecker }` in `UnitsModule`) with a query
 * on `shifts` (`status = 'open'`), run in the transaction of the change.
 */
@Injectable()
export class OpenShiftChecker {
  hasOpenShift(_db: TenantDb, _unitId: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  /** Throws `SHIFT_OPEN` (409) when the unit has an open shift. */
  async assertNoOpenShift(db: TenantDb, unitId: string): Promise<void> {
    if (await this.hasOpenShift(db, unitId)) {
      throw setupError('SHIFT_OPEN');
    }
  }
}
