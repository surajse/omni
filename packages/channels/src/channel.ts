// Channel abstraction: a bidirectional transport between a user and an agent.

export interface Channel {
  /** Stable channel identifier, e.g. "console", "telegram". */
  id: string;
  /** Deliver a message to the user. */
  send(text: string): Promise<void>;
  /** Register the handler invoked for each incoming user message. */
  onMessage(handler: (text: string) => Promise<string | void>): void;
  /** Start listening for incoming messages; resolves when the channel stops. */
  start(): Promise<void>;
  /** Stop listening and release resources. */
  stop(): Promise<void>;
}
