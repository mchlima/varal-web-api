import { z } from 'zod';

/**
 * Rooms of the real-time channel (spec 01, section 10):
 * - `unit:{unitId}`: everything that happens in the unit (counter and owner's panel);
 * - `station:{stationId}`: items that enter, change or leave the queue of a station.
 *
 * Ids are UUIDs, unique across organizations, so a room name never mixes two organizations. The
 * server only puts a socket in the rooms its user may access (`RealtimeAccessService`).
 */
export type RoomKind = 'unit' | 'station';

export interface RoomRef {
  kind: RoomKind;
  id: string;
}

export function unitRoom(unitId: string): string {
  return `unit:${unitId}`;
}

export function stationRoom(stationId: string): string {
  return `station:${stationId}`;
}

/**
 * Internal room with every socket of one session, used to end them all at once (logout, password
 * change or reset, deactivation). Clients can never join it: {@link parseRoom} accepts only
 * `unit:` and `station:`.
 */
export function sessionRoom(sessionId: string): string {
  return `session:${sessionId}`;
}

const ROOM_PATTERN = /^(unit|station):(.+)$/;
const uuidSchema = z.uuid();

/** Parses a room name sent by the client; null when it is not a `unit:` or `station:` room. */
export function parseRoom(value: unknown): RoomRef | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = ROOM_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const [, kind, id] = match;
  const parsed = uuidSchema.safeParse(id);
  if (!parsed.success) {
    return null;
  }
  return { kind: kind as RoomKind, id: parsed.data.toLowerCase() };
}

export function roomName(room: RoomRef): string {
  return room.kind === 'unit' ? unitRoom(room.id) : stationRoom(room.id);
}

/** True for the rooms a client sees (`unit:` and `station:`), false for internal ones. */
export function isPublicRoom(name: string): boolean {
  return name.startsWith('unit:') || name.startsWith('station:');
}
