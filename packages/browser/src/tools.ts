// browser.* tools: register an agent's browser backend on a ToolGateway.
// Browsing is network egress, so all four are write-class (policy default:
// ask). An agent config can allowlist them explicitly.
import type { ToolGateway } from '@omni/kernel';
import type { BrowserBackend } from './backend.js';

function strArg(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`browser tool: argument "${name}" must be a non-empty string`);
  }
  return v;
}

/** Register browser.open / browser.snapshot / browser.click / browser.type on `gateway`. */
export function registerBrowserTools(gateway: ToolGateway, backend: BrowserBackend): void {
  gateway.register(
    {
      name: 'browser.open',
      description:
        'Open an http(s) URL in the agent\u2019s browser and wait for the page to load. ' +
        'Network egress — needs approval per policy.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'http(s) URL to open.' },
        },
        required: ['url'],
      },
      readOnly: false,
    },
    async (args) => {
      const url = strArg(args, 'url');
      await backend.open(url);
      return `opened ${url}`;
    },
  );

  gateway.register(
    {
      name: 'browser.snapshot',
      description:
        'Read the current page as an accessibility tree: lines like `[12] button "Sign in"`. ' +
        'Use the bracketed node ids with browser.click / browser.type.',
      parameters: { type: 'object', properties: {} },
      readOnly: false,
    },
    async () => backend.snapshot(),
  );

  gateway.register(
    {
      name: 'browser.click',
      description: 'Click a node from the latest browser.snapshot by its bracketed node id.',
      parameters: {
        type: 'object',
        properties: {
          node: { type: 'string', description: 'Node id from browser.snapshot, e.g. "12".' },
        },
        required: ['node'],
      },
      readOnly: false,
    },
    async (args) => {
      const node = strArg(args, 'node');
      await backend.click(node);
      return `clicked node ${node}`;
    },
  );

  gateway.register(
    {
      name: 'browser.type',
      description: 'Focus a node from the latest browser.snapshot and type text into it.',
      parameters: {
        type: 'object',
        properties: {
          node: { type: 'string', description: 'Node id from browser.snapshot, e.g. "12".' },
          text: { type: 'string', description: 'Text to type.' },
        },
        required: ['node', 'text'],
      },
      readOnly: false,
    },
    async (args) => {
      const node = strArg(args, 'node');
      const text = strArg(args, 'text');
      await backend.type(node, text);
      return `typed into node ${node}`;
    },
  );
}
