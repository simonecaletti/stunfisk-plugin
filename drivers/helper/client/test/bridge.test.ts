import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS } from '@stunfisk-plugin/common';
import { NetworkError } from '../src/backend.ts';
import { BridgeBackend, CHANNEL } from '../src/extension/bridge.ts';
import { FakeWindow, memoryExtensionStorage, wireBridge } from './fakes.ts';
import type { FetchStub } from './fakes.ts';

const reply = (status: number, body: unknown = {}) => ({ status, json: async () => body });

/** A service stub that records what it is asked and answers from a table. */
function service(answers: Record<string, ReturnType<typeof reply> | (() => ReturnType<typeof reply>)> = {}) {
  const calls: { url: string; method: string; auth?: string; body?: string }[] = [];
  const fetchImpl: FetchStub = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.Authorization, body: init.body });
    const key = `${init.method} ${new URL(url).pathname}`;
    const a = answers[key];
    return a ? (typeof a === 'function' ? a() : a) : reply(404, { error: 'nope' });
  };
  return { calls, fetchImpl };
}

test('no relay in the page means no bridge', async () => {
  assert.equal(await BridgeBackend.detect(new FakeWindow(), 120, 20), null);
});

test('settings go through the extension and persist there', async () => {
  const { backend, storage } = await wireBridge(service().fetchImpl);
  assert.deepEqual(await backend.getSettings(), DEFAULT_SETTINGS);
  const next = await backend.setSettings({ model: 'other', evil: 'x' } as never);
  assert.equal(next.model, 'other');
  assert.ok(!('evil' in next));
  assert.equal((storage.data.get('settings') as { model: string }).model, 'other');
});

test('the token is stored on sign-in, stripped from the reply, and attached to later calls', async () => {
  const s = service({ 'POST /v1/auth/verify': reply(200, { token: 'T.1', email: 'a@b.co', expires_at: 1 }), 'GET /v1/me': reply(200, { email: 'a@b.co' }) });
  const { backend } = await wireBridge(s.fetchImpl);
  const verify = await backend.request('POST', '/v1/auth/verify', { email: 'a@b.co', code: '123456' });
  assert.deepEqual(verify.body, { email: 'a@b.co', expires_at: 1 });
  await backend.request('GET', '/v1/me');
  assert.equal(s.calls[0].auth, undefined);
  assert.equal(s.calls[1].auth, 'Bearer T.1');
  await backend.signOut();
  await backend.request('GET', '/v1/me');
  assert.equal(s.calls[2].auth, undefined);
});

test('a token is only ever sent to the service it was issued by', async () => {
  const s = service({ 'POST /v1/auth/verify': reply(200, { token: 'T.1' }), 'GET /v1/me': reply(200, {}) });
  const { backend } = await wireBridge(s.fetchImpl);
  await backend.request('POST', '/v1/auth/verify', {});
  await backend.setSettings({ run_mode: 'remote', remote_url: 'https://elsewhere.example.com' });
  await backend.request('GET', '/v1/me');
  assert.equal(s.calls.at(-1)!.url, 'https://elsewhere.example.com/v1/me');
  assert.equal(s.calls.at(-1)!.auth, undefined);
  await backend.setSettings({ run_mode: 'local' });
  await backend.request('GET', '/v1/me');
  assert.equal(s.calls.at(-1)!.auth, 'Bearer T.1');
});

test('only known service paths and methods get through', async () => {
  const s = service({ 'GET /v1/me': reply(200, {}) });
  const { backend } = await wireBridge(s.fetchImpl);
  for (const path of ['/', '/v1/health', '/v1/../etc', 'https://evil.example/v1/me', '//evil.example/v1/me', '/v1/me/extra', '/v1/helper/sessions/zz', '/v1/me?x=<script>']) {
    await assert.rejects(backend.request('GET', path), /not allowed/, path);
  }
  await assert.rejects(backend.request('PUT' as never, '/v1/me'), /not allowed/);
  assert.equal(s.calls.length, 0);
  for (const ok of ['/v1/me', '/v1/capabilities', '/v1/helper/sessions', '/v1/helper/sessions/0123456789abcdef', '/v1/helper/sessions/0123456789abcdef/events', '/v1/helper/sessions/0123456789abcdef?after=3&wait=20']) {
    await backend.request('GET', ok).catch(() => {});
  }
  assert.equal(s.calls.length, 6);
});

test('the page may confirm a link but never create or change one', async () => {
  const s = service({ 'POST /v1/me/showdown/seen': reply(200, { linked: true, match: true, confirmed: true }) });
  const { backend } = await wireBridge(s.fetchImpl);
  await backend.request('POST', '/v1/me/showdown/seen', { name: 'Ash' });
  assert.equal(s.calls.length, 1);
  await assert.rejects(backend.request('PUT' as never, '/v1/me/showdown', { name: 'Gary' }), /not allowed/);
  await assert.rejects(backend.request('POST', '/v1/me/showdown', { name: 'Gary' }), /not allowed/);
  await assert.rejects(backend.request('DELETE', '/v1/me/showdown'), /not allowed/);
  assert.equal(s.calls.length, 1);
});

test('a name sign-in captures its token in the background like an email one', async () => {
  const s = service({ 'GET /v1/status': reply(200, { username_login: true }), 'POST /v1/auth/username/start': reply(200, { request: 'abcd' }),
    'POST /v1/auth/username/approve': reply(200, { token: 'N.1', name: 'Ash', expires_at: 9 }), 'GET /v1/me': reply(200, { email: null }) });
  const { backend } = await wireBridge(s.fetchImpl);
  await backend.request('GET', '/v1/status');
  await backend.request('POST', '/v1/auth/username/start', { username: 'Ash' });
  const approved = await backend.request('POST', '/v1/auth/username/approve', { name: 'Ash' });
  assert.deepEqual(approved.body, { name: 'Ash', expires_at: 9 }); // no token in the reply
  await backend.request('GET', '/v1/me');
  assert.equal(s.calls.at(-1)!.auth, 'Bearer N.1');
  // the page may not poll for someone else's sign-in token
  await assert.rejects(backend.request('GET', '/v1/auth/username/poll?request=abcd'), /not allowed/);
});

test('invalid settings stop a call before it is made', async () => {
  const s = service();
  const { backend } = await wireBridge(s.fetchImpl);
  await backend.setSettings({ local_url: 'http://example.com:8787' });
  await assert.rejects(backend.request('GET', '/v1/me'), /must be on this computer/);
  await backend.setSettings({ run_mode: 'remote', remote_url: 'http://svc.example.com' });
  await assert.rejects(backend.request('GET', '/v1/me'), /must use https/);
  assert.equal(s.calls.length, 0);
});

test('a service that cannot be reached is a NetworkError', async () => {
  const { backend } = await wireBridge(async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(backend.request('GET', '/v1/me'), (e: unknown) => e instanceof NetworkError && /Cannot reach the service/.test((e as Error).message));
});

test('aborting a long call cancels the fetch', async () => {
  let aborted = false;
  const fetchImpl: FetchStub = (_url, init) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('x'), { name: 'AbortError' })); });
  });
  const { backend } = await wireBridge(fetchImpl);
  const controller = new AbortController();
  const pending = backend.request('GET', '/v1/capabilities', undefined, controller.signal);
  await new Promise((r) => setTimeout(r, 20));
  controller.abort();
  await assert.rejects(pending, (e: unknown) => e instanceof NetworkError && e.aborted);
  assert.ok(aborted);
});

test('the relay ignores messages from other windows and other origins', async () => {
  const { win, forwarded } = await wireBridge(service().fetchImpl);
  const before = forwarded.length;
  const env = { channel: CHANNEL, dir: 'req', id: 'x1', payload: { op: 'getSettings' } };
  win.inject(env, {}, win.location.origin); // another window
  win.inject(env, win, 'https://evil.example'); // another origin
  win.inject({ channel: 'other', dir: 'req', id: 'x2', payload: {} }, win, win.location.origin);
  win.inject({ channel: CHANNEL, dir: 'res', id: 'x3' }, win, win.location.origin);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(forwarded.length, before);
});

test('an unknown operation is refused by the background', async () => {
  const { handler } = await wireBridge(service().fetchImpl);
  assert.deepEqual(await handler({ op: 'format-disk' } as never), { ok: false, error: 'Unknown request.' });
  assert.equal((await handler(undefined as never)).ok, false);
});

test('extension storage helper keeps copies, not references', async () => {
  const st = memoryExtensionStorage();
  const obj = { a: 1 };
  await st.set('k', obj);
  obj.a = 2;
  assert.deepEqual(await st.get('k'), { a: 1 });
});
