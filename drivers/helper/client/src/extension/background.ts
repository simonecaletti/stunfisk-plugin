// Background entry: a service worker in Chrome, an event page in Firefox.
import { createHandler } from './handler.ts';
import { extensionApi } from './api.ts';
import type { BridgeRequest } from './bridge.ts';

const api = extensionApi();
if (api) {
  const handle = createHandler({
    storage: {
      get: async (key) => (await api.storage.local.get(key))[key],
      set: (key, value) => api.storage.local.set({ [key]: value }),
    },
    fetch: (url, init) => fetch(url, init),
  });
  api.runtime.onMessage.addListener((message, _sender, respond) => {
    void handle(message as BridgeRequest).then(respond);
    return true; // the answer comes later
  });
}
