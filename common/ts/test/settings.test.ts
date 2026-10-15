import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DEFAULT_SETTINGS, loadSettings, parseSettings, saveSettings, serviceUrl, settingsProblems } from '../src/settings.ts';

const schema = JSON.parse(readFileSync(new URL('../../schema/settings.schema.json', import.meta.url), 'utf8'));

test('defaults are valid and match the schema', () => {
  assert.deepEqual(settingsProblems(DEFAULT_SETTINGS), []);
  assert.deepEqual(Object.keys(DEFAULT_SETTINGS).sort(), Object.keys(schema.properties).sort());
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    const d = schema.properties[key].default;
    if (d !== undefined) assert.equal(value, d, key);
  }
});

test('local stays on this computer; remote needs https', () => {
  assert.ok(settingsProblems({ ...DEFAULT_SETTINGS, local_url: 'http://example.com:8787' }).length);
  assert.equal(serviceUrl({ ...DEFAULT_SETTINGS, local_url: 'http://localhost:9000/' }), 'http://localhost:9000');
  assert.ok(settingsProblems({ ...DEFAULT_SETTINGS, run_mode: 'remote', remote_url: 'http://svc.example.com' }).length);
  assert.ok(settingsProblems({ ...DEFAULT_SETTINGS, run_mode: 'remote', remote_url: 'https://a:b@svc.example.com' }).length);
  assert.equal(serviceUrl({ ...DEFAULT_SETTINGS, run_mode: 'remote', remote_url: 'https://svc.example.com/' }), 'https://svc.example.com');
});

test('bad values are reported and serviceUrl throws', () => {
  for (const bad of [{ email: 'nope' }, { model: 'Bad Name' }, { engine: '' }, { analysis_mode: 'slow' }]) {
    assert.ok(settingsProblems({ ...DEFAULT_SETTINGS, ...bad } as never).length, JSON.stringify(bad));
  }
  assert.throws(() => serviceUrl({ ...DEFAULT_SETTINGS, run_mode: 'cloud' } as never));
});

test('parseSettings ignores unknown keys and non-strings', () => {
  const s = parseSettings({ model: 'x', evil: 'y', engine: 3 });
  assert.equal(s.model, 'x');
  assert.equal(s.engine, 'pscpp');
  assert.ok(!('evil' in s));
});

test('settings round-trip through storage and survive corrupt storage', () => {
  const data = new Map<string, string>();
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  saveSettings(storage, { ...DEFAULT_SETTINGS, model: 'other' });
  assert.equal(loadSettings(storage).model, 'other');
  data.set('stunfisk-plugin:settings', '{broken');
  assert.deepEqual(loadSettings(storage), DEFAULT_SETTINGS);
});
