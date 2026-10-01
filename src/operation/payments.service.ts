import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { requireOrganizationId } from '../context/request-context.js';
import { AppError } from '../errors/app-error.js';
import type { CashRegister, Tab } from '../generated/prisma/client.js';
import type { DiscountType, PaymentMethod } from '../generated/prisma/enums.js';
import { PrismaService, type TenantDb } from '../prisma/prisma.service.js';
import { CashRegistersService } from './cash-registers.service.js';
import type { CreatePaymentRequest, PayFirstRequest, PaymentResultDto } from './cash.schemas.js';
import { assertCounter, OperationAccessService } from './operation-access.js';
import { operationError } from './operation-errors.js';
import { OperationEvents, TabCreated, TabUpdated } from './operation-events.js';
import { loadTab, loadTabSummary, paymentInclude, toPaymentDto } from './operation-reader.js';
import type { TabDto, TabSummaryDto } from './operation.schemas.js';
import { applyPayment, type AppliedPayment, type PaymentRefusal } from './payment-rules.js';
import { lockRow } from './row-lock.js';
import {
  activePaymentIds,
  assertShiftOpen,
  CLOSED_STATUSES,
  requireShift,
  requireTab,
  TabsService,
} from './tabs.service.js';

interface PaymentInput {
  method: PaymentMethod;
  amountCents?: number | undefined;
  tenderedCents?: number | undefined;
}

/** RN-05.08 to RN-05.11: a refused payment as the error the app shows. */
function refusalError(refusal: PaymentRefusal, balanceCents: number, index?: number): AppError {
  const details = { balanceCents, ...(index === undefined ? {} : { index }) };
  switch (refusal) {
    case 'nothing_to_pay':
      return operationError('TAB_NOTHING_TO_PAY', details);
    case 'exceeds_balance':
      return operationError('PAYMENT_EXCEEDS_BALANCE', details);
    case 'missing_amount':
      return AppError.of('VALIDATION_FAILED');
  }
}

/**
 * RN-05.10 (and RN-04.12 `closing` → `paid`): a tab in `closing` whose payments cover the total
 * becomes `paid` and leaves the varal. Also after a discount or a canceled item lowered the total
 * to what was already paid. Returns true when the tab became paid.
 */
export async function settleIfCovered(
  db: TenantDb,
  audit: AuditService,
  tabId: string,
): Promise<boolean> {
  const summary = await loadTabSummary(db, tabId);
  if (summary.status !== 'closing' || summary.paidCents === 0 || summary.balanceCents !== 0) {
    return false;
  }
  await db.tab.update({
    where: { id: tabId },
    data: { status: 'paid', closedAt: new Date(), version: { increment: 1 } },
  });
  await audit.record(db, {
    action: 'tab.paid',
    entityType: 'tab',
    entityId: tabId,
    before: { status: 'closing' },
    after: { status: 'paid' },
    metadata: { unitId: summary.unitId, totalCents: summary.totalCents },
  });
  return true;
}

/**
 * Discounts, payments, reversals and "paga antes" (spec 05, sections 3 and 4). Operated from the
 * counter (RN-05.02, RN-05.05). Every change locks the tab first, so two devices paying the same
 * tab at once run one after the other and the second sees the new balance: the sum of the payments
 * never goes past the total (RN-05.08). `version` is optional (`TAB_CHANGED`).
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: OperationAccessService,
    private readonly events: OperationEvents,
    private readonly registers: CashRegistersService,
    private readonly tabs: TabsService,
  ) {}

  /** RN-05.01 to RN-05.03 (CA-05.04): applies or replaces the discount of an open/closing tab. */
  async setDiscount(
    tabId: string,
    input: { type: DiscountType; value: number; reason: string; version?: number | undefined },
  ): Promise<TabDto> {
    return this.changeDiscount(tabId, input.version, {
      discount: { type: input.type, value: input.value, reason: input.reason },
      action: 'tab.discount_applied',
    });
  }

  /** RN-05.01: removing is registered too, with a reason. */
  async removeDiscount(
    tabId: string,
    input: { reason: string; version?: number | undefined },
  ): Promise<TabDto> {
    return this.changeDiscount(tabId, input.version, {
      discount: null,
      reason: input.reason,
      action: 'tab.discount_removed',
    });
  }

  /**
   * `POST /tabs/{id}/payments` (RN-05.04 to RN-05.10; CA-05.01 to CA-05.03, CA-05.08): only in
   * `closing`; pix and cards up to the balance, cash with change; into an open register of the
   * shift; the tab becomes `paid` when the balance reaches zero.
   */
  async pay(tabId: string, input: CreatePaymentRequest): Promise<PaymentResultDto> {
    return this.prisma.transaction(async (db) => {
      const tab = await this.lockTab(db, tabId, input.version);
      if (tab.status === 'paid') {
        throw operationError('TAB_NOTHING_TO_PAY', { balanceCents: 0 });
      }
      if (CLOSED_STATUSES.includes(tab.status)) {
        throw operationError('TAB_CLOSED');
      }
      if (tab.status !== 'closing') {
        // RN-05.07: an open tab is paid after "pedir a conta".
        throw operationError('TAB_NOT_CLOSING');
      }
      const summary = await loadTabSummary(db, tabId);
      const applied = applyPayment(input, summary.balanceCents);
      if (typeof applied === 'string') {
        throw refusalError(applied, summary.balanceCents);
      }
      const register = await this.registers.forPayment(db, tab.shiftId, input.cashRegisterId);
      const access = await this.access.forUnit(db, tab.unitId);
      const paymentId = await this.record(db, tab, register, input.method, applied, access.actor);
      await db.tab.update({ where: { id: tabId }, data: { version: { increment: 1 } } });
      await settleIfCovered(db, this.audit, tabId);
      await this.registers.touched(db, register.id);
      return this.result(db, tabId, paymentId);
    });
  }

  /**
   * RN-05.13 to RN-05.15 (CA-05.05): reverses a payment with a reason while its shift and its
   * register are open. The payment stays, marked; a `paid` tab goes back to `closing`.
   */
  async reverse(paymentId: string, reason: string): Promise<PaymentResultDto> {
    return this.prisma.transaction(async (db) => {
      const found = await db.payment.findUnique({ where: { id: paymentId } });
      if (!found) {
        throw AppError.of('NOT_FOUND');
      }
      const tab = await this.lockTab(db, found.tabId, undefined);
      const payment = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
      if (payment.reversedAt !== null) {
        throw operationError('PAYMENT_ALREADY_REVERSED');
      }
      await assertShiftOpen(db, payment.shiftId);
      if (tab.status !== 'paid' && tab.status !== 'closing' && tab.status !== 'open') {
        // On credit and settled tabs belong to spec 06.
        throw operationError('TAB_CLOSED');
      }
      await lockRow(db, 'cash_registers', payment.cashRegisterId);
      const register = await db.cashRegister.findUniqueOrThrow({
        where: { id: payment.cashRegisterId },
      });
      if (register.status !== 'open') {
        throw operationError('CASH_REGISTER_CLOSED');
      }
      const access = await this.access.forUnit(db, tab.unitId);
      const now = new Date();
      await db.payment.update({
        where: { id: paymentId },
        data: {
          reversedAt: now,
          reversedByType: access.actor.type,
          reversedById: access.actor.id,
          reversalReason: reason,
        },
      });
      // RN-05.14: a paid tab goes back to `closing` with the balance of the reversed payment.
      const statusAfter = tab.status === 'paid' ? 'closing' : tab.status;
      await db.tab.update({
        where: { id: tab.id },
        data: {
          version: { increment: 1 },
          ...(tab.status === 'paid' ? { status: 'closing', closedAt: null } : {}),
        },
      });
      await this.audit.record(db, {
        action: 'payment.reversed',
        entityType: 'payment',
        entityId: paymentId,
        before: { reversedAt: null },
        after: { reversedAt: now.toISOString(), reversalReason: reason },
        metadata: {
          tabId: tab.id,
          unitId: tab.unitId,
          cashRegisterId: register.id,
          method: payment.method,
          amountCents: payment.amountCents,
          tabStatusBefore: tab.status,
          tabStatusAfter: statusAfter,
        },
      });
      await this.registers.touched(db, register.id);
      return this.result(db, tab.id, paymentId);
    });
  }

  /**
   * `POST /shifts/{id}/tabs/pay-first` (RN-04.11, RN-05.12; CA-04.10, CA-05.09): tab, order and
   * payments in one transaction. The tab is born `paid`; when the payments do not cover the total
   * nothing is written. Events (`tab.created`, `order.created`) leave only after the commit, so no
   * item reaches a station before its payment is registered.
   */
  async payFirst(shiftId: string, input: PayFirstRequest): Promise<TabDto> {
    return this.prisma.transaction(async (db) => {
      const shift = await requireShift(db, shiftId);
      const access = await this.access.forUnit(db, shift.unitId);
      assertCounter(access);
      const [numbered] = await db.shift.updateManyAndReturn({
        where: { id: shiftId, status: 'open' },
        data: { nextTabNumber: { increment: 1 } },
      });
      if (!numbered) {
        throw operationError('SHIFT_CLOSED');
      }
      const now = new Date();
      const tab = await db.tab.create({
        data: {
          organizationId: requireOrganizationId(),
          shiftId,
          unitId: shift.unitId,
          number: numbered.nextTabNumber - 1,
          customerName: input.customerName,
          mode: 'pay_first',
          status: 'paid',
          openedByType: access.actor.type,
          openedById: access.actor.id,
          closedAt: now,
        },
      });
      await this.audit.record(db, {
        action: 'tab.opened',
        entityType: 'tab',
        entityId: tab.id,
        after: { number: tab.number, customerName: tab.customerName, mode: tab.mode },
        metadata: { shiftId, unitId: shift.unitId },
      });
      const order = await this.tabs.insertOrder(db, tab, access, input.items, now);
      const { totalCents } = await loadTabSummary(db, tab.id, now);

      let balance = totalCents;
      const applied: { input: PaymentInput; value: AppliedPayment }[] = [];
      for (const [index, payment] of input.payments.entries()) {
        const value = applyPayment(payment, balance);
        if (typeof value === 'string') {
          throw refusalError(value, balance, index);
        }
        applied.push({ input: payment, value });
        balance -= value.amountCents;
      }
      if (balance > 0) {
        // CA-05.09: nothing is written (the transaction rolls back).
        throw operationError('PAYMENT_INSUFFICIENT', {
          totalCents,
          paidCents: totalCents - balance,
        });
      }
      if (applied.length > 0) {
        const register = await this.registers.forPayment(db, shiftId, input.cashRegisterId);
        for (const payment of applied) {
          await this.record(db, tab, register, payment.input.method, payment.value, access.actor);
        }
        await this.registers.touched(db, register.id);
      }
      await this.audit.record(db, {
        action: 'tab.paid',
        entityType: 'tab',
        entityId: tab.id,
        after: { status: 'paid' },
        metadata: { unitId: shift.unitId, totalCents, mode: 'pay_first' },
      });
      const dto = await loadTab(db, tab.id, now);
      this.events.tab(TabCreated, dto);
      // CA-04.10: sent to the stations only now, with the payment written in this transaction.
      this.events.orderCreated(order);
      return dto;
    });
  }

  private async changeDiscount(
    tabId: string,
    version: number | undefined,
    change: {
      discount: { type: DiscountType; value: number; reason: string } | null;
      reason?: string;
      action: string;
    },
  ): Promise<TabDto> {
    return this.prisma.transaction(async (db) => {
      const tab = await this.lockTab(db, tabId, version);
      if (tab.status === 'paid') {
        throw operationError('TAB_PAID', { paymentIds: await activePaymentIds(db, tabId) });
      }
      if (CLOSED_STATUSES.includes(tab.status)) {
        throw operationError('TAB_CLOSED');
      }
      const before = await loadTabSummary(db, tabId);
      const discount = change.discount;
      await db.tab.update({
        where: { id: tabId },
        data: {
          discountType: discount?.type ?? null,
          discountValue: discount?.value ?? null,
          discountReason: discount?.reason ?? null,
          version: { increment: 1 },
        },
      });
      const after = await loadTabSummary(db, tabId);
      if (after.balanceCents < 0) {
        // RN-05.07: the payments already registered never go past the total.
        throw operationError('TAB_PAYMENTS_EXCEED_TOTAL', {
          paidCents: after.paidCents,
          totalCents: after.totalCents,
        });
      }
      await this.audit.record(db, {
        action: change.action,
        entityType: 'tab',
        entityId: tabId,
        before: discountOf(before),
        after: discountOf(after),
        metadata: {
          unitId: tab.unitId,
          ...(change.reason === undefined ? {} : { reason: change.reason }),
        },
      });
      await settleIfCovered(db, this.audit, tabId);
      const dto = await loadTab(db, tabId);
      this.events.tab(TabUpdated, dto);
      return dto;
    });
  }

  /** The tab locked (lock order: tab, then cash register), in an open shift, at the counter. */
  private async lockTab(db: TenantDb, tabId: string, version: number | undefined): Promise<Tab> {
    const found = await requireTab(db, tabId);
    assertCounter(await this.access.forUnit(db, found.unitId));
    await lockRow(db, 'tabs', tabId);
    const tab = await requireTab(db, tabId);
    await assertShiftOpen(db, tab.shiftId);
    if (version !== undefined && version !== tab.version) {
      throw operationError('TAB_CHANGED', { currentVersion: tab.version });
    }
    return tab;
  }

  private async record(
    db: TenantDb,
    tab: Tab,
    register: CashRegister,
    method: PaymentMethod,
    applied: AppliedPayment,
    actor: { type: 'owner' | 'staff'; id: string },
  ): Promise<string> {
    const payment = await db.payment.create({
      data: {
        organizationId: requireOrganizationId(),
        tabId: tab.id,
        shiftId: register.shiftId,
        cashRegisterId: register.id,
        method,
        amountCents: applied.amountCents,
        tenderedCents: applied.tenderedCents,
        changeCents: applied.changeCents,
        receivedByType: actor.type,
        receivedById: actor.id,
      },
    });
    await this.audit.record(db, {
      action: 'payment.received',
      entityType: 'payment',
      entityId: payment.id,
      after: {
        method,
        amountCents: applied.amountCents,
        tenderedCents: applied.tenderedCents,
        changeCents: applied.changeCents,
      },
      metadata: { tabId: tab.id, unitId: tab.unitId, cashRegisterId: register.id },
    });
    return payment.id;
  }

  private async result(db: TenantDb, tabId: string, paymentId: string): Promise<PaymentResultDto> {
    const row = await db.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: paymentInclude,
    });
    const tab = await loadTab(db, tabId);
    this.events.tab(TabUpdated, tab);
    return { payment: toPaymentDto(row), tab };
  }
}

function discountOf(summary: TabSummaryDto) {
  return {
    discountType: summary.discountType,
    discountValue: summary.discountValue,
    discountReason: summary.discountReason,
    discountCents: summary.discountCents,
    totalCents: summary.totalCents,
  };
}
