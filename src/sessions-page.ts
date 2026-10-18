// The sessions UI page: one HTML document with inline CSS and JS, no external resources (CSP allows only this nonce).
// Everything that comes from a transcript (titles, prompts, paths) is written with textContent, never innerHTML.
// The JS below must not contain backticks or "${": it lives inside a String.raw template.

const CSS = String.raw`
:root { --bg:#f6f7f9; --card:#fff; --fg:#1b1f24; --muted:#6a737d; --line:#dfe3e8; --accent:#2f6fed; --danger:#c62828; --ok:#1a7f37; --warn:#9a6700; --chip:#eef1f5; --code:#f0f2f5; }
@media (prefers-color-scheme: dark) { :root { --bg:#14171b; --card:#1c2026; --fg:#e6e9ee; --muted:#9aa4b0; --line:#2c333b; --accent:#6ea0ff; --danger:#ff7b72; --ok:#56d364; --warn:#e3b341; --chip:#262c34; --code:#12151a; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
main { max-width:1000px; margin:0 auto; padding:16px; }
h1 { font-size:18px; margin:0 0 12px; }
.toolbar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:12px; }
input[type=search], input[type=text], select { background:var(--card); color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:6px 8px; font:inherit; }
input[type=search] { flex:1 1 220px; min-width:0; }
button { font:inherit; border:1px solid var(--line); background:var(--card); color:var(--fg); border-radius:6px; padding:5px 10px; cursor:pointer; }
button:hover:not(:disabled) { border-color:var(--accent); }
button:disabled { opacity:.5; cursor:not-allowed; }
button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
button.danger { color:var(--danger); border-color:var(--danger); }
button.tab[aria-pressed=true] { background:var(--accent); color:#fff; border-color:var(--accent); }
.banner { border:1px solid var(--line); border-left-width:4px; background:var(--card); border-radius:6px; padding:8px 10px; margin-bottom:8px; display:flex; gap:8px; align-items:flex-start; }
.banner.pending, .banner.approved { border-left-color:var(--warn); } .banner.done { border-left-color:var(--ok); }
.banner.failed, .banner.rejected, .banner.expired, .banner.error { border-left-color:var(--danger); }
.banner .grow { flex:1; min-width:0; overflow-wrap:anywhere; }
details.group { background:var(--card); border:1px solid var(--line); border-radius:8px; margin-bottom:10px; }
details.group > summary { cursor:pointer; padding:10px 12px; display:flex; gap:8px; align-items:center; }
.proj-name { font-weight:600; } .muted { color:var(--muted); } .grow { flex:1; min-width:0; }
.path { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; direction:rtl; text-align:left; }
.session { border-top:1px solid var(--line); padding:9px 12px; cursor:pointer; }
.session:hover { background:var(--chip); }
.title { font-weight:600; overflow-wrap:anywhere; }
.meta { color:var(--muted); font-size:12px; margin-top:2px; }
.chip { display:inline-block; background:var(--chip); border-radius:10px; padding:0 7px; font-size:11px; margin-left:4px; vertical-align:middle; }
.chip.live { background:var(--ok); color:#fff; }
.detail { border-top:1px dashed var(--line); background:var(--bg); padding:10px 12px; cursor:default; }
.detail h3 { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:10px 0 4px; }
.detail ul { margin:0; padding-left:18px; } .detail li { overflow-wrap:anywhere; }
pre { background:var(--code); border:1px solid var(--line); border-radius:6px; padding:6px 8px; margin:0; overflow:auto; flex:1; }
.row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:8px; }
.overlay { position:fixed; inset:0; background:rgba(0,0,0,.5); display:flex; align-items:center; justify-content:center; padding:16px; }
.dialog { background:var(--card); border-radius:10px; padding:16px; width:min(440px,100%); border:1px solid var(--line); }
.dialog h2 { margin:0 0 8px; font-size:16px; } .dialog label { display:block; margin:8px 0 4px; }
.dialog input[type=text] { width:100%; }
.mb { margin-bottom:8px; }
.empty { padding:24px; text-align:center; color:var(--muted); }
`;

const JS = String.raw`
'use strict';
var TOKEN = document.querySelector('meta[name=token]').content;
var S = { q: '', project: '', live: false, sort: 'recent', view: 'sessions', data: null, other: null, trash: [], projects: [], actions: [], dismissed: {}, open: null, detail: null, error: '' };

function h(tag, attrs) {
  var el = document.createElement(tag);
  var a = attrs || {};
  Object.keys(a).forEach(function (k) {
    var v = a[k];
    if (v == null || v === false) return;
    if (k === 'class') el.className = v;
    else if (k === 'value' || k === 'checked' || k === 'disabled') el[k] = v;
    else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  });
  Array.prototype.slice.call(arguments, 2).forEach(function add(kid) {
    if (Array.isArray(kid)) return kid.forEach(add);
    if (kid == null || kid === false) return;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  });
  return el;
}

function api(path, body) {
  return fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-Token': TOKEN, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (j) {
      if (!r.ok) throw new Error(j.error || r.statusText);
      return j;
    });
  });
}

function fmtTime(iso) { return iso ? new Date(iso).toLocaleString() : ''; }
function fmtSize(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
// OpenCode ids all start with ses_, so their short form skips it
function shortId(agent, id) { return agent === 'opencode' ? id.slice(4, 12) : id.slice(0, 8); }
function base(p) { return p.split('/').filter(Boolean).pop() || p; }
function busy(a) { return a.status === 'pending' || a.status === 'approved'; }

function copy(text, btn) {
  var done = function () { var t = btn.textContent; btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = t; }, 1200); };
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () { window.prompt('Copy:', text); });
  else window.prompt('Copy:', text);
}

// ---- data ----------------------------------------------------------------------------------------------------------
function load() {
  var p = new URLSearchParams({ sort: S.sort });
  if (S.q) p.set('q', S.q);
  if (S.project) p.set('project', S.project);
  if (S.live) p.set('live', '1');
  return Promise.all([api('/api/sessions?' + p), api('/api/trash'), api('/api/actions'), api('/api/other')]).then(function (r) {
    S.data = r[0]; S.trash = r[1].trash; S.actions = r[2].actions; S.other = r[3]; S.error = '';
    if (!S.project) S.projects = r[0].groups.map(function (g) { return g.project; });
    renderAll();
    if (S.actions.some(busy)) poll();
  }).catch(function (e) { S.error = e.message; renderAll(); });
}

var timer = null;
function poll() {
  if (timer) return;
  timer = setInterval(function () {
    api('/api/actions').then(function (r) {
      S.actions = r.actions; renderBanners();
      if (!S.actions.some(busy)) { clearInterval(timer); timer = null; load(); }
    }).catch(function () {});
  }, 1500);
}

function request(body) {
  return api('/api/actions', body).then(function (r) { S.actions.unshift(r.action); renderBanners(); poll(); });
}

// ---- dialogs -------------------------------------------------------------------------------------------------------
function dialog(title, content, confirmLabel, onConfirm, opts) {
  var o = opts || {};
  var err = h('div', { class: 'muted' });
  var ok = h('button', { class: o.danger ? 'danger' : 'primary', disabled: !!o.needs }, confirmLabel);
  var close = function () { overlay.remove(); };
  ok.addEventListener('click', function () {
    ok.disabled = true;
    Promise.resolve(onConfirm()).then(close, function (e) { err.textContent = e.message; ok.disabled = false; });
  });
  var overlay = h('div', { class: 'overlay' }, h('div', { class: 'dialog', role: 'dialog' },
    h('h2', {}, title), content, err,
    h('div', { class: 'row' }, ok, h('button', { onclick: close }, 'Cancel'))));
  document.body.append(overlay);
  return ok;
}

function confirmDelete(s) {
  var short = s.id.slice(0, 8);
  var memchk = h('input', { type: 'checkbox' });
  var typed = h('input', { type: 'text', placeholder: short, autocomplete: 'off' });
  var ok = dialog('Delete session',
    h('div', {},
      h('p', {}, 'This moves "' + s.title + '" to the trash. The request still has to be approved in the terminal running the server.'),
      h('label', {}, memchk, ' Also delete its supermemory notes (' + (s.memoryCount || 0) + ')'),
      h('label', {}, 'Type ', h('b', {}, short), ' to confirm'), typed),
    'Request deletion',
    function () { return request({ kind: 'delete', sessionId: s.id, deleteMemories: memchk.checked }); },
    { danger: true, needs: true });
  typed.addEventListener('input', function () { ok.disabled = typed.value.trim() !== short; });
}

function confirmDeleteOpenCode(s) {
  var short = shortId('opencode', s.id);
  var typed = h('input', { type: 'text', placeholder: short, autocomplete: 'off' });
  var ok = dialog('Delete OpenCode session',
    h('div', {},
      h('p', {}, 'Deletes "' + (s.name || s.title) + '" and its sub-agent sessions through OpenCode itself. A restorable backup is written to the trash first. Close every OpenCode window before approving; the request still has to be approved in the terminal running the server.'),
      h('label', {}, 'Type ', h('b', {}, short), ' to confirm'), typed),
    'Request deletion',
    function () { return request({ kind: 'delete', agent: 'opencode', sessionId: s.id }); },
    { danger: true, needs: true });
  typed.addEventListener('input', function () { ok.disabled = typed.value.trim() !== short; });
}

function confirmText(title, label, current, onSave) {
  var input = h('input', { type: 'text', value: current });
  dialog(title, h('div', {}, h('label', {}, label), input), 'Request change', function () { return onSave(input.value); });
}

function confirmTrash(t, kind) {
  var agent = t.agent || 'claude';
  var short = shortId(agent, t.id);
  var typed = h('input', { type: 'text', placeholder: short, autocomplete: 'off' });
  var purge = kind === 'purge';
  var ok = dialog(purge ? 'Purge permanently' : 'Restore session',
    h('div', {}, h('p', {}, (purge ? 'Permanently removes ' : agent === 'opencode' ? 'Re-imports into OpenCode (close OpenCode first): ' : 'Moves back to ~/.claude: ') + (t.label || short) + '. Needs approval in the terminal.'),
      purge ? [h('label', {}, 'Type ', h('b', {}, short), ' to confirm'), typed] : null),
    purge ? 'Request purge' : 'Request restore',
    function () { return request({ kind: kind, agent: agent, trashId: t.trashId }); },
    { danger: purge, needs: purge });
  typed.addEventListener('input', function () { ok.disabled = typed.value.trim() !== short; });
}

// ---- rendering -----------------------------------------------------------------------------------------------------
function renderBanners() {
  var box = document.getElementById('banners');
  box.replaceChildren();
  if (S.error) box.append(h('div', { class: 'banner error' }, h('div', { class: 'grow' }, S.error)));
  S.actions.filter(function (a) { return !S.dismissed[a.id]; }).slice(0, 5).forEach(function (a) {
    var text = { pending: 'Waiting for your approval in the terminal: ', approved: 'Running: ', done: 'Done: ', failed: 'Failed: ', rejected: 'Rejected: ', expired: 'Expired: ' }[a.status] + a.summary;
    if (a.error) text += ' (' + a.error + ')';
    var r = a.result;
    if (r && r.memories) text += ' - notes deleted: ' + r.memories.deleted + (r.memories.failed.length ? ', not deleted: ' + r.memories.failed.length : '');
    box.append(h('div', { class: 'banner ' + a.status }, h('div', { class: 'grow' }, text),
      busy(a) ? null : h('button', { onclick: function () { S.dismissed[a.id] = 1; renderBanners(); } }, 'Dismiss')));
  });
}

function chips(s) {
  var meta = S.data.meta[s.id] || {};
  return [
    s.live ? h('span', { class: 'chip live' }, 'live') : null,
    (meta.tags || []).map(function (t) { return h('span', { class: 'chip' }, '#' + t); }),
    s.prNumber ? h('span', { class: 'chip' }, 'PR #' + s.prNumber) : null,
    s.memoryCount ? h('span', { class: 'chip' }, s.memoryCount + ' notes') : null,
  ];
}

function detailPanel(s, d) {
  var meta = S.data.meta[s.id] || {};
  var files = d.session.files;
  return h('div', { class: 'detail', onclick: function (e) { e.stopPropagation(); } },
    h('h3', {}, 'First prompt'), h('div', {}, d.session.firstPrompt || '-'),
    h('h3', {}, 'Last prompt'), h('div', {}, d.session.lastPrompt || '-'),
    h('h3', {}, 'Files touched (' + files.length + ')'),
    files.length ? h('ul', {}, files.slice(0, 40).map(function (f) { return h('li', {}, f); }), files.length > 40 ? h('li', { class: 'muted' }, '+' + (files.length - 40) + ' more') : null) : h('div', { class: 'muted' }, 'none'),
    h('h3', {}, 'Linked supermemory notes'),
    d.memories === null ? h('div', { class: 'muted' }, 'Memory server unavailable.') :
      d.memories.length ? h('ul', {}, d.memories.map(function (m) { return h('li', {}, '[' + m.type + ' ' + fmtTime(m.createdAt) + '] ' + m.excerpt); })) : h('div', { class: 'muted' }, 'none'),
    h('h3', {}, 'Resume'),
    (function () { var b = h('button', {}, 'Copy'); b.addEventListener('click', function () { copy(d.resume, b); }); return h('div', { class: 'row' }, h('pre', {}, d.resume), b); })(),
    h('div', { class: 'row' },
      h('button', { onclick: function () { confirmText('Rename session', 'Name (empty clears it)', meta.name || '', function (v) { return request({ kind: 'rename', sessionId: s.id, name: v }); }); } }, 'Rename'),
      h('button', { onclick: function () { confirmText('Tags', 'Comma-separated tags', (meta.tags || []).join(', '), function (v) { return request({ kind: 'tags', sessionId: s.id, tags: v.split(',').map(function (t) { return t.trim(); }).filter(Boolean) }); }); } }, 'Tags'),
      h('button', { class: 'danger', disabled: s.live, title: s.live ? 'Running sessions cannot be deleted' : '', onclick: function () { confirmDelete(s); } }, 'Delete')));
}

function sessionRow(s) {
  var meta = S.data.meta[s.id] || {};
  var open = S.open === s.id;
  var row = h('div', { class: 'session', onclick: function () {
    if (open) { S.open = null; S.detail = null; return renderMain(); }
    S.open = s.id; S.detail = null; renderMain();
    api('/api/sessions/' + s.id).then(function (d) { if (S.open === s.id) { S.detail = d; renderMain(); } }).catch(function (e) { S.error = e.message; renderBanners(); });
  } },
    h('div', { class: 'title' }, meta.name || s.title, chips(s)),
    h('div', { class: 'meta' }, [s.branch, fmtTime(s.lastAt), fmtSize(s.size), s.costUSD != null ? '$' + s.costUSD.toFixed(2) : '', s.id.slice(0, 8)].filter(Boolean).join(' - ')));
  return h('div', {}, row, open && S.detail ? detailPanel(s, S.detail) : open ? h('div', { class: 'detail muted' }, 'Loading...') : null);
}

function renderSessions() {
  var groups = S.data.groups;
  if (!groups.length) return h('div', { class: 'empty' }, 'No sessions match.');
  return groups.map(function (g) {
    var btn = h('button', { title: g.newCommand }, 'New session');
    btn.addEventListener('click', function (e) { e.preventDefault(); copy(g.newCommand, btn); });
    return h('details', { class: 'group', open: true },
      h('summary', {}, h('span', { class: 'proj-name' }, base(g.project)), h('span', { class: 'muted path grow', title: g.project }, g.project), h('span', { class: 'muted' }, g.sessions.length + ' sessions'), btn),
      g.sessions.map(sessionRow));
  });
}

function renderTrash() {
  if (!S.trash.length) return h('div', { class: 'empty' }, 'Trash is empty.');
  return S.trash.map(function (t) {
    return h('div', { class: 'banner' }, h('div', { class: 'grow' },
      h('div', { class: 'title' }, t.label || t.id, h('span', { class: 'chip' }, t.agent === 'opencode' ? 'OpenCode' : 'Claude Code')),
      h('div', { class: 'meta' }, 'deleted ' + fmtTime(t.deletedAt) + ' - ' + fmtSize(t.size) + ' - ' + shortId(t.agent, t.id))),
      h('button', { onclick: function () { confirmTrash(t, 'restore'); } }, 'Restore'),
      h('button', { class: 'danger', onclick: function () { confirmTrash(t, 'purge'); } }, 'Purge'));
  });
}

var OTHER = { opencode: 'OpenCode', antigravity: 'Antigravity' };

// OpenCode and Antigravity sessions: rename and tags (kept in our sidecar) for both, delete and restore for OpenCode only.
function renderOther(kind) {
  var list = S.other && S.other[kind];
  if (!list) return h('div', { class: 'empty' }, 'Loading...');
  if (!list.available) return h('div', { class: 'empty' }, OTHER[kind] + ' data not found' + (list.error ? ': ' + list.error : '.'));
  var q = S.q.toLowerCase();
  var rows = list.sessions.filter(function (s) { return !q || ((s.name || '') + ' ' + s.title + ' ' + s.project + ' ' + s.id + ' ' + (s.tags || []).join(' ')).toLowerCase().indexOf(q) >= 0; });
  if (!rows.length) return h('div', { class: 'empty' }, 'No sessions match.');
  var groups = {};
  rows.forEach(function (s) { (groups[s.project || '(no project)'] = groups[s.project || '(no project)'] || []).push(s); });
  var out = Object.keys(groups).map(function (project) {
    return h('details', { class: 'group', open: true },
      h('summary', {}, h('span', { class: 'proj-name' }, base(project)), h('span', { class: 'muted path grow', title: project }, project), h('span', { class: 'muted' }, groups[project].length + ' sessions')),
      groups[project].map(function (s) {
        var resume = s.resume ? h('button', { title: s.resume }, 'Copy resume') : null;
        if (resume) resume.addEventListener('click', function () { copy(s.resume, resume); });
        return h('div', { class: 'session' },
          h('div', { class: 'title' }, s.name || s.title, (s.tags || []).map(function (t) { return h('span', { class: 'chip' }, '#' + t); })),
          h('div', { class: 'meta' }, [fmtTime(s.updatedAt)].concat(s.facts, [s.id.slice(0, 12)]).filter(Boolean).join(' - ')),
          h('div', { class: 'row' }, resume,
            h('button', { onclick: function () { confirmText('Rename session', 'Name (empty clears it)', s.name || '', function (v) { return request({ kind: 'rename', agent: kind, sessionId: s.id, name: v }); }); } }, 'Rename'),
            h('button', { onclick: function () { confirmText('Tags', 'Comma-separated tags', (s.tags || []).join(', '), function (v) { return request({ kind: 'tags', agent: kind, sessionId: s.id, tags: v.split(',').map(function (t) { return t.trim(); }).filter(Boolean) }); }); } }, 'Tags'),
            kind === 'opencode' ? h('button', { class: 'danger', onclick: function () { confirmDeleteOpenCode(s); } }, 'Delete') : null));
      }));
  });
  out.push(h('div', { class: 'muted mb' }, (kind === 'opencode' ? 'Delete is available for OpenCode only. ' : 'Antigravity sessions can be renamed and tagged, not deleted. ') + (list.hidden ? list.hidden + ' sub-agent or empty sessions are hidden.' : '')));
  return out;
}

function renderMain() {
  var main = document.getElementById('list');
  main.replaceChildren();
  if (!S.data) return;
  if (!OTHER[S.view] && S.data.memories && !S.data.memories.available) main.append(h('div', { class: 'muted mb' }, 'Memory server unavailable: linked notes are hidden.'));
  var body = S.view === 'trash' ? renderTrash() : OTHER[S.view] ? renderOther(S.view) : renderSessions();
  main.append.apply(main, [].concat(body));
}

function renderToolbar() {
  var sel = document.getElementById('project');
  sel.replaceChildren(h('option', { value: '' }, 'All projects'));
  S.projects.forEach(function (p) { sel.append(h('option', { value: p }, base(p) + '  (' + p + ')')); });
  sel.value = S.project;
  document.getElementById('tab-sessions').setAttribute('aria-pressed', String(S.view === 'sessions'));
  var t = document.getElementById('tab-trash');
  t.setAttribute('aria-pressed', String(S.view === 'trash'));
  t.textContent = 'Trash (' + S.trash.length + ')';
  Object.keys(OTHER).forEach(function (k) {
    var b = document.getElementById('tab-' + k);
    b.setAttribute('aria-pressed', String(S.view === k));
    b.textContent = OTHER[k] + (S.other && S.other[k] && S.other[k].available ? ' (' + S.other[k].sessions.length + ')' : '');
  });
  // project filter, sort and live-only only mean something for Claude sessions
  ['project', 'sort', 'live-label'].forEach(function (id) { document.getElementById(id).hidden = S.view !== 'sessions'; });
}

function renderAll() { renderToolbar(); renderBanners(); renderMain(); }

(function init() {
  var wait = null;
  document.getElementById('q').addEventListener('input', function (e) { clearTimeout(wait); wait = setTimeout(function () { S.q = e.target.value; load(); }, 200); });
  document.getElementById('project').addEventListener('change', function (e) { S.project = e.target.value; load(); });
  document.getElementById('sort').addEventListener('change', function (e) { S.sort = e.target.value; load(); });
  document.getElementById('live').addEventListener('change', function (e) { S.live = e.target.checked; load(); });
  document.getElementById('tab-sessions').addEventListener('click', function () { S.view = 'sessions'; renderAll(); });
  document.getElementById('tab-trash').addEventListener('click', function () { S.view = 'trash'; renderAll(); });
  Object.keys(OTHER).forEach(function (k) { document.getElementById('tab-' + k).addEventListener('click', function () { S.view = k; renderAll(); }); });
  load();
})();
`;

export const pageHtml = (token: string, nonce: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="token" content="${token}">
<title>Agent Sessions</title>
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
<main>
<h1>Agent sessions</h1>
<div class="toolbar">
<input id="q" type="search" placeholder="Search title, prompts, files, tags" aria-label="Search">
<select id="project" aria-label="Project"></select>
<select id="sort" aria-label="Sort"><option value="recent">Most recent</option><option value="size">Largest</option></select>
<label id="live-label"><input id="live" type="checkbox"> live only</label>
<button id="tab-sessions" class="tab" aria-pressed="true">Claude Code</button>
<button id="tab-opencode" class="tab" aria-pressed="false">OpenCode</button>
<button id="tab-antigravity" class="tab" aria-pressed="false">Antigravity</button>
<button id="tab-trash" class="tab" aria-pressed="false">Trash</button>
</div>
<div id="banners"></div>
<div id="list"></div>
</main>
<script nonce="${nonce}">${JS}</script>
</body>
</html>`;
