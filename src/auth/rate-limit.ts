import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  applyDecorators,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiTooManyRequestsResponse } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { AppError } from '../errors/app-error.js';
import { ErrorResponseSchema } from '../errors/error-response.schema.js';

export interface RateLimitRule {
  /** Bucket name: routes with the same name share the counter. */
  name: string;
  limit: number;
  windowMs: number;
}

/** Login of any profile: 20 attempts per minute per IP (staff of a stall may share one IP). */
export const LOGIN_RATE_LIMIT: RateLimitRule = { name: 'login', limit: 20, windowMs: 60_000 };
/** "Esqueci a senha": 5 requests per 15 minutes per IP. */
export const FORGOT_RATE_LIMIT: RateLimitRule = { name: 'forgot', limit: 5, windowMs: 15 * 60_000 };
/** Lookups of establishment codes: 30 per minute per IP (codes must not be enumerable). */
export const ACCESS_CODE_RATE_LIMIT: RateLimitRule = {
  name: 'access-code',
  limit: 30,
  windowMs: 60_000,
};
/** Password change and reset with a token: 10 per 15 minutes per IP. */
export const PASSWORD_RATE_LIMIT: RateLimitRule = {
  name: 'password',
  limit: 10,
  windowMs: 15 * 60_000,
};

interface Window {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window counters per IP, kept IN MEMORY of this API instance: they reset on restart and are
 * not shared between instances. Enough for the single instance of the MVP; a second instance would
 * need the counters in Postgres. The per-identifier lock of section 7.3 is in the database
 * ({@link LoginThrottleService}), so it does not depend on this.
 */
@Injectable()
export class RateLimiter {
  private readonly windows = new Map<string, Window>();
  private lastSweep = 0;

  /** Counts a hit; returns the seconds to wait when over the limit, or 0. */
  hit(rule: RateLimitRule, client: string, now = Date.now()): number {
    this.sweep(now);
    const key = `${rule.name}:${client}`;
    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + rule.windowMs };
      this.windows.set(key, window);
    }
    window.count += 1;
    return window.count > rule.limit ? Math.ceil((window.resetAt - now) / 1000) : 0;
  }

  /** Tests only: forget every counter. */
  reset(): void {
    this.windows.clear();
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) {
      return;
    }
    this.lastSweep = now;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) {
        this.windows.delete(key);
      }
    }
  }
}

const RATE_LIMIT_RULE = Symbol('RATE_LIMIT_RULE');

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimiter,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const rule = this.reflector.get<RateLimitRule | undefined>(
      RATE_LIMIT_RULE,
      context.getHandler(),
    );
    if (!rule || context.getType() !== 'http') {
      return true;
    }
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const retryAfter = this.limiter.hit(rule, request.ip ?? 'unknown');
    if (retryAfter > 0) {
      http.getResponse<Response>().setHeader('Retry-After', String(retryAfter));
      throw AppError.of('RATE_LIMITED', { details: { retryAfterSeconds: retryAfter } });
    }
    return true;
  }
}

/** Limits a route per client IP (in memory, see {@link RateLimiter}). */
export function RateLimit(rule: RateLimitRule, description?: string): MethodDecorator {
  return applyDecorators(
    SetMetadata(RATE_LIMIT_RULE, rule),
    UseGuards(RateLimitGuard),
    ApiTooManyRequestsResponse({
      description:
        description ??
        `\`RATE_LIMITED\`: mais de ${rule.limit} requisições em ${rule.windowMs / 1000} s deste IP.`,
      standardSchema: ErrorResponseSchema,
    }),
  );
}
