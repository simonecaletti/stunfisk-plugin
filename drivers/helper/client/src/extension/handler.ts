// The background side of the bridge. It owns the settings and the sign-in token, and is the only code that calls the service.

import { parseSettings, serviceUrl, settingsProblems } from '@stunfisk-plugin/common';
import type { Settings } from '@stunfisk-plugin/common';
import type { BridgeRequest, BridgeResponse } from './bridge.ts';

export interface HandlerDeps {
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
  };
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) =>
    Promise<{ status: number; json(): Promise<unknown> }>;
}

const SETTINGS = 'settings';
const TOKENS = 'tokens';

/** The only paths the page may ask for. Anything else is refused, so the bridge is not a general proxy. */
const ALLOWED = /^\/v1\/(auth\/(request|verify|username\/(start|approve))|me|me\/showdown\/seen|status|capabilities|helper\/sessions(\/[0-9a-f]{16}(\/events)?)?)(\?[A-Za-z0-9=&._-]*)?$/;
const METHODS = new Set(['GET', 'POST', 'DELETE']);

export function createHandler(deps: HandlerDeps) {
  const inflight = new Map<string, AbortController>();

  const settings = async (): Promise<Settings> => parseSettings(await deps.storage.get(SETTINGS));
  const tokens = async (): Promise<Record<string, string>> => {
    const value = await deps.storage.get(TOKENS);
    return value && typeof value === 'object' ? (value as Record<string, string>) : {};
  };

  return async function handle(request: BridgeRequest): Promise<BridgeResponse> {
    try {
      switch (request?.op) {
        case 'hello':
          return { ok: true, value: 'coach' };
        case 'getSettings':
          return { ok: true, value: await settings() };
        case 'setSettings': {
          const next = parseSettings({ ...(await settings()), ...(request.patch ?? {}) });
          await deps.storage.set(SETTINGS, next);
          return { ok: true, value: next };
        }
        case 'signOut': {
          const current = await settings();
          if (!settingsProblems(current).length) {
            const all = await tokens();
            delete all[serviceUrl(current)];
            await deps.storage.set(TOKENS, all);
          }
          return { ok: true, value: null };
        }
        case 'abort':
          inflight.get(request.callId)?.abort();
          return { ok: true, value: null };
        case 'call':
          return await call(request);
        default:
          return { ok: false, error: 'Unknown request.' };
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  async function call(request: Extract<BridgeRequest, { op: 'call' }>): Promise<BridgeResponse> {
    if (!METHODS.has(request.method) || typeof request.path !== 'string' || !ALLOWED.test(request.path)) {
      return { ok: false, error: 'That request is not allowed.' };
    }
    if (typeof request.callId !== 'string' || !request.callId) return { ok: false, error: 'Missing call id.' };
    const current = await settings();
    const problems = settingsProblems(current);
    if (problems.length) return { ok: false, error: problems[0] };
    const base = serviceUrl(current);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = (await tokens())[base];
    if (token) headers.Authorization = `Bearer ${token}`;
    const abort = new AbortController();
    inflight.set(request.callId, abort);
    try {
      const response = await deps.fetch(base + request.path, {
        method: request.method, headers, signal: abort.signal,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
      });
      let body: Record<string, unknown> = {};
      try {
        body = (await response.json()) as Record<string, unknown>;
      } catch { /* an empty or non-JSON body */ }
      if ((request.path === '/v1/auth/verify' || request.path === '/v1/auth/username/approve') && response.status === 200 && typeof body.token === 'string') {
        const all = await tokens();
        all[base] = body.token;
        await deps.storage.set(TOKENS, all);
        delete body.token; // the page never sees it
      }
      return { ok: true, value: { status: response.status, body } };
    } catch (error) {
      if (abort.signal.aborted || (error as { name?: string }).name === 'AbortError') return { ok: false, error: 'aborted', aborted: true };
      return { ok: false, error: `Cannot reach the service at ${base}. Is it running?` };
    } finally {
      inflight.delete(request.callId);
    }
  }
}
