import { Module } from '@nestjs/common';

import { UnitsModule } from '../units/units.module.js';
import { AdminEmailsController } from './admin-emails.controller.js';
import { AdminTasksJob } from './admin-tasks.job.js';
import { AnnouncementsController } from './announcements/announcements.controller.js';
import { AnnouncementsService } from './announcements/announcements.service.js';
import { AuditLogsController } from './audit-logs.controller.js';
import { ImpersonationsController } from './impersonation/impersonations.controller.js';
import { ImpersonationsService } from './impersonation/impersonations.service.js';
import { MetricsController } from './metrics/metrics.controller.js';
import { MetricsService } from './metrics/metrics.service.js';
import { OrganizationsController } from './organizations/organizations.controller.js';
import { OrganizationsService } from './organizations/organizations.service.js';
import { PlatformAdminsService } from './platform-admins.service.js';
import { PermissionGuard } from './rbac/require-permission.js';
import { RolesController } from './rbac/roles.controller.js';
import { RolesService } from './rbac/roles.service.js';
import { AdminUsersController } from './users/admin-users.controller.js';
import { AdminUsersService } from './users/admin-users.service.js';

/**
 * Platform admin (spec 02). Every route is under `/api/v1/admin`, needs the admin session
 * (CA-01.04) and declares its permission with `@RequirePermission` or `@AnyAdmin` (RN-02.01).
 */
@Module({
  // UnitTemplateService: default template of the first unit of a new organization (RN-02.09).
  imports: [UnitsModule],
  controllers: [
    RolesController,
    AdminUsersController,
    OrganizationsController,
    AnnouncementsController,
    MetricsController,
    ImpersonationsController,
    AdminEmailsController,
    AuditLogsController,
  ],
  providers: [
    PermissionGuard,
    PlatformAdminsService,
    RolesService,
    AdminUsersService,
    OrganizationsService,
    AnnouncementsService,
    MetricsService,
    ImpersonationsService,
    AdminTasksJob,
  ],
})
export class AdminModule {}
