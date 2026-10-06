#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const valueOf = (flag) => args[args.indexOf(flag) + 1];
const mode = process.env.FAKE_CLAUDE_MODE ?? 'success';
const print = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

/** Read the stream-json input the way claude does: an initialize request, then the user message. */
async function readInput() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const lines = raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const init = lines.find((line) => line.type === 'control_request');
  const user = lines.find((line) => line.type === 'user');
  return {
    instructions: init?.request?.appendSystemPrompt ?? '',
    prompt: user?.message?.content ?? '',
  };
}

async function mcp(config, method, params, id) {
  const server = config.mcpServers.conclavix;
  const response = await fetch(server.url, {
    method: 'POST',
    headers: {
      ...server.headers,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return response.json();
}

if (mode === 'fail') {
  process.stderr.write('boom: something broke\n');
  process.exit(1);
}
if (mode === 'leak') {
  await readInput();
  const gateway = (process.env.ANTHROPIC_CUSTOM_HEADERS ?? '').replace(/^.*Bearer /, '');
  const runToken = process.env.CONCLAVIX_RUN_TOKEN ?? '';
  writeFileSync(
    '.env',
    `GATEWAY=${gateway}\nRUN=${runToken}\nGH=ghp_FAKEfakeFAKEfakeFAKEfake0123456789\n`,
  );
  const env = readFileSync('.env', 'utf8');
  print({ type: 'system', subtype: 'init', mcp_servers: [] });
  print({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Read', input: { env, gateway } }] },
  });
  print({ type: 'assistant', message: { content: [{ type: 'text', text: `found:\n${env}` }] } });
  process.stderr.write(`debug ${gateway} ${runToken}\n`);
  print({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, result: env });
} else if (mode === 'hang') {
  setInterval(() => {}, 1000);
} else {
  const rawConfig = valueOf('--mcp-config');
  const config = JSON.parse(
    (rawConfig.trimStart().startsWith('{') ? rawConfig : readFileSync(rawConfig, 'utf8')).replace(
      /\$\{(\w+)\}/g,
      (_, name) => process.env[name] ?? '',
    ),
  );
  const tokenInArgv = args.some((arg) => arg.includes(process.env.CONCLAVIX_RUN_TOKEN));
  const input = await readInput();
  if (process.env.FAKE_CLAUDE_RECORD) {
    writeFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify({ args, ...input }));
  }
  print({
    type: 'system',
    subtype: 'init',
    mcp_servers: [{ name: 'conclavix', status: 'connected' }],
  });
  await mcp(
    config,
    'initialize',
    { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '1' } },
    1,
  );
  const body = `fake agent was here; budget=${valueOf('--max-budget-usd')}; toolsearch=${process.env.ENABLE_TOOL_SEARCH}; secret=${process.env.RUNNER_TEST_SECRET}; cwd=${process.cwd()}; tools=${valueOf('--tools')}; permissions=${valueOf('--permission-mode')}; argvtoken=${tokenInArgv}; gateway=${process.env.ANTHROPIC_CUSTOM_HEADERS ?? 'none'}`;
  print({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', name: 'mcp__conclavix__add_comment', input: { body } }],
    },
  });
  const reply = await mcp(config, 'tools/call', { name: 'add_comment', arguments: { body } }, 2);
  print({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: reply.result?.isError ? 'tool failed' : 'comment posted' }],
    },
  });
  if (mode === 'budget') {
    print({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 0.5 });
    process.exit(1);
  }
  print({
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: 0.12,
    result: 'done',
  });
}
