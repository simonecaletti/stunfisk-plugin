// Reads the battle the user has open, straight from the Showdown client in this page. Nothing is pasted or linked.
//
// Both client generations keep the same two things per battle room: `room.battle.stepQueue`, every protocol line the
// battle has received, and `room.request`, the private request for the player. They differ in where the rooms live:
// the classic client in `window.app`, the rewritten Preact client in `window.PS`. (Showdex reads the same fields.)

import type { Side } from '@stunfisk-plugin/common';

interface RoomLike {
  id?: string;
  battle?: { stepQueue?: unknown; ended?: boolean; id?: string } | null;
  request?: unknown;
}

export interface HostWindow {
  app?: { receive?: unknown; curRoom?: RoomLike | null; curSideRoom?: RoomLike | null; rooms?: Record<string, RoomLike>; user?: { get?(k: string): unknown; attributes?: { name?: string } } };
  PS?: { join?: unknown; room?: RoomLike | null; rooms?: Record<string, RoomLike>; user?: { name?: string } };
}

/**
 * Whether this page is a Showdown client, the official one or one served from your own computer.
 * Only a client has `app.receive` (classic) or `PS.join` (rewritten) next to its room list.
 */
export function hasShowdownClient(host: HostWindow): boolean {
  const app = host.app;
  const ps = host.PS;
  return !!(app && typeof app.receive === 'function' && app.rooms) || !!(ps && typeof ps.join === 'function' && ps.rooms);
}

/** Waits for the client to finish starting. Resolves false if this page never becomes one. */
export async function waitForShowdownClient(host: HostWindow, timeoutMs = 60_000, everyMs = 250): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (hasShowdownClient(host)) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return hasShowdownClient(host);
}

export interface OpenBattle {
  roomId: string;
  format: string;
  /** Every protocol line so far, in order. */
  lines: string[];
  /** The private request as the client holds it, or null (spectating, or between decisions). */
  request: Record<string, unknown> | null;
  /** Which side the request says we play, if it says. */
  side: Side | null;
  user: string;
  ended: boolean;
}

const BATTLE_ROOM = /^battle-[a-z0-9-]+$/;

/** `battle-gen9vgc2026regmc-123456` or `battle-gen9vgc2026regmc-123456-token` -> `gen9vgc2026regmc`. */
export function formatFromRoom(roomId: string): string {
  const m = /^battle-(.+?)-\d+(?:-[a-z0-9]+)?$/.exec(roomId);
  return m ? m[1] : '';
}

function isBattleRoom(room: RoomLike | null | undefined): room is RoomLike & { id: string } {
  return !!room && typeof room.id === 'string' && BATTLE_ROOM.test(room.id) && !!room.battle && Array.isArray(room.battle.stepQueue);
}

/** The rooms to consider, foreground first. */
function candidateRooms(host: HostWindow): (RoomLike | null | undefined)[] {
  if (host.PS?.rooms) return [host.PS.room, ...Object.values(host.PS.rooms)];
  if (host.app?.rooms) return [host.app.curRoom, host.app.curSideRoom, ...Object.values(host.app.rooms)];
  return [];
}

/** The battle to follow: the one in front, else the one already followed if it is still open, else the first open. */
export function findBattleRoom(host: HostWindow, following: string | null): string | null {
  const [front] = candidateRooms(host);
  if (isBattleRoom(front)) return front.id;
  const rooms = candidateRooms(host).filter(isBattleRoom);
  if (following && rooms.some((r) => r.id === following)) return following;
  return rooms.length ? rooms[0].id : null;
}

function roomById(host: HostWindow, id: string): RoomLike | undefined {
  return host.PS?.rooms?.[id] ?? host.app?.rooms?.[id];
}

function userName(host: HostWindow): string {
  return host.PS?.user?.name ?? host.app?.user?.attributes?.name ?? '';
}

export function readOpenBattle(host: HostWindow, roomId: string): OpenBattle | null {
  const room = roomById(host, roomId);
  if (!isBattleRoom(room)) return null;
  const queue = room.battle!.stepQueue as unknown[];
  const request = room.request && typeof room.request === 'object' ? (room.request as Record<string, unknown>) : null;
  const sideId = (request?.side as { id?: string } | undefined)?.id;
  return {
    roomId,
    format: formatFromRoom(roomId),
    lines: queue.filter((l): l is string => typeof l === 'string'),
    request,
    side: sideId === 'p1' || sideId === 'p2' ? sideId : null,
    user: userName(host),
    ended: !!room.battle!.ended,
  };
}
