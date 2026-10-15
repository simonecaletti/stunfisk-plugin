import { parseSettings, settingsProblems } from '@stunfisk-plugin/common';
import type { Analysis, Capabilities, Settings, Side } from '@stunfisk-plugin/common';
import type { Backend } from './backend.ts';
import { findBattleRoom, openBattleRoomIds, playerRoomIds, readOpenBattle, readUserName } from './host.ts';
import type { HostWindow, OpenBattle } from './host.ts';
import { ServiceClient, ServiceError } from './serviceClient.ts';
import type { ShowdownLink } from './serviceClient.ts';

export type Connection = 'signed-out' | 'code-sent' | 'signed-in';

export interface ViewState {
  settings: Settings;
  problems: string[];
  connection: Connection;
  capabilities: Capabilities | null;
  following: string | null;
  /** The Showdown account linked to this Coach account on the service's website, if any. */
  link: ShowdownLink | null;
  /** Who is signed in: an email, or a Showdown name. */
  who: string;
  /** The service offers sign-in with a Showdown name. */
  usernameLogin: boolean;
  /** The name this page is logged in to Showdown as, if it is a real one. */
  browserName: string;
  analysis: Analysis | null;
  status: string;
  message: string;
}

export interface ControllerOptions {
  host: HostWindow;
  backend: Backend;
  /** Milliseconds between looks at the open battle. */
  tickMs?: number;
  /** Seconds the service may hold a poll open. */
  pollSeconds?: number;
  /** How often to tell the service our Showdown name while no link is confirmed. */
  reportEveryMs?: { unlinked: number; unconfirmed: number };
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (id: unknown) => void;
}

/** A real Showdown name, or ''. A guest ("Guest 1234") has no account to sign in as. */
function usableName(name: string): string {
  const trimmed = (name ?? '').trim();
  return trimmed && !/^guest\s*\d*$/i.test(trimmed) ? trimmed : '';
}

/**
 * Follows the battle in front of the user and keeps the service's copy of it up to date.
 *
 * Every tick it reads the open battle's line list and request from the host and sends only what the service has not
 * seen. The service answers by polling. Nothing the user is shown is ever sent back to Showdown.
 */
export class HelperController {
  private o: Required<Omit<ControllerOptions, 'host' | 'backend'>> & Pick<ControllerOptions, 'host' | 'backend'>;
  private api: ServiceClient;
  private listeners = new Set<(v: ViewState) => void>();
  private timer: unknown = null;
  private ticking = false;
  private active = false;
  /** Bumped whenever the session is dropped, so a tick that was mid-flight knows its result is stale. */
  private epoch = 0;
  private pendingEmail = '';
  private link: ShowdownLink | null = null;
  private who = '';
  private usernameLogin = false;
  private lastName = '';
  private lastApprove = 0;
  /** Battle rooms where the user was seen playing. A client drops the request between decisions. */
  private mine = new Set<string>();
  private reportedName = '';
  private reportedAt = 0;

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
      tickMs: 500, pollSeconds: 20, reportEveryMs: { unlinked: 5000, unconfirmed: 2000 },
      setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (id) => clearInterval(id as never),
      ...options,
    };
    this.settings = parseSettings(null);
    this.api = new ServiceClient(options.backend);
  }

  // --- state for the UI -------------------------------------------------------------

  view(): ViewState {
    return {
      settings: this.settings, problems: settingsProblems(this.settings), connection: this.connection,
      capabilities: this.capabilities, following: this.following, link: this.link, who: this.who,
      usernameLogin: this.usernameLogin, browserName: usableName(readUserName(this.o.host)), analysis: this.analysis, status: this.status, message: this.message,
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
    this.active = true;
    this.settings = await this.o.backend.getSettings();
    await this.resume();
    this.timer = this.o.setInterval(() => void this.tick(), this.o.tickMs);
  }

  async stop(): Promise<void> {
    this.active = false;
    if (this.timer) this.o.clearInterval(this.timer);
    this.timer = null;
    await this.endSession();
  }

  /** Called at start and after the service changes: asks the service whether we are still signed in. */
  private async resume(): Promise<void> {
    this.analysis = null;
    this.capabilities = null;
    this.usernameLogin = false;
    if (settingsProblems(this.settings).length) {
      this.connection = this.pendingEmail ? 'code-sent' : 'signed-out';
      return this.emit();
    }
    try {
      this.usernameLogin = !!(await this.api.status().catch(() => ({ username_login: false }))).username_login;
      const me = await this.api.me();
      this.link = me.showdown ?? null;
      this.who = me.email ?? me.username ?? '';
      this.connection = 'signed-in';
      this.capabilities = await this.api.capabilities();
      this.message = '';
    } catch (error) {
      if (error instanceof ServiceError && error.status === 401) {
        this.connection = this.pendingEmail ? 'code-sent' : 'signed-out'; // simply not signed in yet
        this.message = '';
      } else {
        this.handle(error);
      }
    }
    this.emit();
  }

  private handle(error: unknown): void {
    if (error instanceof ServiceError && error.status === 401 && this.connection === 'signed-in') {
      void this.o.backend.signOut();
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
    this.settings = await this.o.backend.setSettings(patch);
    const serviceChanged = before.run_mode !== this.settings.run_mode || before.local_url !== this.settings.local_url || before.remote_url !== this.settings.remote_url;
    const sessionChanged = serviceChanged || before.model !== this.settings.model || before.engine !== this.settings.engine || before.analysis_mode !== this.settings.analysis_mode;
    if (sessionChanged) await this.endSession();
    if (serviceChanged) await this.resume();
    else this.emit();
  }

  async requestCode(email: string): Promise<void> {
    this.settings = await this.o.backend.setSettings({ email: email.trim() });
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
      await this.api.verify(this.pendingEmail || this.settings.email, code.trim());
      this.who = this.pendingEmail || this.settings.email;
      this.link = null;
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

  /**
   * Signs in as the Showdown name this page is logged in as, with no code: the service accepts the browser's word for it.
   * Only offered when the service says it is reachable from this computer alone.
   */
  async signInWithBrowserName(): Promise<void> {
    const name = usableName(readUserName(this.o.host));
    if (!name) return this.say('Log in to Showdown first. A guest name cannot sign in.');
    try {
      await this.api.startUsername(name);
      await this.api.approveUsername(name);
      await this.afterNameSignIn();
    } catch (error) {
      this.handle(error);
      this.emit();
    }
  }

  private async afterNameSignIn(): Promise<void> {
    const me = await this.api.me();
    this.link = me.showdown ?? null;
    this.who = me.email ?? me.username ?? '';
    this.connection = 'signed-in';
    this.message = '';
    this.capabilities = await this.api.capabilities();
    this.emit();
  }

  /**
   * While signed out, answers a sign-in the website has started for this browser's Showdown name. Asking costs one
   * small request every couple of seconds, and the answer is "nobody asked" unless the user just started one.
   */
  private async watchSignIn(): Promise<void> {
    const name = usableName(readUserName(this.o.host));
    if (this.connection === 'signed-in' || !this.usernameLogin || !name || settingsProblems(this.settings).length) return;
    if (Date.now() - this.lastApprove < 2000) return;
    this.lastApprove = Date.now();
    try {
      await this.api.approveUsername(name);
    } catch {
      return; // nobody is signing in as this name
    }
    await this.afterNameSignIn();
  }

  async signOut(): Promise<void> {
    this.pendingEmail = '';
    this.who = '';
    await this.endSession();
    try {
      await this.o.backend.signOut();
    } catch { /* nothing to forget */ }
    this.connection = 'signed-out';
    this.capabilities = null;
    this.analysis = null;
    this.link = null;
    this.reportedName = '';
    this.emit();
  }

  // --- following the battle ---------------------------------------------------------

  /** Looks at the open battle once. The host may call this on its own events; the timer calls it too. */
  async tick(): Promise<void> {
    if (!this.active || this.ticking) return;
    this.ticking = true;
    try {
      const name = readUserName(this.o.host);
      if (name !== this.lastName) {
        this.lastName = name; // the user logged in or out of Showdown: the panel offers a different sign-in
        this.emit();
      }
      if (this.connection !== 'signed-in') await this.watchSignIn();
      if (this.connection !== 'signed-in' || settingsProblems(this.settings).length) return;
      this.remember();
      void this.report();
      const roomId = findBattleRoom(this.o.host, this.following, this.mine);
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

  /** Notes which open battles the user plays in, and forgets the ones that closed. */
  private remember(): void {
    const open = new Set(openBattleRoomIds(this.o.host));
    for (const id of playerRoomIds(this.o.host)) this.mine.add(id);
    for (const id of [...this.mine]) if (!open.has(id)) this.mine.delete(id);
  }

  /**
   * Tells the service which Showdown name this page is logged in as, so a link made on the service's website can be
   * confirmed. Sent when the name changes, and again now and then until a link is confirmed (a link may be made later).
   */
  private async report(): Promise<void> {
    const name = readUserName(this.o.host);
    if (!name || this.connection !== 'signed-in') return;
    const wait = this.link ? this.o.reportEveryMs.unconfirmed : this.o.reportEveryMs.unlinked;
    const stale = !this.link?.confirmed && Date.now() - this.reportedAt > wait;
    if (name === this.reportedName && !stale) return;
    this.reportedName = name;
    this.reportedAt = Date.now();
    try {
      const result = await this.api.seen(name);
      const next = result.linked && result.name ? { name: result.name, confirmed: result.confirmed } : null;
      if (JSON.stringify(next) !== JSON.stringify(this.link)) {
        this.link = next;
        this.emit();
      }
    } catch {
      this.reportedName = ''; // try again on a later tick
    }
  }

  private async begin(battle: OpenBattle): Promise<void> {
    const epoch = this.epoch;
    const created = await this.api.createSession({
      room: battle.roomId, format: battle.format, user: battle.user,
      model: this.settings.model, engine: this.settings.engine, analysis_mode: this.settings.analysis_mode,
    });
    if (epoch !== this.epoch || !this.active || this.connection !== 'signed-in') {
      // Signed out, stopped or restarted while we were creating it: nobody wants this session any more.
      void this.api.closeSession(created.id).catch(() => {});
      return;
    }
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
    this.epoch++;
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
