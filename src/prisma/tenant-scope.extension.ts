import { Prisma } from '../generated/prisma/client.js';
import { tenantFieldOf } from './tenant-models.js';

/**
 * A query on a tenant model that cannot be safely scoped: no organization in the context, an
 * attempt to write another organization's id, or an operation the scope does not know. It is a
 * programming error, rendered as 500 (and logged), never as data from another organization.
 */
export class TenantScopeError extends Error {
  override name = 'TenantScopeError';
}

type Args = Record<string, unknown>;
type Where = Record<string, unknown>;

/** Operations whose `where` is a plain filter: wrapped as `AND: [where, scope]`. */
const FILTER_OPERATIONS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'updateMany',
  'updateManyAndReturn',
  'deleteMany',
]);

/** Operations whose `where` is unique: the scope goes into `AND` next to the unique fields. */
const UNIQUE_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'update',
  'delete',
  'upsert',
]);

const CREATE_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn', 'upsert']);
const UPDATE_OPERATIONS = new Set(['update', 'updateMany', 'updateManyAndReturn', 'upsert']);

/** The tenant itself can be read and updated through the tenant client, never created or removed. */
const ORGANIZATION_ALLOWED = new Set([
  ...FILTER_OPERATIONS,
  'findUnique',
  'findUniqueOrThrow',
  'update',
]);
ORGANIZATION_ALLOWED.delete('deleteMany');

function toArray(value: unknown): unknown[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function scopeFilter(where: unknown, scope: Where): Where {
  return where === undefined ? scope : { AND: [where, scope] };
}

function scopeUnique(where: unknown, scope: Where): Where {
  const unique = (where ?? {}) as Where;
  return { ...unique, AND: [...toArray(unique.AND), scope] };
}

function relationNameOf(field: string): string {
  return field === 'id' ? 'id' : field.replace(/Id$/, '');
}

/** Rejects a write that names another organization, or that sets the tenant relation directly. */
function checkWriteData(
  model: string,
  field: string,
  organizationId: string,
  data: unknown,
  { fill }: { fill: boolean },
): Args[] {
  return toArray(data).map((entry) => {
    const row = { ...(entry as Args) };
    if (field !== 'id' && relationNameOf(field) in row) {
      throw new TenantScopeError(
        `${model}: set "${field}" through the tenant scope, not the "${relationNameOf(field)}" relation`,
      );
    }
    if (field in row && row[field] !== organizationId) {
      throw new TenantScopeError(`${model}: "${field}" belongs to another organization`);
    }
    if (fill) {
      row[field] = organizationId;
    }
    return row;
  });
}

function scopeData(
  model: string,
  field: string,
  organizationId: string,
  data: unknown,
  fill: boolean,
): unknown {
  const checked = checkWriteData(model, field, organizationId, data, { fill });
  return Array.isArray(data) ? checked : checked[0];
}

/**
 * Returns `args` scoped to `organizationId` (spec 01, section 6). Pure, so it is unit-tested on
 * every operation; {@link tenantScope} applies it to every query on a tenant model.
 *
 * Not covered (by design, documented in the README): nested writes inside `data` (use top-level
 * operations or composite foreign keys), and raw SQL (`$queryRaw`), which must filter by hand.
 */
export function scopeTenantArgs(
  model: string,
  operation: string,
  args: Args | undefined,
  organizationId: string,
): Args {
  const field = tenantFieldOf(model);
  if (field === undefined) {
    return args ?? {};
  }
  if (model === 'Organization' && !ORGANIZATION_ALLOWED.has(operation)) {
    throw new TenantScopeError(
      `Organization.${operation} is not allowed through the tenant client (platform only)`,
    );
  }
  const scope: Where = { [field]: organizationId };
  const scoped: Args = { ...args };

  if (FILTER_OPERATIONS.has(operation)) {
    scoped.where = scopeFilter(scoped.where, scope);
  } else if (UNIQUE_OPERATIONS.has(operation)) {
    scoped.where = scopeUnique(scoped.where, scope);
  } else if (
    operation !== 'create' &&
    operation !== 'createMany' &&
    operation !== 'createManyAndReturn'
  ) {
    throw new TenantScopeError(`${model}.${operation} is not supported by the tenant scope`);
  }

  if (operation === 'upsert') {
    scoped.create = scopeData(model, field, organizationId, scoped.create, true);
    scoped.update = scopeData(model, field, organizationId, scoped.update, false);
  } else if (CREATE_OPERATIONS.has(operation)) {
    scoped.data = scopeData(model, field, organizationId, scoped.data, true);
  } else if (UPDATE_OPERATIONS.has(operation)) {
    scoped.data = scopeData(model, field, organizationId, scoped.data, false);
  }
  return scoped;
}

/**
 * Prisma client extension that applies {@link scopeTenantArgs} to every query on a tenant model and
 * fails when the context has no organization. Models outside TENANT_MODELS pass through untouched.
 */
export function tenantScope(getOrganizationId: () => string | null) {
  return Prisma.defineExtension({
    name: 'tenant-scope',
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          if (tenantFieldOf(model) === undefined) {
            return query(args);
          }
          const organizationId = getOrganizationId();
          if (organizationId === null) {
            throw new TenantScopeError(
              `${model}.${operation} needs an organization in the request context (spec 01, section 6)`,
            );
          }
          return query(scopeTenantArgs(model, operation, args, organizationId));
        },
      },
    },
  });
}
