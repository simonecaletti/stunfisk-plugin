// Entry point loaded into play.pokemonshowdown.com. Starts the helper and docks its panel in the corner of the page.
// The panel is a plain element for now; moving it into a Showdex-style room is a later step (see adr/0002).

import { HelperController } from './controller.ts';
import type { HostWindow } from './host.ts';
import { mountPanel } from './panel.ts';

declare const window: HostWindow & { localStorage: Storage; fetch: typeof fetch; __STUNFISK_HELPER?: HelperController };
declare const document: { body: { appendChild(el: unknown): void }; createElement(tag: string): Record<string, any> };

if (!window.__STUNFISK_HELPER) {
  const controller = new HelperController({
    host: window,
    storage: window.localStorage,
    fetch: (url, init) => window.fetch(url, init),
  });
  window.__STUNFISK_HELPER = controller;
  const dock = document.createElement('div');
  dock.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483000';
  document.body.appendChild(dock);
  mountPanel(dock as never, controller);
  void controller.start();
}
