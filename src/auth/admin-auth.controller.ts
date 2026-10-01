import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiNoContentResponse,
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
import { AdminArea, AdminAuth, LOGIN_LOCK_DOC, LoginResponses, Public } from './auth.decorators.js';
import { authenticatedOf, cookieOf } from './auth.guard.js';
import {
  type AdminMe,
  AdminLoginRequestSchema,
  AdminMeSchema,
  ChangePasswordRequestSchema,
  FORGOT_PASSWORD_MESSAGE,
  ForgotPasswordRequestSchema,
  ForgotPasswordResponseSchema,
  ResetPasswordRequestSchema,
  type SessionInfo,
  SessionInfoSchema,
} from './auth.schemas.js';
import { AuthService } from './auth.service.js';
import { PasswordLinkService } from './password-link.service.js';
import { ProfileService } from './profile.service.js';
import {
  FORGOT_RATE_LIMIT,
  LOGIN_RATE_LIMIT,
  PASSWORD_RATE_LIMIT,
  RateLimit,
} from './rate-limit.js';
import {
  clearSessionCookies,
  clientOf,
  sessionInfoOf,
  setSessionCookies,
} from './session-cookies.js';

/**
 * Authentication of the platform admin (`varal-admin-web`), with its own cookies and signing
 * secret: a panel session is never accepted here, nor an admin session in the panel (CA-01.04).
 * RBAC (permissions per route) arrives with spec 02.
 */
@ApiTags('admin-auth')
@AdminArea()
@Controller('admin/auth')
export class AdminAuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly profile: ProfileService,
    private readonly links: PasswordLinkService,
  ) {}

  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  @RateLimit(LOGIN_RATE_LIMIT, LOGIN_LOCK_DOC)
  @ApiOperation({ summary: 'Login do admin da plataforma' })
  @LoginResponses()
  @ApiOkResponse({
    description: 'Sessão do admin aberta; cookies definidos.',
    standardSchema: AdminMeSchema,
  })
  async login(
    @Body({ schema: AdminLoginRequestSchema }) body: z.infer<typeof AdminLoginRequestSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AdminMe> {
    const issued = await this.auth.loginAdmin(body.email, body.password, clientOf(request));
    setSessionCookies(response, 'admin', issued);
    return this.profile.adminMe(issued.session, issued.accessToken.expiresAt);
  }

  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Renova a sessão do admin' })
  @ApiOkResponse({ description: 'Novos cookies definidos.', standardSchema: SessionInfoSchema })
  @ApiUnauthorizedResponse({
    description: '`UNAUTHENTICATED`: sem token de renovação válido; cookies apagados.',
    standardSchema: ErrorResponseSchema,
  })
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionInfo> {
    const token = cookieOf(request, AUTH_COOKIES.admin.refresh);
    try {
      if (token === undefined) {
        throw AppError.of('UNAUTHENTICATED');
      }
      const issued = await this.auth.refresh('admin', token, clientOf(request));
      setSessionCookies(response, 'admin', issued);
      return sessionInfoOf({
        session: issued.session,
        accessTokenExpiresAt: issued.accessToken.expiresAt,
      });
    } catch (error) {
      clearSessionCookies(response, 'admin');
      throw error;
    }
  }

  @Post('logout')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Encerra a sessão do admin neste aparelho' })
  @ApiNoContentResponse({
    description: 'Sessão encerrada (ou já não havia sessão); cookies apagados.',
  })
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const accessToken = cookieOf(request, AUTH_COOKIES.admin.access);
    const refreshToken = cookieOf(request, AUTH_COOKIES.admin.refresh);
    try {
      await this.auth.logout('admin', {
        ...(accessToken === undefined ? {} : { accessToken }),
        ...(refreshToken === undefined ? {} : { refreshToken }),
      });
    } finally {
      clearSessionCookies(response, 'admin');
    }
  }

  @Get('me')
  @AdminAuth()
  @ApiOperation({ summary: 'Admin logado' })
  @ApiOkResponse({ standardSchema: AdminMeSchema })
  me(@Req() request: Request): Promise<AdminMe> {
    const { session, claims } = authenticatedOf(request);
    return this.profile.adminMe(session, claims.expiresAt);
  }

  @Post('password/forgot')
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @RateLimit(FORGOT_RATE_LIMIT)
  @ApiOperation({ summary: 'Admin pede o link de redefinição de senha' })
  @ApiAcceptedResponse({
    description: 'Sempre a mesma resposta, exista ou não o e-mail (RN-01.03).',
    standardSchema: ForgotPasswordResponseSchema,
  })
  async forgot(
    @Body({ schema: ForgotPasswordRequestSchema })
    body: z.infer<typeof ForgotPasswordRequestSchema>,
  ): Promise<z.infer<typeof ForgotPasswordResponseSchema>> {
    await this.links.requestAdminPasswordReset(body.email);
    return { message: FORGOT_PASSWORD_MESSAGE };
  }

  @Post('password/reset')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit(PASSWORD_RATE_LIMIT)
  @ApiOperation({
    summary: 'Define a senha do admin com o token de um convite ou de uma redefinição',
  })
  @ApiNoContentResponse({
    description: 'Senha definida; todas as sessões do admin foram encerradas.',
  })
  @ApiBadRequestResponse({
    description: '`INVALID_PASSWORD_TOKEN` ou `VALIDATION_FAILED`.',
    standardSchema: ErrorResponseSchema,
  })
  async reset(
    @Body({ schema: ResetPasswordRequestSchema }) body: z.infer<typeof ResetPasswordRequestSchema>,
  ): Promise<void> {
    await this.auth.resetPassword('admin', body.token, body.password);
  }

  @Post('password/change')
  @AdminAuth()
  @HttpCode(HttpStatus.OK)
  @RateLimit(PASSWORD_RATE_LIMIT)
  @ApiOperation({ summary: 'Troca a senha do admin (logado)' })
  @ApiOkResponse({
    description:
      'Senha trocada; as outras sessões foram encerradas e este aparelho recebeu uma sessão nova.',
    standardSchema: SessionInfoSchema,
  })
  @ApiBadRequestResponse({
    description: '`WRONG_CURRENT_PASSWORD` ou `VALIDATION_FAILED`.',
    standardSchema: ErrorResponseSchema,
  })
  async change(
    @Body({ schema: ChangePasswordRequestSchema })
    body: z.infer<typeof ChangePasswordRequestSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionInfo> {
    const issued = await this.auth.changePassword(
      'admin',
      body.currentPassword,
      body.newPassword,
      clientOf(request),
    );
    setSessionCookies(response, 'admin', issued);
    return sessionInfoOf({
      session: issued.session,
      accessTokenExpiresAt: issued.accessToken.expiresAt,
    });
  }
}
