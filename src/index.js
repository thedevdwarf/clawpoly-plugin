const https = require('https');
const http = require('http');
const { URL } = require('url');
const { execFile } = require('child_process');

const DEFAULT_SERVER_URL = 'https://server.clawpoly.fun/mcp';

// ─── Runtime state ────────────────────────────────────────────────────────────

const ps = {
  serverUrl: DEFAULT_SERVER_URL,
  sessionId: null,
  agentToken: null,
  reqId: 1,
  lastGameState: null,
  stopSSE: null,
};

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function httpPost(url, extraHeaders, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;

    const req = mod.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'Content-Length': Buffer.byteLength(data),
          ...extraHeaders,
        },
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c.toString()));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: chunks }),
        );
        res.on('error', reject);
      },
    );

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function parseSSEResult(raw) {
  const lines = raw
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim());

  if (!lines.length) throw new Error(`No SSE data lines in: ${raw.slice(0, 200)}`);

  const msg = JSON.parse(lines.join(''));
  if (msg.error) throw new Error(JSON.stringify(msg.error));

  const result = msg.result ?? msg;
  const text = result?.content?.[0]?.text;
  if (typeof text === 'string' && (text.startsWith('{') || text.startsWith('['))) {
    try { return JSON.parse(text); } catch { return result; }
  }
  return result;
}

// ─── MCP protocol ─────────────────────────────────────────────────────────────

async function mcpInitialize(serverUrl) {
  const res = await httpPost(serverUrl, {}, {
    jsonrpc: '2.0',
    id: ps.reqId++,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'openclaw-plugin-clawpoly', version: '1.0.0' },
    },
  });

  const sid = res.headers['mcp-session-id'];
  if (!sid) throw new Error('MCP initialize: Mcp-Session-Id header missing');

  await httpPost(serverUrl, { 'Mcp-Session-Id': sid }, {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {},
  });

  return sid;
}

async function mcpCallTool(name, args) {
  if (!ps.sessionId) throw new Error('MCP session not initialized');

  const res = await httpPost(
    ps.serverUrl,
    { 'Mcp-Session-Id': ps.sessionId },
    {
      jsonrpc: '2.0',
      id: ps.reqId++,
      method: 'tools/call',
      params: { name, arguments: args },
    },
  );

  return parseSSEResult(res.body);
}

// ─── SSE stream ───────────────────────────────────────────────────────────────

function openSSEStream(onDecision, log) {
  let stopped = false;
  let req = null;

  function connect() {
    if (stopped || !ps.sessionId) return;

    const parsed = new URL(ps.serverUrl);
    const mod = parsed.protocol === 'https:' ? https : http;

    req = mod.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname,
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          'Mcp-Session-Id': ps.sessionId,
        },
      },
      (res) => {
        log('[clawpoly] SSE stream open');
        let buf = '';

        res.on('data', (chunk) => {
          buf += chunk.toString();
          const parts = buf.split('\n\n');
          buf = parts.pop() ?? '';

          for (const part of parts) {
            const dataLine = part.split('\n').find((l) => l.startsWith('data:'));
            if (!dataLine) continue;
            try {
              const msg = JSON.parse(dataLine.slice(5).trim());
              const data = msg?.params?.data;
              if (data?.event === 'pending_decision') {
                onDecision(data);
              }
            } catch { /* malformed chunk, skip */ }
          }
        });

        res.on('end', () => {
          if (!stopped) {
            log('[clawpoly] SSE disconnected, reconnecting in 3s');
            setTimeout(connect, 3000);
          }
        });

        res.on('error', () => {
          if (!stopped) setTimeout(connect, 3000);
        });
      },
    );

    req.on('error', (err) => {
      log(`[clawpoly] SSE error: ${err.message}, retry in 5s`);
      if (!stopped) setTimeout(connect, 5000);
    });

    req.end();
  }

  connect();
  return () => { stopped = true; req?.destroy(); };
}

// ─── Decision prompt builder ──────────────────────────────────────────────────

function buildDecisionPrompt(decision) {
  const me = ps.lastGameState?.me ?? {};
  const money = me.money ?? '?';
  const escapeCards = me.escapeCards ?? 0;

  const header = `[CLAWPOLY] DECISION REQUIRED — 30 SECONDS. Call clawpoly_decide IMMEDIATELY. Do NOT call clawpoly_state first.\n\n`;

  if (decision.type === 'buy') {
    const prop = decision.context?.property ?? {};
    return (
      header +
      `BUY DECISION\n` +
      `Property: ${prop.name ?? '?'} (index ${prop.index ?? '?'}), Price: ${prop.price ?? '?'} Shells\n` +
      `Your money: ${money} Shells\n\n` +
      `Rule: if (money - price >= 200) → action="buy", else → action="pass"\n` +
      `Call clawpoly_decide NOW with action="buy" or action="pass".`
    );
  }

  if (decision.type === 'build') {
    const buildable = (decision.context?.buildableSquares ?? []).map((s) => s.index);
    const upgradeable = (decision.context?.upgradeableSquares ?? []).map((s) => s.index);
    return (
      header +
      `BUILD DECISION\n` +
      `Can build outposts at indices: [${buildable.join(', ')}]\n` +
      `Can upgrade to fortress at indices: [${upgradeable.join(', ')}]\n` +
      `Your money: ${money} Shells\n\n` +
      `Call clawpoly_decide NOW with action="build:INDEX", "upgrade:INDEX", or "skip_build".`
    );
  }

  if (decision.type === 'lobster_pot') {
    return (
      header +
      `LOBSTER POT ESCAPE\n` +
      `Escape cards: ${escapeCards}, Money: ${money} Shells\n\n` +
      `Rule: if escapeCards > 0 → "escape_card", elif money >= 250 → "escape_pay", else → "escape_roll"\n` +
      `Call clawpoly_decide NOW.`
    );
  }

  return header + `Decision type: ${decision.type}. Call clawpoly_decide NOW.`;
}

// ─── Session init ─────────────────────────────────────────────────────────────

async function ensureSession(api) {
  if (ps.sessionId) return;
  api.logger.info('[clawpoly] Initializing MCP session...');
  ps.sessionId = await mcpInitialize(ps.serverUrl);
  api.logger.info(`[clawpoly] Session ready: ${ps.sessionId}`);
}

async function startSSE(api) {
  ps.stopSSE?.();

  ps.stopSSE = openSSEStream((decision) => {
    api.logger.info(`[clawpoly] SSE received: ${decision.type}`);

    const prompt = buildDecisionPrompt(decision);
    api.logger.info(`[clawpoly] Invoking openclaw agent...`);

    execFile('openclaw', ['agent', '--agent', 'main', '--message', prompt], { timeout: 25000 }, (err, stdout, stderr) => {
      if (err) {
        api.logger.error(`[clawpoly] openclaw agent failed: ${err.message}`);
      } else {
        api.logger.info(`[clawpoly] openclaw agent OK: ${stdout.trim()}`);
      }
    });
  }, (msg) => api.logger.info(msg));
}

// ─── Plugin entry point ───────────────────────────────────────────────────────

module.exports = function register(api) {
  const cfg = api.config ?? {};
  ps.serverUrl = cfg.serverUrl ?? DEFAULT_SERVER_URL;
  if (cfg.agentToken) ps.agentToken = cfg.agentToken;

  // Background service: MCP session + SSE
  api.registerService({
    id: 'clawpoly-sse',

    async start() {
      if (!ps.agentToken) {
        api.logger.info('[clawpoly] No agentToken configured. Call clawpoly_register first.');
        return;
      }
      await ensureSession(api);
      await startSSE(api);
      api.logger.info('[clawpoly] Ready — SSE stream active.');
    },

    async stop() {
      ps.stopSSE?.();
      ps.stopSSE = null;
      ps.sessionId = null;
      api.logger.info('[clawpoly] Stopped.');
    },
  });

  // ── Tools ─────────────────────────────────────────────────────────────────

  api.registerTool({
    name: 'clawpoly_register',
    description: 'Register a new Clawpoly agent. Call once to get your agentToken.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Your agent display name' },
      },
      required: ['name'],
    },
    async execute(_id, { name }) {
      await ensureSession(api);
      const result = await mcpCallTool('clawpoly_register', { name });
      if (result?.agentToken) {
        ps.agentToken = result.agentToken;
        await startSSE(api);
        api.logger.info(`[clawpoly] Registered as "${name}". Add agentToken to plugin config to persist.`);
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  });

  api.registerTool({
    name: 'clawpoly_start_with_bots',
    description: 'Start a Clawpoly game immediately against 3 bot opponents.',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(_id, _params) {
      if (!ps.agentToken) return { content: [{ type: 'text', text: 'No agentToken. Call clawpoly_register first.' }], isError: true };
      await ensureSession(api);
      const result = await mcpCallTool('clawpoly_start_with_bots', { agentToken: ps.agentToken });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  });

  api.registerTool({
    name: 'clawpoly_join_queue',
    description: 'Join the Clawpoly matchmaking queue (waits for 4 agents).',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(_id, _params) {
      if (!ps.agentToken) return { content: [{ type: 'text', text: 'No agentToken. Call clawpoly_register first.' }], isError: true };
      await ensureSession(api);
      const result = await mcpCallTool('clawpoly_join_queue', { agentToken: ps.agentToken });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  });

  api.registerTool({
    name: 'clawpoly_state',
    description: 'Get current game state: position, money, properties, pending decision.',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(_id, _params) {
      if (!ps.agentToken || !ps.sessionId) return { content: [{ type: 'text', text: 'Not connected.' }], isError: true };
      const result = await mcpCallTool('clawpoly_get_state', { agentToken: ps.agentToken });
      ps.lastGameState = result;
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  });

  api.registerCli(({ program }) => {
    program.command('clawpoly-test').description('Test openclaw agent invocation from plugin').action(() => {
      console.log('[clawpoly] Calling openclaw agent...');
      execFile('openclaw', ['agent', '--agent', 'main', '--message', 'Say exactly: "clawpoly test OK"'], { timeout: 25000 }, (err, stdout, stderr) => {
        if (err) console.error('[clawpoly] FAILED:', err.message);
        else console.log('[clawpoly] OK:', stdout.trim());
      });
    });
  }, { commands: ['clawpoly-test'] });

  api.registerTool({
    name: 'clawpoly_decide',
    description:
      'Submit a decision. Actions: "buy", "pass", "build:INDEX", "upgrade:INDEX", ' +
      '"skip_build", "escape_pay", "escape_card", "escape_roll". INDEX is a board position number.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Action to submit, e.g. "buy", "build:6", "skip_build"' },
      },
      required: ['action'],
    },
    async execute(_id, { action }) {
      if (!ps.agentToken || !ps.sessionId) return { content: [{ type: 'text', text: 'Not connected.' }], isError: true };
      const result = await mcpCallTool('clawpoly_get_state', { agentToken: ps.agentToken, action });
      ps.lastGameState = result;
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  });

}
