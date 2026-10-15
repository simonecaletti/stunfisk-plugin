// The slice of the WebExtension API Coach uses. Firefox exposes promises on `browser`; Chrome's MV3 `chrome` does too.

export interface ExtApi {
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: { addListener(fn: (message: unknown, sender: unknown, respond: (reply: unknown) => void) => boolean | void): void };
  };
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
}

export function extensionApi(): ExtApi | null {
  const g = globalThis as unknown as { browser?: ExtApi; chrome?: ExtApi };
  const api = g.browser ?? g.chrome ?? null;
  return api && api.runtime ? api : null;
}
