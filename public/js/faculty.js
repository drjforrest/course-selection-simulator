import * as M from './model.js';

let data = null;
let term = null;
let edits = {}; // code -> formats[] for the selected term, not yet saved
let tab = 'schedule';

const $ = sel => document.querySelector(sel);
const FORMATS = ['on-ground', 'hybrid', 'online'];

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

async function boot() {
  const s = await api('GET', '/api/session');
  $('#login').addEventListener('submit', login);
  $('#fac-logout').addEventListener('click', logout);
  if (s.faculty) return enterAdmin();
  $('#login').hidden = false;
  if (!s.configured) showLoginError('Faculty sign-in is not configured on this server (FACULTY_PASSWORD is not set).');
}

function showLoginError(msg) {
  $('#login-error').textContent = msg;
  $('#login-error').hidden = false;
}

async function login(e) {
  e.preventDefault();
  try {
    await api('POST', '/api/login', { password: $('#password').value });
    $('#password').value = '';
    enterAdmin();
  } catch (err) {
    showLoginError(err.message);
  }
}

async function logout() {
  if (dirty() && !confirm('Discard unsaved changes?')) return;
  await api('POST', '/api/logout');
  location.reload();
}

async function enterAdmin() {
  data = await api('GET', '/api/data');
  $('#login').hidden = true;
  $('#admin').hidden = false;
  $('#fac-logout').hidden = false;

  const terms = M.termRange(M.currentTerm(), 10);
  term = M.upcomingTerm();
  $('#term-select').replaceChildren(...terms.map(t => h('option', { value: t, selected: t === term }, M.termLabel(t))));
  $('#term-select').addEventListener('change', e => {
    if (dirty() && !confirm('Discard unsaved changes for this term?')) { e.target.value = term; return; }
    term = e.target.value;
    edits = {};
    renderTerm();
  });
  $('#term-save').addEventListener('click', saveTerm);
  $('#term-reset').addEventListener('click', resetTerm);
  window.addEventListener('beforeunload', e => { if (dirty()) e.preventDefault(); });
  renderTabs();
  renderSchedule();
  renderTerm();
  renderCourses();
  renderUpdated();
}

const dirty = () => Object.keys(edits).length > 0;

const TABS = [['schedule', 'When courses run'], ['terms', 'One-term exceptions'], ['courses', 'Credits & prerequisites']];

function renderTabs() {
  $('#fac-tabs').replaceChildren(...TABS.map(([k, label]) =>
    h('button', { class: 'tab', type: 'button', 'aria-pressed': String(tab === k), onclick: () => { tab = k; renderTabs(); } }, label)));
  for (const [k] of TABS) $(`#tab-${k}`).hidden = k !== tab;
}

// ---------- when courses run (course schedules) ----------
const LETTER = { 'on-ground': 'G', hybrid: 'H', online: 'O' };
const scheduleTerms = () => M.termRange(M.upcomingTerm(), 9);

function cell(code, t) {
  const off = M.offering(data, code, t);
  const text = !off ? '?' : off.formats.length ? off.formats.map(f => LETTER[f]).join(' ') : '—';
  const cls = ['c', 'sched-cell', !off ? 'unknown' : off.formats.length ? 'on' : 'off', off?.source === 'term' ? 'exception' : ''].join(' ');
  const title = `${M.termLabel(t)}: ${off ? (off.formats.length ? off.formats.join(', ') : 'not offered') : 'no data'} (${M.offeringNote(off, t)})`;
  return h('td', { class: cls, title }, text);
}

function scheduleSummary(code) {
  const p = data.overrides.patterns?.[code];
  if (!p) {
    const src = M.regularOffering(data, code, M.upcomingTerm());
    return src?.source === 'program' ? 'Program default' : 'Course schedule spreadsheet';
  }
  const seasons = M.SEASONS.filter(se => p.seasons[se]).map(M.seasonName);
  return `Faculty: ${seasons.length ? seasons.join(', ') : 'not offered'} from ${M.termLabel(p.from)}`;
}

function renderSchedule() {
  const terms = scheduleTerms();
  $('#sched-head').replaceChildren(h('tr', {},
    h('th', {}, 'Course'), h('th', {}, 'Title'),
    ...terms.map(t => h('th', { class: 'c' }, M.termLabel(t).replace(' ', '\u00a0'))),
    h('th', {}, 'Schedule source'), h('th', {})));
  $('#sched-rows').replaceChildren(...M.allCodes(data).map(code => h('tr', {},
    h('td', {}, h('b', {}, code)),
    h('td', {}, M.course(data, code).title),
    ...terms.map(t => cell(code, t)),
    h('td', { class: 'small muted' }, scheduleSummary(code)),
    h('td', {}, h('button', { class: 'btn', type: 'button', onclick: () => openSchedule(code) }, 'Change schedule')))));
}

function openSchedule(code) {
  const c = M.course(data, code);
  const existing = data.overrides.patterns?.[code];
  const start = M.upcomingTerm();
  // Pre-fill with what the course does now: next year's term of each season.
  const current = Object.fromEntries(M.SEASONS.map(se => {
    const t = M.termRange(start, 3).find(x => x.endsWith(se));
    return [se, existing ? existing.seasons[se] || [] : M.regularOffering(data, code, t)?.formats || []];
  }));
  const from = h('select', { id: 'sched-from' }, ...M.termRange(M.currentTerm(), 10).map(t =>
    h('option', { value: t, selected: t === (existing?.from || start) }, M.termLabel(t))));
  const rows = M.SEASONS.map(se => h('tr', {},
    h('th', { scope: 'row' }, M.seasonName(se)),
    ...FORMATS.map(f => h('td', { class: 'c' }, h('input', { type: 'checkbox', name: `${se}:${f}`, checked: current[se].includes(f), 'aria-label': `${M.seasonName(se)} ${f}` })))));
  const close = () => $('#sched-dialog').close();
  const save = async () => {
    const seasons = Object.fromEntries(M.SEASONS.map(se => [se, FORMATS.filter(f => $('#sched-form').elements[`${se}:${f}`].checked)]));
    try {
      const r = await api('PUT', `/api/patterns/${encodeURIComponent(code)}`, { from: from.value, seasons });
      data.overrides = r.overrides;
      close();
      refreshAll();
      toast(`Saved schedule for ${code}.`);
    } catch (err) { toast(err.message); }
  };
  const remove = async () => {
    try {
      const r = await api('DELETE', `/api/patterns/${encodeURIComponent(code)}`);
      data.overrides = r.overrides;
      close();
      refreshAll();
      toast(`${code} is back on its original schedule.`);
    } catch (err) { toast(err.message); }
  };
  $('#sched-form').replaceChildren(
    h('h2', {}, `${code} · ${c.title}`),
    h('p', { class: 'muted small' }, 'Tick the formats the course runs in each season. Leave a season blank if it doesn’t run then. The schedule repeats every year from the starting term. Terms before it, and one-term exceptions, are unchanged.'),
    h('table', { class: 'fac-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Season'), ...FORMATS.map(f => h('th', { class: 'c' }, f)))),
      h('tbody', {}, ...rows)),
    h('label', { class: 'field' }, h('span', {}, h('b', {}, 'Starting')), from,
      h('span', { class: 'muted small' }, 'The first term this schedule applies to.')),
    h('div', { class: 'row' },
      existing ? h('button', { class: 'btn', type: 'button', onclick: remove }, 'Use original schedule') : null,
      h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'),
      h('button', { class: 'btn primary', type: 'button', onclick: save }, 'Save schedule')));
  $('#sched-dialog').showModal();
}

function refreshAll() {
  renderSchedule();
  renderTerm();
  renderUpdated();
}

function renderUpdated() {
  $('#updated').textContent = data.overrides.updatedAt ? `Last saved ${new Date(data.overrides.updatedAt).toLocaleString()}` : 'No faculty changes yet';
}

// ---------- term offerings ----------
function renderTerm() {
  const own = data.overrides.terms[term] || {};
  let offered = 0;
  const rows = M.allCodes(data).map(code => {
    const off = M.offering(data, code, term);
    const current = edits[code] ?? off?.formats ?? null;
    if (current?.length) offered++;
    const isOwn = code in own;
    const source = edits[code] ? 'Unsaved change' : M.offeringNote(off, term);
    const box = f => h('td', { class: 'c' }, h('input', {
      type: 'checkbox', checked: !!current?.includes(f), 'aria-label': `${code} ${f}`,
      onchange: e => {
        const next = new Set(edits[code] ?? off?.formats ?? []);
        e.target.checked ? next.add(f) : next.delete(f);
        edits[code] = FORMATS.filter(x => next.has(x));
        renderTerm();
      },
    }));
    return h('tr', { class: edits[code] ? 'dirty' : '' },
      h('td', {}, h('b', {}, code)),
      h('td', {}, M.course(data, code).title),
      ...FORMATS.map(box),
      h('td', { class: 'small muted' }, current === null && !edits[code] ? 'No data: students see it as “Unconfirmed”' : source),
      h('td', {}, isOwn && !edits[code] ? h('button', { class: 'btn link', type: 'button', onclick: () => resetRow(code) }, 'Use default') : null));
  });
  $('#term-rows').replaceChildren(...rows);
  $('#term-summary').textContent = `${offered} of ${rows.length} courses offered in ${M.termLabel(term)}`;
  $('#term-save').disabled = !dirty();
  $('#term-reset').disabled = !data.overrides.terms[term];
}

async function saveTerm() {
  const offerings = { ...(data.overrides.terms[term] || {}), ...edits };
  try {
    const r = await api('PUT', `/api/terms/${term}`, { offerings });
    data.overrides = r.overrides;
    edits = {};
    refreshAll();
    toast(`Saved ${M.termLabel(term)}.`);
  } catch (err) { toast(err.message); }
}

async function resetRow(code) {
  const offerings = { ...(data.overrides.terms[term] || {}) };
  delete offerings[code];
  try {
    const r = await api('PUT', `/api/terms/${term}`, { offerings });
    data.overrides = r.overrides;
    refreshAll();
  } catch (err) { toast(err.message); }
}

async function resetTerm() {
  if (!confirm(`Reset every course in ${M.termLabel(term)} to the default?`)) return;
  try {
    const r = await api('DELETE', `/api/terms/${term}`);
    data.overrides = r.overrides;
    edits = {};
    refreshAll();
  } catch (err) { toast(err.message); }
}

// ---------- credits & prerequisites ----------
const formatPrereqs = p => p.map(g => g.join(' | ')).join('; ');
const parsePrereqs = s => s.split(';').map(g => g.split('|').map(x => x.trim().toUpperCase().replace(/\s+/g, ' ')).filter(Boolean)).filter(g => g.length);

function renderCourses() {
  $('#course-rows').replaceChildren(...M.allCodes(data).map(code => {
    const c = M.course(data, code);
    const own = code in data.overrides.courses;
    const credits = h('input', { type: 'number', min: '0', max: '12', value: String(c.credits), 'aria-label': `${code} credits` });
    const prereqs = h('input', { type: 'text', value: formatPrereqs(c.prereqs), 'aria-label': `${code} prerequisites`, placeholder: 'None' });
    const save = async () => {
      const parsed = parsePrereqs(prereqs.value);
      const unknown = parsed.flat().filter(x => !(x in data.base.courses) && !(x in data.base.external));
      if (unknown.length) return toast(`Unknown course: ${unknown.join(', ')}`);
      try {
        const r = await api('PUT', `/api/courses/${encodeURIComponent(code)}`, { credits: Number(credits.value), prereqs: parsed });
        data.overrides = r.overrides;
        renderCourses();
        renderUpdated();
        toast(`Saved ${code}.`);
      } catch (err) { toast(err.message); }
    };
    const reset = async () => {
      const r = await api('DELETE', `/api/courses/${encodeURIComponent(code)}`);
      data.overrides = r.overrides;
      renderCourses();
      renderUpdated();
    };
    return h('tr', {},
      h('td', {}, h('b', {}, code)),
      h('td', {}, c.title),
      h('td', {}, credits),
      h('td', {}, prereqs),
      h('td', { class: 'small muted' }, own ? 'Edited by faculty' : 'Catalogue'),
      h('td', {}, h('button', { class: 'btn', type: 'button', onclick: save }, 'Save'), own ? h('button', { class: 'btn link', type: 'button', onclick: reset }, 'Revert') : null));
  }));
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

boot();
