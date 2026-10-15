import type { Settings } from './types.ts';

export const DEFAULT_LOCAL_URL = 'http://127.0.0.1:8787';
export const RUN_MODES = ['local', 'remote'] as const;
export const ANALYSIS_MODES = ['fast', 'standard', 'deep'] as const;

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  email: '',
  model: 'stunfisk',
  engine: 'pscpp',
  run_mode: 'local',
  local_url: DEFAULT_LOCAL_URL,
  remote_url: '',
  analysis_mode: 'fast',
});

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ID = /^[a-z][a-z0-9_-]{0,31}$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function urlProblems(label: string, url: string, loopbackOnly: boolean): string[] {
  if (!url) return [`${label} is empty.`];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [`${label} must be an http(s) URL without a user name or password.`];
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    return [`${label} must be an http(s) URL without a user name or password.`];
  }
  const loopback = LOOPBACK.has(parsed.hostname.toLowerCase());
  if (loopbackOnly && !loopback) {
    return [`${label} must be on this computer (127.0.0.1 or localhost). Use remote mode for another host.`];
  }
  if (!loopback && parsed.protocol !== 'https:') {
    return [`${label} must use https, because it carries your login and your battles.`];
  }
  return [];
}

/** Every problem with these settings, as sentences. Same rules as the Python Settings.problems(). */
export function settingsProblems(s: Settings): string[] {
  const out: string[] = [];
  if (s.email && !EMAIL.test(s.email)) out.push('The email address is not valid.');
  if (!ID.test(s.model)) out.push('The model must be a lowercase identifier.');
  if (!ID.test(s.engine)) out.push('The engine must be a lowercase identifier.');
  if (!(RUN_MODES as readonly string[]).includes(s.run_mode)) out.push(`The run mode must be one of ${RUN_MODES.join(', ')}.`);
  if (!(ANALYSIS_MODES as readonly string[]).includes(s.analysis_mode)) {
    out.push(`The analysis mode must be one of ${ANALYSIS_MODES.join(', ')}.`);
  }
  if (s.run_mode === 'local') out.push(...urlProblems('The local service address', s.local_url, true));
  else if (s.run_mode === 'remote') out.push(...urlProblems('The remote service address', s.remote_url, false));
  return out;
}

/** The base URL of the chosen service, without a trailing slash. Throws the first problem. */
export function serviceUrl(s: Settings): string {
  const problems = settingsProblems(s);
  if (problems.length) throw new Error(problems[0]);
  return (s.run_mode === 'local' ? s.local_url : s.remote_url).replace(/\/+$/, '');
}

/** Known string keys only; anything else keeps its default. Does not validate. */
export function parseSettings(raw: unknown): Settings {
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      const value = (raw as Record<string, unknown>)[key];
      if (typeof value === 'string') out[key] = value;
    }
  }
  return out as unknown as Settings;
}

/** The slice of Storage the settings need, so tests and the extension's own storage can stand in. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = 'stunfisk-plugin:settings';

export function loadSettings(storage: StorageLike): Settings {
  try {
    const text = storage.getItem(KEY);
    return parseSettings(text ? JSON.parse(text) : null);
  } catch {
    return parseSettings(null);
  }
}

export function saveSettings(storage: StorageLike, settings: Settings): void {
  storage.setItem(KEY, JSON.stringify(settings));
}
