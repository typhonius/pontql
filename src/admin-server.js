import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { listProjects, listRooms, ensureTokens } from './promptql-client.js';
import { sessions } from './session-store.js';
import { config } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', '.env');
const PORT = 3099;

// Callback to fetch WhatsApp groups from the client (registered by index.js)
let groupsFetcher = null;
export function registerGroupsFetcher(fn) { groupsFetcher = fn; }

let state = {
  qrDataUrl: null,
  status: 'starting',
  project: null,
  room: null,
  phone: null,
};

// Stats (always tracked, shown to all users)
const stats = {
  startedAt: Date.now(),
  threadsCreated: 0,
  messagesSent: 0,
  messagesReceived: 0,
  artifactsGenerated: 0,
  lastActivity: null,
};

// Activity log (only populated when DEBUG=true, shown in UI)
const activityLog = []; // { ts, type, msg }
const MAX_LOG = 200;

export function updateState(patch) {
  Object.assign(state, patch);
}

export function trackStat(key, increment = 1) {
  if (key in stats) stats[key] += increment;
  stats.lastActivity = Date.now();
}

export function logActivity(type, msg) {
  stats.lastActivity = Date.now();
  if (!config.debug) return;
  activityLog.unshift({ ts: Date.now(), type, msg });
  if (activityLog.length > MAX_LOG) activityLog.length = MAX_LOG;
}

function parseEnv() {
  if (!existsSync(envPath)) return {};
  const vars = {};
  readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const eq = trimmed.indexOf('=');
      if (eq > 0) vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  });
  return vars;
}

function saveEnv(updates) {
  const lines = existsSync(envPath) ? readFileSync(envPath, 'utf-8').split('\n') : [];
  const updated = new Set();
  const newLines = lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) return line;
    const key = trimmed.slice(0, eq).trim();
    if (key in updates) { updated.add(key); return `${key}=${updates[key]}`; }
    return line;
  });
  for (const [key, val] of Object.entries(updates)) {
    if (!updated.has(key)) newLines.push(`${key}=${val}`);
  }
  writeFileSync(envPath, newLines.join('\n'));
}

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/api/state') {
    const env = parseEnv();
    const safeEnv = { ...env };
    // Mask PAT but indicate if set
    const hasPat = !!(safeEnv.PROMPTQL_PAT || safeEnv.PERSONAL_PAT);
    delete safeEnv.PROMPTQL_PAT;
    delete safeEnv.PERSONAL_PAT;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...state, env: safeEnv, hasPat, stats, debug: config.debug, log: config.debug ? activityLog.slice(0, 50) : [] }));
    return;
  }

  // Setup endpoint — save PAT and phone number, create .env if needed
  if (req.method === 'POST' && url.pathname === '/api/setup') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { pat, myNumber } = JSON.parse(body);
        if (!pat) { res.writeHead(400); res.end(JSON.stringify({ error: 'PAT is required' })); return; }
        const updates = { PROMPTQL_PAT: pat };
        if (myNumber) updates.MY_NUMBER = myNumber;
        // Create .env from example if it doesn't exist
        if (!existsSync(envPath)) {
          const examplePath = join(__dirname, '..', '.env.example');
          if (existsSync(examplePath)) {
            const example = readFileSync(examplePath, 'utf-8');
            writeFileSync(envPath, example);
          }
        }
        saveEnv(updates);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        // Restart to pick up the new config
        setTimeout(() => process.exit(1), 300);
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/projects') {
    try {
      const projects = await listProjects();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(projects));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/rooms') {
    try {
      const rooms = await listRooms();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rooms));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/restart') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    // Exit with code 1 so watch mode restarts us (code 0 = "done")
    setTimeout(() => process.exit(1), 300);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/reset') {
    const { rmSync } = await import('fs');
    try { rmSync(join(__dirname, '..', '.wwebjs_auth'), { recursive: true, force: true }); } catch {}
    try { rmSync(join(__dirname, '..', '.wwebjs_cache'), { recursive: true, force: true }); } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    setTimeout(() => process.exit(1), 300);
    return;
  }

  // Groups — list WhatsApp groups with subscription status
  if (req.method === 'GET' && url.pathname === '/api/groups') {
    if (!groupsFetcher) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ connected: false, groups: [] }));
      return;
    }
    try {
      const waGroups = await groupsFetcher();
      const subIds = sessions.getSubscribedGroupIds();
      const groups = waGroups.map(g => ({ ...g, subscribed: subIds.has(g.id) }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ connected: true, groups }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Groups — toggle subscription
  if (req.method === 'POST' && url.pathname === '/api/groups/subscribe') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { groupId, groupName, subscribe } = JSON.parse(body);
        if (subscribe) {
          sessions.subscribeGroup(groupId, groupName);
        } else {
          sessions.unsubscribeGroup(groupId);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/save') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const updates = JSON.parse(body);
        saveEnv(updates);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        setTimeout(() => process.exit(1), 300);
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/favicon.ico') {
    try {
      const ico = readFileSync(join(__dirname, '..', 'data', 'favicon.ico'));
      res.writeHead(200, { 'Content-Type': 'image/x-icon', 'Cache-Control': 'public, max-age=86400' });
      res.end(ico);
    } catch { res.writeHead(404); res.end(); }
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(PAGE_HTML);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}

export function startAdminServer() {
  const server = createServer(handleRequest);
  // Always bind to 127.0.0.1 only - never expose to network.
  // Access remotely via SSH tunnel: ssh -L 3099:localhost:3099 yourserver
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[admin] Dashboard: http://localhost:${PORT} (localhost only)`);
  });
  return server;
}

/* ────────────────────────────────────────
   Colors from promptql.io (marketing site)
   bg:        #0a0a0f
   surface:   #111118
   border:    rgba(255,255,255,0.08)
   brand:     #B6FC34 (electric lime)
   text:      #f5f5f7
   dim:       #9CA3AF
   dim2:      #6B7280
   hover:     #273042
   font:      Archivo, Inter
   ──────────────────────────────────────── */

const PAGE_HTML = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PontQL</title>
<link rel="icon" href="/favicon.ico">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#0a0a0f;--surface:#111118;--border:rgba(255,255,255,0.08);
  --text:#f5f5f7;--dim:#9CA3AF;--dim2:#6B7280;
  --brand:#B6FC34;--brand-dark:#9ad42a;--brand-fg:#0a0a0f;
  --accent-soft:rgba(182,252,52,0.08);--hover:#273042;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Inter,system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
.shell{max-width:560px;margin:0 auto;padding:24px 16px}

header{display:flex;align-items:center;gap:10px;margin-bottom:24px}
.logo{width:30px;height:30px;border-radius:8px;background:var(--brand);display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;color:var(--brand-fg);font-family:Archivo,system-ui,sans-serif}
header h1{font-size:17px;font-weight:600;color:#fff;font-family:Archivo,system-ui,sans-serif}
header .tag{margin-left:auto;font-size:11px;color:var(--dim);background:var(--surface);border:1px solid var(--border);padding:3px 10px;border-radius:12px}

.card{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:16px;margin-bottom:12px}
.card h2{font-size:11px;font-weight:600;color:var(--dim);text-transform:uppercase;letter-spacing:.7px;margin-bottom:14px;font-family:Archivo,system-ui,sans-serif}

.hero{text-align:center;padding:28px 16px;background:var(--surface);border:1px solid var(--border);border-radius:16px;margin-bottom:12px}
.hero img{width:220px;border-radius:8px}
.hero .hint{color:var(--dim);font-size:12px;margin-top:12px}

.pill{display:inline-flex;align-items:center;gap:6px;padding:5px 14px;border-radius:16px;font-size:13px;font-weight:500}
.pill.ok{background:var(--accent-soft);color:var(--brand)}
.pill.ok::before{content:'';width:7px;height:7px;border-radius:50%;background:var(--brand);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.pill.wait{background:rgba(212,165,74,0.1);color:#d4a54a}
.pill.err{background:rgba(232,113,113,0.1);color:#e87171}

.info{display:flex;justify-content:space-between;padding:6px 0;font-size:13px;border-bottom:1px solid rgba(255,255,255,0.05)}
.info:last-child{border:none}
.info .k{color:var(--dim)}
.info .v{font-weight:500;color:#fff}

.field{margin-bottom:14px}.field:last-child{margin-bottom:0}
.field label{display:block;font-size:12px;color:var(--dim);margin-bottom:4px}
.field select,.field input{width:100%;padding:8px 10px;background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:8px;color:#fff;font-size:13px;outline:none;transition:border .15s}
.field select:focus,.field input:focus{border-color:rgba(182,252,52,0.3)}
.field select{cursor:pointer;appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2371717a' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center}
.field .hint{font-size:11px;color:var(--dim2);margin-top:3px}
.field .err-msg{font-size:11px;color:#e87171;margin-top:3px}
.row{display:flex;gap:10px}
.row>*{flex:1}

.modes{display:flex;gap:6px;flex-wrap:wrap}
.mp{padding:6px 14px;border-radius:20px;font-size:12px;font-weight:500;border:1px solid var(--border);background:transparent;color:var(--dim);cursor:pointer;transition:all .15s}
.mp:hover{border-color:rgba(255,255,255,0.2);color:#fff}
.mp.on{background:var(--brand);color:var(--brand-fg);border-color:var(--brand);font-weight:600}

.bar{position:sticky;bottom:0;padding:12px 0;background:linear-gradient(transparent,var(--bg) 40%)}
.btn{width:100%;padding:10px;background:var(--brand);color:var(--brand-fg);border:none;border-radius:40px;font-size:14px;font-weight:600;cursor:pointer;display:none;transition:background .15s;font-family:Archivo,system-ui,sans-serif}
.btn:hover{background:var(--brand-dark)}
.btn.show{display:block}

.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%) translateY(80px);background:var(--brand);color:var(--brand-fg);padding:8px 24px;border-radius:40px;font-size:13px;font-weight:500;transition:transform .3s;pointer-events:none;z-index:10}
.toast.show{transform:translateX(-50%) translateY(0)}

.loading-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--dim);animation:blink 1s infinite}
@keyframes blink{0%,100%{opacity:.2}50%{opacity:1}}

.ctrl-btn{flex:1;padding:8px;background:var(--surface);border:1px solid var(--border);border-radius:10px;color:var(--dim);font-size:12px;font-weight:500;cursor:pointer;transition:all .15s;font-family:Inter,system-ui,sans-serif}
.ctrl-btn:hover{border-color:rgba(255,255,255,0.2);color:#fff}
.ctrl-danger:hover{border-color:rgba(232,113,113,0.4);color:#e87171}
</style>
</head><body>
<div class="shell">

<header>
  <div class="logo">P</div>
  <h1>PontQL</h1>
  <span class="tag">Bridge</span>
</header>

<div class="hero" id="hero"><div class="pill wait">Starting<span class="loading-dot" style="margin-left:4px"></span></div></div>

<div style="display:flex;gap:8px;margin-bottom:12px">
  <button onclick="restart()" class="ctrl-btn">Restart</button>
  <button onclick="if(confirm('Clear session and re-scan QR?'))reset()" class="ctrl-btn ctrl-danger">Reset Session</button>
</div>

<div class="card" id="status-card" style="display:none">
  <h2>Connection</h2>
  <div id="status-info"></div>
</div>

<div class="card config-card" id="config-card">
  <h2>Access Control</h2>
  <div id="acl"></div>
</div>

<div class="card" id="groups-card" style="display:none">
  <h2>Groups <span id="groups-count" style="font-size:10px;color:var(--dim);text-transform:none;letter-spacing:0"></span></h2>
  <input id="groups-filter" type="text" placeholder="Filter groups..." oninput="filterGroups()" style="width:100%;padding:7px 10px;background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:8px;color:#fff;font-size:13px;outline:none;margin-bottom:8px">
  <div id="groups-list" style="max-height:260px;overflow-y:auto"><span style="color:var(--dim);font-size:13px">Loading...</span></div>
</div>

<div class="card config-card">
  <h2>PromptQL</h2>
  <div class="row">
    <div class="field">
      <label>Project</label>
      <select id="project"><option value="">Loading...</option></select>
    </div>
    <div class="field">
      <label>Room</label>
      <select id="room"><option value="">Loading...</option></select>
    </div>
  </div>
  <div class="field">
    <label>New thread after idle (minutes)</label>
    <input id="timeout" type="number" min="1" max="120" value="10">
  </div>
</div>

<div class="card" id="stats-card">
  <h2>Activity</h2>
  <div id="stats-info"></div>
</div>

<div class="card" id="log-card" style="display:none">
  <h2>Live Log <span style="font-size:10px;color:var(--brand);text-transform:none;letter-spacing:0">DEBUG</span></h2>
  <div id="log-entries" style="max-height:300px;overflow-y:auto;font-family:'JetBrains Mono',monospace;font-size:11px;line-height:1.7"></div>
</div>

<div class="bar">
  <button class="btn" id="save-btn" onclick="save()">Save & Restart</button>
</div>

</div>
<div class="toast" id="toast">Saved! Restarting...</div>

<script>
const $=id=>document.getElementById(id);
let env={};let loaded=false;let dirty=false;
let projectsCache=[];let roomsCache=[];

// Access control state (3 axes)
let acl={listenDm:true,listenGroups:'',who:'me',allowedContacts:'',wakeWord:''};

function markDirty(){dirty=true;$('save-btn').classList.add('show');}

function renderAcl(){
  $('acl').innerHTML=
    // WHERE
    '<div style="margin-bottom:14px">'+
    '<label style="font-size:12px;color:var(--dim);margin-bottom:6px;display:block">Where does it listen?</label>'+
    '<div style="display:flex;flex-direction:column;gap:6px">'+
      '<label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">'+
        '<input type="checkbox" id="acl-dm" '+(acl.listenDm?'checked':'')+' onchange="aclChange()" style="accent-color:var(--brand);width:16px;height:16px"> My DMs</label>'+
      '<label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">'+
        '<input type="checkbox" id="acl-groups-on" '+(acl.listenGroups?'checked':'')+' onchange="aclChange()" style="accent-color:var(--brand);width:16px;height:16px"> Groups</label>'+
      (acl.listenGroups!==undefined&&document.getElementById&&document.getElementById("acl-groups-on")?.checked||acl.listenGroups?
        '<input id="acl-groups" value="'+(acl.listenGroups||'')+'" placeholder="* for all, or: pql-team, analytics" oninput="markDirty()" style="margin-left:24px;width:calc(100% - 24px);padding:6px 10px;background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:6px;color:#fff;font-size:12px;outline:none">'+
        '<div style="margin-left:24px;font-size:11px;color:var(--dim2)">* = all groups, or comma-separated names</div>':'')+
    '</div></div>'+
    // WHO
    '<div style="margin-bottom:14px">'+
    '<label style="font-size:12px;color:var(--dim);margin-bottom:6px;display:block">Who can use it?</label>'+
    '<div class="modes" style="margin-bottom:6px">'+
      '<button class="mp'+(acl.who==='me'?' on':'')+'" onclick="acl.who=\\'me\\';renderAcl();markDirty()">Just me</button>'+
      '<button class="mp'+(acl.who==='contacts'?' on':'')+'" onclick="acl.who=\\'contacts\\';renderAcl();markDirty()">Specific people</button>'+
      '<button class="mp'+(acl.who==='anyone'?' on':'')+'" onclick="acl.who=\\'anyone\\';renderAcl();markDirty()">Anyone</button>'+
    '</div>'+
    (acl.who==='contacts'?
      '<input id="acl-contacts" value="'+(acl.allowedContacts||'')+'" placeholder="61412345678, 44771234567" oninput="markDirty()" style="width:100%;padding:6px 10px;background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:6px;color:#fff;font-size:12px;outline:none">'+
      '<div style="font-size:11px;color:var(--dim2);margin-top:2px">Country code + number, comma-separated</div>':'')+
    '</div>'+
    // WAKE WORD
    '<div>'+
    '<label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;margin-bottom:6px">'+
      '<input type="checkbox" id="acl-wake-on" '+(acl.wakeWord?'checked':'')+' onchange="aclChange()" style="accent-color:var(--brand);width:16px;height:16px"> Require wake word</label>'+
    (acl.wakeWord||document.getElementById?.("acl-wake-on")?.checked?
      '<input id="acl-wake" value="'+(acl.wakeWord||'pql')+'" placeholder="pql" oninput="markDirty()" style="width:100%;padding:6px 10px;background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:6px;color:#fff;font-size:12px;outline:none">'+
      '<div style="font-size:11px;color:var(--dim2);margin-top:2px">Messages must start with this word, e.g. "pql what\\'s our revenue?"</div>':'')+
    '</div>';
}

function aclChange(){
  acl.listenDm=$('acl-dm')?.checked??true;
  const gOn=$('acl-groups-on')?.checked;
  if(!gOn)acl.listenGroups='';
  else if(!acl.listenGroups)acl.listenGroups='*';
  const wOn=$('acl-wake-on')?.checked;
  if(!wOn)acl.wakeWord='';
  else if(!acl.wakeWord)acl.wakeWord='pql';
  renderAcl();
  markDirty();
}

async function loadProjects(){
  try{
    const res=await fetch('/api/projects');
    if(!res.ok)throw new Error('failed');
    projectsCache=await res.json();
    const sel=$('project');
    const cur=env.PROMPTQL_PROJECT||'';
    sel.innerHTML='<option value="">(auto-detect first)</option>'+
      projectsCache.map(p=>'<option value="'+p.name+'"'+(p.name===cur?' selected':'')+'>'+p.name+(p.title?' - '+p.title:'')+'</option>').join('');
  }catch{
    $('project').innerHTML='<option value="">(connect to load)</option>';
  }
}

async function loadRooms(){
  try{
    const res=await fetch('/api/rooms');
    if(!res.ok)throw new Error('failed');
    roomsCache=await res.json();
    const sel=$('room');
    const cur=env.PROMPTQL_ROOM||'whatsapp';
    sel.innerHTML=roomsCache.map(r=>'<option value="'+r.name+'"'+(r.name===cur?' selected':'')+'>'+r.name+(r.description?' - '+r.description:'')+'</option>').join('');
    if(!roomsCache.find(r=>r.name===cur)){
      sel.innerHTML='<option value="'+cur+'" selected>'+cur+'</option>'+sel.innerHTML;
    }
  }catch{
    const cur=env.PROMPTQL_ROOM||'whatsapp';
    $('room').innerHTML='<option value="'+cur+'">'+cur+'</option>';
  }
}

let allGroups=[];
async function loadGroups(){
  try{
    const res=await fetch('/api/groups');
    if(!res.ok)throw new Error('failed');
    const data=await res.json();
    if(!data.connected){
      $('groups-card').style.display='none';
      return;
    }
    $('groups-card').style.display='block';
    allGroups=data.groups;
    const subCount=allGroups.filter(g=>g.subscribed).length;
    $('groups-count').textContent=subCount>0?subCount+' active':'';
    renderGroups();
  }catch{
    $('groups-card').style.display='none';
  }
}

function renderGroups(){
  const filter=($('groups-filter')?.value||'').toLowerCase();
  const filtered=allGroups.filter(g=>g.name.toLowerCase().includes(filter));
  if(allGroups.length===0){
    $('groups-list').innerHTML='<span style="color:var(--dim);font-size:13px">No groups found</span>';
    return;
  }
  if(filtered.length===0){
    $('groups-list').innerHTML='<span style="color:var(--dim);font-size:13px">No matches</span>';
    return;
  }
  // Show subscribed first, then by most recent activity
  filtered.sort((a,b)=>(b.subscribed-a.subscribed)||(b.timestamp||0)-(a.timestamp||0));
  $('groups-list').innerHTML=filtered.map(g=>
    '<label style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.05);font-size:13px;cursor:pointer" data-gid="'+g.id+'" data-gname="'+g.name.replace(/"/g,'&quot;')+'">'+
      '<input type="checkbox" '+(g.subscribed?'checked':'')+' onchange="toggleGroup(this)" style="accent-color:var(--brand);width:16px;height:16px;flex-shrink:0">'+
      '<span style="color:'+(g.subscribed?'#fff':'var(--dim)')+'">'+g.name+'</span>'+
    '</label>'
  ).join('');
}

function filterGroups(){renderGroups();}

async function toggleGroup(el){
  const label=el.closest('[data-gid]');
  const groupId=label.dataset.gid;
  const groupName=label.dataset.gname;
  const subscribe=el.checked;
  label.querySelector('span').style.color=subscribe?'#fff':'var(--dim)';
  const g=allGroups.find(x=>x.id===groupId);
  if(g)g.subscribed=subscribe;
  const subCount=allGroups.filter(x=>x.subscribed).length;
  $('groups-count').textContent=subCount>0?subCount+' active':'';
  try{
    await fetch('/api/groups/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({groupId,groupName,subscribe})});
  }catch{el.checked=!el.checked;if(g)g.subscribed=!subscribe;}
}

async function poll(){
  try{
    const res=await fetch('/api/state');
    const data=await res.json();
    env=data.env||{};

    // Setup mode — show setup form
    if(data.needsSetup||data.status==='setup'){
      $('hero').innerHTML='<div style="text-align:left;max-width:400px;margin:0 auto">'+
        '<h3 style="color:var(--brand);margin-bottom:12px">Welcome to PontQL</h3>'+
        '<p style="color:var(--dim);margin-bottom:16px;font-size:13px">Enter your PromptQL credentials to get started.</p>'+
        '<label style="font-size:12px;color:var(--dim);display:block;margin-bottom:4px">PromptQL PAT <span style="color:#ef4444">*</span></label>'+
        '<input id="setup-pat" type="password" placeholder="pat_..." style="width:100%;padding:8px 12px;background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--text);font-family:monospace;font-size:13px;margin-bottom:12px">'+
        '<label style="font-size:12px;color:var(--dim);display:block;margin-bottom:4px">Phone number (with country code, no +)</label>'+
        '<input id="setup-number" type="text" placeholder="61412345678" style="width:100%;padding:8px 12px;background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px;margin-bottom:16px">'+
        '<button onclick="doSetup()" style="width:100%;padding:10px;background:var(--brand);color:var(--brand-fg);border:none;border-radius:6px;font-weight:600;cursor:pointer;font-size:14px">Connect</button>'+
        '<p id="setup-err" style="color:#ef4444;font-size:12px;margin-top:8px"></p>'+
        '<p style="color:var(--dim2);font-size:11px;margin-top:12px">Get a PAT at <a href="https://cloud.hasura.io/account-settings/access-tokens" target="_blank" style="color:var(--brand)">cloud.hasura.io</a></p>'+
        '</div>';
      // Hide everything except the setup form
      $('status-card').style.display='none';
      $('stats-card').style.display='none';
      document.querySelectorAll('.config-card').forEach(el=>el.style.display='none');
      document.querySelectorAll('.bar').forEach(el=>el.style.display='none');
      return;
    }

    // Hero
    if(data.qrDataUrl){
      $('hero').innerHTML='<img src="'+data.qrDataUrl+'"/><p class="hint">WhatsApp \\u2192 Settings \\u2192 Linked Devices \\u2192 Scan</p>';
    }else if(data.status==='ready'){
      $('hero').innerHTML='<div class="pill ok">Connected</div>';
    }else if(data.status==='disconnected'||data.status==='dead'){
      $('hero').innerHTML='<div class="pill err">'+data.status+'</div>';
    }else{
      $('hero').innerHTML='<div class="pill wait">'+data.status+'<span class="loading-dot" style="margin-left:4px"></span></div>';
    }

    // Status
    if(data.status==='ready'||data.project){
      $('status-card').style.display='block';
      $('status-info').innerHTML=
        '<div class="info"><span class="k">Project</span><span class="v">'+(data.project||'-')+'</span></div>'+
        '<div class="info"><span class="k">Room</span><span class="v">'+(data.room||'-')+'</span></div>'+
        '<div class="info"><span class="k">Phone</span><span class="v">'+(data.phone||'-')+'</span></div>';
    }else{$('status-card').style.display='none';}

    // Stats (always shown)
    if(data.stats){
      const s=data.stats;
      const uptime=Math.floor((Date.now()-s.startedAt)/60000);
      const uptimeStr=uptime<60?uptime+'m':Math.floor(uptime/60)+'h '+uptime%60+'m';
      const lastAgo=s.lastActivity?Math.floor((Date.now()-s.lastActivity)/1000)+'s ago':'--';
      $('stats-info').innerHTML=
        '<div class="info"><span class="k">Uptime</span><span class="v">'+uptimeStr+'</span></div>'+
        '<div class="info"><span class="k">Threads created</span><span class="v">'+s.threadsCreated+'</span></div>'+
        '<div class="info"><span class="k">Messages sent</span><span class="v">'+s.messagesSent+'</span></div>'+
        '<div class="info"><span class="k">Replies received</span><span class="v">'+s.messagesReceived+'</span></div>'+
        '<div class="info"><span class="k">Artifacts</span><span class="v">'+s.artifactsGenerated+'</span></div>'+
        '<div class="info"><span class="k">Last activity</span><span class="v">'+lastAgo+'</span></div>';
    }

    // Debug log
    if(data.debug&&data.log&&data.log.length>0){
      $('log-card').style.display='block';
      const colors={msg:'var(--brand)',api:'#d4a54a',reply:'#9CA3AF',artifact:'#a78bfa',status:'var(--dim2)'};
      $('log-entries').innerHTML=data.log.map(l=>{
        const t=new Date(l.ts).toLocaleTimeString();
        const c=colors[l.type]||'var(--dim)';
        return '<div style="color:var(--dim2)"><span style="color:var(--dim)">'+t+'</span> <span style="color:'+c+'">'+l.type+'</span> '+l.msg.replace(/</g,'&lt;')+'</div>';
      }).join('');
    }else{$('log-card').style.display='none';}

    // First load
    if(!loaded){
      loaded=true;
      // Populate ACL from env
      acl.listenDm=env.LISTEN_DM!=='false';
      acl.listenGroups=env.LISTEN_GROUPS||'';
      acl.who=env.WHO||'me';
      acl.allowedContacts=env.ALLOWED_CONTACTS||'';
      acl.wakeWord=env.WAKE_WORD||'';
      $('timeout').value=env.SESSION_TIMEOUT||'10';
      renderAcl();
      $('project').addEventListener('change',markDirty);
      $('room').addEventListener('change',markDirty);
      $('timeout').addEventListener('input',markDirty);
      loadProjects();
      loadRooms();
      loadGroups();
    }

    // Reload dropdowns when we become ready
    if(data.status==='ready'&&projectsCache.length===0){
      loadProjects();
      loadRooms();
      loadGroups();
    }
  }catch{}
}

async function doSetup(){
  const pat=$('setup-pat')?.value?.trim();
  const num=$('setup-number')?.value?.trim();
  if(!pat){$('setup-err').textContent='PAT is required';return;}
  try{
    const res=await fetch('/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pat,myNumber:num})});
    const data=await res.json();
    if(!res.ok){$('setup-err').textContent=data.error||'Failed';return;}
    $('hero').innerHTML='<div class="pill wait">Connecting<span class="loading-dot" style="margin-left:4px"></span></div>';
    loaded=false;
    setTimeout(poll,3000);
  }catch(e){$('setup-err').textContent='Error: '+e.message;}
}

async function save(){
  const updates={
    PROMPTQL_PROJECT:$('project').value,
    PROMPTQL_ROOM:$('room').value,
    SESSION_TIMEOUT:$('timeout').value,
    LISTEN_DM:acl.listenDm?'true':'false',
    LISTEN_GROUPS:$('acl-groups')?.value||acl.listenGroups||'',
    WHO:acl.who,
    ALLOWED_CONTACTS:$('acl-contacts')?.value||'',
    WAKE_WORD:$('acl-wake')?.value||'',
  };
  $('save-btn').textContent='Saving...';
  try{
    await fetch('/api/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(updates)});
    const t=$('toast');t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2500);
    dirty=false;$('save-btn').classList.remove('show');loaded=false;projectsCache=[];
  }catch{}
  $('save-btn').textContent='Save & Restart';
  setTimeout(poll,3000);
}

async function restart(){
  try{await fetch('/api/restart',{method:'POST'});}catch{}
  $('hero').innerHTML='<div class="pill wait">Restarting<span class="loading-dot" style="margin-left:4px"></span></div>';
  loaded=false;projectsCache=[];
  setTimeout(poll,3000);
}
async function reset(){
  try{await fetch('/api/reset',{method:'POST'});}catch{}
  $('hero').innerHTML='<div class="pill wait">Resetting<span class="loading-dot" style="margin-left:4px"></span></div>';
  loaded=false;projectsCache=[];
  setTimeout(poll,3000);
}

poll();
setInterval(poll,2000);
</script>
</body></html>`;
