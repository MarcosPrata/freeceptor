import { createServer, IncomingMessage, ServerResponse } from "http";
import {
  FreeceptorWebSocketClient,
  type AgentStatus,
} from "./websocket-client.js";
import type {
  ProxyAgentConfig,
  ConnectionConfig,
} from "./config.js";
import { saveAgentConfig, mergeToProxyConfig } from "./config.js";

type SseClient = ServerResponse;

interface ConnectionEntry {
  config: ConnectionConfig;
  client: FreeceptorWebSocketClient;
  status: AgentStatus;
}

function generateClientId(): string {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).substring(2, 8);
  return `client-${ts}-${rnd}`;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

export class FreeceptorHTTPServer {
  private server: ReturnType<typeof createServer>;
  private sseClients: SseClient[] = [];
  private connections = new Map<string, ConnectionEntry>();
  private globalConfig: Omit<ProxyAgentConfig, "connections">;

  constructor(
    private port: number,
    private configPath: string,
    initialConfig: ProxyAgentConfig
  ) {
    const { connections: conns, ...global } = initialConfig;
    this.globalConfig = global;

    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        console.error("[UI] Request error:", err);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end("Internal Server Error");
        }
      });
    });

    for (const conn of conns) {
      this.spawnConnection(conn);
    }
  }

  // ---- connection management ----

  private spawnConnection(conn: ConnectionConfig): void {
    const proxyConfig = mergeToProxyConfig(this.globalConfig, conn);
    const client = new FreeceptorWebSocketClient(proxyConfig);
    const entry: ConnectionEntry = { config: conn, client, status: "idle" };

    client.onStatusChange = (status) => {
      entry.status = status;
      this.broadcastStatus();
    };

    this.connections.set(conn.serverName, entry);
    client.connect();
    console.log(`[UI] Iniciando conexão para servidor: ${conn.serverName}`);
  }

  private addConnection(conn: ConnectionConfig): void {
    if (this.connections.has(conn.serverName)) {
      throw new Error(`Servidor "${conn.serverName}" já existe`);
    }
    this.spawnConnection(conn);
    this.persistConfig();
  }

  private updateConnection(oldName: string, conn: ConnectionConfig): void {
    const entry = this.connections.get(oldName);
    if (!entry) throw new Error(`Servidor "${oldName}" não encontrado`);

    if (conn.serverName !== oldName) {
      if (this.connections.has(conn.serverName)) {
        throw new Error(`Servidor "${conn.serverName}" já existe`);
      }
      entry.client.disconnect();
      this.connections.delete(oldName);
      this.spawnConnection(conn);
    } else {
      entry.config = conn;
      const newProxyConfig = mergeToProxyConfig(this.globalConfig, conn);
      entry.client.updateConfig(newProxyConfig);
    }

    this.persistConfig();
  }

  private removeConnection(name: string): void {
    const entry = this.connections.get(name);
    if (!entry) return;
    entry.client.disconnect();
    this.connections.delete(name);
    this.persistConfig();
  }

  disconnectAll(): void {
    for (const entry of this.connections.values()) {
      entry.client.disconnect();
    }
  }

  private persistConfig(): void {
    const config: ProxyAgentConfig = {
      ...this.globalConfig,
      connections: Array.from(this.connections.values()).map((e) => e.config),
    };
    saveAgentConfig(config, this.configPath);
  }

  private getStatusPayload() {
    return {
      globalConfig: this.globalConfig,
      connections: Array.from(this.connections.entries()).map(
        ([serverName, entry]) => ({
          serverName,
          serverPassword: entry.config.serverPassword,
          localServices: entry.config.localServices,
          status: entry.status,
        })
      ),
    };
  }

  private broadcastStatus(): void {
    const data = JSON.stringify(this.getStatusPayload());
    this.sseClients = this.sseClients.filter((client) => {
      try {
        client.write(`event: status\ndata: ${data}\n\n`);
        return true;
      } catch {
        return false;
      }
    });
  }

  // ---- HTTP server ----

  start(): void {
    this.server.listen(this.port, () => {
      console.log(`[UI] Dashboard disponível em http://localhost:${this.port}`);
    });
  }

  stop(): void {
    this.server.close();
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const url = req.url?.split("?")[0] ?? "/";
    const method = req.method ?? "GET";

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (method === "GET" && url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(HTML);
      return;
    }

    if (method === "GET" && url === "/api/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(this.getStatusPayload()));
      return;
    }

    if (method === "GET" && url === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(":\n\n");
      this.sseClients.push(res);
      res.write(`event: status\ndata: ${JSON.stringify(this.getStatusPayload())}\n\n`);
      req.on("close", () => {
        this.sseClients = this.sseClients.filter((c) => c !== res);
      });
      return;
    }

    // POST /api/global
    if (method === "POST" && url === "/api/global") {
      const body = await readBody(req);
      try {
        const raw = JSON.parse(body) as Partial<Omit<ProxyAgentConfig, "connections">>;
        const freeceptorUrl = raw.freeceptorUrl?.trim();
        if (!freeceptorUrl) throw new Error("freeceptorUrl é obrigatório");

        const prevUrl = this.globalConfig.freeceptorUrl;
        const fallbackId = this.globalConfig.clientId || generateClientId();

        this.globalConfig = {
          clientId: raw.clientId?.trim() || fallbackId,
          clientName: raw.clientName?.trim() || fallbackId,
          clientPassword: raw.clientPassword?.trim() || undefined,
          freeceptorUrl,
          verbose: this.globalConfig.verbose,
          reconnectInterval: this.globalConfig.reconnectInterval,
        };

        this.persistConfig();

        if (prevUrl !== freeceptorUrl) {
          for (const entry of this.connections.values()) {
            entry.client.updateConfig(
              mergeToProxyConfig(this.globalConfig, entry.config)
            );
          }
        }

        this.broadcastStatus();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: err instanceof Error ? err.message : "Config inválida" })
        );
      }
      return;
    }

    // POST /api/connections
    if (method === "POST" && url === "/api/connections") {
      const body = await readBody(req);
      try {
        const conn = JSON.parse(body) as ConnectionConfig;
        if (!conn.serverName?.trim()) throw new Error("serverName é obrigatório");
        conn.serverName = conn.serverName.trim();
        conn.localServices = (conn.localServices ?? []).filter(
          (s) => s.name && s.port > 0
        );
        this.addConnection(conn);
        this.broadcastStatus();
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: err instanceof Error ? err.message : "Config inválida" })
        );
      }
      return;
    }

    const connActionMatch = url.match(/^\/api\/connections\/([^/]+)\/(reconnect|disconnect)$/);
    if (connActionMatch) {
      const name = decodeURIComponent(connActionMatch[1]);
      const action = connActionMatch[2];
      const entry = this.connections.get(name);
      if (entry) {
        if (action === "reconnect") {
          entry.client.updateConfig(mergeToProxyConfig(this.globalConfig, entry.config));
        } else {
          entry.client.disconnect();
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    const connBaseMatch = url.match(/^\/api\/connections\/([^/]+)$/);
    if (connBaseMatch) {
      const name = decodeURIComponent(connBaseMatch[1]);

      if (method === "PUT") {
        const body = await readBody(req);
        try {
          const conn = JSON.parse(body) as ConnectionConfig;
          if (!conn.serverName?.trim()) throw new Error("serverName é obrigatório");
          conn.serverName = conn.serverName.trim();
          conn.localServices = (conn.localServices ?? []).filter(
            (s) => s.name && s.port > 0
          );
          this.updateConnection(name, conn);
          this.broadcastStatus();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ error: err instanceof Error ? err.message : "Config inválida" })
          );
        }
        return;
      }

      if (method === "DELETE") {
        this.removeConnection(name);
        this.broadcastStatus();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
    }

    res.writeHead(404);
    res.end("Not found");
  }
}

// ---------------------------------------------------------------------------
// Embedded HTML UI
// ---------------------------------------------------------------------------

const HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Freeceptor Agent</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #0a0a0a;
      --card: #111111;
      --border: #222222;
      --input: #161616;
      --input-border: #2a2a2a;
      --text: #e5e5e5;
      --muted: #888888;
      --dim: #444444;
      --green: #22c55e;
      --yellow: #eab308;
      --red: #ef4444;
      --radius: 10px;
      --selected: #1a1a1a;
    }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif;
      font-size: 14px;
      min-height: 100vh;
      padding: 32px;
      line-height: 1.5;
    }

    /* Header */
    header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 20px;
    }

    h1 { font-size: 22px; font-weight: 600; letter-spacing: -0.4px; }
    .subtitle { font-size: 13px; color: var(--muted); margin-top: 3px; }

    #status-pills { display: flex; gap: 8px; flex-wrap: wrap; }

    .pill {
      display: flex; align-items: center; gap: 7px;
      background: var(--card); border: 1px solid var(--border);
      border-radius: 20px; padding: 5px 13px; font-size: 12px; color: var(--muted);
    }

    .dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: var(--dim); flex-shrink: 0;
    }
    .dot.connected  { background: var(--green); box-shadow: 0 0 7px var(--green); animation: pulse 2.5s ease-in-out infinite; }
    .dot.pulsing    { background: var(--yellow); animation: blink 0.9s ease-in-out infinite; }
    .dot.error      { background: var(--red); }

    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
    @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.2} }

    /* Global settings bar */
    .global-bar {
      display: flex; align-items: flex-end; gap: 12px;
      margin-bottom: 16px; flex-wrap: wrap;
    }
    .global-bar .form-group { flex: 1; min-width: 140px; }
    .global-bar .form-group.wide { flex: 2; min-width: 200px; }

    /* Cards */
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 20px;
    }

    .card-title { font-size: 13px; font-weight: 500; margin-bottom: 14px; }

    /* Two-column layout */
    .layout { display: grid; grid-template-columns: 280px 1fr; gap: 16px; align-items: start; }

    /* Server list */
    .server-item {
      border: 1px solid transparent;
      border-radius: 8px;
      padding: 11px 12px;
      cursor: pointer;
      transition: background 0.12s, border-color 0.12s;
      margin-bottom: 6px;
    }
    .server-item:hover { background: #161616; border-color: var(--border); }
    .server-item.selected { background: var(--selected); border-color: #333; }

    .server-item-top {
      display: flex; align-items: center; gap: 0;
      margin-bottom: 5px;
    }
    .server-dot { margin-right: 8px; flex-shrink: 0; }
    .server-name { font-size: 13px; font-weight: 500; flex: 1; }
    .server-status-lbl { font-size: 11px; color: var(--dim); }

    .server-svcs { margin-top: 4px; margin-left: 15px; }

    .tag {
      display: inline-block;
      background: #1a1a1a; border: 1px solid var(--border);
      border-radius: 4px; padding: 1px 7px;
      font-size: 11px; color: var(--muted); margin: 2px 3px 0 0;
    }

    .placeholder {
      border: 1px dashed var(--border); border-radius: 8px;
      padding: 32px 20px; text-align: center;
    }
    .placeholder p:first-child { font-size: 13px; color: var(--muted); }
    .placeholder p + p { font-size: 12px; color: var(--dim); margin-top: 4px; }

    /* Forms */
    .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .form-group { display: flex; flex-direction: column; gap: 5px; }
    .form-group.full { grid-column: 1 / -1; }

    label { font-size: 11px; color: var(--muted); font-weight: 500; }

    input[type=text], input[type=password], input[type=number], input[type=url] {
      background: var(--input); border: 1px solid var(--input-border);
      border-radius: 6px; color: var(--text); font-size: 13px;
      padding: 8px 10px; width: 100%; outline: none;
      transition: border-color 0.15s;
    }
    input:focus { border-color: #555; }
    input::placeholder { color: var(--dim); }

    /* Status row in right panel */
    .conn-status-row {
      display: flex; align-items: center; gap: 8px;
      background: #0d0d0d; border: 1px solid var(--border);
      border-radius: 7px; padding: 9px 13px;
      font-size: 12px; color: var(--muted);
      margin-top: 14px;
    }
    .conn-status-row .spacer { flex: 1; }

    /* Divider */
    .sep { border: none; border-top: 1px solid var(--border); margin: 18px 0; }

    /* Services */
    .svcs-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .svcs-label { font-size: 11px; color: var(--muted); font-weight: 500; text-transform: uppercase; letter-spacing: .5px; }

    .svc-cols { display: grid; grid-template-columns: 1fr 1.2fr 90px 32px; gap: 8px; margin-bottom: 5px; }
    .svc-cols span { font-size: 10px; color: var(--dim); text-transform: uppercase; letter-spacing: .4px; }

    .svc-row { display: grid; grid-template-columns: 1fr 1.2fr 90px 32px; gap: 8px; align-items: center; margin-bottom: 8px; }

    .btn-remove {
      width: 32px; height: 32px; display: flex; align-items: center; justify-content: center;
      background: transparent; border: 1px solid var(--input-border); border-radius: 6px;
      color: var(--dim); cursor: pointer; font-size: 18px; line-height: 1;
      transition: all 0.15s; flex-shrink: 0;
    }
    .btn-remove:hover { border-color: var(--red); color: var(--red); background: #160a0a; }

    .svcs-empty {
      border: 1px dashed var(--border); border-radius: 6px; padding: 16px;
      text-align: center; color: var(--dim); font-size: 12px; margin-bottom: 10px;
    }

    /* Buttons */
    .btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      padding: 8px 16px; border-radius: 6px; font-size: 13px; font-weight: 500;
      cursor: pointer; border: 1px solid var(--border); background: transparent;
      color: var(--text); transition: background .15s, border-color .15s, opacity .15s;
    }
    .btn:hover:not(:disabled) { background: #1a1a1a; }
    .btn:active:not(:disabled) { opacity: .75; }
    .btn:disabled { opacity: .4; cursor: not-allowed; }
    .btn-primary { background: var(--text); color: #000; border-color: var(--text); }
    .btn-primary:hover:not(:disabled) { background: #ccc; border-color: #ccc; }
    .btn-danger { border-color: #2a1515; color: var(--red); }
    .btn-danger:hover:not(:disabled) { background: #160a0a; border-color: #3a1515; }
    .btn-sm { padding: 6px 13px; font-size: 12px; }

    .form-footer {
      display: flex; justify-content: space-between; align-items: center;
      gap: 10px; margin-top: 20px;
    }
    .form-footer-right { display: flex; gap: 8px; }

    /* Toast */
    #toast {
      position: fixed; bottom: 24px; right: 24px;
      background: var(--card); border: 1px solid var(--border);
      border-radius: 8px; padding: 11px 16px; font-size: 13px;
      opacity: 0; transform: translateY(8px); transition: all .2s ease;
      pointer-events: none; z-index: 100; max-width: 320px;
    }
    #toast.show { opacity: 1; transform: translateY(0); }
    #toast.success { border-color: #163326; color: var(--green); }
    #toast.error   { border-color: #2a1515; color: var(--red); }

    ::-webkit-scrollbar { width: 5px; }
    ::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 3px; }
  </style>
</head>
<body>

<!-- Header -->
<header>
  <div>
    <h1>Freeceptor Agent</h1>
    <p class="subtitle">Configure e monitore o agente proxy reverso.</p>
  </div>
  <div id="status-pills">
    <div class="pill"><span class="dot"></span><span>Carregando...</span></div>
  </div>
</header>

<!-- Global settings bar -->
<div class="card global-bar" style="margin-bottom:16px">
  <div class="form-group wide">
    <label>URL do Freeceptor *</label>
    <input type="url" id="g-url" placeholder="http://seu-servidor:3002" />
  </div>
  <div class="form-group">
    <label>ID do Cliente</label>
    <input type="text" id="g-id" placeholder="gerado automaticamente" />
  </div>
  <div class="form-group">
    <label>Nome do Cliente</label>
    <input type="text" id="g-name" placeholder="ex: MacBook Pro" />
  </div>
  <div class="form-group">
    <label>Senha do Cliente</label>
    <input type="password" id="g-pass" placeholder="opcional" />
  </div>
  <div style="padding-top:18px;flex-shrink:0">
    <button class="btn btn-sm btn-primary" onclick="saveGlobal()">Salvar</button>
  </div>
</div>

<!-- Main layout -->
<div class="layout">

  <!-- Left: server list -->
  <div class="card">
    <div class="card-title" id="servers-title">Servidores (0)</div>
    <div id="server-list">
      <div class="placeholder">
        <p>Nenhum servidor configurado.</p>
        <p>Configure o Freeceptor acima e adicione servidores.</p>
      </div>
    </div>
    <button class="btn" style="margin-top:12px;width:100%" onclick="startNewConn()">
      + Adicionar Servidor
    </button>
  </div>

  <!-- Right: connection config -->
  <div class="card">
    <div class="card-title">Configuração do Servidor</div>
    <div id="conn-panel">
      <div class="placeholder">
        <p>Selecione um servidor para editar suas configurações.</p>
      </div>
    </div>
  </div>

</div>

<div id="toast"></div>

<script>
// ---- State ----
var gc = {};         // global config
var conns = [];      // array of {serverName, serverPassword, localServices, status}
var editing = null;  // null | '__new__' | serverName
var editOrigName = '';
var editSvcs = [];

var statusInfo = {
  idle:         { cls: '',          lbl: 'Inativo' },
  connecting:   { cls: 'pulsing',   lbl: 'Conectando...' },
  connected:    { cls: 'pulsing',   lbl: 'Autenticando...' },
  registered:   { cls: 'connected', lbl: 'Registrado' },
  reconnecting: { cls: 'pulsing',   lbl: 'Reconectando...' },
  disconnected: { cls: 'error',     lbl: 'Desconectado' },
  failed:       { cls: 'error',     lbl: 'Falhou' },
};

// ---- SSE ----
var es = new EventSource('/api/events');
es.addEventListener('status', function(e) {
  try { onState(JSON.parse(e.data)); } catch(err) { console.error('[Agent] onState error:', err); }
});

function onState(data) {
  conns = data.connections || [];

  var activeId = document.activeElement ? document.activeElement.id : '';
  if (!activeId || ['g-url','g-id','g-name','g-pass'].indexOf(activeId) === -1) {
    gc = data.globalConfig || {};
    setVal('g-url',  gc.freeceptorUrl  || '');
    setVal('g-id',   gc.clientId       || '');
    setVal('g-name', gc.clientName     || '');
    setVal('g-pass', gc.clientPassword || '');
  }

  renderList();
  renderPills();

  if (editing && editing !== '__new__') {
    var c = conns.find(function(x){ return x.serverName === editing; });
    if (c) updateRightStatus(c.status);
  }
}

function setVal(id, val) {
  var el = document.getElementById(id);
  if (el) el.value = val;
}

// ---- Render pills ----
function renderPills() {
  var reg = conns.filter(function(c){ return c.status === 'registered'; });
  var pils = document.getElementById('status-pills');
  if (!pils) return;
  if (reg.length === 0) {
    pils.innerHTML = '<div class="pill"><span class="dot error"></span><span>Desconectado</span></div>';
  } else {
    pils.innerHTML = reg.map(function(c){
      return '<div class="pill"><span class="dot connected"></span><span>' + esc(c.serverName) + '</span></div>';
    }).join('');
  }
}

// ---- Render left panel ----
function renderList() {
  var ul = document.getElementById('server-list');
  var title = document.getElementById('servers-title');
  if (!ul || !title) return;

  var display = conns.slice();
  if (editing === '__new__') {
    var liveNameEl = document.getElementById('cf-name');
    var liveName = liveNameEl ? (liveNameEl.value || '(novo servidor)') : '(novo servidor)';
    display.unshift({ serverName: '__new__', _displayName: liveName, status: 'idle', localServices: [] });
  }

  title.textContent = 'Servidores (' + conns.length + ')';

  if (display.length === 0) {
    ul.innerHTML = '<div class="placeholder"><p>Nenhum servidor configurado.</p><p>Clique em "+ Adicionar Servidor".</p></div>';
    return;
  }

  ul.innerHTML = display.map(function(c) {
    var isNew = c.serverName === '__new__';
    var sel = isNew ? (editing === '__new__') : (editing === c.serverName);
    var info = statusInfo[c.status] || { cls: '', lbl: c.status };
    var displayName = isNew ? esc(c._displayName || '(novo servidor)') : esc(c.serverName);
    var svcsHtml = '';
    if (!isNew && c.localServices && c.localServices.length > 0) {
      svcsHtml = c.localServices.map(function(s){
        return '<span class="tag">' + esc(s.name) + ':' + s.port + '</span>';
      }).join('');
    } else if (!isNew) {
      svcsHtml = '<span style="color:var(--dim);font-size:11px">Nenhum servi\u00e7o</span>';
    }

    var dataName = isNew ? '__new__' : c.serverName;
    return '<div class="server-item' + (sel ? ' selected' : '') + '" data-name="' + esc(dataName) + '">'
      + '<div class="server-item-top">'
      + '<span class="dot server-dot ' + info.cls + '"></span>'
      + '<span class="server-name">' + displayName + '</span>'
      + '<span class="server-status-lbl">' + info.lbl + '</span>'
      + '</div>'
      + (svcsHtml ? '<div class="server-svcs">' + svcsHtml + '</div>' : '')
      + '</div>';
  }).join('');
}

// ---- Right panel ----
function selectConn(name) {
  if (editing === name) return;
  editing = name;
  if (name === '__new__') {
    renderConnPanel({ serverName: '', serverPassword: '', localServices: [] }, true);
  } else {
    var c = conns.find(function(x){ return x.serverName === name; });
    if (c) renderConnPanel(c, false);
  }
  renderList();
}

function startNewConn() {
  editing = '__new__';
  renderConnPanel({ serverName: '', serverPassword: '', localServices: [] }, true);
  renderList();
}

function renderConnPanel(conn, isNew) {
  editSvcs = (conn.localServices || []).map(function(s){ return Object.assign({}, s); });
  editOrigName = conn.serverName || '';

  var info = statusInfo[conn.status || 'idle'] || { cls: '', lbl: 'Inativo' };

  var html = '<div>';

  html += '<div class="form-grid" style="margin-bottom:4px">';
  html += '<div class="form-group"><label>Nome do Servidor *</label>';
  html += '<input type="text" id="cf-name" value="' + esc(conn.serverName || '') + '" placeholder="ex: dev10" oninput="onCfNameInput()" /></div>';
  html += '<div class="form-group"><label>Senha do Servidor</label>';
  html += '<input type="password" id="cf-pass" value="' + esc(conn.serverPassword || '') + '" placeholder="opcional" /></div>';
  html += '</div>';

  html += '<div class="conn-status-row">';
  html += '<span class="dot ' + info.cls + '" id="cf-dot"></span>';
  html += '<span id="cf-status-lbl">' + info.lbl + '</span>';
  html += '<span class="spacer"></span>';
  if (!isNew) {
    html += '<button class="btn btn-sm" onclick="reconnectConn()">&#8635; Reconectar</button>';
    html += '<button class="btn btn-sm btn-danger" style="margin-left:8px" onclick="disconnectConn()">Desconectar</button>';
  }
  html += '</div>';

  html += '<hr class="sep" />';

  html += '<div class="svcs-header">';
  html += '<span class="svcs-label">Servi\u00e7os Locais</span>';
  html += '<button type="button" class="btn btn-sm" onclick="addSvc()">+ Adicionar</button>';
  html += '</div>';
  html += '<div id="cf-svc-cols" class="svc-cols" style="display:none"><span>Nome</span><span>Host</span><span>Porta</span><span></span></div>';
  html += '<div id="cf-svcs"></div>';

  html += '<div class="form-footer">';
  if (!isNew) {
    html += '<button class="btn btn-danger" onclick="removeConn()">Remover Servidor</button>';
  } else {
    html += '<div></div>';
  }
  html += '<div class="form-footer-right">';
  html += '<button class="btn btn-primary" onclick="saveConn()">Salvar</button>';
  html += '</div></div>';

  html += '</div>';

  document.getElementById('conn-panel').innerHTML = html;
  renderSvcs();
}

function updateRightStatus(status) {
  var info = statusInfo[status] || { cls: '', lbl: status };
  var dot = document.getElementById('cf-dot');
  var lbl = document.getElementById('cf-status-lbl');
  if (dot) dot.className = 'dot ' + info.cls;
  if (lbl) lbl.textContent = info.lbl;
}

function onCfNameInput() {
  renderList();
}

// ---- Services ----
function renderSvcs() {
  var cont = document.getElementById('cf-svcs');
  var cols = document.getElementById('cf-svc-cols');
  if (!cont) return;

  if (editSvcs.length === 0) {
    if (cols) cols.style.display = 'none';
    cont.innerHTML = '<div class="svcs-empty">Nenhum servi\u00e7o configurado. Clique em "+ Adicionar" para expor uma porta local.</div>';
    return;
  }

  if (cols) cols.style.display = 'grid';
  cont.innerHTML = editSvcs.map(function(s, i) {
    return '<div class="svc-row">'
      + '<input type="text"   value="' + esc(s.name)        + '" placeholder="nome"      oninput="editSvcs[' + i + '].name=this.value" />'
      + '<input type="text"   value="' + esc(s.host)        + '" placeholder="localhost" oninput="editSvcs[' + i + '].host=this.value" />'
      + '<input type="number" value="' + s.port              + '" placeholder="3000" min="1" max="65535" oninput="editSvcs[' + i + '].port=parseInt(this.value)||0" />'
      + '<button type="button" class="btn-remove" onclick="removeSvc(' + i + ')">&#215;</button>'
      + '</div>';
  }).join('');
}

function addSvc() {
  editSvcs.push({ name: '', host: 'localhost', port: 3000 });
  renderSvcs();
  var inputs = document.querySelectorAll('.svc-row input');
  if (inputs.length) inputs[inputs.length - 3].focus();
}

function removeSvc(i) {
  editSvcs.splice(i, 1);
  renderSvcs();
}

// ---- Save / remove connection ----
async function saveConn() {
  var nameEl = document.getElementById('cf-name');
  var passEl = document.getElementById('cf-pass');
  if (!nameEl) return;

  var serverName = nameEl.value.trim();
  if (!serverName) { showToast('Nome do servidor \u00e9 obrigat\u00f3rio', 'error'); return; }

  var conn = {
    serverName: serverName,
    serverPassword: passEl ? (passEl.value.trim() || undefined) : undefined,
    localServices: editSvcs.filter(function(s){ return s.name && s.port > 0; }),
  };

  var isNew = (editing === '__new__');

  try {
    var res;
    if (isNew) {
      res = await fetch('/api/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(conn),
      });
    } else {
      res = await fetch('/api/connections/' + encodeURIComponent(editOrigName), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(conn),
      });
    }

    if (res.ok) {
      showToast('Servidor salvo!', 'success');
      editing = serverName;
      editOrigName = serverName;
    } else {
      var err = await res.json();
      showToast(err.error || 'Erro ao salvar', 'error');
    }
  } catch(e) {
    showToast('Erro de rede', 'error');
  }
}

async function removeConn() {
  if (!editing || editing === '__new__') return;
  if (!confirm('Remover servidor "' + editing + '"?')) return;

  try {
    await fetch('/api/connections/' + encodeURIComponent(editing), { method: 'DELETE' });
    editing = null;
    editSvcs = [];
    document.getElementById('conn-panel').innerHTML =
      '<div class="placeholder"><p>Selecione um servidor para editar suas configura\u00e7\u00f5es.</p></div>';
    renderList();
    showToast('Servidor removido.', 'success');
  } catch(e) {
    showToast('Erro ao remover', 'error');
  }
}

async function reconnectConn() {
  if (!editing || editing === '__new__') return;
  await fetch('/api/connections/' + encodeURIComponent(editing) + '/reconnect', { method: 'POST' }).catch(function(){});
  showToast('Reconectando...', 'success');
}

async function disconnectConn() {
  if (!editing || editing === '__new__') return;
  await fetch('/api/connections/' + encodeURIComponent(editing) + '/disconnect', { method: 'POST' }).catch(function(){});
  showToast('Desconectado.', 'success');
}

// ---- Global settings ----
async function saveGlobal() {
  var freeceptorUrl = (document.getElementById('g-url') || {}).value;
  if (freeceptorUrl) freeceptorUrl = freeceptorUrl.trim();
  if (!freeceptorUrl) { showToast('URL do Freeceptor \u00e9 obrigat\u00f3ria', 'error'); return; }

  var payload = {
    freeceptorUrl: freeceptorUrl,
    clientId:       ((document.getElementById('g-id')   || {}).value || '').trim(),
    clientName:     ((document.getElementById('g-name') || {}).value || '').trim(),
    clientPassword: ((document.getElementById('g-pass') || {}).value || '').trim() || undefined,
  };

  try {
    var res = await fetch('/api/global', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      showToast('Configura\u00e7\u00e3o global salva!', 'success');
    } else {
      var err = await res.json();
      showToast(err.error || 'Erro', 'error');
    }
  } catch(e) {
    showToast('Erro de rede', 'error');
  }
}

// ---- Utilities ----
function esc(s) {
  return String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

var toastTmr;
function showToast(msg, type) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show ' + type;
  clearTimeout(toastTmr);
  toastTmr = setTimeout(function(){ t.className = ''; }, 3500);
}

// ---- Event delegation for server list clicks ----
document.getElementById('server-list').addEventListener('click', function(e) {
  var item = e.target.closest('.server-item');
  if (item && item.dataset.name) selectConn(item.dataset.name);
});

// ---- Initial load ----
fetch('/api/status')
  .then(function(r) { return r.json(); })
  .then(onState)
  .catch(function(err) { console.error('[Agent] Failed to load status:', err); });
</script>

</body>
</html>`;
