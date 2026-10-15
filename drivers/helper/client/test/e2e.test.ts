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
const codes: string[] = [];

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
      const c = /^CODE \S+ (\d{6})/.exec(line);
      if (c) codes.push(c[1]);
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
    await helper.requestCode('me@example.com');
    assert.equal(helper.view().connection, 'code-sent');
    await until(() => codes.length > 0);
    const code = codes[codes.length - 1];
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
  await helper.requestCode('direct@example.com');
  await until(() => codes.length > 0);
  await helper.verifyCode(codes[codes.length - 1]);
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
