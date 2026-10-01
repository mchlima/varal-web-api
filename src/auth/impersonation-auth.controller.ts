import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { z } from 'zod';

import { AppError } from '../errors/app-error.js';
import { ErrorResponseSchema } from '../errors/error-response.schema.js';
import { AUTH_COOKIES } from './auth-area.js';
import { authError } from './auth-errors.js';
import { DEVICE_HEADER_DOC, Public } from './auth.decorators.js';
import { cookieOf } from './auth.guard.js';
import { ImpersonationExchangeRequestSchema, type PanelMe, PanelMeSchema } from './auth.schemas.js';
import { AuthService } from './auth.service.js';
import { ImpersonationService } from './impersonation.service.js';
import { ProfileService } from './profile.service.js';
import { RateLimit, type RateLimitRule } from './rate-limit.js';
import { clientOf, setSessionCookies } from './session-cookies.js';

const IMPERSONATION_RATE_LIMIT: RateLimitRule = {
  name: 'impersonation',
  limit: 20,
  windowMs: 60_000,
};

/**
 * Opens the panel with an "entrar como" (spec 02, section 7; flow in `ImpersonationService`). Lives
 * in the panel area: it sets the cookies of the customers' app. The admin session is used only as
 * proof that the link is opened by the same admin, in the same browser; it never authenticates a
 * panel route (CA-01.04).
 */
@ApiTags('auth')
@Controller('auth/impersonation')
export class ImpersonationAuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly impersonations: ImpersonationService,
    private readonly profile: ProfileService,
  ) {}

  @Post()
  @Public()
  @HttpCode(HttpStatus.OK)
  @RateLimit(IMPERSONATION_RATE_LIMIT)
  @ApiOperation({
    summary: 'Troca o link de uso único do "entrar como" pela sessão do app (RN-02.21)',
    description:
      'Chamado pela página `/entrar-como` do painel com o token do fragmento. Exige o cookie de sessão do admin que gerou o link (mesmo navegador) e o `X-Device-Id` do painel. A sessão aberta é do dono, dura até o fim do "entrar como" (60 min, CA-02.08) e não dá acesso a outras organizações nem ao admin.',
  })
  @ApiHeader(DEVICE_HEADER_DOC)
  @ApiOkResponse({
    description: 'Sessão do app aberta como o dono; cookies do app definidos.',
    standardSchema: PanelMeSchema,
  })
  @ApiBadRequestResponse({
    description: '`INVALID_IMPERSONATION_TOKEN` ou `DEVICE_ID_REQUIRED`.',
    standardSchema: ErrorResponseSchema,
  })
  @ApiUnauthorizedResponse({
    description: '`UNAUTHENTICATED`: sem a sessão do admin neste navegador.',
    standardSchema: ErrorResponseSchema,
  })
  async exchange(
    @Body({ schema: ImpersonationExchangeRequestSchema })
    body: z.infer<typeof ImpersonationExchangeRequestSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PanelMe> {
    const client = clientOf(request);
    if (client.deviceId === null) {
      throw authError('DEVICE_ID_REQUIRED');
    }
    const adminToken = cookieOf(request, AUTH_COOKIES.admin.access);
    const admin =
      adminToken === undefined ? null : await this.auth.authenticate('admin', adminToken);
    if (admin?.session.subjectType !== 'platform_admin') {
      throw AppError.of('UNAUTHENTICATED', {
        message: 'Entre no admin do Varal neste navegador e gere o acesso de novo.',
      });
    }
    const issued = await this.impersonations.openPanelSession(
      body.token,
      { platformAdminId: admin.session.subjectId },
      { ...client, deviceId: client.deviceId },
    );
    setSessionCookies(response, 'panel', issued);
    return this.profile.panelMe(issued.session, issued.accessToken.expiresAt);
  }
}
