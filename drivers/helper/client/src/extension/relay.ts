// The content script's job: pass the page's bridge requests to the background and the answers back. It decides nothing.

import { CHANNEL, isEnvelope } from './bridge.ts';
import type { BridgeRequest, BridgeResponse, Envelope, MessageHost } from './bridge.ts';

export function startRelay(win: MessageHost, send: (request: BridgeRequest) => Promise<unknown>): void {
  const post = (envelope: Envelope) => win.postMessage(envelope, win.location.origin);
  win.addEventListener('message', (event) => {
    // Only this window's own page script, on this origin.
    if (event.source !== win || event.origin !== win.location.origin) return;
    if (!isEnvelope(event.data) || event.data.dir !== 'req' || typeof event.data.id !== 'string') return;
    const id = event.data.id;
    send(event.data.payload as BridgeRequest).then(
      (payload) => post({ channel: CHANNEL, dir: 'res', id, payload }),
      (error) => post({ channel: CHANNEL, dir: 'res', id, payload: { ok: false, error: String(error?.message ?? error) } satisfies BridgeResponse }),
    );
  });
  post({ channel: CHANNEL, dir: 'ready' });
}
