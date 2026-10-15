// Page script, loaded into play.pokemonshowdown.com. Starts the Live Match Helper and docks Stunfisk Coach's panel in the corner.
// Stunfisk Coach is its own extension: the panel is an element Coach owns, and it works with or without Showdex installed.

import { DirectBackend } from './backend.ts';
import { HelperController } from './controller.ts';
import { BridgeBackend } from './extension/bridge.ts';
import type { MessageHost } from './extension/bridge.ts';
import { waitForShowdownClient } from './host.ts';
import type { HostWindow } from './host.ts';
import { mountPanel } from './panel.ts';

declare const window: HostWindow & MessageHost & { localStorage: Storage; fetch: typeof fetch; __STUNFISK_HELPER?: HelperController };
declare const document: { body: { appendChild(el: unknown): void }; createElement(tag: string): Record<string, any> };

void (async () => {
  if (window.__STUNFISK_HELPER) return;
  // The extension also runs on local addresses, where most pages are not Showdown. Do nothing unless this is a client.
  if (!(await waitForShowdownClient(window))) return;
  // Normally the extension's relay answers and the token never reaches the page. Without it (a pasted script, a dev
  // build), fall back to the page's own fetch and storage.
  const backend = (await BridgeBackend.detect(window)) ?? new DirectBackend({ storage: window.localStorage, fetch: (url, init) => window.fetch(url, init) });
  const controller = new HelperController({ host: window, backend });
  window.__STUNFISK_HELPER = controller;
  const dock = document.createElement('div');
  dock.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483000';
  document.body.appendChild(dock);
  mountPanel(dock as never, controller);
  void controller.start();
})();
