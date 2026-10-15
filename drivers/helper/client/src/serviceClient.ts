import type { Analysis, Capabilities, SessionStatus } from '@stunfisk-plugin/common';
import { NetworkError } from './backend.ts';
import type { Backend } from './backend.ts';

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

export interface ShowdownLink {
  name: string;
  confirmed: boolean;
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

/** The helper service's v1 API (see drivers/helper/service/stunfisk_plugin_helper/server.py), over a Backend. */
export class ServiceClient {
  private backend: Backend;

  constructor(backend: Backend) {
    this.backend = backend;
  }

  private async call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let reply;
    try {
      reply = await this.backend.request(method, path, body, signal);
    } catch (error) {
      if (error instanceof NetworkError && error.aborted) throw error;
      if (error instanceof NetworkError) throw new ServiceError(0, error.message);
      throw error;
    }
    if (reply.status === 204) return undefined as T;
    if (reply.status < 200 || reply.status >= 300) {
      throw new ServiceError(reply.status, String(reply.body.error ?? `The service answered ${reply.status}.`), reply.body);
    }
    return reply.body as T;
  }

  requestCode(email: string): Promise<{ sent: boolean }> {
    return this.call('POST', '/v1/auth/request', { email });
  }

  verify(email: string, code: string): Promise<{ expires_at: number; email: string }> {
    return this.call('POST', '/v1/auth/verify', { email, code });
  }

  me(): Promise<{ email: string | null; username: string | null; showdown: ShowdownLink | null }> {
    return this.call('GET', '/v1/me');
  }

  /** Whether the service offers sign-in with a Showdown name. Public. */
  status(): Promise<{ username_login: boolean }> {
    return this.call('GET', '/v1/status');
  }

  startUsername(username: string): Promise<{ request: string }> {
    return this.call('POST', '/v1/auth/username/start', { username });
  }

  /** Approves a sign-in as `name`, from a browser logged in to Showdown as that name. The backend keeps the token. */
  approveUsername(name: string): Promise<{ name: string; expires_at: number }> {
    return this.call('POST', '/v1/auth/username/approve', { name });
  }

  /** Tells the service which Showdown name this browser is logged in as, which confirms a matching link. */
  seen(name: string): Promise<{ linked: boolean; match: boolean; confirmed: boolean; name?: string }> {
    return this.call('POST', '/v1/me/showdown/seen', { name });
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
