#!/usr/bin/env node
// Interactive debug client for Hypen servers.
//
// Connects via WebSocket, prints all patches to stdout, and accepts
// commands from stdin to dispatch actions.
//
// Usage: node debug-client.js [port]
//
// Commands (type in terminal):
//   action <name> [json-payload]   — dispatch an action
//   bind <path> <value>            — dispatch a __hypen_bind action
//   state                          — request current state (subscribeState)
//   quit / exit                    — disconnect and exit
//
// Examples:
//   action switchTab {"tab":"search"}
//   bind searchQuery "hello"
//   action like {"postId":"post_1"}
//   state

const port = process.argv[2] || 3000;
const url = `ws://localhost:${port}/ws`;

const readline = require('readline');

let revision = 0;
let ws;

// ── Pretty-print helpers ──────────────────────────────────────────────

const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function printPatch(p) {
  const tag = `${CYAN}[patch]${RESET}`;
  switch (p.type || p.op) {
    case 'Create':
    case 'create':
      console.log(`${tag} ${GREEN}CREATE${RESET} ${p.id}  type=${p.element_type || p.elementType}  props=${JSON.stringify(p.props || {})}`);
      break;
    case 'SetProp':
    case 'setProp':
      console.log(`${tag} SET    ${p.id}.${p.name} = ${JSON.stringify(p.value)}`);
      break;
    case 'RemoveProp':
    case 'removeProp':
      console.log(`${tag} UNSET  ${p.id}.${p.name}`);
      break;
    case 'SetText':
    case 'setText':
      console.log(`${tag} TEXT   ${p.id} = ${JSON.stringify(p.text)}`);
      break;
    case 'Insert':
    case 'insert':
      console.log(`${tag} INSERT ${p.id} → parent=${p.parent_id || p.parentId}  before=${p.before_id || p.beforeId || 'end'}`);
      break;
    case 'Move':
    case 'move':
      console.log(`${tag} MOVE   ${p.id} → parent=${p.parent_id || p.parentId}  before=${p.before_id || p.beforeId || 'end'}`);
      break;
    case 'Remove':
    case 'remove':
      console.log(`${tag} ${YELLOW}REMOVE${RESET} ${p.id}`);
      break;
    default:
      console.log(`${tag} ${JSON.stringify(p)}`);
  }
}

function printState(state) {
  console.log(`${BOLD}[state]${RESET}`);
  console.log(JSON.stringify(state, null, 2));
}

// ── WebSocket connection ──────────────────────────────────────────────

console.log(`Connecting to ${url} ...`);
ws = new WebSocket(url);

ws.addEventListener('open', () => {
  console.log(`${GREEN}Connected.${RESET} Sending hello...\n`);
  ws.send(JSON.stringify({ type: 'hello' }));
  // Subscribe to state updates so we can inspect state
  ws.send(JSON.stringify({ type: 'subscribeState' }));
});

ws.addEventListener('message', (event) => {
  const raw = typeof event.data === 'string' ? event.data : event.data.toString();
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    console.log(`${DIM}(non-JSON: ${raw})${RESET}`);
    return;
  }

  switch (m.type) {
    case 'sessionAck':
      console.log(`${DIM}sessionAck  id=${m.sessionId}  new=${m.isNew}${RESET}`);
      break;

    case 'initialTree': {
      const patches = m.patches || [];
      revision = m.revision || 0;
      console.log(`\n${BOLD}── initialTree (${patches.length} patches, rev ${revision}) ──${RESET}`);
      patches.forEach(printPatch);
      if (m.state) {
        console.log(`\n${BOLD}── initial state ──${RESET}`);
        printState(m.state);
      }
      console.log(`\n${DIM}Type "help" for commands.${RESET}\n`);
      break;
    }

    case 'patch': {
      const patches = m.patches || [];
      revision = m.revision || revision;
      console.log(`\n${BOLD}── patch (${patches.length} patches, rev ${revision}) ──${RESET}`);
      patches.forEach(printPatch);
      console.log('');
      break;
    }

    case 'stateUpdate':
      if (m.state) {
        console.log(`\n${BOLD}── stateUpdate ──${RESET}`);
        printState(m.state);
        console.log('');
      }
      break;

    default:
      console.log(`${DIM}[${m.type || 'unknown'}] ${JSON.stringify(m)}${RESET}`);
  }
});

ws.addEventListener('close', () => {
  console.log(`\n${YELLOW}Disconnected.${RESET}`);
  process.exit(0);
});

ws.addEventListener('error', (e) => {
  console.error(`Connection error: ${e.message || e.type}`);
  process.exit(1);
});

// ── Interactive input ─────────────────────────────────────────────────

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: `${DIM}>${RESET} `,
});

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) { rl.prompt(); return; }

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  switch (cmd) {
    case 'help':
      console.log(`
Commands:
  action <name> [json-payload]   Dispatch an action
  bind <path> <value>            Dispatch __hypen_bind
  state                          Request full state
  quit / exit                    Disconnect
`);
      break;

    case 'action': {
      const actionName = parts[1];
      if (!actionName) {
        console.log('Usage: action <name> [json-payload]');
        break;
      }
      let payload = {};
      const rest = trimmed.slice(trimmed.indexOf(actionName) + actionName.length).trim();
      if (rest) {
        try { payload = JSON.parse(rest); } catch {
          console.log(`Invalid JSON payload: ${rest}`);
          break;
        }
      }
      const msg = { type: 'dispatchAction', action: actionName, payload };
      ws.send(JSON.stringify(msg));
      console.log(`${DIM}→ dispatched ${actionName}${RESET}`);
      break;
    }

    case 'bind': {
      const path = parts[1];
      const value = parts.slice(2).join(' ');
      if (!path) {
        console.log('Usage: bind <path> <value>');
        break;
      }
      // Try to parse value as JSON, fall back to string
      let parsed;
      try { parsed = JSON.parse(value); } catch { parsed = value; }
      const msg = {
        type: 'dispatchAction',
        action: '__hypen_bind',
        payload: { path, value: parsed },
      };
      ws.send(JSON.stringify(msg));
      console.log(`${DIM}→ bound ${path} = ${JSON.stringify(parsed)}${RESET}`);
      break;
    }

    case 'state':
      ws.send(JSON.stringify({ type: 'subscribeState' }));
      console.log(`${DIM}→ requested state${RESET}`);
      break;

    case 'quit':
    case 'exit':
      ws.close();
      break;

    default:
      console.log(`Unknown command: ${cmd}. Type "help" for usage.`);
  }

  rl.prompt();
});

rl.on('close', () => {
  ws.close();
});

// Start prompting after a short delay to let initial messages print
setTimeout(() => rl.prompt(), 500);
