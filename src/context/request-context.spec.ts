import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import {
  currentOrganizationId,
  getRequestContext,
  RequestContextError,
  requireOrganizationId,
  runWithContext,
  setAuthContext,
  systemContext,
} from './request-context.js';

const ORG_A = '01900000-0000-7000-8000-00000000000a';
const ORG_B = '01900000-0000-7000-8000-00000000000b';

describe('request context (spec 01, section 6)', () => {
  it('is empty outside a context', () => {
    expect(getRequestContext()).toBeUndefined();
    expect(currentOrganizationId()).toBeNull();
    expect(() => requireOrganizationId()).toThrow(RequestContextError);
  });

  it('keeps concurrent requests apart across awaits', async () => {
    const run = (organizationId: string, delay: number) =>
      runWithContext(systemContext(), async () => {
        setAuthContext({ organizationId, actor: { type: 'staff', id: organizationId } });
        await sleep(delay);
        return currentOrganizationId();
      });
    await expect(Promise.all([run(ORG_A, 20), run(ORG_B, 5)])).resolves.toEqual([ORG_A, ORG_B]);
  });

  it('accepts the auth context only once, so nothing later can swap the organization', () => {
    runWithContext(systemContext(), () => {
      setAuthContext({ organizationId: ORG_A, actor: { type: 'owner', id: ORG_A } });
      expect(() => {
        setAuthContext({ organizationId: ORG_B, actor: { type: 'owner', id: ORG_B } });
      }).toThrow(/already set/);
      expect(requireOrganizationId()).toBe(ORG_A);
    });
  });

  it('freezes the auth context', () => {
    runWithContext(systemContext(), () => {
      setAuthContext({ organizationId: ORG_A, actor: { type: 'owner', id: ORG_A } });
      const auth = getRequestContext()?.auth;
      expect(Object.isFrozen(auth)).toBe(true);
      expect(Object.isFrozen(auth?.actor)).toBe(true);
    });
  });

  it('refuses setAuthContext outside a context', () => {
    expect(() => {
      setAuthContext({ organizationId: ORG_A, actor: { type: 'owner', id: ORG_A } });
    }).toThrow(RequestContextError);
  });
});
