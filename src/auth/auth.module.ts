import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AccessTokenService } from './access-token.service.js';
import { AdminAuthController } from './admin-auth.controller.js';
import { AuthController } from './auth.controller.js';
import { AuthEvents } from './auth-events.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { LoginThrottleService } from './login-throttle.service.js';
import { PasswordLinkService } from './password-link.service.js';
import { PasswordTokenService } from './password-token.service.js';
import { ProfileService } from './profile.service.js';
import { RateLimitGuard, RateLimiter } from './rate-limit.js';
import { SessionService } from './session.service.js';

/**
 * Authentication (spec 01, section 7). `AuthGuard` is the global guard of every HTTP route; tests
 * that use the stub authentication override it (test/support/test-app.ts).
 */
@Global()
@Module({
  controllers: [AuthController, AdminAuthController],
  providers: [
    AccessTokenService,
    AuthEvents,
    AuthGuard,
    { provide: APP_GUARD, useExisting: AuthGuard },
    AuthService,
    LoginThrottleService,
    PasswordLinkService,
    PasswordTokenService,
    ProfileService,
    RateLimiter,
    RateLimitGuard,
    SessionService,
  ],
  exports: [AuthEvents, AuthService, PasswordLinkService, SessionService, RateLimiter],
})
export class AuthModule {}
