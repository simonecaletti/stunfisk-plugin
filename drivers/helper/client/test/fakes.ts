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

// --- the extension bridge, in one process ---------------------------------------------------------------------

import { createHandler } from '../src/extension/handler.ts';
import type { HandlerDeps } from '../src/extension/handler.ts';
import { BridgeBackend } from '../src/extension/bridge.ts';
import type { BridgeRequest, MessageHost } from '../src/extension/bridge.ts';
import { startRelay } from '../src/extension/relay.ts';

type Listener = (event: { data: unknown; source: unknown; origin: string }) => void;

/** A window that delivers its own postMessage asynchronously to its own listeners, as a browser does. */
export class FakeWindow implements MessageHost {
  location = { origin: 'https://play.pokemonshowdown.com' };
  seen: unknown[] = [];
  private listeners: Listener[] = [];
  postMessage(data: unknown, _origin: string): void {
    this.seen.push(data);
    queueMicrotask(() => this.listeners.forEach((fn) => fn({ data, source: this, origin: this.location.origin })));
  }
  /** A message from someone else: another window, or another origin. */
  inject(data: unknown, source: unknown, origin: string): void {
    this.listeners.forEach((fn) => fn({ data, source, origin }));
  }
  addEventListener(_type: 'message', fn: Listener): void { this.listeners.push(fn); }
  removeEventListener(_type: 'message', fn: Listener): void { this.listeners = this.listeners.filter((l) => l !== fn); }
}

export function memoryExtensionStorage() {
  const data = new Map<string, unknown>();
  return { data, get: async (k: string) => data.get(k), set: async (k: string, v: unknown) => void data.set(k, structuredClone(v)) };
}

export type FetchStub = HandlerDeps['fetch'];

/** The whole chain: page-side BridgeBackend -> relay -> background handler, with `fetch` and storage supplied. */
export async function wireBridge(fetchImpl: FetchStub, storage = memoryExtensionStorage()) {
  const win = new FakeWindow();
  const handler = createHandler({ storage, fetch: fetchImpl });
  const forwarded: BridgeRequest[] = [];
  startRelay(win, async (req) => { forwarded.push(req); return handler(req); });
  const backend = await BridgeBackend.detect(win, 500, 20);
  if (!backend) throw new Error('bridge did not come up');
  return { win, backend, storage, forwarded, handler };
}
