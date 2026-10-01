import { describe, expect, it } from 'vitest';

import { Prisma } from '../generated/prisma/client.js';
import { PLATFORM_MODELS_WITH_ORGANIZATION, TENANT_MODELS } from './tenant-models.js';
import { scopeTenantArgs, TenantScopeError } from './tenant-scope.extension.js';

const ORG = '01900000-0000-7000-8000-00000000000a';
const OTHER = '01900000-0000-7000-8000-00000000000b';
const scope = { organizationId: ORG };

describe('scopeTenantArgs: reads and bulk writes get the organization in where (spec 01, section 6)', () => {
  it.each([
    'findFirst',
    'findFirstOrThrow',
    'findMany',
    'count',
    'aggregate',
    'groupBy',
    'updateMany',
    'updateManyAndReturn',
    'deleteMany',
  ])('%s wraps the filter in AND', (operation) => {
    expect(scopeTenantArgs('Unit', operation, { where: { name: 'A' } }, ORG).where).toEqual({
      AND: [{ name: 'A' }, scope],
    });
  });

  it('adds the filter when there is no where', () => {
    expect(scopeTenantArgs('Unit', 'findMany', undefined, ORG)).toEqual({ where: scope });
  });

  it('cannot be widened by an OR in the caller filter', () => {
    const where = { OR: [{ organizationId: OTHER }, { name: 'A' }] };
    expect(scopeTenantArgs('Unit', 'findMany', { where }, ORG).where).toEqual({
      AND: [where, scope],
    });
  });

  it.each(['findUnique', 'findUniqueOrThrow', 'update', 'delete'])(
    '%s keeps the unique fields and adds the organization in AND',
    (operation) => {
      const args = scopeTenantArgs(
        'Unit',
        operation,
        { where: { id: 'u1', AND: { active: true } } },
        ORG,
      );
      expect(args.where).toEqual({ id: 'u1', AND: [{ active: true }, scope] });
    },
  );
});

describe('scopeTenantArgs: writes get the organization in data', () => {
  it('fills organizationId on create', () => {
    expect(scopeTenantArgs('Unit', 'create', { data: { name: 'A' } }, ORG).data).toEqual({
      name: 'A',
      organizationId: ORG,
    });
  });

  it('accepts the organization of the context written explicitly', () => {
    expect(
      scopeTenantArgs('Unit', 'create', { data: { name: 'A', organizationId: ORG } }, ORG).data,
    ).toEqual({ name: 'A', organizationId: ORG });
  });

  it.each(['createMany', 'createManyAndReturn'])('%s fills every row', (operation) => {
    expect(
      scopeTenantArgs('Unit', operation, { data: [{ name: 'A' }, { name: 'B' }] }, ORG).data,
    ).toEqual([
      { name: 'A', organizationId: ORG },
      { name: 'B', organizationId: ORG },
    ]);
  });

  it('scopes upsert: where, create and update', () => {
    const args = scopeTenantArgs(
      'Unit',
      'upsert',
      { where: { id: 'u1' }, create: { name: 'A' }, update: { name: 'B' } },
      ORG,
    );
    expect(args).toEqual({
      where: { id: 'u1', AND: [scope] },
      create: { name: 'A', organizationId: ORG },
      update: { name: 'B' },
    });
  });

  it.each([
    ['create', { data: { name: 'A', organizationId: OTHER } }],
    ['createMany', { data: [{ name: 'A' }, { name: 'B', organizationId: OTHER }] }],
    ['update', { where: { id: 'u1' }, data: { organizationId: OTHER } }],
    ['updateMany', { where: {}, data: { organizationId: OTHER } }],
    ['upsert', { where: { id: 'u1' }, create: { name: 'A' }, update: { organizationId: OTHER } }],
  ])('%s refuses another organization id', (operation, args) => {
    expect(() => scopeTenantArgs('Unit', operation, args, ORG)).toThrow(TenantScopeError);
  });

  it('refuses setting the organization through the relation', () => {
    expect(() =>
      scopeTenantArgs(
        'Unit',
        'create',
        { data: { name: 'A', organization: { connect: { id: OTHER } } } },
        ORG,
      ),
    ).toThrow(/relation/);
  });

  it('fails closed on an operation it does not know', () => {
    expect(() => scopeTenantArgs('Unit', 'findRaw', {}, ORG)).toThrow(TenantScopeError);
  });
});

describe('scopeTenantArgs: Organization is scoped by its own id', () => {
  it('reads and updates only the organization of the context', () => {
    expect(scopeTenantArgs('Organization', 'findMany', {}, ORG)).toEqual({ where: { id: ORG } });
    expect(
      scopeTenantArgs('Organization', 'update', { where: { id: OTHER }, data: {} }, ORG),
    ).toEqual({
      where: { id: OTHER, AND: [{ id: ORG }] },
      data: {},
    });
  });

  it.each(['create', 'createMany', 'upsert', 'delete', 'deleteMany'])(
    'refuses %s (platform admin only, spec 02)',
    (operation) => {
      expect(() => scopeTenantArgs('Organization', operation, { data: {} }, ORG)).toThrow(
        TenantScopeError,
      );
    },
  );
});

describe('scopeTenantArgs: platform models pass through', () => {
  it.each(['AuditLog', 'Session', 'PlatformAdmin', 'IdempotencyKey'])(
    '%s is untouched',
    (model) => {
      const args = { where: { id: 'x' } };
      expect(scopeTenantArgs(model, 'findMany', args, ORG)).toEqual(args);
    },
  );
});

describe('TENANT_MODELS coverage', () => {
  it('lists every model with organizationId as tenant or platform (spec 01, section 6)', () => {
    const withOrganization = Object.values(Prisma.ModelName).filter((model) => {
      const fields = (Prisma as unknown as Record<string, Record<string, string> | undefined>)[
        `${model}ScalarFieldEnum`
      ];
      return fields !== undefined && 'organizationId' in fields;
    });
    const classified = [
      ...Object.keys(TENANT_MODELS).filter((model) => model !== 'Organization'),
      ...PLATFORM_MODELS_WITH_ORGANIZATION,
    ];
    expect(withOrganization.sort()).toEqual(classified.sort());
  });
});
