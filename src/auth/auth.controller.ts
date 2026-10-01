import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req, Res } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
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
import { LOGIN_LOCK_DOC, LoginResponses, PanelAuth, Public } from './auth.decorators.js';
import { authenticatedOf, cookieOf } from './auth.guard.js';
import {
  AccessCodeOrganizationSchema,
  AccessCodeParamSchema,
  ChangePasswordRequestSchema,
  FORGOT_PASSWORD_MESSAGE,
  ForgotPasswordRequestSchema,
  ForgotPasswordResponseSchema,
  OwnerLoginRequestSchema,
  type PanelMe,
  PanelMeSchema,
  ResetPasswordRequestSchema,
  type SessionInfo,
  SessionInfoSchema,
  StaffLoginRequestSchema,
} from './auth.schemas.js';
import { AuthService, type IssuedSession } from './auth.service.js';
import { PasswordLinkService } from './password-link.service.js';
import { ProfileService } from './profile.service.js';
import {
  ACCESS_CODE_RATE_LIMIT,
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

/** Authentication of the customers' app (`varal-panel-web`): owners and staff (spec 01, section 13). */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly profile: ProfileService,
    private readonly links: PasswordLinkService,
  ) {}

  @Post('owner/login')
  @Public()
  @HttpCode(HttpStatus.OK)
  @RateLimit(LOGIN_RATE_LIMIT, LOGIN_LOCK_DOC)
  @ApiOperation({ summary: 'Login do dono (e-mail e senha)' })
  @LoginResponses()
  @ApiOkResponse({
    description: 'Sessão aberta; cookies definidos.',
    standardSchema: PanelMeSchema,
  })
  async ownerLogin(
    @Body({ schema: OwnerLoginRequestSchema }) body: z.infer<typeof OwnerLoginRequestSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PanelMe> {
    const issued = await this.auth.loginOwner(body.email, body.password, clientOf(request));
    return this.openPanelSession(response, issued);
  }

  @Post('staff/login')
  @Public()
  @HttpCode(HttpStatus.OK)
  @RateLimit(LOGIN_RATE_LIMIT, LOGIN_LOCK_DOC)
  @ApiOperation({ summary: 'Login do colaborador (código do estabelecimento, usuário e senha)' })
  @LoginResponses()
  @ApiOkResponse({
    description: 'Sessão aberta; cookies definidos.',
    standardSchema: PanelMeSchema,
  })
  async staffLogin(
    @Body({ schema: StaffLoginRequestSchema }) body: z.infer<typeof StaffLoginRequestSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PanelMe> {
    const issued = await this.auth.loginStaff(
      body.accessCode,
      body.username,
      body.password,
      clientOf(request),
    );
    return this.openPanelSession(response, issued);
  }

  @Get('access-code/:code')
  @Public()
  @RateLimit(ACCESS_CODE_RATE_LIMIT)
  @ApiOperation({ summary: 'Nome da organização de um código de estabelecimento' })
  @ApiOkResponse({ standardSchema: AccessCodeOrganizationSchema })
  @ApiNotFoundResponse({ description: 'Código inexistente.', standardSchema: ErrorResponseSchema })
  async accessCode(
    @Param('code') code: string,
  ): Promise<z.infer<typeof AccessCodeOrganizationSchema>> {
    const parsed = AccessCodeParamSchema.safeParse(code);
    if (!parsed.success) {
      throw AppError.of('NOT_FOUND', { message: 'Código do estabelecimento não encontrado.' });
    }
    return { organizationName: await this.profile.organizationNameByAccessCode(parsed.data) };
  }

  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Renova a sessão (gira o token de renovação)' })
  @ApiOkResponse({ description: 'Novos cookies definidos.', standardSchema: SessionInfoSchema })
  @ApiUnauthorizedResponse({
    description: '`UNAUTHENTICATED`: sem token de renovação válido; cookies apagados.',
    standardSchema: ErrorResponseSchema,
  })
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionInfo> {
    const token = cookieOf(request, AUTH_COOKIES.panel.refresh);
    try {
      if (token === undefined) {
        throw AppError.of('UNAUTHENTICATED');
      }
      const issued = await this.auth.refresh('panel', token, clientOf(request));
      setSessionCookies(response, 'panel', issued);
      return sessionInfoOf({
        session: issued.session,
        accessTokenExpiresAt: issued.accessToken.expiresAt,
      });
    } catch (error) {
      clearSessionCookies(response, 'panel');
      throw error;
    }
  }

  @Post('logout')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Encerra a sessão deste aparelho' })
  @ApiNoContentResponse({
    description: 'Sessão encerrada (ou já não havia sessão); cookies apagados.',
  })
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const accessToken = cookieOf(request, AUTH_COOKIES.panel.access);
    const refreshToken = cookieOf(request, AUTH_COOKIES.panel.refresh);
    try {
      await this.auth.logout('panel', {
        ...(accessToken === undefined ? {} : { accessToken }),
        ...(refreshToken === undefined ? {} : { refreshToken }),
      });
    } finally {
      clearSessionCookies(response, 'panel');
    }
  }

  @Get('me')
  @PanelAuth()
  @ApiOperation({ summary: 'Perfil, organização, unidades e estações permitidas' })
  @ApiOkResponse({ standardSchema: PanelMeSchema })
  me(@Req() request: Request): Promise<PanelMe> {
    const { session, claims } = authenticatedOf(request);
    return this.profile.panelMe(session, claims.expiresAt);
  }

  @Post('password/forgot')
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @RateLimit(FORGOT_RATE_LIMIT)
  @ApiOperation({ summary: 'Dono pede o link de redefinição de senha' })
  @ApiAcceptedResponse({
    description: 'Sempre a mesma resposta, exista ou não o e-mail (RN-01.03).',
    standardSchema: ForgotPasswordResponseSchema,
  })
  async forgot(
    @Body({ schema: ForgotPasswordRequestSchema })
    body: z.infer<typeof ForgotPasswordRequestSchema>,
  ): Promise<z.infer<typeof ForgotPasswordResponseSchema>> {
    await this.links.requestOwnerPasswordReset(body.email);
    return { message: FORGOT_PASSWORD_MESSAGE };
  }

  @Post('password/reset')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit(PASSWORD_RATE_LIMIT)
  @ApiOperation({ summary: 'Define a senha com o token de um convite ou de uma redefinição' })
  @ApiNoContentResponse({
    description: 'Senha definida; todas as sessões do usuário foram encerradas.',
  })
  @ApiBadRequestResponse({
    description:
      '`INVALID_PASSWORD_TOKEN` ou `VALIDATION_FAILED` (senha com menos de 8 caracteres).',
    standardSchema: ErrorResponseSchema,
  })
  async reset(
    @Body({ schema: ResetPasswordRequestSchema }) body: z.infer<typeof ResetPasswordRequestSchema>,
  ): Promise<void> {
    await this.auth.resetPassword('panel', body.token, body.password);
  }

  @Post('password/change')
  @PanelAuth()
  @HttpCode(HttpStatus.OK)
  @RateLimit(PASSWORD_RATE_LIMIT)
  @ApiOperation({ summary: 'Troca a senha (logado)' })
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
      'panel',
      body.currentPassword,
      body.newPassword,
      clientOf(request),
    );
    setSessionCookies(response, 'panel', issued);
    return sessionInfoOf({
      session: issued.session,
      accessTokenExpiresAt: issued.accessToken.expiresAt,
    });
  }

  private async openPanelSession(response: Response, issued: IssuedSession): Promise<PanelMe> {
    setSessionCookies(response, 'panel', issued);
    return this.profile.panelMe(issued.session, issued.accessToken.expiresAt);
  }
}
