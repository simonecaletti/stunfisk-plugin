import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS } from '@stunfisk-plugin/common';
import type { ViewState } from '../src/controller.ts';
import { renderPanel } from '../src/panel.ts';

const base = (over: Partial<ViewState> = {}): ViewState => ({
  settings: { ...DEFAULT_SETTINGS }, problems: [], connection: 'signed-out', capabilities: null, following: null,
  analysis: null, status: 'idle', message: '', ...over,
});

test('signed out shows the email form and no advice', () => {
  const html = renderPanel(base());
  assert.match(html, /data-f="email"/);
  assert.match(html, /Sign in to get advice/);
});

test('signed in shows advice, alternatives and model and engine choices', () => {
  const html = renderPanel(base({
    connection: 'signed-in', following: 'battle-x-1',
    settings: { ...DEFAULT_SETTINGS, email: 'me@example.com' },
    capabilities: {
      models: [{ id: 'stunfisk', name: 'Stunfisk', level: 'A', formats: [], available: true, reason: '' }],
      engines: [{ id: 'pscpp', name: 'pscpp', level: 'B', formats: [], available: false, reason: 'not built' },
                { id: 'showdown', name: 'Showdown', level: 'B', formats: [], available: true, reason: '' }],
    },
    analysis: { phase: 'turn', turn: 4, win: 0.612, notes: ['Assumed: spread'],
      recommended: { action: 'Earthquake', choice: 'move 1', win: 0.612 },
      choices: [{ action: 'Earthquake', choice: 'move 1', win: 0.612 }, { action: 'Protect', choice: 'move 2', win: 0.4 }],
      expected_opponent: [{ action: 'Fake Out', choice: 'move 3', likelihood: 0.7 }] },
  }));
  assert.match(html, /Turn 4/);
  assert.match(html, /Earthquake/);
  assert.match(html, /61\.2%/);
  assert.match(html, /Protect/);
  assert.match(html, /70\.0%/);
  assert.match(html, /Assumed: spread/);
  assert.match(html, /<option value="pscpp"[^>]*disabled[^>]*>pscpp \(not built\)/);
  assert.match(html, /Signed in as <b>me@example.com/);
});

test('everything shown from outside is escaped', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const html = renderPanel(base({
    connection: 'signed-in', following: 'battle-x-1', message: evil,
    settings: { ...DEFAULT_SETTINGS, email: evil },
    analysis: { phase: 'turn', turn: 1, notes: [evil], recommended: { action: evil, choice: 'x' }, choices: [] },
  }));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
});

test('remote mode warns that the battle leaves this computer', () => {
  const html = renderPanel(base({ settings: { ...DEFAULT_SETTINGS, run_mode: 'remote', remote_url: 'https://s.example.com' } }));
  assert.match(html, /is sent to that service/);
  assert.match(html, /data-set="remote_url"/);
});
