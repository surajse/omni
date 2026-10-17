// Interactive terminal channel built on node:readline/promises.
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { Channel } from './channel.js';

export class ConsoleChannel implements Channel {
  readonly id = 'console';
  private readonly rl = createInterface({ input, output, terminal: true });
  private handler: ((text: string) => Promise<string | void>) | null = null;
  private running = false;

  async send(text: string): Promise<void> {
    output.write(text + '\n');
  }

  onMessage(handler: (text: string) => Promise<string | void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    this.running = true;
    while (this.running) {
      let line: string;
      try {
        line = await this.rl.question('you> ');
      } catch {
        break; // stdin closed (Ctrl+D)
      }
      const text = line.trim();
      if (text === '/quit' || text === '/exit') break;
      if (text.length === 0) continue;
      try {
        const reply = await this.handler?.(text);
        if (typeof reply === 'string' && reply.length > 0) {
          await this.send(`agent> ${reply}`);
        }
      } catch (err) {
        await this.send(`agent> Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await this.stop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.rl.close();
  }
}
