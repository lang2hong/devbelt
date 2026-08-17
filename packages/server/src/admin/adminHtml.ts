/**
 * 管理后台单文件页面（自包含 HTML/CSS/JS，零依赖零构建）。
 *
 * 安全约定：
 * - 页面公开访问，但所有数据都走 /admin/*（requireRole(['admin']) 校验 JWT）。
 * - access token 仅存 localStorage，请求带 Authorization: Bearer。
 * - 前端不做任何 HTML 注入的模板字符串，统一 esc() 转义。
 */

export const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>DB Client Admin</title>
<style>
  :root { --bg:#0f172a; --panel:#1e293b; --panel2:#273449; --border:#334155; --text:#e2e8f0; --muted:#94a3b8; --accent:#38bdf8; --danger:#f87171; --ok:#4ade80; --warn:#fbbf24; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; background:var(--bg); color:var(--text); font-size:14px; }
  .hidden { display:none !important; }
  button { cursor:pointer; font:inherit; }
  input, select { font:inherit; color:var(--text); background:var(--panel2); border:1px solid var(--border); border-radius:6px; padding:6px 8px; }
  input:focus, select:focus { outline:2px solid var(--accent); }

  /* login */
  .login { max-width:360px; margin:12vh auto 0; background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:32px; }
  .login h1 { margin:0 0 8px; font-size:20px; }
  .login .sub { color:var(--muted); margin:0 0 24px; }
  .login input { width:100%; margin-bottom:12px; }
  .login button { width:100%; padding:8px; background:var(--accent); color:#082f49; border:none; border-radius:6px; font-weight:600; }
  .error { color:var(--danger); margin-top:12px; min-height:1em; }

  /* layout */
  header { display:flex; align-items:center; gap:16px; padding:12px 20px; background:var(--panel); border-bottom:1px solid var(--border); position:sticky; top:0; }
  header .brand { font-weight:700; font-size:15px; color:var(--accent); margin-right:8px; }
  nav button { background:none; border:none; color:var(--muted); padding:8px 14px; border-radius:6px; font-weight:600; }
  nav button.active { background:var(--panel2); color:var(--text); }
  header .whoami { margin-left:auto; color:var(--muted); }
  header #logout { background:none; border:1px solid var(--border); color:var(--muted); padding:6px 12px; border-radius:6px; }
  header #logout:hover { color:var(--danger); border-color:var(--danger); }
  main { padding:20px; max-width:1200px; margin:0 auto; }

  .toolbar { display:flex; align-items:center; gap:12px; margin-bottom:16px; }
  .toolbar input { width:260px; }
  .toolbar .count { color:var(--muted); }

  table { width:100%; border-collapse:collapse; background:var(--panel); border:1px solid var(--border); border-radius:10px; overflow:hidden; }
  th, td { text-align:left; padding:10px 12px; border-bottom:1px solid var(--border); vertical-align:middle; }
  th { background:var(--panel2); color:var(--muted); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.3px; }
  tr:last-child td { border-bottom:none; }
  tr:hover td { background:rgba(56,189,248,.04); }
  td select { padding:4px 6px; font-size:13px; }
  .muted { color:var(--muted); }

  .badge { display:inline-block; padding:2px 8px; border-radius:10px; font-size:12px; font-weight:600; }
  .badge.active, .badge.trialing { background:rgba(74,222,128,.15); color:var(--ok); }
  .badge.expired { background:rgba(251,191,36,.15); color:var(--warn); }
  .badge.canceled, .badge.disabled { background:rgba(248,113,113,.15); color:var(--danger); }
  .badge.admin { background:rgba(56,189,248,.15); color:var(--accent); }

  .btn { border:1px solid var(--border); background:var(--panel2); color:var(--text); padding:5px 10px; border-radius:6px; font-size:13px; }
  .btn:hover { border-color:var(--accent); }
  .btn.danger { color:var(--danger); }
  .btn.danger:hover { border-color:var(--danger); }
  .btn.primary { background:var(--accent); color:#082f49; border-color:transparent; font-weight:600; }

  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:16px; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:16px; }
  .card h3 { margin:0 0 8px; color:var(--accent); }
  .card .row { display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px dashed var(--border); }
  .card .row:last-child { border-bottom:none; }
  .card .row .k { color:var(--muted); }
  .card .row .v { font-weight:600; }

  /* modal */
  .modal { position:fixed; inset:0; background:rgba(0,0,0,.6); display:flex; align-items:flex-start; justify-content:center; padding:6vh 20px; z-index:50; }
  .modal-body { background:var(--panel); border:1px solid var(--border); border-radius:12px; max-width:760px; width:100%; max-height:84vh; overflow:auto; padding:20px; }
  .modal-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; }
  .modal-head h2 { margin:0; font-size:17px; color:var(--accent); }
  .modal-close { background:none; border:none; color:var(--muted); font-size:20px; }
  .section { margin-top:18px; }
  .section > h4 { color:var(--muted); text-transform:uppercase; font-size:12px; letter-spacing:.5px; margin:0 0 8px; }
  .kv { display:grid; grid-template-columns:auto 1fr; gap:6px 18px; }
  .kv .k { color:var(--muted); }
  .pager { display:flex; gap:8px; align-items:center; margin:12px 0; }
  .pager .info { color:var(--muted); margin-right:8px; }

  /* detail tabs */
  .dtabs { display:flex; flex-wrap:wrap; gap:2px; border-bottom:1px solid var(--border); margin-bottom:14px; }
  .dtab { background:none; border:none; color:var(--muted); padding:8px 12px; font-size:13px; border-bottom:2px solid transparent; margin-bottom:-1px; }
  .dtab:hover { color:var(--text); }
  .dtab.active { color:var(--accent); border-bottom-color:var(--accent); }
  .dpane.hidden { display:none; }
  .feats { display:flex; flex-wrap:wrap; gap:8px 16px; }
  .feat { display:inline-flex; align-items:center; gap:4px; color:var(--text); }
</style>
</head>
<body>

<div id="loginView" class="login hidden">
  <h1>DB Client Admin</h1>
  <p class="sub">Sign in with an admin account</p>
  <form id="loginForm">
    <input id="email" type="email" placeholder="Email" autocomplete="username" required/>
    <input id="password" type="password" placeholder="Password" autocomplete="current-password" required/>
    <button type="submit">Sign in</button>
    <div id="loginError" class="error"></div>
  </form>
</div>

<div id="appView" class="hidden">
  <header>
    <span class="brand">DB Client Admin</span>
    <nav>
      <button data-tab="users" class="active">Users</button>
      <button data-tab="subs">Subscriptions</button>
      <button data-tab="plans">Plans</button>
    </nav>
    <span class="whoami" id="whoami"></span>
    <button id="logout">Logout</button>
  </header>
  <main>
    <div id="tab-users"></div>
    <div id="tab-subs" class="hidden"></div>
    <div id="tab-plans" class="hidden"></div>
  </main>
</div>

<div id="modal" class="modal hidden">
  <div class="modal-body">
    <div class="modal-head">
      <h2 id="modalTitle"></h2>
      <button class="modal-close" id="modalClose">&times;</button>
    </div>
    <div id="modalContent"></div>
  </div>
</div>

<script>
var token = localStorage.getItem('adminToken') || null;
(function () {
  var m = location.hash.match(/[#&]token=([^&]+)/);
  if (m) {
    token = decodeURIComponent(m[1]);
    localStorage.setItem('adminToken', token);
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
  }
})();
var me = null;
var plans = [];
var users = [];
var usersTotal = 0;
var subs = [];
var query = '';
var page = 1;
var PAGE_SIZE = 20;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function fmt(d) { if (!d) return '<span class="muted">—</span>'; var t = new Date(d); if (isNaN(t)) return '<span class="muted">—</span>'; return t.toLocaleString(); }
function bytes(n) {
  n = Number(n || 0);
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}
var FEATURES = [['basic', 1], ['er_export', 2], ['excel', 4], ['datatransfer', 8], ['team_share', 16], ['audit_log', 32]];
function featNames(f) {
  var out = [];
  for (var i = 0; i < FEATURES.length; i++) if ((f & FEATURES[i][1]) !== 0) out.push(FEATURES[i][0]);
  return out.length ? out.join(', ') : '—';
}
function badge(text, kind) { return '<span class="badge ' + kind + '">' + esc(text) + '</span>'; }

async function api(path, opts) {
  var o = opts || {};
  var headers = { 'Accept': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (o.body) headers['Content-Type'] = 'application/json';
  var res = await fetch(path, { method: o.method || 'GET', headers: headers, body: o.body ? JSON.stringify(o.body) : undefined });
  if (res.status === 401) { token = null; localStorage.removeItem('adminToken'); me = null; show('#loginView'); throw new Error('Session expired'); }
  var data = {};
  try { data = await res.json(); } catch (e) { data = {}; }
  if (!res.ok) throw new Error(data.message || ('HTTP ' + res.status));
  return data;
}

function show(sel) {
  var id = sel.charAt(0) === '#' ? sel.slice(1) : sel;
  document.getElementById('loginView').classList.add('hidden');
  document.getElementById('appView').classList.add('hidden');
  document.getElementById(id).classList.remove('hidden');
}

async function init() {
  if (!token) { show('#loginView'); return; }
  try {
    var r = await api('/api/me');
    if (r.user && r.user.role === 'admin') { me = r.user; enterApp(); }
    else { token = null; localStorage.removeItem('adminToken'); show('#loginView'); }
  } catch (e) { show('#loginView'); }
}

async function enterApp() {
  document.getElementById('whoami').textContent = me.email;
  show('#appView');
  await loadAll();
}

async function loadAll() {
  await Promise.all([loadUsers(), loadSubs(), loadPlans()]);
}

async function loadUsers() {
  var r = await api('/admin/users?limit=500&offset=0');
  users = r.users || [];
  usersTotal = r.total || users.length;
  renderUsers();
}
async function loadSubs() {
  var r = await api('/admin/subscriptions');
  subs = r.subscriptions || [];
  renderSubs();
}
async function loadPlans() {
  var r = await api('/admin/plans');
  plans = r.plans || [];
  renderPlans();
}

function filteredUsers() {
  var q = query.trim().toLowerCase();
  if (!q) return users;
  return users.filter(function (u) {
    return String(u.id).indexOf(q) >= 0 || (u.email || '').toLowerCase().indexOf(q) >= 0;
  });
}

function planOptions(selected) {
  var codes = plans.length ? plans.map(function (p) { return p.code; }) : ['free', 'pro', 'team'];
  var out = '';
  for (var i = 0; i < codes.length; i++) {
    out += '<option value="' + esc(codes[i]) + '"' + (codes[i] === selected ? ' selected' : '') + '>' + esc(codes[i]) + '</option>';
  }
  return out;
}

function statusBadge(s) { return badge(s, s); }

function renderUsers() {
  var list = filteredUsers();
  var totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  if (page > totalPages) page = totalPages;
  var start = (page - 1) * PAGE_SIZE;
  var slice = list.slice(start, start + PAGE_SIZE);

  var html = '<div class="toolbar">' +
    '<input id="userSearch" placeholder="Search by id / email…" value="' + esc(query) + '"/>' +
    '<span class="count">Total ' + usersTotal + ' user(s)</span>' +
    '<button class="btn" id="refreshUsers">Refresh</button>' +
    '</div>';

  html += '<table><thead><tr>' +
    '<th>ID</th><th>Email</th><th>Role</th><th>Status</th><th>Plan</th><th>Subscription</th><th>Expires</th><th>Last login</th><th>Created</th><th>Actions</th>' +
    '</tr></thead><tbody>';

  if (slice.length === 0) {
    html += '<tr><td colspan="10" class="muted">No users</td></tr>';
  }
  for (var i = 0; i < slice.length; i++) {
    var u = slice[i];
    var s = u.subscription;
    html += '<tr>' +
      '<td>' + u.id + '</td>' +
      '<td>' + esc(u.email) + '</td>' +
      '<td><select onchange="updateUser(' + u.id + ',\\'role\\',this.value)">' +
        '<option value="user"' + (u.role === 'user' ? ' selected' : '') + '>user</option>' +
        '<option value="admin"' + (u.role === 'admin' ? ' selected' : '') + '>admin</option>' +
      '</select></td>' +
      '<td><select onchange="updateUser(' + u.id + ',\\'status\\',this.value)">' +
        '<option value="active"' + (u.status === 'active' ? ' selected' : '') + '>active</option>' +
        '<option value="disabled"' + (u.status === 'disabled' ? ' selected' : '') + '>disabled</option>' +
      '</select></td>' +
      '<td><select onchange="updateUser(' + u.id + ',\\'planCode\\',this.value)">' + planOptions(u.planCode) + '</select></td>' +
      '<td>' + (s ? statusBadge(s.status) : '<span class="muted">—</span>') + '</td>' +
      '<td>' + fmt(s ? s.periodEndTime : null) + '</td>' +
      '<td>' + fmt(u.lastLoginTime) + '</td>' +
      '<td>' + fmt(u.createTime) + '</td>' +
      '<td>' +
        '<button class="btn" onclick="openDetail(' + u.id + ')">Detail</button> ' +
        '<button class="btn primary" onclick="openRenew(' + u.id + ',\\'' + esc(u.planCode) + '\\')">Renew</button>' +
      '</td>' +
      '</tr>';
  }
  html += '</tbody></table>';

  html += '<div class="pager">' +
    '<span class="info">Page ' + page + ' / ' + totalPages + '</span>' +
    '<button class="btn" onclick="goPage(-1)"' + (page <= 1 ? ' disabled' : '') + '>Prev</button>' +
    '<button class="btn" onclick="goPage(1)"' + (page >= totalPages ? ' disabled' : '') + '>Next</button>' +
    '</div>';

  document.getElementById('tab-users').innerHTML = html;

  var search = document.getElementById('userSearch');
  if (search) search.addEventListener('input', function (e) { query = e.target.value; page = 1; renderUsers(); });
  var refresh = document.getElementById('refreshUsers');
  if (refresh) refresh.addEventListener('click', loadUsers);
}

function goPage(d) { page += d; renderUsers(); }

async function updateUser(id, field, value) {
  try {
    var body = {}; body[field] = value;
    await api('/admin/users/' + id, { method: 'PATCH', body: body });
    await loadUsers();
  } catch (e) { alert(e.message); }
}

function openModal(title, contentHtml) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalContent').innerHTML = contentHtml;
  document.getElementById('modal').classList.remove('hidden');
}
function closeModal() { document.getElementById('modal').classList.add('hidden'); }

function bindDetailTabs() {
  var modal = document.getElementById('modal');
  var tabs = modal.querySelectorAll('[data-dtab]');
  for (var t = 0; t < tabs.length; t++) {
    tabs[t].addEventListener('click', function (e) {
      var name = e.target.getAttribute('data-dtab');
      var allTabs = modal.querySelectorAll('[data-dtab]');
      for (var t2 = 0; t2 < allTabs.length; t2++) {
        allTabs[t2].classList.toggle('active', allTabs[t2].getAttribute('data-dtab') === name);
      }
      var panes = modal.querySelectorAll('.dpane');
      for (var p2 = 0; p2 < panes.length; p2++) {
        panes[p2].classList.toggle('hidden', panes[p2].id !== 'dpane-' + name);
      }
    });
  }
}

async function openDetail(id) {
  try {
    var d = await api('/admin/users/' + id);
    var extra = { devices: [], connections: [], syncEvents: [], usageEvents: [] };
    try {
      var devR = await api('/admin/users/' + id + '/devices');
      var connR = await api('/admin/users/' + id + '/connections');
      var evR = await api('/admin/users/' + id + '/sync-events');
      var uR = await api('/admin/users/' + id + '/usage-events');
      extra.devices = devR.devices || [];
      extra.connections = connR.connections || [];
      extra.syncEvents = evR.syncEvents || [];
      extra.usageEvents = uR.usageEvents || [];
    } catch (e) {}
    openModal('User #' + id, detailHtml(d, extra));
    bindDetail(id, d);
    bindDeviceEvents(id);
    bindDetailTabs();
  } catch (e) { alert(e.message); }
}

function detailHtml(d, extra) {
  var u = d.user, p = d.plan, s = d.subscription, usage = d.usage;
  var html = '<div class="dtabs">' +
    '<button class="dtab active" data-dtab="overview">Overview</button>' +
    '<button class="dtab" data-dtab="devices">Devices</button>' +
    '<button class="dtab" data-dtab="sessions">Sessions</button>' +
    '<button class="dtab" data-dtab="connections">Connections</button>' +
    '<button class="dtab" data-dtab="syncevents">Sync events</button>' +
    '<button class="dtab" data-dtab="usage">Usage</button>' +
    '</div>';

  // Overview
  html += '<div class="dpane" id="dpane-overview">';
  html += '<div class="kv">' +
    '<span class="k">Email</span><span>' + esc(u.email) + '</span>' +
    '<span class="k">Role</span><span>' + esc(u.role) + '</span>' +
    '<span class="k">Status</span><span>' + esc(u.status) + '</span>' +
    '<span class="k">Current plan</span><span>' + esc(u.planCode) + '</span>' +
    '<span class="k">Last login</span><span>' + fmt(u.lastLoginTime) + '</span>' +
    '<span class="k">Created</span><span>' + fmt(u.createTime) + '</span>' +
    '</div>';

  html += '<div class="section"><h4>Plan quotas (' + esc(p.name) + ')</h4><div class="kv">' +
    '<span class="k">Max connections</span><span>' + (p.maxConnections === 0 ? 'unlimited' : p.maxConnections) + '</span>' +
    '<span class="k">Sync quota</span><span>' + (p.syncQuotaBytes === 0 ? 'unlimited' : bytes(p.syncQuotaBytes)) + '</span>' +
    '<span class="k">Version retention</span><span>' + p.syncVersionRetention + '</span>' +
    '<span class="k">Features</span><span>' + featNames(p.features) + '</span>' +
    '</div></div>';

  html += '<div class="section"><h4>Subscription</h4>';
  if (s) {
    html += '<div class="kv">' +
      '<span class="k">Plan</span><span>' + esc(s.planCode) + '</span>' +
      '<span class="k">Status</span><span>' + statusBadge(s.status) + '</span>' +
      '<span class="k">Period end</span><span>' + fmt(s.periodEndTime) + '</span>' +
      '<span class="k">Trial end</span><span>' + fmt(s.trialEndTime) + '</span>' +
      '<span class="k">Cancel time</span><span>' + fmt(s.cancelTime) + '</span>' +
      '<span class="k">Provider</span><span>' + esc(s.provider) + '</span>' +
      '<span class="k">External ID</span><span>' + esc(s.externalId) + '</span>' +
      '</div>';
  } else { html += '<p class="muted">No subscription</p>'; }
  html += '</div>';

  html += '<div class="section"><h4>Sync usage</h4><div class="kv">' +
    '<span class="k">Active devices</span><span>' + usage.devices + '</span>' +
    '<span class="k">Total sync (cipher)</span><span>' + bytes(usage.syncBytes) + '</span>' +
    '</div>';
  if (usage.sections && usage.sections.length) {
    html += '<table style="margin-top:8px"><thead><tr><th>Section</th><th>Version</th><th>Bytes (cipher)</th><th>Updated</th></tr></thead><tbody>';
    for (var i = 0; i < usage.sections.length; i++) {
      var sec = usage.sections[i];
      html += '<tr><td>' + esc(sec.section) + '</td><td>' + sec.version + '</td><td>' + bytes(sec.bytes) + '</td><td>' + fmt(sec.updateTime) + '</td></tr>';
    }
    html += '</tbody></table>';
  } else { html += '<p class="muted">No sync data</p>'; }
  html += '<p class="muted">Note: connections/history counts are end-to-end encrypted and invisible to the server.</p>';
  html += '</div>';
  html += '</div>';

  // Devices
  var devs = extra.devices || [];
  html += '<div class="dpane hidden" id="dpane-devices">';
  if (devs.length) {
    html += '<table><thead><tr><th>Host</th><th>OS</th><th>App</th><th>Version</th><th>Remote</th><th>Lang</th><th>Last seen</th><th></th></tr></thead><tbody>';
    for (var k = 0; k < devs.length; k++) {
      var dev = devs[k];
      html += '<tr>' +
        '<td>' + esc(dev.hostname || dev.deviceId) + '</td>' +
        '<td>' + esc(dev.os || '') + (dev.arch ? ' ' + esc(dev.arch) : '') + '</td>' +
        '<td>' + esc(dev.appName || '') + '</td>' +
        '<td>' + esc(dev.appVersion || '') + '</td>' +
        '<td>' + esc(dev.remoteName || 'local') + '</td>' +
        '<td>' + esc(dev.language || '') + '</td>' +
        '<td>' + fmt(dev.lastSeenTime) + '</td>' +
        '<td><button class="btn" data-dev-events="' + esc(dev.deviceId) + '">Events</button></td>' +
        '</tr>';
    }
    html += '</tbody></table>';
  } else { html += '<p class="muted">No devices</p>'; }
  html += '</div>';

  // Sessions
  html += '<div class="dpane hidden" id="dpane-sessions">';
  if (d.sessions && d.sessions.length) {
    html += '<table><thead><tr><th>ID</th><th>Device</th><th>IP</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>';
    for (var j = 0; j < d.sessions.length; j++) {
      var sess = d.sessions[j];
      html += '<tr>' +
        '<td>' + sess.id + '</td>' +
        '<td>' + esc(sess.deviceName) + '</td>' +
        '<td>' + esc(sess.ip) + '</td>' +
        '<td>' + fmt(sess.createTime) + '</td>' +
        '<td>' + fmt(sess.lastUsedTime) + '</td>' +
        '<td><button class="btn danger" data-revoke="' + sess.id + '">Revoke</button></td>' +
        '</tr>';
    }
    html += '</tbody></table>';
  } else { html += '<p class="muted">No active sessions</p>'; }
  html += '</div>';

  // Connections
  var conns = extra.connections || [];
  html += '<div class="dpane hidden" id="dpane-connections">';
  if (conns.length) {
    html += '<table><thead><tr><th>Type</th><th>Name</th><th>Group</th><th>Status</th><th>Created</th><th>Updated</th></tr></thead><tbody>';
    for (var m = 0; m < conns.length; m++) {
      var c = conns[m];
      html += '<tr>' +
        '<td>' + esc(c.type) + '</td>' +
        '<td>' + esc(c.name) + '</td>' +
        '<td>' + esc(c.groupName) + '</td>' +
        '<td>' + (c.deleted ? badge('deleted', 'canceled') : (c.enabled ? badge('active', 'active') : badge('disabled', 'disabled'))) + '</td>' +
        '<td>' + fmt(c.createdAt) + '</td>' +
        '<td>' + fmt(c.updatedAt) + '</td>' +
        '</tr>';
    }
    html += '</tbody></table>';
  } else { html += '<p class="muted">No connection metadata (push to sync)</p>'; }
  html += '</div>';

  // Sync events
  var ses = extra.syncEvents || [];
  html += '<div class="dpane hidden" id="dpane-syncevents">';
  if (ses.length) {
    html += '<table><thead><tr><th>Direction</th><th>Section</th><th>Bytes</th><th>Items</th><th>Time</th></tr></thead><tbody>';
    for (var e2 = 0; e2 < ses.length; e2++) {
      var evt = ses[e2];
      html += '<tr>' +
        '<td>' + esc(evt.direction) + '</td>' +
        '<td>' + esc(evt.section) + '</td>' +
        '<td>' + bytes(evt.bytes) + '</td>' +
        '<td>' + evt.itemCount + '</td>' +
        '<td>' + fmt(evt.createTime) + '</td>' +
        '</tr>';
    }
    html += '</tbody></table>';
  } else { html += '<p class="muted">No sync events</p>'; }
  html += '</div>';

  // Usage
  var ues = extra.usageEvents || [];
  html += '<div class="dpane hidden" id="dpane-usage">';
  if (ues.length) {
    var totalOpens = 0, totalQueries = 0;
    for (var ue = 0; ue < ues.length; ue++) {
      if (ues[ue].kind === 'connection_open') totalOpens += ues[ue].count;
      else totalQueries += ues[ue].count;
    }
    html += '<div class="kv">' +
      '<span class="k">Connections opened</span><span>' + totalOpens + '</span>' +
      '<span class="k">Queries executed</span><span>' + totalQueries + '</span>' +
      '</div>';
    html += '<table style="margin-top:8px"><thead><tr><th>Kind</th><th>Count</th><th>Time</th></tr></thead><tbody>';
    for (var ue2 = 0; ue2 < ues.length; ue2++) {
      var ueRow = ues[ue2];
      html += '<tr><td>' + esc(ueRow.kind) + '</td><td>' + ueRow.count + '</td><td>' + fmt(ueRow.createTime) + '</td></tr>';
    }
    html += '</tbody></table>';
  } else { html += '<p class="muted">No usage events</p>'; }
  html += '</div>';

  return html;
}

function bindDeviceEvents(id) {
  var modal = document.getElementById('modal');
  var btns = modal.querySelectorAll('[data-dev-events]');
  for (var i = 0; i < btns.length; i++) {
    btns[i].addEventListener('click', async function (e) {
      var did = e.target.getAttribute('data-dev-events');
      try {
        var r = await api('/admin/users/' + id + '/devices/' + encodeURIComponent(did) + '/events');
        var html = '<table><thead><tr><th>Event</th><th>App</th><th>Version</th><th>OS</th><th>OS ver</th><th>Time</th></tr></thead><tbody>';
        var evs = r.events || [];
        for (var j = 0; j < evs.length; j++) {
          var x = evs[j];
          html += '<tr><td>' + esc(x.event) + '</td><td>' + esc(x.appName) + '</td><td>' + esc(x.appVersion) + '</td><td>' + esc(x.os) + '</td><td>' + esc(x.osVersion) + '</td><td>' + fmt(x.createTime) + '</td></tr>';
        }
        html += '</tbody></table>';
        openModal('Device events', html);
      } catch (ex) { alert(ex.message); }
    });
  }
}

function bindDetail(id, d) {
  var modal = document.getElementById('modal');
  var btns = modal.querySelectorAll('[data-revoke]');
  for (var i = 0; i < btns.length; i++) {
    btns[i].addEventListener('click', async function (e) {
      var sid = e.target.getAttribute('data-revoke');
      if (!confirm('Revoke session #' + sid + '?')) return;
      try {
        await api('/admin/users/' + id + '/sessions/' + sid, { method: 'DELETE' });
        openDetail(id);
      } catch (ex) { alert(ex.message); }
    });
  }
}

function openRenew(id, currentPlan) {
  var opts = planOptions(currentPlan);
  var html = '<p class="muted">Renew subscription for user #' + id + '.</p>' +
    '<div class="kv" style="margin:12px 0">' +
    '<span class="k">Plan</span><select id="renewPlan">' + opts + '</select>' +
    '<span class="k">Period</span><select id="renewPeriod"><option value="month">month</option><option value="year">year</option></select>' +
    '</div>' +
    '<button class="btn primary" id="renewSubmit">Renew</button>';

  openModal('Renew', html);
  document.getElementById('renewSubmit').addEventListener('click', async function () {
    var planCode = document.getElementById('renewPlan').value;
    var period = document.getElementById('renewPeriod').value;
    try {
      await api('/admin/users/' + id + '/renew', { method: 'POST', body: { planCode: planCode, period: period } });
      closeModal();
      await loadUsers();
    } catch (e) { alert(e.message); }
  });
}

function renderSubs() {
  var html = '<div class="toolbar"><span class="count">Total ' + subs.length + ' subscription(s)</span>' +
    '<button class="btn" id="refreshSubs">Refresh</button></div>';
  html += '<table><thead><tr><th>User</th><th>Email</th><th>Plan</th><th>Status</th><th>Period end</th><th>Trial end</th><th>Cancel time</th><th>Provider</th><th>External ID</th><th>Created</th></tr></thead><tbody>';
  if (subs.length === 0) html += '<tr><td colspan="10" class="muted">No subscriptions</td></tr>';
  for (var i = 0; i < subs.length; i++) {
    var s = subs[i];
    html += '<tr>' +
      '<td>' + s.userId + '</td>' +
      '<td>' + esc(s.email) + '</td>' +
      '<td>' + esc(s.planCode) + '</td>' +
      '<td>' + statusBadge(s.status) + '</td>' +
      '<td>' + fmt(s.periodEndTime) + '</td>' +
      '<td>' + fmt(s.trialEndTime) + '</td>' +
      '<td>' + fmt(s.cancelTime) + '</td>' +
      '<td>' + esc(s.provider) + '</td>' +
      '<td>' + esc(s.externalId) + '</td>' +
      '<td>' + fmt(s.createTime) + '</td>' +
      '</tr>';
  }
  html += '</tbody></table>';
  document.getElementById('tab-subs').innerHTML = html;
  document.getElementById('refreshSubs').addEventListener('click', loadSubs);
}

function renderPlans() {
  var html = '<div class="toolbar"><span class="count">' + plans.length + ' plan(s)</span>' +
    '<button class="btn" id="refreshPlans">Refresh</button></div>';
  if (plans.length === 0) { html += '<p class="muted">No plans</p>'; }
  else {
    html += '<div class="grid">';
    for (var i = 0; i < plans.length; i++) {
      var p = plans[i];
      html += '<div class="card"><h3>' + esc(p.name) + ' <span class="muted">(' + esc(p.code) + ')</span></h3>' +
        '<div class="row"><span class="k">Monthly</span><span class="v">¥' + p.priceMonth + '</span></div>' +
        '<div class="row"><span class="k">Yearly</span><span class="v">¥' + p.priceYear + '</span></div>' +
        '<div class="row"><span class="k">Max connections</span><span class="v">' + (p.maxConnections === 0 ? '∞' : p.maxConnections) + '</span></div>' +
        '<div class="row"><span class="k">Sync quota</span><span class="v">' + (p.syncQuotaBytes === 0 ? '∞' : bytes(p.syncQuotaBytes)) + '</span></div>' +
        '<div class="row"><span class="k">Version retention</span><span class="v">' + p.syncVersionRetention + '</span></div>' +
        '<div class="row"><span class="k">Features</span><span class="v">' + featNames(p.features) + '</span></div>' +
        '<button class="btn" style="margin-top:10px" data-edit-plan="' + esc(p.code) + '">Edit</button>' +
        '</div>';
    }
    html += '</div>';
  }
  document.getElementById('tab-plans').innerHTML = html;
  document.getElementById('refreshPlans').addEventListener('click', loadPlans);
  var editBtns = document.querySelectorAll('#tab-plans [data-edit-plan]');
  for (var b = 0; b < editBtns.length; b++) {
    editBtns[b].addEventListener('click', function (e) {
      openPlanEdit(e.target.getAttribute('data-edit-plan'));
    });
  }
}

function openPlanEdit(code) {
  var p = null;
  for (var i = 0; i < plans.length; i++) if (plans[i].code === code) p = plans[i];
  if (!p) return;
  var quotaMb = p.syncQuotaBytes === 0 ? 0 : Math.round(p.syncQuotaBytes / 1048576);
  var featHtml = '';
  for (var f = 0; f < FEATURES.length; f++) {
    var checked = (p.features & FEATURES[f][1]) !== 0 ? ' checked' : '';
    featHtml += '<label class="feat"><input type="checkbox" data-feat="' + FEATURES[f][1] + '"' + checked + '/> ' + esc(FEATURES[f][0]) + '</label>';
  }
  var html = '<p class="muted">Edit plan <b>' + esc(code) + '</b></p>' +
    '<div class="kv" style="margin:12px 0">' +
    '<span class="k">Name</span><input id="pName" value="' + esc(p.name) + '"/>' +
    '<span class="k">Monthly (¥)</span><input id="pMonth" type="number" min="0" step="1" value="' + p.priceMonth + '"/>' +
    '<span class="k">Yearly (¥)</span><input id="pYear" type="number" min="0" step="1" value="' + p.priceYear + '"/>' +
    '<span class="k">Max connections</span><input id="pMaxConn" type="number" min="0" step="1" value="' + p.maxConnections + '"/>' +
    '<span class="k">Sync quota (MB)</span><input id="pQuota" type="number" min="0" step="1" value="' + quotaMb + '"/>' +
    '<span class="k">Version retention</span><input id="pRetention" type="number" min="0" step="1" value="' + p.syncVersionRetention + '"/>' +
    '</div>' +
    '<div class="muted" style="margin-bottom:6px">Features</div>' +
    '<div class="feats">' + featHtml + '</div>' +
    '<button class="btn primary" id="planSubmit" style="margin-top:14px">Save</button>';
  openModal('Edit plan', html);
  document.getElementById('planSubmit').addEventListener('click', async function () {
    var features = 0;
    var checks = document.querySelectorAll('#modal [data-feat]');
    for (var c = 0; c < checks.length; c++) if (checks[c].checked) features |= Number(checks[c].getAttribute('data-feat'));
    var body = {
      name: document.getElementById('pName').value,
      priceMonth: Number(document.getElementById('pMonth').value),
      priceYear: Number(document.getElementById('pYear').value),
      maxConnections: Number(document.getElementById('pMaxConn').value),
      syncQuotaBytes: Number(document.getElementById('pQuota').value) * 1048576,
      syncVersionRetention: Number(document.getElementById('pRetention').value),
      features: features,
    };
    try {
      await api('/admin/plans/' + encodeURIComponent(code), { method: 'POST', body: body });
      closeModal();
      await loadPlans();
    } catch (ex) { alert(ex.message); }
  });
}

/* tab switching */
document.addEventListener('click', function (e) {
  var tabBtn = e.target.closest('nav button[data-tab]');
  if (tabBtn) {
    document.querySelectorAll('nav button').forEach(function (b) { b.classList.remove('active'); });
    tabBtn.classList.add('active');
    ['users', 'subs', 'plans'].forEach(function (t) {
      document.getElementById('tab-' + t).classList.toggle('hidden', t !== tabBtn.getAttribute('data-tab'));
    });
  }
});

document.getElementById('loginForm').addEventListener('submit', async function (e) {
  e.preventDefault();
  var err = document.getElementById('loginError');
  err.textContent = '';
  try {
    var r = await api('/api/auth/login', {
      method: 'POST',
      body: { email: document.getElementById('email').value, password: document.getElementById('password').value },
    });
    if (r.role !== 'admin') { err.textContent = 'This account is not an admin.'; return; }
    token = r.token;
    localStorage.setItem('adminToken', r.token);
    me = r.user;
    await enterApp();
  } catch (ex) { err.textContent = ex.message; }
});

document.getElementById('logout').addEventListener('click', function () {
  token = null; me = null;
  localStorage.removeItem('adminToken');
  show('#loginView');
});

document.getElementById('modalClose').addEventListener('click', closeModal);
document.getElementById('modal').addEventListener('click', function (e) { if (e.target.id === 'modal') closeModal(); });

init();
</script>
</body>
</html>`;