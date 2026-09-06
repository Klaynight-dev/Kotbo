

declare module 'node:http' {
  interface IncomingMessage {
    bodyText?: string;
  }
}

declare global {
  // eslint-disable-next-line no-var
  var KOTBO_MAINTENANCE_MODE: boolean;
  // eslint-disable-next-line no-var
  var KOTBO_BLACKLIST: Set<string>;
  // eslint-disable-next-line no-var
  var KOTBO_WS_BROADCASTER: ((guildId: string, reason: string) => void) | undefined;
  // eslint-disable-next-line no-var
  var KOTBO_WS_EVENT_BROADCASTER: ((event: { type: string } & Record<string, unknown>) => void) | undefined;
}

export {};
