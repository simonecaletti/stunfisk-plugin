import type { HostWindow } from '../src/host.ts';

export function memoryStorage() {
  const data = new Map<string, string>();
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

export interface FakeRoom {
  id: string;
  battle: { stepQueue: string[]; ended: boolean };
  request: Record<string, unknown> | null;
}

export function room(id: string, lines: string[] = [], request: Record<string, unknown> | null = null): FakeRoom {
  return { id, battle: { stepQueue: [...lines], ended: false }, request };
}

/** A classic-client host showing `rooms`, the first one in front. */
export function classicHost(...rooms: FakeRoom[]): HostWindow & { app: { curRoom: FakeRoom | null; rooms: Record<string, FakeRoom> } } {
  return { app: { curRoom: rooms[0] ?? null, rooms: Object.fromEntries(rooms.map((r) => [r.id, r])), user: { attributes: { name: 'Alice' } } } } as never;
}

export function preactHost(...rooms: FakeRoom[]): HostWindow {
  return { PS: { room: rooms[0] ?? null, rooms: Object.fromEntries(rooms.map((r) => [r.id, r])), user: { name: 'Alice' } } } as never;
}

export const until = async (pred: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting for condition');
};
