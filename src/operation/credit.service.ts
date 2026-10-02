import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { decodeKeysetCursor, encodeKeysetCursor } from '../common/pagination.js';
import { updateWithVersion } from '../common/versioned-update.js';
import { requireOrganizationId } from '../context/request-context.js';
import { AppError } from '../errors/app-error.js';
import { type Customer, Prisma } from '../generated/prisma/client.js';
import { PrismaService, type TenantDb } from '../prisma/prisma.service.js';
import { digitsOf, REMOVED_CUSTOMER_NAME } from './credit-rules.js';
import type {
  CreateCustomerRequest,
  CustomerDetailDto,
  CustomerDto,
  CustomerListDto,
  CustomerListQuery,
  PutOnCreditRequest,
  ReceivablesDto,
  UpdateCustomerRequest,
} from './credit.schemas.js';
import {
  assertCounter,
  canOperateCash,
  hasCounter,
  isOwner,
  OperationAccessService,
  type OperatorAccess,
} from './operation-access.js';
import { operationError } from './operation-errors.js';
import { OperationEvents, TabUpdated } from './operation-events.js';
import { loadPayments, loadTab, loadTabSummaries, loadTabSummary } from './operation-reader.js';
import type { TabDto, TabSummaryDto } from './operation.schemas.js';
import { lockRow } from './row-lock.js';
import { CLOSED_STATUSES, currentBusinessDate, requireTab } from './tabs.service.js';

/** RN-06.08: reference of the customer created for the contractor of a `consumption_billed` event. */
export const CONTRACTOR_REFERENCE = 'Contratante de evento';
/** RN-06.08: customers created before 2026-10-02 with the old reference are reused too. */
const LEGACY_CONTRACTOR_REFERENCE = 'Contratante de turno';

export function toCustomerDto(row: Customer): CustomerDto {
  return {
    id: row.id,
    unitId: row.unitId,
    name: row.name,
    phone: row.phone,
    cpf: row.cpf,
    reference: row.reference,
    note: row.note,
    removedAt: row.anonymizedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    version: row.version,
  };
}

/** Phone and CPF are stored with digits only; empty clears the field. */
function digitsOrNull(value: string | null | undefined): string | null {
  const digits = digitsOf(value ?? '');
  return digits === '' ? null : digits;
}

function textOrNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}

/** Which optional identification fields are filled, for the audit (no personal data, LGPD). */
function filledFields(row: Pick<Customer, 'phone' | 'cpf' | 'reference' | 'note'>) {
  return {
    hasPhone: row.phone !== null,
    hasCpf: row.cpf !== null,
    hasReference: row.reference !== null,
    hasNote: row.note !== null,
  };
}

/**
 * Fiado (spec 06): customers per unit, putting a tab on credit and the receivables. Settling is a
 * payment (`PaymentsService`, RN-06.09). Searching, registering, putting on credit and reading the
 * receivables: the owner and the counter (RN-06.02, RN-06.04); editing and removing a customer:
 * the owner (panel, spec 06 section 8).
 *
 * Audit never stores the name, phone, CPF, reference or note of a customer: the log is insert-only
 * and a removed customer must not be found there (RN-06.03).
 */
@Injectable()
export class CreditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: OperationAccessService,
    private readonly events: OperationEvents,
  ) {}

  /**
   * `GET /units/{id}/customers?q=&limit=&cursor=` (RN-06.02, CA-06.04, CA-06.06): in name order,
   * paginated by a keyset cursor (name, id).
   */
  async list(unitId: string, query: CustomerListQuery): Promise<CustomerListDto> {
    const db = this.prisma.db;
    assertCounter(await this.access.forUnit(db, unitId));
    const q = query.q ?? '';
    const digits = digitsOf(q);
    const or: Prisma.CustomerWhereInput[] = [];
    if (q !== '') {
      or.push(
        { name: { contains: q, mode: 'insensitive' } },
        { reference: { contains: q, mode: 'insensitive' } },
      );
      if (digits.length >= 3) {
        or.push({ phone: { contains: digits } }, { cpf: { contains: digits } });
      }
    }
    const after = query.cursor === undefined ? null : decodeKeysetCursor(query.cursor);
    const rows = await db.customer.findMany({
      where: {
        unitId,
        anonymizedAt: null,
        AND: [
          or.length > 0 ? { OR: or } : {},
          after === null
            ? {}
            : { OR: [{ name: { gt: after.key } }, { name: after.key, id: { gt: after.id } }] },
        ],
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: query.limit + 1,
    });
    const data = rows.slice(0, query.limit);
    const last = data.at(-1);
    return {
      data: data.map(toCustomerDto),
      nextCursor: rows.length > query.limit && last ? encodeKeysetCursor(last.name, last.id) : null,
    };
  }

  /** `POST /units/{id}/customers`: only the name is required (RN-06.01, CA-06.06). */
  async create(unitId: string, input: CreateCustomerRequest): Promise<CustomerDto> {
    return this.prisma.transaction(async (db) => {
      assertCounter(await this.access.forUnit(db, unitId));
      const data = {
        name: input.name,
        phone: digitsOrNull(input.phone),
        cpf: digitsOrNull(input.cpf),
        reference: textOrNull(input.reference),
        note: textOrNull(input.note),
      };
      await assertUnique(db, unitId, data, null);
      const customer = await uniqueOr(data, () =>
        db.customer.create({ data: { organizationId: requireOrganizationId(), unitId, ...data } }),
      );
      await this.audit.record(db, {
        action: 'customer.created',
        entityType: 'customer',
        entityId: customer.id,
        after: filledFields(customer),
        metadata: { unitId },
      });
      return toCustomerDto(customer);
    });
  }

  /** `PATCH /customers/{id}`: the owner edits; phone and CPF stay unique (RN-06.02). */
  async update(id: string, input: UpdateCustomerRequest): Promise<CustomerDto> {
    return this.prisma.transaction(async (db) => {
      const current = await requireCustomer(db, id);
      assertOwner(await this.access.forUnit(db, current.unitId));
      if (current.anonymizedAt !== null) {
        throw operationError('CUSTOMER_REMOVED');
      }
      const data = {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.phone === undefined ? {} : { phone: digitsOrNull(input.phone) }),
        ...(input.cpf === undefined ? {} : { cpf: digitsOrNull(input.cpf) }),
        ...(input.reference === undefined ? {} : { reference: textOrNull(input.reference) }),
        ...(input.note === undefined ? {} : { note: textOrNull(input.note) }),
      };
      await assertUnique(db, current.unitId, data, id);
      const updated = await uniqueOr(data, () =>
        updateWithVersion<Customer>(db.customer, {
          where: { id, anonymizedAt: null },
          expectedVersion: input.version ?? current.version,
          data,
          onConflict: (currentVersion) => operationError('CUSTOMER_CHANGED', { currentVersion }),
        }),
      );
      await this.audit.record(db, {
        action: 'customer.updated',
        entityType: 'customer',
        entityId: id,
        before: filledFields(current),
        after: filledFields(updated),
        metadata: { unitId: current.unitId, fields: Object.keys(data) },
      });
      return toCustomerDto(updated);
    });
  }

  /**
   * `DELETE /customers/{id}` (RN-06.03, CA-06.05): refused while the customer has a balance to
   * receive; otherwise name and identification data are erased (the name becomes "Cliente
   * removido") and the tabs stay in the history, with their `customer_name` also replaced by
   * "Cliente removido" in the same transaction (LGPD).
   */
  async remove(id: string): Promise<CustomerDto> {
    return this.prisma.transaction(async (db) => {
      const found = await requireCustomer(db, id);
      assertOwner(await this.access.forUnit(db, found.unitId));
      // Same lock as putting on credit: no tab is hung on the customer while it is removed.
      await lockRow(db, 'customers', id);
      const customer = await requireCustomer(db, id);
      if (customer.anonymizedAt !== null) {
        throw operationError('CUSTOMER_REMOVED');
      }
      const balanceCents = await receivableOf(db, id);
      if (balanceCents !== null) {
        throw operationError('CUSTOMER_HAS_RECEIVABLE', { balanceCents });
      }
      const now = new Date();
      const removed = await db.customer.update({
        where: { id },
        data: {
          name: REMOVED_CUSTOMER_NAME,
          phone: null,
          cpf: null,
          reference: null,
          note: null,
          anonymizedAt: now,
          version: { increment: 1 },
        },
      });
      // RN-06.03: the name typed on the tabs of the customer is personal data too.
      const renamed = await db.tab.updateMany({
        where: { customerId: id },
        data: { customerName: REMOVED_CUSTOMER_NAME, version: { increment: 1 } },
      });
      await this.audit.record(db, {
        action: 'customer.anonymized',
        entityType: 'customer',
        entityId: id,
        before: { removedAt: null },
        after: { removedAt: now.toISOString() },
        metadata: { unitId: customer.unitId, tabsRenamed: renamed.count },
      });
      return toCustomerDto(removed);
    });
  }

  /** `GET /customers/{id}`: the customer with the tabs on credit and settled, and the settlements. */
  async detail(id: string): Promise<CustomerDetailDto> {
    const db = this.prisma.db;
    const customer = await requireCustomer(db, id);
    assertCounter(await this.access.forUnit(db, customer.unitId));
    const tabs = await db.tab.findMany({
      where: { customerId: id, status: { in: ['on_credit', 'settled'] } },
      orderBy: [{ creditAt: 'desc' }, { id: 'desc' }],
    });
    const summaries = await loadTabSummaries(db, tabs);
    return {
      ...toCustomerDto(customer),
      balanceCents: sumOnCredit(summaries),
      tabs: summaries,
      settlements: await loadPayments(db, {
        tabId: { in: tabs.map((tab) => tab.id) },
        isCreditSettlement: true,
      }),
    };
  }

  /**
   * `POST /tabs/{id}/put-on-credit` (RN-06.04 to RN-06.08; CA-06.01, CA-06.02): only a tab in
   * `closing`, from the counter, for a customer of the unit. Payments already made stay; the
   * amount on credit is the balance.
   */
  async putOnCredit(tabId: string, input: PutOnCreditRequest): Promise<TabDto> {
    return this.prisma.transaction(async (db) => {
      const found = await requireTab(db, tabId);
      assertCounter(await this.access.forUnit(db, found.unitId));
      await lockRow(db, 'tabs', tabId);
      const tab = await requireTab(db, tabId);
      if (input.version !== undefined && input.version !== tab.version) {
        throw operationError('TAB_CHANGED', { currentVersion: tab.version });
      }
      if (CLOSED_STATUSES.includes(tab.status)) {
        throw operationError('TAB_CLOSED');
      }
      if (tab.status !== 'closing') {
        // RN-06.04, CA-06.02: an open tab asks for the bill first.
        throw operationError('TAB_NOT_CLOSING');
      }
      const summary = await loadTabSummary(db, tabId);
      if (summary.balanceCents <= 0) {
        throw operationError('TAB_NOTHING_TO_PAY', { balanceCents: summary.balanceCents });
      }
      const customer = await this.customerFor(db, tab.unitId, tab.eventId, input.customerId);
      const now = new Date();
      await db.tab.update({
        where: { id: tabId },
        data: {
          status: 'on_credit',
          customerId: customer.id,
          creditAt: now,
          closedAt: now,
          // RN-04.38: the day it was put on credit (spec 07, RN-07.03).
          closedBusinessDate: await currentBusinessDate(db, tab.unitId),
          version: { increment: 1 },
        },
      });
      await this.audit.record(db, {
        action: 'tab.put_on_credit',
        entityType: 'tab',
        entityId: tabId,
        before: { status: 'closing', customerId: null },
        after: { status: 'on_credit', customerId: customer.id },
        metadata: {
          unitId: tab.unitId,
          totalCents: summary.totalCents,
          paidCents: summary.paidCents,
          balanceCents: summary.balanceCents,
        },
      });
      const dto = await loadTab(db, tabId);
      this.events.tab(TabUpdated, dto);
      return dto;
    });
  }

  /** `GET /units/{id}/receivables`: tabs on credit, oldest first, and totals per customer. */
  async receivables(unitId: string): Promise<ReceivablesDto> {
    const db = this.prisma.db;
    const access = await this.access.forUnit(db, unitId);
    if (!hasCounter(access) && !canOperateCash(access)) {
      throw AppError.of('FORBIDDEN', {
        message: 'Só o balcão e quem opera o caixa veem o fiado da unidade.',
      });
    }
    const tabs = await db.tab.findMany({
      where: { unitId, status: 'on_credit' },
      orderBy: [{ creditAt: 'asc' }, { id: 'asc' }],
    });
    const summaries = await loadTabSummaries(db, tabs);
    const customers = await db.customer.findMany({
      where: { id: { in: [...new Set(tabs.flatMap((tab) => tab.customerId ?? []))] } },
    });
    const byCustomer = customers.map((customer) => {
      const own = summaries.filter((tab) => tab.customer?.id === customer.id);
      return {
        customer: toCustomerDto(customer),
        balanceCents: sumOnCredit(own),
        tabCount: own.length,
        oldestCreditAt: own[0]?.creditAt ?? customer.createdAt.toISOString(),
      };
    });
    byCustomer.sort(
      (a, b) =>
        b.balanceCents - a.balanceCents || a.customer.name.localeCompare(b.customer.name, 'pt-BR'),
    );
    return { unitId, totalCents: sumOnCredit(summaries), tabs: summaries, customers: byCustomer };
  }

  /** RN-06.05, RN-06.08: the customer chosen, or the contractor of a `consumption_billed` event. */
  private async customerFor(
    db: TenantDb,
    unitId: string,
    eventId: string | null,
    customerId: string | undefined,
  ): Promise<Customer> {
    if (customerId !== undefined) {
      const id = customerId.toLowerCase();
      if (!(await lockRow(db, 'customers', id))) {
        throw operationError('INVALID_CUSTOMER');
      }
      const customer = await db.customer.findUniqueOrThrow({ where: { id } });
      if (customer.unitId !== unitId || customer.anonymizedAt !== null) {
        throw operationError('INVALID_CUSTOMER');
      }
      return customer;
    }
    const event =
      eventId === null ? null : await db.contractedEvent.findUnique({ where: { id: eventId } });
    if (event?.modality !== 'consumption_billed') {
      throw operationError('CUSTOMER_REQUIRED');
    }
    const name = event.contractorName.trim().slice(0, 60);
    const existing = await db.customer.findFirst({
      where: {
        unitId,
        name,
        reference: { in: [CONTRACTOR_REFERENCE, LEGACY_CONTRACTOR_REFERENCE] },
        anonymizedAt: null,
      },
      orderBy: { id: 'asc' },
    });
    if (existing) {
      return existing;
    }
    const customer = await db.customer.create({
      data: {
        organizationId: requireOrganizationId(),
        unitId,
        name,
        reference: CONTRACTOR_REFERENCE,
      },
    });
    await this.audit.record(db, {
      action: 'customer.created',
      entityType: 'customer',
      entityId: customer.id,
      after: filledFields(customer),
      metadata: { unitId, eventId, contractor: true },
    });
    return customer;
  }
}

function assertOwner(access: OperatorAccess): void {
  if (!isOwner(access)) {
    throw AppError.of('FORBIDDEN', { message: 'Só o dono edita e remove clientes.' });
  }
}

async function requireCustomer(db: TenantDb, id: string): Promise<Customer> {
  const customer = await db.customer.findUnique({ where: { id } });
  if (!customer) {
    throw AppError.of('NOT_FOUND');
  }
  return customer;
}

function sumOnCredit(tabs: readonly TabSummaryDto[]): number {
  return tabs
    .filter((tab) => tab.status === 'on_credit')
    .reduce((sum, tab) => sum + tab.balanceCents, 0);
}

/**
 * RN-06.03: what the customer still owes. A tab stays `on_credit` only while it has a balance
 * (RN-06.10), so any tab on credit blocks the removal.
 */
async function receivableOf(db: TenantDb, customerId: string): Promise<number | null> {
  const tabs = await db.tab.findMany({ where: { customerId, status: 'on_credit' } });
  return tabs.length === 0 ? null : sumOnCredit(await loadTabSummaries(db, tabs));
}

/** RN-06.02: phone and CPF unique among the customers of the unit not removed. */
async function assertUnique(
  db: TenantDb,
  unitId: string,
  data: { phone?: string | null; cpf?: string | null },
  selfId: string | null,
): Promise<void> {
  const other = (field: 'phone' | 'cpf', value: string) =>
    db.customer.findFirst({
      where: {
        unitId,
        anonymizedAt: null,
        [field]: value,
        ...(selfId === null ? {} : { id: { not: selfId } }),
      },
      select: { id: true },
    });
  if (data.phone != null && (await other('phone', data.phone))) {
    throw operationError('CUSTOMER_PHONE_TAKEN');
  }
  if (data.cpf != null && (await other('cpf', data.cpf))) {
    throw operationError('CUSTOMER_CPF_TAKEN');
  }
}

/** Two devices registering the same phone at once: the unique index refuses the second (P2002). */
async function uniqueOr<T>(
  data: { phone?: string | null; cpf?: string | null },
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const target = JSON.stringify(error.meta ?? {});
      const cpf = data.phone == null || (target.includes('cpf') && !target.includes('phone'));
      throw operationError(cpf ? 'CUSTOMER_CPF_TAKEN' : 'CUSTOMER_PHONE_TAKEN');
    }
    throw error;
  }
}
