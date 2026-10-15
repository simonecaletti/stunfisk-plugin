import type { Analysis, Capabilities, SessionStatus } from '@stunfisk-plugin/common';

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) =>
  Promise<{ status: number; ok: boolean; json(): Promise<unknown>; text(): Promise<string> }>;

export class ServiceError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, message: string, body: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
    this.body = body;
  }
}

export interface CreateSession {
  room: string;
  format: string;
  user: string;
  model: string;
  engine: string;
  analysis_mode: string;
}

export interface EventsBody {
  from: number;
  lines: string[];
  side?: string | null;
  request?: Record<string, unknown> | null;
}

/** The helper service's v1 API (see drivers/helper/service/stunfisk_plugin_helper/server.py). */
export class ServiceClient {
  private fetch: FetchLike;
  private base: () => string;
  private token: () => string | null;

  constructor(fetch: FetchLike, base: () => string, token: () => string | null) {
    this.fetch = fetch;
    this.base = base;
    this.token = token;
  }

  private async call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = this.token();
    if (token) headers.Authorization = `Bearer ${token}`;
    let response;
    try {
      response = await this.fetch(this.base() + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
    } catch (error) {
      if ((error as { name?: string }).name === 'AbortError') throw error;
      throw new ServiceError(0, `Cannot reach the service at ${this.base()}. Is it running?`);
    }
    if (response.status === 204) return undefined as T;
    let data: Record<string, unknown> = {};
    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch { /* an empty or non-JSON body */ }
    if (!response.ok) throw new ServiceError(response.status, String(data.error ?? `The service answered ${response.status}.`), data);
    return data as T;
  }

  requestCode(email: string): Promise<{ sent: boolean }> {
    return this.call('POST', '/v1/auth/request', { email });
  }

  verify(email: string, code: string): Promise<{ token: string; expires_at: number; email: string }> {
    return this.call('POST', '/v1/auth/verify', { email, code });
  }

  me(): Promise<{ email: string }> {
    return this.call('GET', '/v1/me');
  }

  capabilities(): Promise<Capabilities> {
    return this.call('GET', '/v1/capabilities');
  }

  createSession(body: CreateSession): Promise<SessionStatus> {
    return this.call('POST', '/v1/helper/sessions', body);
  }

  sendEvents(id: string, body: EventsBody): Promise<{ accepted: number; lines: number }> {
    return this.call('POST', `/v1/helper/sessions/${id}/events`, body);
  }

  poll(id: string, after: number, waitSeconds: number, signal?: AbortSignal): Promise<SessionStatus> {
    return this.call('GET', `/v1/helper/sessions/${id}?after=${after}&wait=${waitSeconds}`, undefined, signal);
  }

  closeSession(id: string): Promise<void> {
    return this.call('DELETE', `/v1/helper/sessions/${id}`);
  }
}

export type { Analysis };
