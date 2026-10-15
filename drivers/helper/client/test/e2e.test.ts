// The client against the real Python service (with a fake model): sign in by email, follow an open battle, get advice.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS } from '@stunfisk-plugin/common';
import { HelperController } from '../src/controller.ts';
import type { FetchLike } from '../src/serviceClient.ts';
import { classicHost, memoryStorage, room, until } from './fakes.ts';

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
      if (c && !codes.includes(c[1] + line)) codes.push(c[1]);
    }
    buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
  });
  child.stderr.on('data', (d) => process.stderr.write(d));
  await until(() => port > 0);
});

after(() => void child?.kill());

const realFetch: FetchLike = (url, init) => fetch(url, init) as never;

test('sign in, follow the open battle, send only new lines, and get advice', async () => {
  const battle = room('battle-gen9vgc2026regmc-9001', ['|player|p1|Alice|1|', '|tier|[Gen 9] VGC', '|poke|p1|Garchomp, L50|', '|teampreview|4'],
    { teamPreview: true, side: { id: 'p1', pokemon: [] } });
  const host = classicHost(battle);
  const storage = memoryStorage();
  storage.setItem('stunfisk-plugin:settings', JSON.stringify({ ...DEFAULT_SETTINGS, model: 'fake', engine: 'fake', local_url: `http://127.0.0.1:${port}` }));
  const helper = new HelperController({ host, storage, fetch: realFetch, tickMs: 50, pollSeconds: 2 });
  await helper.start();
  try {
    assert.equal(helper.view().connection, 'signed-out');
    await helper.requestCode('me@example.com');
    assert.equal(helper.view().connection, 'code-sent');
    await until(() => codes.length > 0);
    await helper.verifyCode(codes[codes.length - 1]);
    assert.equal(helper.view().connection, 'signed-in');
    assert.deepEqual(helper.view().capabilities?.models.map((m) => m.id), ['fake']);

    await until(() => helper.view().analysis?.phase === 'preview');
    assert.equal(helper.view().following, battle.id);
    assert.equal(helper.view().analysis?.recommended?.action, 'Play after 4 lines');
    assert.equal(helper.view().analysis?.side, 'p1');

    // the battle moves on inside the page: only the new lines go to the service
    battle.battle.stepQueue.push('|turn|1');
    battle.request = { active: [{}, {}], side: { id: 'p1' } };
    await until(() => helper.view().analysis?.turn === 1);
    assert.equal(helper.view().analysis?.recommended?.action, 'Play after 5 lines');

    // a settings change that matters restarts the session and replays everything once
    await helper.updateSettings({ analysis_mode: 'deep' });
    await until(() => helper.view().analysis?.recommended?.action === 'Play after 5 lines' && helper.view().analysis?.turn === 1);
  } finally {
    await helper.stop();
  }
});

test('a wrong code is refused and the user stays signed out', async () => {
  const storage = memoryStorage();
  storage.setItem('stunfisk-plugin:settings', JSON.stringify({ ...DEFAULT_SETTINGS, local_url: `http://127.0.0.1:${port}` }));
  const helper = new HelperController({ host: classicHost(), storage, fetch: realFetch, tickMs: 1000 });
  await helper.requestCode('other@example.com');
  await helper.verifyCode('000000');
  assert.notEqual(helper.view().connection, 'signed-in');
  assert.match(helper.view().message, /wrong or has expired/);
});

test('an unreachable service is reported, not thrown', async () => {
  const storage = memoryStorage();
  storage.setItem('stunfisk-plugin:settings', JSON.stringify({ ...DEFAULT_SETTINGS, local_url: 'http://127.0.0.1:1' }));
  const helper = new HelperController({ host: classicHost(), storage, fetch: realFetch, tickMs: 1000 });
  await helper.requestCode('me@example.com');
  assert.match(helper.view().message, /Cannot reach the service/);
});
