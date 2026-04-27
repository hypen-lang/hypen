package space.hypen

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.response.*
import io.ktor.server.routing.*

fun Application.configureRouting() {
    routing {
        get("/") {
            call.respondText(appHtml(), ContentType.Text.Html)
        }

        get("/health") {
            call.respondText("OK")
        }

        get("/stats") {
            call.respond(hypenServer.getStats())
        }
    }
}

private fun appHtml(): String = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Hypen Server</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
            min-height: 100vh;
            background: #0a0a0a;
            color: #fafafa;
        }

        /* Toolbar */
        .toolbar {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 12px 24px;
            background: #111;
            border-bottom: 1px solid #222;
        }
        .toolbar .logo {
            font-size: 14px;
            font-weight: 600;
            color: #888;
            margin-right: 16px;
            letter-spacing: 0.5px;
        }
        .toolbar .tab {
            padding: 8px 20px;
            border: 1px solid #333;
            border-radius: 6px;
            background: transparent;
            color: #888;
            font-size: 14px;
            cursor: pointer;
            transition: all 0.15s;
        }
        .toolbar .tab:hover { color: #ccc; border-color: #555; }
        .toolbar .tab.active {
            background: #fafafa;
            color: #0a0a0a;
            border-color: #fafafa;
        }
        .toolbar .spacer { flex: 1; }
        .toolbar .status {
            font-size: 12px;
            color: #555;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .toolbar .dot {
            width: 6px; height: 6px;
            border-radius: 50%;
            background: #555;
        }
        .toolbar .dot.connected { background: #4ade80; }

        /* Hypen root container */
        #hypen-root {
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: calc(100vh - 57px);
            padding: 32px;
        }

        /* ---- Hypen Component Styles ---- */

        /* Column */
        [data-hypen-type="column"] {
            display: flex;
            flex-direction: column;
            align-items: stretch;
        }

        /* Row */
        [data-hypen-type="row"] {
            display: flex;
            flex-direction: row;
            align-items: center;
            gap: 12px;
        }

        /* Text */
        [data-hypen-type="text"] {
            font-size: inherit;
            color: inherit;
        }

        /* Button */
        [data-hypen-type="button"] {
            padding: 12px 28px;
            border: 1px solid #333;
            border-radius: 8px;
            background: #111;
            color: #fafafa;
            font-size: 15px;
            cursor: pointer;
            transition: all 0.15s;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
        }
        [data-hypen-type="button"]:hover { background: #1a1a1a; border-color: #555; }
        [data-hypen-type="button"]:active { transform: scale(0.97); }

        /* Input */
        [data-hypen-type="input"] {
            width: 100%;
            padding: 10px 14px;
            border: 1px solid #333;
            border-radius: 8px;
            background: #111;
            color: #fafafa;
            font-size: 14px;
            font-family: inherit;
            outline: none;
            transition: border-color 0.15s;
        }
        [data-hypen-type="input"]:focus { border-color: #555; }

        /* Textarea */
        [data-hypen-type="textarea"] {
            width: 100%;
            padding: 10px 14px;
            border: 1px solid #333;
            border-radius: 8px;
            background: #111;
            color: #fafafa;
            font-size: 14px;
            font-family: inherit;
            outline: none;
            resize: vertical;
            min-height: 80px;
            transition: border-color 0.15s;
        }
        [data-hypen-type="textarea"]:focus { border-color: #555; }

        /* Container / Box */
        [data-hypen-type="container"],
        [data-hypen-type="box"] {
            display: flex;
            flex-direction: column;
        }

        /* Center */
        [data-hypen-type="center"] {
            display: flex;
            justify-content: center;
            align-items: center;
        }

        /* Spacer */
        [data-hypen-type="spacer"] {
            flex: 1;
        }

        /* Divider */
        [data-hypen-type="divider"] {
            height: 1px;
            background: #333;
            width: 100%;
        }

        /* Checkbox */
        [data-hypen-type="checkbox"] {
            width: 20px;
            height: 20px;
            accent-color: #fafafa;
        }

        /* Switch */
        [data-hypen-type="switch"] {
            width: 44px;
            height: 24px;
            accent-color: #fafafa;
        }
    </style>
</head>
<body>
    <div class="toolbar" id="toolbar">
        <span class="logo">hypen</span>
        <span class="spacer"></span>
        <div class="status">
            <span class="dot" id="dot"></span>
            <span id="status">connecting...</span>
        </div>
    </div>

    <div id="hypen-root"></div>

    <script>
    // =========================================================================
    // Hypen Client-Side Patch Renderer
    //
    // This is a minimal DOM renderer that applies patches from the Hypen server.
    // It mirrors the architecture of @hypen-space/web's DOMRenderer:
    //   - Flat node map: id -> HTMLElement
    //   - Component registry: elementType -> createElement function
    //   - Applicator registry: propName -> applyProp function
    //   - Patch application: create, setProp, setText, insert, move, remove
    // =========================================================================

    const rootEl = document.getElementById('hypen-root');
    const toolbarEl = document.getElementById('toolbar');
    const dotEl = document.getElementById('dot');
    const statusEl = document.getElementById('status');

    // Flat node map: patch id -> DOM element
    const nodes = new Map();
    let rootNodeId = null;
    let ws = null;
    let currentRoute = '/';
    let routes = [];
    let sessionId = null;

    // ---- Component Registry ----
    // Maps Hypen element types to DOM element constructors
    const components = {
        column:    () => document.createElement('div'),
        row:       () => document.createElement('div'),
        text:      () => document.createElement('span'),
        button:    () => document.createElement('button'),
        input:     () => { const el = document.createElement('input'); el.type = 'text'; return el; },
        textarea:  () => document.createElement('textarea'),
        image:     () => document.createElement('img'),
        container: () => document.createElement('div'),
        box:       () => document.createElement('div'),
        center:    () => document.createElement('div'),
        list:      () => document.createElement('div'),
        spacer:    () => document.createElement('div'),
        stack:     () => document.createElement('div'),
        divider:   () => document.createElement('hr'),
        grid:      () => document.createElement('div'),
        card:      () => document.createElement('div'),
        heading:   () => document.createElement('h1'),
        checkbox:  () => { const el = document.createElement('input'); el.type = 'checkbox'; return el; },
        select:    () => document.createElement('select'),
        switch:    () => { const el = document.createElement('input'); el.type = 'checkbox'; return el; },
        slider:    () => { const el = document.createElement('input'); el.type = 'range'; return el; },
        paragraph: () => document.createElement('p'),
        video:     () => document.createElement('video'),
        audio:     () => document.createElement('audio'),
        badge:     () => document.createElement('span'),
        avatar:    () => document.createElement('img'),
        spinner:   () => document.createElement('div'),
        progressbar: () => document.createElement('progress'),
    };

    // ---- Applicator Registry ----
    // Maps prop/applicator names to functions that apply them to elements
    function applyProp(element, name, value) {
        const type = element.dataset.hypenType;

        switch (name) {
            // Layout
            case 'padding':    element.style.padding = px(value); break;
            case 'margin':     element.style.margin = px(value); break;
            case 'gap':        element.style.gap = px(value); break;
            case 'flex':       element.style.flex = value; break;
            case 'width':      element.style.width = px(value); break;
            case 'height':     element.style.height = px(value); break;
            case 'minWidth':   element.style.minWidth = px(value); break;
            case 'maxWidth':   element.style.maxWidth = px(value); break;
            case 'minHeight':  element.style.minHeight = px(value); break;
            case 'maxHeight':  element.style.maxHeight = px(value); break;

            // Typography
            case 'fontSize':   element.style.fontSize = px(value); break;
            case 'fontWeight':
                element.style.fontWeight = (value === 'bold' || value === true) ? '700' : value;
                break;
            case 'fontFamily': element.style.fontFamily = value; break;
            case 'textAlign':  element.style.textAlign = value; break;
            case 'lineHeight': element.style.lineHeight = String(value); break;
            case 'letterSpacing': element.style.letterSpacing = px(value); break;

            // Colors
            case 'color':      element.style.color = cssColor(value); break;
            case 'background':
            case 'backgroundColor':
                element.style.backgroundColor = cssColor(value);
                break;

            // Border
            case 'border':       element.style.border = value; break;
            case 'borderRadius': element.style.borderRadius = px(value); break;
            case 'borderColor':  element.style.borderColor = cssColor(value); break;
            case 'borderWidth':  element.style.borderWidth = px(value); break;

            // Effects
            case 'opacity':    element.style.opacity = String(value); break;
            case 'shadow':     element.style.boxShadow = value; break;
            case 'overflow':   element.style.overflow = value; break;

            // Display
            case 'display':    element.style.display = value; break;
            case 'visible':    element.style.visibility = value ? 'visible' : 'hidden'; break;

            // Form attributes
            case 'placeholder':
                element.setAttribute('placeholder', value);
                break;
            case 'value':
                if (element !== document.activeElement) element.value = value;
                break;
            case 'enabled':
                element.disabled = !value;
                break;
            case 'disabled':
                element.disabled = !!value;
                break;
            case 'checked':
                element.checked = !!value;
                break;

            // Image
            case 'src':  element.src = value; break;
            case 'alt':  element.alt = value; break;

            // Events — action references like "@actions.Increment"
            case 'onClick':
            case 'onPress':
            case 'onTap':
                attachActionEvent(element, 'click', value);
                break;

            // Two-way binding
            case 'bind':
                attachBind(element, value);
                break;

            // Text content (first positional argument for Text/Button)
            case 'text':
                if (type === 'button') {
                    // Button text is set as child, not textContent
                } else {
                    element.textContent = value;
                }
                break;

            // Fallback: try as CSS property (kebab-case)
            default:
                const kebab = name.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
                element.style.setProperty(kebab, typeof value === 'number' ? value + 'px' : String(value));
        }
    }

    function px(v) { return typeof v === 'number' ? v + 'px' : String(v); }

    function cssColor(v) {
        if (typeof v !== 'string') return String(v);
        // Named colors pass through, hex/rgb pass through
        return v;
    }

    // ---- Event Handling ----

    function extractAction(value) {
        if (typeof value === 'string') {
            // "@actions.Increment" → "Increment"
            const match = value.match(/^@actions\.(.+)$/);
            if (match) return { name: match[1], payload: null };
            return { name: value, payload: null };
        }
        if (typeof value === 'object' && value !== null) {
            const name = value.action || value.name;
            const payload = value.payload || null;
            if (name) return { name: String(name).replace(/^@actions\./, ''), payload };
        }
        return null;
    }

    function attachActionEvent(element, eventType, actionValue) {
        const action = extractAction(actionValue);
        if (!action) return;

        // Remove previous listener if any
        if (element._hypenListener) {
            element.removeEventListener(eventType, element._hypenListener);
        }

        const listener = () => {
            send({ type: 'action', name: action.name, payload: action.payload });
        };
        element._hypenListener = listener;
        element.addEventListener(eventType, listener);
    }

    function attachBind(element, bindValue) {
        // bindValue is "@state.name" or "state.name" — extract the path
        let path = typeof bindValue === 'string' ? bindValue : null;
        if (!path) return;
        path = path.replace(/^@?state\./, '');

        // Remove previous bind listener
        if (element._hypenBindListener) {
            element.removeEventListener('input', element._hypenBindListener);
        }

        const listener = () => {
            const v = element.type === 'checkbox' ? element.checked : element.value;
            send({
                type: 'action',
                name: '__hypen_bind',
                payload: { path: path, value: v }
            });
        };
        element._hypenBindListener = listener;
        element.addEventListener('input', listener);
    }

    // ---- Patch Application ----

    function applyPatches(patches) {
        for (const patch of patches) {
            applyPatch(patch);
        }
    }

    function applyPatch(patch) {
        switch (patch.type) {
            case 'create':  onCreate(patch); break;
            case 'setProp': onSetProp(patch); break;
            case 'removeProp': onRemoveProp(patch); break;
            case 'setText': onSetText(patch); break;
            case 'insert':  onInsert(patch); break;
            case 'move':    onMove(patch); break;
            case 'remove':  onRemove(patch); break;
        }
    }

    function onCreate(patch) {
        const type = (patch.elementType || 'container').toLowerCase();
        const creator = components[type];
        const el = creator ? creator() : document.createElement('div');

        el.dataset.hypenType = type;
        el.dataset.hypenId = patch.id;

        // Apply initial props
        if (patch.props) {
            for (const [name, value] of Object.entries(patch.props)) {
                applyProp(el, name, value);
            }
        }

        nodes.set(patch.id, el);

        // First created element is the root
        if (!rootNodeId) {
            rootNodeId = patch.id;
            rootEl.appendChild(el);
        }
    }

    function onSetProp(patch) {
        const el = nodes.get(patch.id);
        if (!el) return;
        applyProp(el, patch.name, patch.value);
    }

    function onRemoveProp(patch) {
        const el = nodes.get(patch.id);
        if (!el) return;
        // Reset the property
        const kebab = patch.name.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
        el.style.removeProperty(kebab);
    }

    function onSetText(patch) {
        const el = nodes.get(patch.id);
        if (!el) return;
        el.textContent = patch.text;
    }

    function onInsert(patch) {
        const parent = patch.parentId === 'root' ? rootEl : nodes.get(patch.parentId);
        const child = nodes.get(patch.id);
        if (!parent || !child) return;

        if (patch.beforeId) {
            const before = nodes.get(patch.beforeId);
            if (before && before.parentNode === parent) {
                parent.insertBefore(child, before);
            } else if (!parent.contains(child)) {
                parent.appendChild(child);
            }
        } else {
            if (!parent.contains(child)) {
                parent.appendChild(child);
            }
        }
    }

    function onMove(patch) {
        // Move is the same as insert
        onInsert(patch);
    }

    function onRemove(patch) {
        const el = nodes.get(patch.id);
        if (el && el.parentNode) {
            el.parentNode.removeChild(el);
        }
        nodes.delete(patch.id);
    }

    // ---- Clear all nodes (on route change) ----

    function clearAll() {
        rootEl.innerHTML = '';
        nodes.clear();
        rootNodeId = null;
    }

    // ---- Toolbar ----

    function renderToolbar() {
        // Remove old tabs
        toolbarEl.querySelectorAll('.tab').forEach(t => t.remove());

        const logo = toolbarEl.querySelector('.logo');
        for (const route of routes) {
            const tab = document.createElement('button');
            tab.className = 'tab' + (route === currentRoute ? ' active' : '');
            tab.textContent = route.replace('/', '') || 'home';
            tab.dataset.route = route;
            tab.onclick = () => send({ type: 'navigate', path: route });
            logo.insertAdjacentElement('afterend', tab);
        }
    }

    function updateToolbarActive() {
        toolbarEl.querySelectorAll('.tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.route === currentRoute);
        });
    }

    // ---- WebSocket ----

    function send(obj) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(obj));
        }
    }

    function connect() {
        ws = new WebSocket('ws://' + location.host + '/ws');

        ws.onopen = () => {
            dotEl.classList.add('connected');
            statusEl.textContent = 'connected';
        };

        ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            handleMessage(msg);
        };

        ws.onclose = () => {
            dotEl.classList.remove('connected');
            statusEl.textContent = 'reconnecting...';
            setTimeout(connect, 1000);
        };
    }

    function handleMessage(msg) {
        switch (msg.type) {
            case 'sessionAck':
                sessionId = msg.sessionId;
                statusEl.textContent = msg.isRestored ? 'restored' : 'connected';
                break;

            case 'initialTree':
            case 'render':
                // Full render — route change or initial connect
                if (msg.routes) {
                    routes = msg.routes;
                    renderToolbar();
                }
                if (msg.route) {
                    currentRoute = msg.route;
                    updateToolbarActive();
                }
                clearAll();
                if (msg.patches) {
                    applyPatches(msg.patches);
                }
                break;

            case 'patch':
                // Incremental state update
                if (msg.patches) {
                    applyPatches(msg.patches);
                }
                break;

            case 'sessionExpired':
                sessionId = null;
                statusEl.textContent = 'session expired';
                clearAll();
                break;
        }
    }

    // Boot
    connect();
    </script>
</body>
</html>
""".trimIndent()
