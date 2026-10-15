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
  /** The rewritten client sets this for a player and leaves it empty for a spectator. */
  side?: unknown;
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
  const all = host.PS?.rooms
    ? [host.PS.room, ...Object.values(host.PS.rooms)]
    : host.app?.rooms ? [host.app.curRoom, host.app.curSideRoom, ...Object.values(host.app.rooms)] : [];
  // The room in front is also in the room list. Keep the first of each, so the front room stays first.
  return all.filter((room, i) => all.indexOf(room) === i);
}

/** True when the user plays in this room, as opposed to watching it: the client gave them a private request or a side. */
function isPlayerRoom(room: RoomLike): boolean {
  const requestSide = (room.request as { side?: { id?: unknown } } | null | undefined)?.side?.id;
  return !!requestSide || (!!room.side && typeof room.side === 'object');
}

export function openBattleRoomIds(host: HostWindow): string[] {
  return candidateRooms(host).filter(isBattleRoom).map((r) => r.id);
}

/** Rooms where the user is a player right now. */
export function playerRoomIds(host: HostWindow): string[] {
  return candidateRooms(host).filter(isBattleRoom).filter(isPlayerRoom).map((r) => r.id);
}

/**
 * The battle to follow, in order of preference: the front battle if the user plays in it; the one already followed if
 * they still play in it; any other battle they play in; then, with nothing of their own, the front battle, the one
 * already followed, or the first open.
 *
 * `known` holds rooms seen as the user's own earlier. A client drops the request between decisions, and the room must
 * not stop counting as theirs for that.
 */
export function findBattleRoom(host: HostWindow, following: string | null, known: ReadonlySet<string> = new Set()): string | null {
  const rooms = candidateRooms(host).filter(isBattleRoom);
  const mine = (r: RoomLike & { id: string }) => isPlayerRoom(r) || known.has(r.id);
  const [front] = candidateRooms(host);
  if (isBattleRoom(front) && mine(front)) return front.id;
  if (following && rooms.some((r) => r.id === following && mine(r))) return following;
  const own = rooms.find(mine);
  if (own) return own.id;
  if (isBattleRoom(front)) return front.id;
  if (following && rooms.some((r) => r.id === following)) return following;
  return rooms.length ? rooms[0].id : null;
}

function roomById(host: HostWindow, id: string): RoomLike | undefined {
  return host.PS?.rooms?.[id] ?? host.app?.rooms?.[id];
}

/** The Showdown name this page is logged in as. Empty if unknown. */
export function readUserName(host: HostWindow): string {
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
    user: readUserName(host),
    ended: !!room.battle!.ended,
  };
}
