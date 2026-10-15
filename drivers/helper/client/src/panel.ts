import type { Analysis, Choice } from '@stunfisk-plugin/common';
import type { HelperController, ViewState } from './controller.ts';

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const pct = (p: number | null | undefined) => (typeof p === 'number' ? `${(p * 100).toFixed(1)}%` : '');

export const STYLE = `
.sfh{font:13px/1.4 system-ui,sans-serif;color:#222;background:#fff;border:1px solid #bbb;border-radius:8px;width:340px;max-height:80vh;overflow:auto;box-shadow:0 4px 16px #0004}
.sfh *{box-sizing:border-box}.sfh header{display:flex;justify-content:space-between;align-items:center;padding:6px 10px;background:#335;color:#fff;border-radius:7px 7px 0 0;cursor:pointer}
.sfh section{padding:8px 10px;border-top:1px solid #eee}.sfh h4{margin:0 0 4px;font-size:12px;text-transform:uppercase;color:#666}
.sfh label{display:block;margin:4px 0 2px}.sfh input,.sfh select{width:100%;padding:3px}.sfh button{margin-top:6px;padding:3px 8px}
.sfh .rec{font-size:15px;font-weight:600}.sfh table{width:100%;border-collapse:collapse}.sfh td{padding:2px 4px;border-top:1px solid #eee}
.sfh .note{color:#865;margin:2px 0}.sfh .err{color:#a00}.sfh .muted{color:#777}.sfh .na{color:#999}
@media (prefers-color-scheme:dark){.sfh{color:#ddd;background:#1c1c24;border-color:#445}.sfh section,.sfh td{border-color:#334}.sfh h4,.sfh .muted{color:#99a}.sfh input,.sfh select{background:#2a2a35;color:#ddd}}
`;

function choiceRows(rows: Choice[] | undefined, withWin: boolean): string {
  if (!rows?.length) return '';
  return `<table>${rows.map((c) => `<tr><td>${esc(c.action)}</td><td>${esc(withWin ? pct(c.win) : pct(c.likelihood))}</td></tr>`).join('')}</table>`;
}

function advice(a: Analysis | null, v: ViewState): string {
  if (!v.following) return '<p class="muted">Open a battle to get advice.</p>';
  if (!a) return `<p class="muted">Reading ${esc(v.following)}…</p>`;
  const head = a.phase === 'ended' ? 'The battle is over.' : a.phase === 'preview' ? 'Team preview' : `Turn ${a.turn}${a.phase === 'switch' ? ' (switch-in)' : ''}`;
  const rec = a.recommended ? `<div class="rec">${esc(a.recommended.action)}</div>${a.win != null ? `<div>Win chance ${esc(pct(a.win))}</div>` : ''}` : '';
  const others = a.choices && a.choices.length > 1 ? `<h4>Other plays</h4>${choiceRows(a.choices.slice(1), true)}` : '';
  const foe = a.expected_opponent?.length ? `<h4>Opponent likely</h4>${choiceRows(a.expected_opponent, false)}` : '';
  const notes = a.notes.map((n) => `<div class="note">${esc(n)}</div>`).join('');
  return `<div class="muted">${esc(head)}</div>${rec}${others}${foe}${notes}`;
}

function account(v: ViewState): string {
  const s = v.settings;
  if (v.connection === 'signed-in') return `<div>Signed in as <b>${esc(s.email)}</b></div><button data-act="signout">Sign out</button>`;
  if (v.connection === 'code-sent') {
    return `<label>Code from the email<input data-f="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></label>
      <button data-act="verify">Sign in</button> <button data-act="restart">Use another address</button>`;
  }
  return `<label>Email<input data-f="email" type="email" value="${esc(s.email)}" autocomplete="email"></label><button data-act="request">Send me a code</button>`;
}

function options(items: { id: string; name: string; available: boolean; reason: string }[] | undefined, current: string): string {
  const list = items ?? [];
  const known = list.some((i) => i.id === current);
  return [...list, ...(known || !current ? [] : [{ id: current, name: current, available: true, reason: '' }])]
    .map((i) => `<option value="${esc(i.id)}"${i.id === current ? ' selected' : ''}${i.available ? '' : ' disabled'}>${esc(i.name)}${i.available ? '' : ` (${esc(i.reason || 'unavailable')})`}</option>`).join('');
}

function settingsForm(v: ViewState): string {
  const s = v.settings;
  const caps = v.capabilities;
  const url = s.run_mode === 'local' ? `<label>Local service<input data-set="local_url" value="${esc(s.local_url)}"></label>` : `<label>Remote service (https)<input data-set="remote_url" value="${esc(s.remote_url)}"></label>`;
  const warn = s.run_mode === 'remote' ? '<div class="note">In remote mode the battle you have open is sent to that service.</div>' : '';
  return `<label>Run<select data-set="run_mode"><option value="local"${s.run_mode === 'local' ? ' selected' : ''}>On this computer</option><option value="remote"${s.run_mode === 'remote' ? ' selected' : ''}>On a remote service</option></select></label>${url}${warn}
    <label>Model<select data-set="model">${options(caps?.models, s.model)}</select></label>
    <label>Engine<select data-set="engine">${options(caps?.engines, s.engine)}</select></label>
    <label>Analysis<select data-set="analysis_mode">${['fast', 'standard', 'deep'].map((m) => `<option${m === s.analysis_mode ? ' selected' : ''}>${m}</option>`).join('')}</select></label>
    ${v.problems.map((p) => `<div class="err">${esc(p)}</div>`).join('')}`;
}

/** The whole panel as HTML. Every value is escaped; behaviour is attached by `mountPanel` through `data-*` attributes. */
export function renderPanel(v: ViewState, open = true): string {
  const body = open ? `
    <section><h4>Live match helper</h4>${v.connection === 'signed-in' ? advice(v.analysis, v) : '<p class="muted">Sign in to get advice.</p>'}${v.message ? `<div class="${v.status === 'error' ? 'err' : 'muted'}">${esc(v.message)}</div>` : ''}</section>
    <section><h4>Account</h4>${account(v)}</section>
    <section><h4>Settings</h4>${settingsForm(v)}</section>` : '';
  return `<div class="sfh"><header data-act="toggle"><b>Stunfisk Coach</b><span>${open ? '–' : '+'}</span></header>${body}</div>`;
}

interface DomLike {
  innerHTML: string;
  addEventListener(type: string, fn: (e: { target: unknown }) => void): void;
  querySelector(sel: string): { value: string } | null;
}

/** Renders into `el` on every state change and wires its controls to the controller. */
export function mountPanel(el: DomLike, controller: HelperController): () => void {
  let open = true;
  const draw = (v: ViewState) => {
    // Keep what the user is typing: a redraw while they type a code must not wipe it.
    const typed = { email: el.querySelector('[data-f=email]')?.value, code: el.querySelector('[data-f=code]')?.value };
    el.innerHTML = `<style>${STYLE}</style>${renderPanel(v, open)}`;
    for (const [k, val] of Object.entries(typed)) {
      const input = el.querySelector(`[data-f=${k}]`);
      if (input && val) input.value = val;
    }
  };
  const field = (name: string) => el.querySelector(`[data-f=${name}]`)?.value ?? '';
  el.addEventListener('click', (e) => {
    const act = (e.target as { closest?(s: string): { dataset: { act?: string } } | null })?.closest?.('[data-act]')?.dataset.act;
    if (act === 'toggle') { open = !open; draw(controller.view()); }
    else if (act === 'request') void controller.requestCode(field('email'));
    else if (act === 'verify') void controller.verifyCode(field('code'));
    else if (act === 'restart') void controller.signOut();
    else if (act === 'signout') void controller.signOut();
  });
  el.addEventListener('change', (e) => {
    const t = e.target as { dataset?: { set?: string }; value?: string };
    if (t.dataset?.set) void controller.updateSettings({ [t.dataset.set]: t.value ?? '' });
  });
  const off = controller.subscribe(draw);
  draw(controller.view());
  return off;
}
