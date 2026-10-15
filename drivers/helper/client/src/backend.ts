import { loadSettings, parseSettings, saveSettings, serviceUrl, settingsProblems } from '@stunfisk-plugin/common';
import type { Settings, StorageLike } from '@stunfisk-plugin/common';

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface Reply {
  status: number;
  body: Record<string, unknown>;
}

/** Thrown when a request fails before the service answers: no network, a bad address, or an abort. */
export class NetworkError extends Error {
  aborted: boolean;
  constructor(message: string, aborted = false) {
    super(message);
    this.name = aborted ? 'AbortError' : 'NetworkError';
    this.aborted = aborted;
  }
}

/**
 * Everything the controller needs from outside the page: where settings live, and how to reach the service.
 *
 * The sign-in token is not part of this interface on purpose. A backend keeps it and attaches it itself, so the code
 * that shows the panel never holds it. A successful `/v1/auth/verify` reply reaches the caller without its token.
 */
export interface Backend {
  getSettings(): Promise<Settings>;
  /** Merges known string fields into the stored settings and returns the result. Does not reject invalid values. */
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  /** Forgets the sign-in for the currently chosen service. */
  signOut(): Promise<void>;
  /** `path` is relative to the service, for example `/v1/me`. Throws NetworkError if the service cannot be reached. */
  request(method: Method, path: string, body?: unknown, signal?: AbortSignal): Promise<Reply>;
}

type FetchResponse = { status: number; json(): Promise<unknown> };
export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<FetchResponse>;

const TOKENS = 'stunfisk-plugin:tokens';

/** Settings in a Storage, requests with fetch, and the token in the same Storage. For tests and for a page with no extension. */
export class DirectBackend implements Backend {
  private storage: StorageLike;
  private fetchFn: FetchFn;

  constructor(options: { storage: StorageLike; fetch: FetchFn }) {
    this.storage = options.storage;
    this.fetchFn = options.fetch;
  }

  async getSettings(): Promise<Settings> {
    return loadSettings(this.storage);
  }

  async setSettings(patch: Partial<Settings>): Promise<Settings> {
    const next = parseSettings({ ...loadSettings(this.storage), ...patch });
    saveSettings(this.storage, next);
    return next;
  }

  private tokens(): Record<string, string> {
    try {
      return JSON.parse(this.storage.getItem(TOKENS) || '{}');
    } catch {
      return {};
    }
  }

  async signOut(): Promise<void> {
    const settings = loadSettings(this.storage);
    if (settingsProblems(settings).length) return;
    const tokens = this.tokens();
    delete tokens[serviceUrl(settings)];
    this.storage.setItem(TOKENS, JSON.stringify(tokens));
  }

  async request(method: Method, path: string, body?: unknown, signal?: AbortSignal): Promise<Reply> {
    const settings = loadSettings(this.storage);
    const problems = settingsProblems(settings);
    if (problems.length) throw new NetworkError(problems[0]);
    const base = serviceUrl(settings);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = this.tokens()[base];
    if (token) headers.Authorization = `Bearer ${token}`;
    let response: FetchResponse;
    try {
      response = await this.fetchFn(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
    } catch (error) {
      if ((error as { name?: string }).name === 'AbortError') throw new NetworkError('aborted', true);
      throw new NetworkError(`Cannot reach the service at ${base}. Is it running?`);
    }
    let data: Record<string, unknown> = {};
    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch { /* an empty or non-JSON body */ }
    if ((path === '/v1/auth/verify' || path === '/v1/auth/username/approve') && response.status === 200 && typeof data.token === 'string') {
      const tokens = this.tokens();
      tokens[base] = data.token;
      this.storage.setItem(TOKENS, JSON.stringify(tokens));
      delete data.token;
    }
    return { status: response.status, body: data };
  }
}
