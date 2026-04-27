#!/usr/bin/env node
// Usage: node test-nested-modules.js [port]
//
// Connects to ws://localhost:<port>/ws, sends hello, verifies:
// 1. initialTree has patches > 0 (engine rendered something)
// 2. Primary state has currentUser, posts (App module's state)
// 3. Search module's state is NOT leaked into primary (no searchQuery at root)
// 4. dispatchAction targeting a bind works without crash

const port = process.argv[2] || 3000;
const url = `ws://localhost:${port}/ws`;

let passed = 0;
let failed = 0;
let step = 0;

function check(label, ok) {
  if (ok) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.log(`  FAIL: ${label}`);
    failed++;
  }
}

console.log(`Connecting to ${url} ...`);

const ws = new WebSocket(url);

ws.addEventListener('open', () => {
  console.log('Connected. Sending hello...\n');
  ws.send(JSON.stringify({ type: 'hello' }));
});

ws.addEventListener('message', (event) => {
  const raw = typeof event.data === 'string' ? event.data : event.data.toString();
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    console.log('  (non-JSON message, skipping)');
    return;
  }

  if (m.type === 'sessionAck') {
    console.log('[1] sessionAck received');
    check('sessionAck has sessionId', typeof m.sessionId === 'string' && m.sessionId.length > 0);
    return;
  }

  if (m.type === 'initialTree' && step === 0) {
    step = 1;
    console.log(`\n[2] initialTree received (${(m.patches || []).length} patches)`);

    // Check patches exist
    check('initialTree has patches > 0', Array.isArray(m.patches) && m.patches.length > 0);

    // Check primary state has expected App-level fields
    if (m.state) {
      check('root state has currentUser', 'currentUser' in m.state);
      check('root state has posts', 'posts' in m.state);
      check('root state has location', 'location' in m.state);

      // Search module's state must NOT leak into root
      check('searchQuery NOT in root state (scoping works)', !('searchQuery' in m.state));
      check('explorePosts NOT in root state (scoping works)', !('explorePosts' in m.state));
    } else {
      check('state object exists in initialTree', false);
    }

    // Note: Search module is only rendered when location === "/search".
    // The initial route is "/", so Search elements (Input, Grid) won't
    // appear in the initial patches. The key assertion is that searchQuery
    // and explorePosts are NOT in root state — that proves engine scoping.

    // Send a bind action to exercise the Search module's state path
    console.log('\n[3] Dispatching __hypen_bind to searchQuery...');
    ws.send(JSON.stringify({
      type: 'dispatchAction',
      action: '__hypen_bind',
      payload: { path: 'searchQuery', value: 'test query' },
    }));

    // Wait for any response (patch or stateUpdate), then finish
    setTimeout(() => {
      finish();
    }, 2000);
    return;
  }

  // Handle patch / stateUpdate responses after our bind dispatch
  if (step === 1 && (m.type === 'patch' || m.type === 'stateUpdate')) {
    step = 2;
    console.log(`\n[4] ${m.type} received after bind dispatch`);
    check(`${m.type} response received for bind action`, true);

    if (m.type === 'stateUpdate' && m.state) {
      // Root state should still not have searchQuery
      check('searchQuery still not in root state after bind', !('searchQuery' in m.state));
    }
  }
});

ws.addEventListener('error', (e) => {
  console.error(`Connection error: ${e.message || e.type}`);
  process.exit(1);
});

function finish() {
  console.log('\n' + '='.repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(50));
  ws.close();
  process.exit(failed > 0 ? 1 : 0);
}

setTimeout(() => {
  console.error('\nTimeout: no response from server within 15s');
  process.exit(1);
}, 15000);
