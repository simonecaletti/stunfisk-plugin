// Content script entry, in the extension's isolated world. Runs before the page script so the bridge is ready first.
import { extensionApi } from './api.ts';
import { startRelay } from './relay.ts';
import type { MessageHost } from './bridge.ts';

const api = extensionApi();
if (api) startRelay(window as unknown as MessageHost, (request) => api.runtime.sendMessage(request));

declare const window: unknown;
