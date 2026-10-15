// The page script cannot use extension APIs, so it asks the extension through window messages: page script -> relay
// (content script, isolated world) -> background. Requests carry a service-relative path, never a URL and never a token.

import type { Settings } from '@stunfisk-plugin/common';
import { NetworkError } from '../backend.ts';
import type { Backend, Method, Reply } from '../backend.ts';

export const CHANNEL = 'stunfisk-coach';

export type BridgeRequest =
  | { op: 'hello' }
  | { op: 'getSettings' }
  | { op: 'setSettings'; patch: Record<string, unknown> }
  | { op: 'signOut' }
  | { op: 'call'; callId: string; method: Method; path: string; body?: unknown }
  | { op: 'abort'; callId: string };

export type BridgeResponse<T = unknown> = { ok: true; value: T } | { ok: false; error: string; aborted?: boolean };

export interface Envelope {
  channel: typeof CHANNEL;
  dir: 'req' | 'res' | 'ready';
  id?: string;
  payload?: unknown;
}

/** What the page and the relay need from `window`. */
export interface MessageHost {
  postMessage(data: unknown, targetOrigin: string): void;
  addEventListener(type: 'message', fn: (event: { data: unknown; source: unknown; origin: string }) => void): void;
  removeEventListener(type: 'message', fn: (event: { data: unknown; source: unknown; origin: string }) => void): void;
  location: { origin: string };
}

export function isEnvelope(data: unknown): data is Envelope {
  return !!data && typeof data === 'object' && (data as Envelope).channel === CHANNEL;
}

/** A Backend that lives in the extension: settings and the sign-in token stay there, and the page only ever sees replies. */
export class BridgeBackend implements Backend {
  private win: MessageHost;
  private pending = new Map<string, (r: BridgeResponse) => void>();
  private next = 0;

  private constructor(win: MessageHost) {
    this.win = win;
    win.addEventListener('message', (event) => {
      if (event.source !== win || !isEnvelope(event.data) || event.data.dir !== 'res' || !event.data.id) return;
      const done = this.pending.get(event.data.id);
      if (done) {
        this.pending.delete(event.data.id);
        done(event.data.payload as BridgeResponse);
      }
    });
  }

  /** Returns a backend if the extension's relay answers within `ms`, else null (the page then has no extension). */
  static async detect(win: MessageHost, ms = 2000, every = 100): Promise<BridgeBackend | null> {
    const backend = new BridgeBackend(win);
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const reply = await backend.send({ op: 'hello' }, Math.min(every, Math.max(1, end - Date.now())));
      if (reply?.ok) return backend;
    }
    return null;
  }

  private send<T>(payload: BridgeRequest, timeoutMs = 0): Promise<BridgeResponse<T> | null> {
    const id = `r${++this.next}`;
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      this.pending.set(id, (r) => {
        if (timer) clearTimeout(timer);
        resolve(r as BridgeResponse<T>);
      });
      if (timeoutMs) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          resolve(null);
        }, timeoutMs);
      }
      const envelope: Envelope = { channel: CHANNEL, dir: 'req', id, payload };
      this.win.postMessage(envelope, this.win.location.origin);
    });
  }

  private async ask<T>(payload: BridgeRequest): Promise<T> {
    const reply = await this.send<T>(payload);
    if (!reply || !reply.ok) throw new Error(reply && !reply.ok ? reply.error : 'The extension did not answer.');
    return reply.value;
  }

  getSettings(): Promise<Settings> {
    return this.ask({ op: 'getSettings' });
  }

  setSettings(patch: Partial<Settings>): Promise<Settings> {
    return this.ask({ op: 'setSettings', patch });
  }

  async signOut(): Promise<void> {
    await this.ask({ op: 'signOut' });
  }

  async request(method: Method, path: string, body?: unknown, signal?: AbortSignal): Promise<Reply> {
    const callId = `c${++this.next}`;
    if (signal?.aborted) throw new NetworkError('aborted', true);
    const onAbort = () => void this.send({ op: 'abort', callId });
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const reply = await this.send<Reply>({ op: 'call', callId, method, path, body });
      if (!reply) throw new NetworkError('The extension did not answer.');
      if (!reply.ok) throw new NetworkError(reply.error, !!reply.aborted);
      return reply.value;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
