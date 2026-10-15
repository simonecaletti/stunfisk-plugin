import { loadSettings, saveSettings, serviceUrl, settingsProblems } from '@stunfisk-plugin/common';
import type { Analysis, Capabilities, Settings, Side, StorageLike } from '@stunfisk-plugin/common';
import { findBattleRoom, readOpenBattle } from './host.ts';
import type { HostWindow, OpenBattle } from './host.ts';
import { ServiceClient, ServiceError } from './serviceClient.ts';
import type { FetchLike } from './serviceClient.ts';

export type Connection = 'signed-out' | 'code-sent' | 'signed-in';

export interface ViewState {
  settings: Settings;
  problems: string[];
  connection: Connection;
  capabilities: Capabilities | null;
  following: string | null;
  analysis: Analysis | null;
  status: string;
  message: string;
}

export interface ControllerOptions {
  host: HostWindow;
  storage: StorageLike;
  fetch: FetchLike;
  /** Milliseconds between looks at the open battle. */
  tickMs?: number;
  /** Seconds the service may hold a poll open. */
  pollSeconds?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (id: unknown) => void;
}

const tokenKey = (url: string) => `stunfisk-plugin:token:${url}`;

/**
 * Follows the battle in front of the user and keeps the service's copy of it up to date.
 *
 * Every tick it reads the open battle's line list and request from the host and sends only what the service has not
 * seen. The service answers by polling. Nothing the user is shown is ever sent back to Showdown.
 */
export class HelperController {
  private o: Required<Omit<ControllerOptions, 'host' | 'storage' | 'fetch'>> & Pick<ControllerOptions, 'host' | 'storage' | 'fetch'>;
  private api: ServiceClient;
  private listeners = new Set<(v: ViewState) => void>();
  private timer: unknown = null;
  private ticking = false;
  private pendingEmail = '';

  private settings: Settings;
  private connection: Connection = 'signed-out';
  private capabilities: Capabilities | null = null;
  private analysis: Analysis | null = null;
  private status = 'idle';
  private message = '';

  private following: string | null = null;
  private session: { id: string; sent: number; lastRequest: string; side: Side | null; poll: AbortController } | null = null;

  constructor(options: ControllerOptions) {
    this.o = {
      tickMs: 500, pollSeconds: 20,
      setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (id) => clearInterval(id as never),
      ...options,
    };
    this.settings = loadSettings(options.storage);
    this.api = new ServiceClient(options.fetch, () => serviceUrl(this.settings), () => this.token());
  }

  // --- state for the UI -------------------------------------------------------------

  view(): ViewState {
    return {
      settings: this.settings, problems: settingsProblems(this.settings), connection: this.connection,
      capabilities: this.capabilities, following: this.following, analysis: this.analysis, status: this.status, message: this.message,
    };
  }

  subscribe(fn: (v: ViewState) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private emit(): void {
    const v = this.view();
    this.listeners.forEach((fn) => fn(v));
  }

  private say(message: string): void {
    this.message = message;
    this.emit();
  }

  // --- lifecycle --------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.timer) return;
    await this.resume();
    this.timer = this.o.setInterval(() => void this.tick(), this.o.tickMs);
  }

  async stop(): Promise<void> {
    if (this.timer) this.o.clearInterval(this.timer);
    this.timer = null;
    await this.endSession();
  }

  /** Called at start and after settings change: checks the stored token against the chosen service. */
  private async resume(): Promise<void> {
    this.analysis = null;
    this.capabilities = null;
    if (settingsProblems(this.settings).length || !this.token()) {
      this.connection = this.pendingEmail ? 'code-sent' : 'signed-out';
      return this.emit();
    }
    try {
      await this.api.me();
      this.connection = 'signed-in';
      this.capabilities = await this.api.capabilities();
      this.message = '';
    } catch (error) {
      this.handle(error);
    }
    this.emit();
  }

  private token(): string | null {
    try {
      return this.o.storage.getItem(tokenKey(serviceUrl(this.settings)));
    } catch {
      return null;
    }
  }

  private setToken(value: string | null): void {
    const key = tokenKey(serviceUrl(this.settings));
    this.o.storage.setItem(key, value ?? '');
  }

  private handle(error: unknown): void {
    if (error instanceof ServiceError && error.status === 401 && this.connection === 'signed-in') {
      this.setToken(null);
      this.connection = 'signed-out';
      this.session = null;
      this.message = 'Your sign-in expired. Sign in again.';
    } else if (error instanceof ServiceError && error.status === 401) {
      this.connection = 'signed-out';
      this.message = error.message;
    } else {
      this.message = error instanceof Error ? error.message : String(error);
    }
  }

  // --- settings and sign-in ---------------------------------------------------------

  async updateSettings(patch: Partial<Settings>): Promise<void> {
    const before = this.settings;
    this.settings = { ...this.settings, ...patch };
    saveSettings(this.o.storage, this.settings);
    const serviceChanged = before.run_mode !== this.settings.run_mode || before.local_url !== this.settings.local_url || before.remote_url !== this.settings.remote_url;
    const sessionChanged = serviceChanged || before.model !== this.settings.model || before.engine !== this.settings.engine || before.analysis_mode !== this.settings.analysis_mode;
    if (sessionChanged) await this.endSession();
    if (serviceChanged) await this.resume();
    else this.emit();
  }

  async requestCode(email: string): Promise<void> {
    this.settings = { ...this.settings, email: email.trim() };
    saveSettings(this.o.storage, this.settings);
    const problems = settingsProblems(this.settings);
    if (!this.settings.email) return this.say('Enter your email address.');
    if (problems.length) return this.say(problems[0]);
    try {
      await this.api.requestCode(this.settings.email);
      this.pendingEmail = this.settings.email;
      this.connection = 'code-sent';
      this.say(this.settings.run_mode === 'local' ? 'Look for the code in the terminal where the service is running.' : 'We sent a code to your email.');
    } catch (error) {
      this.handle(error);
      this.emit();
    }
  }

  async verifyCode(code: string): Promise<void> {
    try {
      const result = await this.api.verify(this.pendingEmail || this.settings.email, code.trim());
      this.setToken(result.token);
      this.pendingEmail = '';
      this.connection = 'signed-in';
      this.message = '';
      this.capabilities = await this.api.capabilities();
      this.emit();
    } catch (error) {
      this.handle(error);
      this.emit();
    }
  }

  async signOut(): Promise<void> {
    this.pendingEmail = '';
    await this.endSession();
    try {
      this.setToken(null);
    } catch { /* settings may be invalid; there is then no token to clear */ }
    this.connection = 'signed-out';
    this.capabilities = null;
    this.analysis = null;
    this.emit();
  }

  // --- following the battle ---------------------------------------------------------

  /** Looks at the open battle once. The host may call this on its own events; the timer calls it too. */
  async tick(): Promise<void> {
    if (this.ticking || this.connection !== 'signed-in' || settingsProblems(this.settings).length) return;
    this.ticking = true;
    try {
      const roomId = findBattleRoom(this.o.host, this.following);
      if (roomId !== this.following) {
        await this.endSession();
        this.following = roomId;
        this.analysis = null;
        this.emit();
      }
      const battle = roomId ? readOpenBattle(this.o.host, roomId) : null;
      if (!battle) return;
      if (!this.session) await this.begin(battle);
      if (this.session) await this.sync(battle);
    } catch (error) {
      this.handle(error);
      this.emit();
    } finally {
      this.ticking = false;
    }
  }

  private async begin(battle: OpenBattle): Promise<void> {
    const created = await this.api.createSession({
      room: battle.roomId, format: battle.format, user: battle.user,
      model: this.settings.model, engine: this.settings.engine, analysis_mode: this.settings.analysis_mode,
    });
    const poll = new AbortController();
    this.session = { id: created.id, sent: 0, lastRequest: '', side: null, poll };
    this.message = '';
    void this.pollLoop(created.id, poll);
  }

  private async sync(battle: OpenBattle): Promise<void> {
    const s = this.session!;
    if (battle.side) s.side = battle.side;
    const request = JSON.stringify(battle.request);
    const lines = battle.lines.slice(s.sent);
    if (battle.lines.length < s.sent) {
      // The client's list shrank (a rewound replay): start the service over.
      await this.endSession();
      return;
    }
    if (!lines.length && request === s.lastRequest) return;
    try {
      const ack = await this.api.sendEvents(s.id, { from: s.sent, lines, side: s.side, request: battle.request });
      s.sent = ack.lines === s.sent + lines.length ? ack.lines : s.sent + lines.length;
      s.lastRequest = request;
    } catch (error) {
      if (error instanceof ServiceError && error.status === 409) {
        s.sent = Number(error.body.have ?? 0); // resend from where the service is
        return;
      }
      if (error instanceof ServiceError && (error.status === 404 || error.status === 410)) {
        await this.endSession(); // the service lost the session; a new tick makes another
        return;
      }
      throw error;
    }
  }

  private async pollLoop(id: string, abort: AbortController): Promise<void> {
    let revision = 0;
    while (!abort.signal.aborted && this.session?.id === id) {
      try {
        const view = await this.api.poll(id, revision, this.o.pollSeconds, abort.signal);
        if (abort.signal.aborted) return;
        this.status = view.status;
        const fresh = view.revision > revision;
        if (fresh) {
          revision = view.revision;
          this.analysis = view.analysis;
        }
        this.message = view.status === 'error' ? view.error ?? 'The analysis failed.' : '';
        this.emit();
        // A poll that returns at once (nothing new) must not spin.
        if (!fresh && view.status !== 'analysing') await new Promise((r) => setTimeout(r, 250));
      } catch (error) {
        if (abort.signal.aborted) return;
        if (error instanceof ServiceError && (error.status === 404 || error.status === 410)) {
          if (this.session?.id === id) this.session = null;
          return;
        }
        this.handle(error);
        this.emit();
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  private async endSession(): Promise<void> {
    const s = this.session;
    this.session = null;
    this.status = 'idle';
    if (!s) return;
    s.poll.abort();
    try {
      await this.api.closeSession(s.id);
    } catch { /* already gone */ }
  }
}
