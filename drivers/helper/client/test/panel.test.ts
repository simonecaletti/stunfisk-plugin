import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS } from '@stunfisk-plugin/common';
import type { ViewState } from '../src/controller.ts';
import { renderPanel } from '../src/panel.ts';

const base = (over: Partial<ViewState> = {}): ViewState => ({
  settings: { ...DEFAULT_SETTINGS }, problems: [], connection: 'signed-out', capabilities: null, following: null, link: null, who: '', usernameLogin: false, browserName: '',
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

test('the panel says whether a Showdown account is linked and confirmed', () => {
  const signedIn = { connection: 'signed-in' as const, settings: { ...DEFAULT_SETTINGS, email: 'me@example.com' } };
  assert.match(renderPanel(base({ ...signedIn, link: null })), /No Showdown account linked\. Link it at http:\/\/127\.0\.0\.1:8787/);
  assert.match(renderPanel(base({ ...signedIn, link: { name: 'Ash', confirmed: false } })), /<b>Ash<\/b> \(waiting for this browser/);
  assert.match(renderPanel(base({ ...signedIn, link: { name: 'Ash', confirmed: true } })), /<b>Ash<\/b> \(confirmed\)/);
  assert.ok(!renderPanel(base({ ...signedIn, link: { name: '<img src=x>', confirmed: true } })).includes('<img'));
});

test('with username sign-in on, a logged-in Showdown name gets a one-click sign-in and email stays an alternative', () => {
  const on = renderPanel(base({ usernameLogin: true, browserName: 'Ash Ketchum' }));
  assert.match(on, /Logged in to Showdown as <b>Ash Ketchum<\/b>/);
  assert.match(on, /data-act="signinname">Sign in as Ash Ketchum/);
  assert.match(on, /data-act="useemail"/);
  assert.ok(!on.includes('data-f="email"'));
  assert.match(renderPanel(base({ usernameLogin: true, browserName: 'Ash' }), true, true), /data-f="email"[\s\S]*data-act="usename"/);
  assert.match(renderPanel(base({ usernameLogin: true, browserName: '' })), /Log in to Showdown to sign in with your username/);
  assert.ok(!renderPanel(base({ usernameLogin: true, browserName: '' })).includes('data-act="signinname"'));
  assert.match(renderPanel(base()), /data-f="email"/); // off: email only
  assert.ok(!renderPanel(base()).includes('usename'));
  assert.ok(!renderPanel(base({ usernameLogin: true, browserName: '<img src=x>' })).includes('<img'));
});

test('a signed-in name account shows its name, not an email', () => {
  const html = renderPanel(base({ connection: 'signed-in', who: 'Ash Ketchum', link: { name: 'Ash Ketchum', confirmed: true } }));
  assert.match(html, /Signed in as <b>Ash Ketchum<\/b>/);
});
