import {
  applyDecorators,
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiExtension, ApiForbiddenResponse } from '@nestjs/swagger';
import type { Request } from 'express';

import { getRequestContext } from '../../context/request-context.js';
import { AppError } from '../../errors/app-error.js';
import { ErrorResponseSchema } from '../../errors/error-response.schema.js';
import { PlatformPrismaService } from '../../prisma/platform-prisma.service.js';
import { type AdminAccess, loadAdminAccess } from './admin-access.js';
import type { Permission } from './permissions.js';

export const REQUIRED_PERMISSIONS = Symbol('REQUIRED_PERMISSIONS');

/** OpenAPI extension with the permissions of an admin operation (empty: any logged-in admin). */
export const PERMISSIONS_EXTENSION = 'x-permissions';

const accessByRequest = new WeakMap<Request, AdminAccess>();

/** Access (roles and effective permissions) of the admin of this request, loaded by the guard. */
export function adminAccessOf(request: Request): AdminAccess {
  const access = accessByRequest.get(request);
  if (!access) {
    throw AppError.of('UNAUTHENTICATED');
  }
  return access;
}

/**
 * RN-02.01: every admin route requires a permission of the catalog; without it, 403 `FORBIDDEN`.
 * Runs after the global `AuthGuard`, which already accepted only the admin session (CA-01.04). The
 * permissions are read from the database on every request (RN-02.08). An inactive admin is 401.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly platform: PlatformPrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<readonly Permission[] | undefined>(
      REQUIRED_PERMISSIONS,
      [context.getHandler(), context.getClass()],
    );
    if (required === undefined) {
      // A route with the guard but no declared permission is a programming error: closed.
      throw AppError.of('FORBIDDEN');
    }
    const auth = getRequestContext()?.auth;
    if (auth?.actor.type !== 'platform_admin' || !auth.actor.id) {
      throw AppError.of('UNAUTHENTICATED');
    }
    const access = await loadAdminAccess(this.platform, auth.actor.id);
    if (!access?.active) {
      throw AppError.of('UNAUTHENTICATED');
    }
    if (
      required.length > 0 &&
      !required.some((permission) => access.permissions.includes(permission))
    ) {
      throw AppError.of('FORBIDDEN', { details: { requiredPermissions: [...required] } });
    }
    accessByRequest.set(context.switchToHttp().getRequest<Request>(), access);
    return true;
  }
}

function permissionDecorators(permissions: readonly Permission[], description: string) {
  return applyDecorators(
    SetMetadata(REQUIRED_PERMISSIONS, permissions),
    UseGuards(PermissionGuard),
    ApiExtension(PERMISSIONS_EXTENSION, [...permissions]),
    ApiForbiddenResponse({ description, standardSchema: ErrorResponseSchema }),
  );
}

/**
 * The admin needs at least one of `permissions` (RN-02.01). Documented in the OpenAPI as
 * `x-permissions` and a 403 response, so the admin app can hide the action.
 */
export function RequirePermission(
  ...permissions: [Permission, ...Permission[]]
): MethodDecorator & ClassDecorator {
  const list = permissions.map((permission) => `\`${permission}\``).join(' ou ');
  return permissionDecorators(permissions, `\`FORBIDDEN\`: falta a permissão ${list}.`);
}

/** Any logged-in, active admin (e.g. the permission catalog). Still declared, so no route is open by omission. */
export function AnyAdmin(): MethodDecorator & ClassDecorator {
  return permissionDecorators([], '`FORBIDDEN`: ação não permitida para este admin.');
}
