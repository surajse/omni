// Omni web console: a zero-dependency node:http + SSE chat UI.
//
// One page, four jobs: pick an agent, chat with live event streaming, watch the
// run transcript, and approve/deny pending tool approvals from the browser.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  RunRecorder,
  type Agent,
  type AgentConfig,
  type AgentRegistry,
  type ApprovalHandler,
  type RunEvent,
} from '@omni/kernel';

export interface WebRunHooks {
  approve: ApprovalHandler;
  onEvent: (event: RunEvent) => void;
}

export interface WebServerOptions {
  registry: AgentRegistry;
  /** Agent home directory for run transcripts: (agentId) => dir. */
  agentHome: (id: string) => string;
  /** Build an Agent for a run; the given hooks MUST be wired into it. */
  makeAgent: (config: AgentConfig, hooks: WebRunHooks) => Agent;
  /** Bind host. Defaults to 127.0.0.1 — never expose without auth (see docs/WEB.md). */
  host?: string;
  port?: number;
  /**
   * Optional bearer token. When set, `/` and every `/api/*` route require
   * `?token=<value>` (constant-time comparison). Set OMNI_WEB_TOKEN if you
   * ever bind wider than localhost.
   */
  token?: string;
}

interface PendingApproval {
  id: string;
  runId: string;
  tool: string;
  args: Record<string, unknown>;
  createdAt: string;
  resolve: (approved: boolean) => void;
}

interface RunState {
  runId: string;
  agentId: string;
  done: boolean;
  output: string;
  recorder: RunRecorder;
  clients: Set<ServerResponse>;
}

export interface WebServer {
  start(): Promise<number>;
  stop(): Promise<void>;
}

const APPROVAL_RE = /^\/api\/approvals\/([A-Za-z0-9-]+)$/;
const RUN_RE = /^\/api\/runs\/([A-Za-z0-9-]+)$/;

/** True when no token is configured, or the request carries the right ?token=. */
function makeAuthorizer(token: string | undefined): (url: URL) => boolean {
  if (!token) return () => true;
  const expected = Buffer.from(token);
  return (url: URL) => {
    const given = Buffer.from(url.searchParams.get('token') ?? '');
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
}

export function createWebServer(opts: WebServerOptions): WebServer {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 8080;
  const authorized = makeAuthorizer(opts.token);
  const runs = new Map<string, RunState>();
  const approvals = new Map<string, PendingApproval>();
  let server: Server | null = null;

  function broadcast(runId: string, event: RunEvent): void {
    const state = runs.get(runId);
    if (!state) return;
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of state.clients) {
      res.write(payload);
    }
  }

  function json(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(text),
    });
    res.end(text);
  }

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    const text = await readBody(req);
    if (!text.trim()) return {};
    return JSON.parse(text) as unknown;
  }

  function finishRun(state: RunState, output: string, emitDone: boolean): void {
    state.done = true;
    state.output = output;
    try {
      state.recorder.save(opts.agentHome(state.agentId), state.runId);
    } catch {
      // Transcript persistence is best-effort; never fail a run over it.
    }
    if (emitDone) {
      const done: RunEvent = { type: 'done', output };
      state.recorder.record(done);
      broadcast(state.runId, done);
    }
    for (const res of state.clients) res.end();
    state.clients.clear();
  }

  function startRun(config: AgentConfig, message: string): string {
    const runId = randomUUID();
    const recorder = new RunRecorder();
    const state: RunState = { runId, agentId: config.id, done: false, output: '', recorder, clients: new Set() };
    runs.set(runId, state);

    const hooks: WebRunHooks = {
      approve: (req) =>
        new Promise<boolean>((resolve) => {
          const id = randomUUID();
          approvals.set(id, {
            id,
            runId,
            tool: req.tool,
            args: req.args,
            createdAt: new Date().toISOString(),
            resolve,
          });
        }),
      onEvent: (event) => {
        recorder.record(event);
        broadcast(runId, event);
      },
    };

    const agent = opts.makeAgent(config, hooks);
    void agent
      .run(message)
      .then((output) => finishRun(state, output, false)) // run() already emitted `done`
      .catch((err: unknown) => {
        const output = `Error: ${err instanceof Error ? err.message : String(err)}`;
        finishRun(state, output, true);
      });
    return runId;
  }

  function serveEvents(runId: string | null, req: IncomingMessage, res: ServerResponse): void {
    const state = runId ? runs.get(runId) : undefined;
    if (!state) {
      json(res, 404, { error: `unknown run: ${runId}` });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    for (const entry of state.recorder.list()) {
      res.write(`event: ${entry.event.type}\ndata: ${JSON.stringify(entry.event)}\n\n`);
    }
    if (state.done) {
      res.end();
      return;
    }
    state.clients.add(res);
    req.on('close', () => {
      state.clients.delete(res);
    });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!authorized(url)) {
      json(res, 401, { error: 'unauthorized: valid ?token= required' });
      return;
    }
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'GET' && path === '/') {
      const page = PAGE;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(page) });
      res.end(page);
      return;
    }

    if (method === 'GET' && path === '/api/agents') {
      json(
        res,
        200,
        opts.registry.list().map((a) => ({ id: a.id, name: a.name, description: a.description ?? '' })),
      );
      return;
    }

    if (method === 'POST' && path === '/api/chat') {
      const body = (await readJsonBody(req)) as { agentId?: unknown; message?: unknown };
      if (typeof body.agentId !== 'string' || typeof body.message !== 'string' || !body.message.trim()) {
        json(res, 400, { error: 'body must be { agentId: string, message: string }' });
        return;
      }
      let config: AgentConfig;
      try {
        config = opts.registry.get(body.agentId);
      } catch {
        json(res, 404, { error: `unknown agent: ${body.agentId}` });
        return;
      }
      const runId = startRun(config, body.message);
      json(res, 200, { runId });
      return;
    }

    if (method === 'GET' && path === '/api/events') {
      serveEvents(url.searchParams.get('runId'), req, res);
      return;
    }

    if (method === 'GET' && path === '/api/approvals') {
      json(
        res,
        200,
        [...approvals.values()].map((a) => ({
          id: a.id,
          runId: a.runId,
          tool: a.tool,
          args: a.args,
          createdAt: a.createdAt,
        })),
      );
      return;
    }

    const approvalMatch = APPROVAL_RE.exec(path);
    if (method === 'POST' && approvalMatch) {
      const pending = approvals.get(approvalMatch[1]!);
      if (!pending) {
        json(res, 404, { error: 'unknown approval' });
        return;
      }
      const body = (await readJsonBody(req)) as { approved?: unknown };
      const approved = body.approved === true;
      approvals.delete(pending.id);
      pending.resolve(approved);
      json(res, 200, { ok: true, approved });
      return;
    }

    const runMatch = RUN_RE.exec(path);
    if (method === 'GET' && runMatch) {
      const state = runs.get(runMatch[1]!);
      if (!state) {
        json(res, 404, { error: 'unknown run' });
        return;
      }
      json(res, 200, {
        runId: state.runId,
        agentId: state.agentId,
        done: state.done,
        output: state.output,
        events: state.recorder.list(),
      });
      return;
    }

    json(res, 404, { error: 'not found' });
  }

  async function start(): Promise<number> {
    server = createServer((req, res) => {
      void handle(req, res).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (!res.headersSent) json(res, 500, { error: message });
        else res.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(port, host, () => resolve());
    });
    const addr = server.address();
    return typeof addr === 'object' && addr !== null ? addr.port : port;
  }

  async function stop(): Promise<void> {
    for (const state of runs.values()) {
      for (const res of state.clients) res.end();
      state.clients.clear();
    }
    runs.clear();
    for (const pending of approvals.values()) pending.resolve(false);
    approvals.clear();
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
      server = null;
    }
  }

  return { start, stop };
}

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Omni Console</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 900px; margin: 1rem auto; padding: 0 1rem; color: #1a1a1a; }
h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 1.5rem; border-bottom: 1px solid #ddd; padding-bottom: .25rem; }
#chatLog div { padding: .3rem .5rem; margin: .2rem 0; background: #f4f4f4; border-radius: 6px; white-space: pre-wrap; }
#eventsLog, #transcriptPre { background: #111; color: #cfc; padding: .5rem; border-radius: 6px; max-height: 220px; overflow: auto; white-space: pre-wrap; font-size: .8rem; }
.approval { border: 1px solid #c90; background: #fff8e6; padding: .5rem; margin: .3rem 0; border-radius: 6px; }
button { margin: .1rem .25rem; padding: .3rem .7rem; cursor: pointer; }
input[type=text] { width: 60%; padding: .3rem; }
.row { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
</style>
</head>
<body>
<h1>Omni Console</h1>

<div class="row">
  <label>Agent: <select id="agentSelect"></select></label>
  <input type="text" id="chatInput" placeholder="Ask something…">
  <button id="sendBtn">Send</button>
</div>

<h2>Chat</h2>
<div id="chatLog"></div>

<h2>Pending approvals</h2>
<div id="approvalsList">Loading…</div>

<h2>Live events</h2>
<pre id="eventsLog"></pre>

<h2>Run transcript</h2>
<div class="row">
  <input type="text" id="runIdInput" placeholder="run id">
  <button id="loadRunBtn">Load</button>
</div>
<pre id="transcriptPre"></pre>

<script>
// Token passthrough: the server may require ?token= on every route.
// Read it from the page URL once and append it to all API calls.
var TOKEN = new URLSearchParams(location.search).get('token') || '';
function api(path) {
  return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN);
}
function addLog(who, text) {
  var log = document.getElementById('chatLog');
  var div = document.createElement('div');
  div.textContent = who + ': ' + text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}
function logEvent(t) {
  var pre = document.getElementById('eventsLog');
  pre.textContent += t + '\\n';
  pre.scrollTop = pre.scrollHeight;
}
function refreshAgents() {
  fetch(api('/api/agents')).then(function (r) { return r.json(); }).then(function (agents) {
    var sel = document.getElementById('agentSelect');
    sel.innerHTML = '';
    agents.forEach(function (a) {
      var o = document.createElement('option');
      o.value = a.id;
      o.textContent = a.name + (a.description ? ' — ' + a.description : '');
      sel.appendChild(o);
    });
  });
}
var es = null;
function watchRun(runId) {
  if (es) es.close();
  document.getElementById('eventsLog').textContent = '';
  document.getElementById('runIdInput').value = runId;
  es = new EventSource(api('/api/events?runId=' + encodeURIComponent(runId)));
  es.addEventListener('tool-call', function (e) {
    var d = JSON.parse(e.data);
    logEvent('tool-call: ' + d.call.name + ' ' + JSON.stringify(d.call.arguments));
  });
  es.addEventListener('approval', function (e) {
    var d = JSON.parse(e.data);
    logEvent('approval: ' + d.call.name + ' -> ' + d.decision);
  });
  es.addEventListener('tool-result', function () { logEvent('tool-result received'); });
  es.addEventListener('text', function (e) {
    var d = JSON.parse(e.data);
    if (d.text) logEvent('text: ' + d.text.slice(0, 200));
  });
  es.addEventListener('done', function (e) {
    var d = JSON.parse(e.data);
    addLog('agent', d.output);
    logEvent('done');
    es.close();
    refreshApprovals();
  });
}
function sendChat() {
  var agentId = document.getElementById('agentSelect').value;
  var input = document.getElementById('chatInput');
  var msg = input.value.trim();
  if (!msg || !agentId) return;
  input.value = '';
  addLog('you', msg);
  fetch(api('/api/chat'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: agentId, message: msg })
  }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
    .then(function (res) {
      if (!res.ok) { addLog('error', res.d.error || 'chat failed'); return; }
      watchRun(res.d.runId);
    });
}
function decide(id, approved) {
  fetch(api('/api/approvals/' + encodeURIComponent(id)), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approved: approved })
  }).then(refreshApprovals);
}
function refreshApprovals() {
  fetch(api('/api/approvals')).then(function (r) { return r.json(); }).then(function (list) {
    var box = document.getElementById('approvalsList');
    box.innerHTML = '';
    if (list.length === 0) { box.textContent = 'No pending approvals.'; return; }
    list.forEach(function (a) {
      var div = document.createElement('div');
      div.className = 'approval';
      var label = document.createElement('div');
      label.textContent = a.tool + ' ' + JSON.stringify(a.args);
      var ok = document.createElement('button');
      ok.textContent = 'Approve';
      ok.onclick = function () { decide(a.id, true); };
      var no = document.createElement('button');
      no.textContent = 'Deny';
      no.onclick = function () { decide(a.id, false); };
      div.appendChild(label); div.appendChild(ok); div.appendChild(no);
      box.appendChild(div);
    });
  });
}
function loadRun() {
  var id = document.getElementById('runIdInput').value.trim();
  if (!id) return;
  fetch(api('/api/runs/' + encodeURIComponent(id)))
    .then(function (r) { return r.json(); })
    .then(function (d) {
      document.getElementById('transcriptPre').textContent = JSON.stringify(d, null, 2);
    });
}
document.getElementById('sendBtn').onclick = sendChat;
document.getElementById('chatInput').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') sendChat();
});
document.getElementById('loadRunBtn').onclick = loadRun;
refreshAgents();
refreshApprovals();
setInterval(refreshApprovals, 2000);
</script>
</body>
</html>`;
