import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { readCookie } from './realtime-auth.js';
import { defineRealtimeEvent } from './realtime.contracts.js';
import { isAllowedOrigin, realtimeServerOptions } from './realtime-io.adapter.js';
import { isPublicRoom, parseRoom, roomName, sessionRoom } from './rooms.js';

const UUID = '01922f2c-7a3b-7c00-8000-0000000000e1';

describe('rooms (spec 01, section 10)', () => {
  it('parses unit and station rooms, normalizing the id', () => {
    expect(parseRoom(`unit:${UUID}`)).toEqual({ kind: 'unit', id: UUID });
    expect(parseRoom(`station:${UUID.toUpperCase()}`)).toEqual({ kind: 'station', id: UUID });
    expect(roomName({ kind: 'station', id: UUID })).toBe(`station:${UUID}`);
  });

  it('refuses internal rooms, other prefixes and malformed ids', () => {
    for (const value of [
      sessionRoom(UUID),
      `organization:${UUID}`,
      'unit:abc',
      `unit:${UUID}:x`,
      ` unit:${UUID}`,
      42,
      null,
    ]) {
      expect(parseRoom(value)).toBeNull();
    }
    expect(isPublicRoom(sessionRoom(UUID))).toBe(false);
    expect(isPublicRoom(`unit:${UUID}`)).toBe(true);
  });
});

describe('readCookie', () => {
  it('reads one cookie of the header, URL-decoded', () => {
    const header = 'a=1; __Host-varal_at=eyJ.x%2Ey; b="q"';
    expect(readCookie(header, '__Host-varal_at')).toBe('eyJ.x.y');
    expect(readCookie(header, 'b')).toBe('q');
    expect(readCookie(header, 'missing')).toBeUndefined();
    expect(readCookie(undefined, 'a')).toBeUndefined();
    expect(readCookie('a=', 'a')).toBeUndefined();
    expect(readCookie('a=%E0%A4%A', 'a')).toBeUndefined();
  });

  it('does not match a cookie whose name only contains the wanted one', () => {
    expect(readCookie('x__Host-varal_at=1', '__Host-varal_at')).toBeUndefined();
  });
});

describe('server options (RN-01.20)', () => {
  const origins = ['https://varal.kratinho.com.br'];

  it('accepts only the exact origins, never a missing one', () => {
    expect(isAllowedOrigin('https://varal.kratinho.com.br', origins)).toBe(true);
    expect(isAllowedOrigin('https://varal.kratinho.com.br.evil.io', origins)).toBe(false);
    expect(isAllowedOrigin('http://varal.kratinho.com.br', origins)).toBe(false);
    expect(isAllowedOrigin(undefined, origins)).toBe(false);
  });

  it('serves /ws over WebSocket only, with credentials for the listed origins', () => {
    const options = realtimeServerOptions(origins);
    expect(options).toMatchObject({
      path: '/ws',
      transports: ['websocket'],
      pingInterval: 25_000,
      cors: { origin: origins, credentials: true },
    });
  });
});

describe('defineRealtimeEvent (RN-01.10)', () => {
  it('names the envelope Event… and validates it', () => {
    const event = defineRealtimeEvent('EventSample', 'sample.done', z.object({ n: z.int() }));
    expect(z.globalRegistry.get(event.schema)?.id).toBe('EventSample');
    const envelope = {
      type: 'sample.done',
      organizationId: UUID,
      unitId: UUID,
      occurredAt: '2026-10-01T12:00:00.000Z',
      version: 1,
      data: { n: 1 },
    };
    expect(event.schema.parse(envelope)).toEqual(envelope);
    expect(() => event.schema.parse({ ...envelope, type: 'other' })).toThrow();
    expect(() => event.schema.parse({ ...envelope, version: -1 })).toThrow();
  });
});
