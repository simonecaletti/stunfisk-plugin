// The client, through the extension bridge, against the real Python service (with a fake model):
// sign in by email, follow an open battle, get advice. The sign-in token must never reach the page.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS } from '@stunfisk-plugin/common';
import { DirectBackend } from '../src/backend.ts';
import { HelperController } from '../src/controller.ts';
import { classicHost, memoryStorage, room, until, wireBridge } from './fakes.ts';
import type { FetchStub } from './fakes.ts';

let child: ChildProcessWithoutNullStreams;
let port = 0;
const latest = new Map<string, string>();
const counts = new Map<string, number>();

/** Runs `request` (which makes the service print a code for `email`) and returns that new code once it arrives. */
async function nextCode(email: string, request: () => Promise<unknown>): Promise<string> {
  const seen = counts.get(email) ?? 0;
  await request();
  await until(() => (counts.get(email) ?? 0) > seen);
  return latest.get(email)!;
}

before(async () => {
  const root = fileURLToPath(new URL('../../../..', import.meta.url));
  child = spawn('python3', [`${root}drivers/helper/service/tests/fake_service.py`], {
    env: { ...process.env, PYTHONPATH: `${root}common/python:${root}drivers/helper/service` },
  });
  let buffer = '';
  child.stdout.on('data', (d) => {
    buffer += d;
    for (const line of buffer.split('\n')) {
      const p = /^PORT (\d+)/.exec(line);
      if (p) port = Number(p[1]);
      const c = /^CODE (\S+) (\d{6})$/.exec(line);
      if (c) { latest.set(c[1], c[2]); counts.set(c[1], (counts.get(c[1]) ?? 0) + 1); }
    }
    buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
  });
  child.stderr.on('data', (d) => process.stderr.write(d));
  await until(() => port > 0);
});

after(async () => {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  child.stdin.end(); // the service stops when its stdin closes
  await exited;
});

const realFetch: FetchStub = (url, init) => fetch(url, init) as never;
const local = () => ({ ...DEFAULT_SETTINGS, model: 'fake', engine: 'fake', local_url: `http://127.0.0.1:${port}` });

test('through the bridge: sign in, follow the open battle, send only new lines, get advice, and the page never sees the token', async () => {
  const battle = room('battle-gen9vgc2026regmc-9001', ['|player|p1|Alice|1|', '|tier|[Gen 9] VGC', '|poke|p1|Garchomp, L50|', '|teampreview|4'],
    { teamPreview: true, side: { id: 'p1', pokemon: [] } });
  const bridge = await wireBridge(realFetch);
  await bridge.backend.setSettings(local());
  const helper = new HelperController({ host: classicHost(battle), backend: bridge.backend, tickMs: 50, pollSeconds: 2 });
  await helper.start();
  try {
    assert.equal(helper.view().connection, 'signed-out');
    assert.equal(helper.view().message, '');
    const code = await nextCode('me@example.com', () => helper.requestCode('me@example.com'));
    assert.equal(helper.view().connection, 'code-sent');
    await helper.verifyCode(code);
    assert.equal(helper.view().connection, 'signed-in');
    assert.deepEqual(helper.view().capabilities?.models.map((m) => m.id), ['fake']);

    // the token is in the extension's storage and nowhere the page can look
    const stored = JSON.stringify([...bridge.storage.data.values()]);
    const token = Object.values(bridge.storage.data.get('tokens') as Record<string, string>)[0];
    assert.ok(token && token.includes('.'), 'the background stored a token');
    assert.ok(stored.includes(token));
    assert.ok(!JSON.stringify(bridge.win.seen).includes(token), 'no window message carries the token');
    assert.ok(!JSON.stringify(bridge.forwarded).includes(token));

    await until(() => helper.view().analysis?.phase === 'preview');
    assert.equal(helper.view().following, battle.id);
    assert.equal(helper.view().analysis?.recommended?.action, 'Play after 4 lines');
    assert.equal(helper.view().analysis?.side, 'p1');

    battle.battle.stepQueue.push('|turn|1');
    battle.request = { active: [{}, {}], side: { id: 'p1' } };
    await until(() => helper.view().analysis?.turn === 1);
    assert.equal(helper.view().analysis?.recommended?.action, 'Play after 5 lines');

    await helper.updateSettings({ analysis_mode: 'deep' });
    await until(() => helper.view().analysis?.recommended?.action === 'Play after 5 lines' && helper.view().analysis?.turn === 1);

    // a new controller (a page reload) finds the sign-in already there
    const again = new HelperController({ host: classicHost(), backend: bridge.backend, tickMs: 1000 });
    await again.start();
    assert.equal(again.view().connection, 'signed-in');
    await again.stop();

    await helper.signOut();
    assert.equal(helper.view().connection, 'signed-out');
    assert.deepEqual(bridge.storage.data.get('tokens'), {});
  } finally {
    await helper.stop();
  }
});

test('without the extension, the direct backend works the same way', async () => {
  const storage = memoryStorage();
  const backend = new DirectBackend({ storage, fetch: realFetch });
  await backend.setSettings(local());
  const helper = new HelperController({ host: classicHost(), backend, tickMs: 1000 });
  await helper.start();
  const code = await nextCode('direct@example.com', () => helper.requestCode('direct@example.com'));
  await helper.verifyCode(code);
  assert.equal(helper.view().connection, 'signed-in');
  await helper.stop();
});

test('a wrong code is refused and the user stays signed out', async () => {
  const bridge = await wireBridge(realFetch);
  await bridge.backend.setSettings(local());
  const helper = new HelperController({ host: classicHost(), backend: bridge.backend, tickMs: 1000 });
  await helper.start();
  await helper.requestCode('other@example.com');
  await helper.verifyCode('000000');
  assert.notEqual(helper.view().connection, 'signed-in');
  assert.match(helper.view().message, /wrong or has expired/);
  await helper.stop();
});

test('an unreachable service is reported, not thrown', async () => {
  const bridge = await wireBridge(realFetch);
  await bridge.backend.setSettings({ ...DEFAULT_SETTINGS, local_url: 'http://127.0.0.1:1' });
  const helper = new HelperController({ host: classicHost(), backend: bridge.backend, tickMs: 1000 });
  await helper.start();
  assert.match(helper.view().message, /Cannot reach the service/);
  await helper.requestCode('me@example.com');
  assert.match(helper.view().message, /Cannot reach the service/);
  await helper.stop();
});

test('a link made on the website is confirmed by the browser, and the game being played is the one followed', async () => {
  const watched = room('battle-gen9vgc2026regmc-7001', ['|player|p1|Zed|1|', '|turn|1']);
  const played = room('battle-gen9vgc2026regmc-7002', ['|player|p1|Alice|1|', '|tier|[Gen 9] VGC', '|turn|1'], { active: [{}], side: { id: 'p1' } });
  const host = classicHost(watched, played); // the watched game is in front; Alice plays the other
  const bridge = await wireBridge(realFetch);
  await bridge.backend.setSettings(local());
  const helper = new HelperController({ host, backend: bridge.backend, tickMs: 50, pollSeconds: 2, reportEveryMs: { unlinked: 100, unconfirmed: 100 } });
  await helper.start();
  // the website: its own sign-in, with its own token, as the same person
  const site = new DirectBackend({ storage: memoryStorage(), fetch: realFetch });
  await site.setSettings(local());
  try {
    await helper.verifyCode(await nextCode('linker@example.com', () => helper.requestCode('linker@example.com')));
    assert.equal(helper.view().link, null);
    const siteCode = await nextCode('linker@example.com', () => site.request('POST', '/v1/auth/request', { email: 'linker@example.com' }));
    await site.request('POST', '/v1/auth/verify', { email: 'linker@example.com', code: siteCode });
    const linked = await site.request('PUT', '/v1/me/showdown', { name: 'Alice' });
    assert.deepEqual(linked.body, { name: 'Alice', confirmed: false });

    // the browser reports its Showdown name and the link is confirmed
    await until(() => helper.view().link?.confirmed === true, 8000);
    assert.equal((await site.request('GET', '/v1/me')).body.showdown && ((await site.request('GET', '/v1/me')).body.showdown as { confirmed: boolean }).confirmed, true);

    // and the helper follows Alice's own game, not the one in front
    await until(() => helper.view().following === played.id);
    await until(() => helper.view().analysis?.side === 'p1');
    const current = (await site.request('GET', '/v1/helper/current')).body as { session: { room: string; linked: boolean; player: string } | null };
    assert.equal(current.session?.room, played.id);
    assert.equal(current.session?.player, 'Alice');
    assert.equal(current.session?.linked, true);
  } finally {
    await helper.stop();
  }
});

test('sign in by Showdown name: the website asks, the browser approves by itself, and both end up signed in and linked', async () => {
  const bridge = await wireBridge(realFetch);
  await bridge.backend.setSettings(local());
  const helper = new HelperController({ host: classicHost(), backend: bridge.backend, tickMs: 50, pollSeconds: 2 });
  await helper.start();
  const site = new DirectBackend({ storage: memoryStorage(), fetch: realFetch });
  await site.setSettings(local());
  try {
    assert.equal(helper.view().usernameLogin, true);
    assert.equal(helper.view().browserName, 'Alice');
    assert.equal(helper.view().connection, 'signed-out');

    // the website asks to sign in as "alice"; the extension, in a browser logged in as Alice, answers on its own
    const started = await site.request('POST', '/v1/auth/username/start', { username: 'alice' });
    const rid = started.body.request as string;
    await until(() => helper.view().connection === 'signed-in');
    assert.equal(helper.view().who, 'Alice');
    assert.deepEqual(helper.view().link, { name: 'Alice', confirmed: true });
    assert.ok(!JSON.stringify(bridge.win.seen).includes('"token"'), 'the token never crossed into the page');

    // the website collects its own sign-in
    const polled = await site.request('GET', `/v1/auth/username/poll?request=${rid}`);
    assert.equal(polled.body.status, 'approved');
    const me = await fetch(`http://127.0.0.1:${port}/v1/me`, { headers: { Authorization: `Bearer ${polled.body.token}` } }).then((r) => r.json());
    assert.deepEqual(me, { email: null, username: 'Alice', showdown: { name: 'Alice', confirmed: true } });

    // a name account does not offer email, and signing out then in again by one click works
    await helper.signOut();
    assert.equal(helper.view().connection, 'signed-out');
    await helper.signInWithBrowserName();
    assert.equal(helper.view().connection, 'signed-in');
    assert.equal(helper.view().who, 'Alice');
  } finally {
    await helper.stop();
  }
});

test('a guest cannot sign in by name, and a logged-out page is told to log in', async () => {
  const bridge = await wireBridge(realFetch);
  await bridge.backend.setSettings(local());
  const host = classicHost();
  host.app.user = { attributes: { name: 'Guest 4242' } } as never;
  const helper = new HelperController({ host, backend: bridge.backend, tickMs: 50, pollSeconds: 2 });
  await helper.start();
  try {
    assert.equal(helper.view().browserName, '');
    await helper.signInWithBrowserName();
    assert.equal(helper.view().connection, 'signed-out');
    assert.match(helper.view().message, /Log in to Showdown first/);
    // logging in to Showdown later changes what the panel offers, without a reload
    host.app.user = { attributes: { name: 'Misty' } } as never;
    await until(() => helper.view().browserName === 'Misty');
  } finally {
    await helper.stop();
  }
});
