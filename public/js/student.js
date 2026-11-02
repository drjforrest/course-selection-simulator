import * as M from './model.js';

// Everything lives in memory only. Logging out or closing the tab discards it.
let data = null;
let plan = null;
let student = { name: '', start: null };
const ui = { search: '', pool: 'all', target: null }; // target: term index whose availability the library shows
let drag = null; // { code, from, allowed: Map(termIndex|'library' -> reasons[]) }

const $ = sel => document.querySelector(sel);

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

const POOL_ORDER = ['core', 'business', 'technical', 'health', 'elective'];
const POOL_SHORT = { core: 'Core', business: 'Business', technical: 'Technical', health: 'Health Informatics', elective: 'Elective', extra: 'Extra' };

// ---------- boot ----------
async function boot() {
  const res = await fetch('/api/data');
  data = await res.json();
  renderSetupForm();
  $('#setup').addEventListener('submit', onSetupSubmit);
  $('#logout').addEventListener('click', logout);
  $('#edit-setup').addEventListener('click', () => showSetup());
  $('#help-toggle').addEventListener('click', () => {
    const help = $('#planner-help');
    help.open = !help.open;
    if (help.open) help.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('#print').addEventListener('click', () => { renderPrint(); window.print(); });
  window.addEventListener('beforeprint', () => plan && renderPrint());
  $('#add-term').addEventListener('click', addTerm);
  $('#remove-term').addEventListener('click', removeTerm);
  $('#search').addEventListener('input', e => { ui.search = e.target.value.trim().toLowerCase(); renderLibrary(); });
  $('#target-term').addEventListener('change', e => setTarget(e.target.value === '' ? null : Number(e.target.value)));
  window.addEventListener('beforeunload', e => { if (plan && M.plannedCodes(plan).length) e.preventDefault(); });
  setupLibraryDropZone();
}

// ---------- setup ----------
function variantValue() {
  return document.querySelector('input[name=variant]:checked')?.value || 'boston';
}

function programCodes(variant) {
  const other = variant === 'vancouver' ? 'HINF 5105' : 'HINF 5106';
  return M.allCodes(data).filter(c => c !== other);
}

function primaryPool(variant, code) {
  if ([M.INTRO, M.CAPSTONE, 'HINF 5105', 'HINF 5106'].includes(code)) return 'core';
  const pools = M.poolsFor(data, variant, code);
  if (pools.includes('elective')) return 'elective'; // DA/INSH: listed with electives, may count once as Technical
  return pools[0] || 'extra';
}

function renderSetupForm() {
  const vc = $('#variant-choices');
  const hints = {
    boston: 'Studying on campus in Boston. Core course HINF 5105 (American Healthcare System). You can take on-ground, hybrid and online sections.',
    online: 'Fully online, Boston-based program. Core course HINF 5105. Online sections only. HLTH 5800 counts as Technical rather than Health Informatics.',
    vancouver: 'Online program through the Vancouver campus. Core course HINF 5106 (Canadian Healthcare System, Spring only). Online sections only.',
  };
  vc.replaceChildren(...Object.entries(M.VARIANTS).map(([k, v], i) =>
    h('label', { class: 'choice' },
      h('input', { type: 'radio', name: 'variant', value: k, checked: i === 0, onchange: renderCompletedGrid }),
      h('span', {}, v.label, h('small', {}, hints[k])))));

  renderStartTerms();
  renderCompletedGrid();
}

// Plans start in Spring or Fall; summer is optional and never a starting term.
function renderStartTerms() {
  const sel = $('#start-term');
  const now = M.currentTerm();
  const options = M.termRange(now, 8).filter(t => !M.isSummer(t));
  const previous = sel.value;
  const preferred = options.includes(previous) ? previous : options.find(t => M.compareTerms(t, M.upcomingTerm()) >= 0) || options[0];
  sel.replaceChildren(...options.map(t =>
    h('option', { value: t, selected: t === preferred }, M.termLabel(t) + (t === now ? ' (current term)' : ''))));
  $('#start-hint').textContent = 'Plans start in Spring or Fall. HINF 5101 and HINF 5105/5106, if not yet completed, are placed for you in the first term each runs; you can move them.';
}

function renderCompletedGrid() {
  const variant = variantValue();
  const checked = new Set([...document.querySelectorAll('#completed-grid input:checked')].map(i => i.value));
  const groups = {};
  for (const code of programCodes(variant)) (groups[primaryPool(variant, code)] ||= []).push(code);
  const box = (code, label) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', value: code, checked: checked.has(code) }),
    h('span', {}, h('b', {}, code), ' ', label));
  $('#completed-grid').replaceChildren(
    ...POOL_ORDER.filter(p => groups[p]).map(p => h('div', {},
      h('h3', {}, p === 'core' ? 'Core' : M.POOLS[p]),
      ...groups[p].map(c => box(c, M.course(data, c).title)))),
    h('div', {},
      h('h3', {}, 'Other prerequisite coursework'),
      ...Object.entries(data.base.external).map(([c, label]) => box(c, label))));
}

function showSetup() {
  $('#planner').hidden = true;
  $('#plan-actions').hidden = true;
  $('#setup').hidden = false;
  window.scrollTo(0, 0);
}

function onSetupSubmit(e) {
  e.preventDefault();
  const variant = variantValue();
  const completed = [...document.querySelectorAll('#completed-grid input:checked')].map(i => i.value);
  const start = $('#start-term').value;
  const semestersDone = Math.max(0, Math.min(12, parseInt($('#semesters-done').value, 10) || 0));
  student = { name: $('#student-name').value.trim(), start };

  // Keep what was already on the board when editing setup, by term id.
  const old = plan;
  const count = Math.max(6, old ? old.terms.length : 0);
  const terms = M.termRange(start, count).map(id => ({
    id,
    courses: (old?.terms.find(t => t.id === id)?.courses || []).filter(c => !completed.includes(c)),
  }));
  plan = { variant, completed, semestersDone, terms };
  if (old && old.variant !== variant) {
    const keep = new Set(programCodes(variant));
    plan.terms.forEach(t => { t.courses = t.courses.filter(c => keep.has(c)); });
  }
  // Default intake placement on a new plan, or when the start term or program version changes.
  if (!old) $('#planner-help').open = true; // first visit: show how it works
  if (!old || old.variant !== variant || old.terms[0].id !== start) {
    for (const code of [M.INTRO, 'HINF 5105', 'HINF 5106']) plan = M.moveCourse(plan, code, null);
    plan = M.placeDefaults(data, plan);
  }

  $('#setup').hidden = true;
  $('#planner').hidden = false;
  $('#plan-actions').hidden = false;
  renderPlanner();
  window.scrollTo(0, 0);
}

function logout() {
  const hasWork = plan && (M.plannedCodes(plan).length || plan.completed.length);
  if (hasWork && !confirm('Log out and clear this plan? Nothing is saved. Print your roadmap first if you want to keep it.')) return;
  plan = null;
  student = { name: '', start: null };
  ui.search = ''; ui.pool = 'all'; ui.target = null;
  $('#search').value = '';
  $('#setup').reset();
  renderSetupForm();
  $('#print-view').replaceChildren();
  showSetup();
}

// ---------- planner ----------
function renderPlanner() {
  renderStatus();
  renderPoolTabs();
  renderLibrary();
  renderBoard();
  renderNotes();
}

function where(code) {
  if (plan.completed.includes(code)) return { completed: true };
  const i = plan.terms.findIndex(t => t.courses.includes(code));
  return i === -1 ? null : { index: i, term: plan.terms[i].id };
}

function renderStatus() {
  const s = M.requirementSummary(data, plan);
  const pct = Math.min(100, Math.round((s.credits / M.MIN_CREDITS) * 100));
  const creditCls = s.credits > M.MAX_CREDITS ? 'over' : s.credits >= M.MIN_CREDITS ? 'done' : '';
  const meters = [
    h('div', { class: `meter ${creditCls}`, title: `Completed plus planned credits. You need at least ${M.MIN_CREDITS} to graduate.` },
      h('span', { class: 'lbl' }, 'Credits'),
      h('b', {}, `${s.credits}`),
      h('span', { class: 'bar' }, barFill(pct)),
      h('span', { class: 'small muted' }, `At least ${M.MIN_CREDITS} needed to graduate`)),
    ...s.groups.map(g => h('div', { class: `meter ${g.have >= g.need ? 'done' : ''}`, title: g.courses.join(', ') || 'None yet' },
      h('span', { class: 'lbl' }, g.label),
      h('b', {}, `${g.have} / ${g.need}`),
      h('span', { class: 'bar' }, barFill(Math.round((g.have / g.need) * 100))),
      h('span', { class: 'small muted' }, g.key === 'core' && g.missing.length ? `Need ${g.missing.join(', ')}` : g.courses.join(', ') || '—'))),
  ];
  const overall = s.complete
    ? h('div', { class: 'overall ok' }, '✓ This plan meets the degree requirements.')
    : h('div', { class: 'overall' }, h('span', { class: 'small' }, remainingText(s)));
  $('#status').replaceChildren(...meters, overall);
}

function barFill(pct) {
  const i = document.createElement('i');
  i.style.width = `${pct}%`;
  return i;
}

function remainingText(s) {
  const parts = s.groups.filter(g => g.have < g.need).map(g => `${g.need - g.have} ${g.label}`);
  if (s.credits < M.MIN_CREDITS) parts.push(`${M.MIN_CREDITS - s.credits} more credits`);
  return parts.length ? `Still needed: ${parts.join(' · ')}` : 'Resolve the issues listed below the board.';
}

function renderPoolTabs() {
  const tabs = [['all', 'All'], ...POOL_ORDER.map(p => [p, p === 'core' ? 'Core' : M.POOLS[p]])];
  $('#pool-tabs').replaceChildren(...tabs.map(([k, label]) =>
    h('button', { type: 'button', class: 'tab', 'aria-pressed': String(ui.pool === k), onclick: () => { ui.pool = k; renderPoolTabs(); renderLibrary(); } }, label)));
}

function poolTags(code) {
  if (primaryPool(plan.variant, code) === 'core') return [h('span', { class: 'tag p-core' }, 'Core')];
  const pools = M.poolsFor(data, plan.variant, code);
  const limited = data.base.techLimited.includes(code);
  return pools.map(p => h('span', { class: `tag p-${p}` }, p === 'technical' && limited ? 'Technical (max 1)' : POOL_SHORT[p]));
}

function prereqTag(code) {
  const pre = M.course(data, code).prereqs;
  if (!pre.length) return null;
  return h('span', { class: 'tag' }, 'Needs ' + pre.map(M.describeGroup).join(' + '));
}

function renderLibrary() {
  const variant = plan.variant;
  const groups = {};
  for (const code of programCodes(variant)) {
    const c = M.course(data, code);
    if (ui.search && !`${code} ${c.title}`.toLowerCase().includes(ui.search)) continue;
    const pools = primaryPool(variant, code) === 'core' ? ['core'] : M.poolsFor(data, variant, code);
    if (ui.pool !== 'all' && !pools.includes(ui.pool)) continue;
    (groups[primaryPool(variant, code)] ||= []).push(code);
  }
  renderTargetSelect();
  const s = M.requirementSummary(data, plan);
  const lib = POOL_ORDER.filter(p => groups[p]).map(p => {
    const g = s.groups.find(x => x.key === p);
    return h('section', { class: 'lib-group' },
      h('h3', {}, h('span', {}, p === 'core' ? 'Core (required)' : `${M.POOLS[p]} · choose 2`), h('span', {}, `${g.have}/${g.need}`)),
      h('div', { class: 'cards' }, ...groups[p].map(libraryCard)));
  });
  $('#library').replaceChildren(...(lib.length ? lib : [h('p', { class: 'muted small' }, 'No courses match.')]));
}

// Library filter: pick a term and the library dims courses that can't go there.
function renderTargetSelect() {
  if (ui.target !== null && ui.target >= plan.terms.length) ui.target = null;
  const sel = $('#target-term');
  sel.replaceChildren(
    h('option', { value: '', selected: ui.target === null }, 'Any term'),
    ...plan.terms.map((t, i) => h('option', { value: String(i), selected: ui.target === i }, M.termLabel(t.id))));
  document.querySelectorAll('.term[data-index]').forEach(col => col.classList.toggle('targeted', Number(col.dataset.index) === ui.target));
}

function setTarget(index) {
  ui.target = index;
  renderLibrary();
}

// Availability of an unplaced course for the target term: null when no target is set.
function targetFit(code) {
  if (ui.target === null) return null;
  const r = M.tryMove(data, plan, code, ui.target);
  return r.ok ? { ok: true, unconfirmed: !M.offering(data, code, plan.terms[ui.target].id) } : { ok: false, why: r.short[0] };
}

function libraryCard(code) {
  const c = M.course(data, code);
  const at = where(code);
  const fit = at ? null : targetFit(code);
  const placedTag = at?.completed ? h('span', { class: 'tag ok' }, 'Completed')
    : at ? h('span', { class: 'tag ok' }, `Planned: ${M.termLabel(at.term)}`) : null;
  const fitTag = !fit ? null
    : !fit.ok ? h('span', { class: 'tag bad' }, fit.why)
    : fit.unconfirmed ? h('span', { class: 'tag warn' }, 'Unconfirmed this term') : null;
  const card = h('div', {
    class: `card p-${primaryPool(plan.variant, code)} ${at ? 'is-placed' : ''} ${fit && !fit.ok ? 'unavailable' : ''}`,
    tabindex: '0', role: 'button', draggable: at ? 'false' : 'true',
    'aria-label': `${code} ${c.title}, ${c.credits} credits${at ? ', already in plan' : ''}`,
    onclick: () => openCourse(code),
    onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCourse(code); } },
  },
  h('div', { class: 'top' }, h('span', { class: 'code' }, code), h('span', { class: 'cr' }, `${c.credits} cr`)),
  h('div', { class: 'title' }, c.title),
  h('div', { class: 'meta' }, ...poolTags(code), prereqTag(code), placedTag, fitTag));
  if (!at) wireDrag(card, code, 'library');
  return card;
}

function renderBoard() {
  const s = M.requirementSummary(data, plan);
  const cols = [];
  if (plan.completed.length) {
    const cr = plan.completed.filter(c => c in data.base.courses).reduce((a, c) => a + M.course(data, c).credits, 0);
    cols.push(h('section', { class: 'term completed', 'aria-label': 'Completed courses' },
      h('header', {}, h('h3', {}, 'Already completed'), h('span', { class: 'cr' }, `${cr} cr`)),
      ...plan.completed.map(code => code in data.base.courses
        ? h('div', { class: `card p-${s.assignment[code] || 'extra'}` },
          h('div', { class: 'top' }, h('span', { class: 'code' }, code), h('span', { class: 'cr' }, `${M.course(data, code).credits} cr`)),
          h('div', { class: 'title' }, M.course(data, code).title),
          h('div', { class: 'meta' }, countsTag(s.assignment[code])))
        : h('div', { class: 'card p-extra' }, h('div', { class: 'top' }, h('span', { class: 'code' }, code)), h('div', { class: 'title muted' }, data.base.external[code])))));
  }
  plan.terms.forEach((t, i) => {
    const cr = t.courses.reduce((a, c) => a + M.course(data, c).credits, 0);
    const col = h('section', { class: `term ${ui.target === i ? 'targeted' : ''}`, 'data-index': String(i), 'aria-label': M.termLabel(t.id) },
      h('header', { class: 'targetable', title: 'Show which courses fit this term', onclick: () => setTarget(ui.target === i ? null : i) }, h('h3', {}, M.termLabel(t.id)), h('span', { class: 'cr' }, `${M.isSummer(t.id) ? 'optional · ' : ''}${t.courses.length} course${t.courses.length === 1 ? '' : 's'} · ${cr} cr`)),
      t.courses.length > M.RECOMMENDED_PER_TERM ? h('div', { class: 'busy' }, `More than ${M.RECOMMENDED_PER_TERM} courses is not recommended`) : null,
      ...t.courses.map(code => termCard(code, i, s)),
      t.courses.length ? null : h('div', { class: 'empty' }, M.isSummer(t.id)
        ? 'Summer is optional. Drop courses here or leave it empty.'
        : 'Drop courses here, or click a course to choose this term.'));
    wireDrop(col, i);
    cols.push(col);
  });
  $('#board').replaceChildren(...cols);
  $('#remove-term').disabled = plan.terms.length <= 1 || plan.terms[plan.terms.length - 1].courses.length > 0;
}

function countsTag(kind) {
  if (!kind) return null;
  return kind === 'extra'
    ? h('span', { class: 'tag warn' }, 'Does not count toward a requirement')
    : h('span', { class: `tag p-${kind}` }, `Counts: ${POOL_SHORT[kind]}`);
}

function formatTag(code, term) {
  const off = M.offering(data, code, term);
  if (!off) return h('span', { class: 'tag warn', title: 'No schedule data for this term' }, 'Unconfirmed');
  if (!off.formats.length) return h('span', { class: 'tag bad' }, 'Not offered');
  const allowed = M.VARIANTS[plan.variant].formats;
  const usable = off.formats.filter(f => allowed.includes(f));
  return h('span', { class: `tag ${usable.length ? '' : 'bad'}`, title: M.offeringNote(off, term) }, off.formats.join(' · '));
}

function termCard(code, index, s) {
  const c = M.course(data, code);
  const term = plan.terms[index].id;
  const card = h('div', {
    class: `card p-${s.assignment[code] || 'extra'}`, draggable: 'true', tabindex: '0', role: 'button',
    'aria-label': `${code} ${c.title} in ${M.termLabel(term)}`,
    onclick: () => openCourse(code),
    onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCourse(code); } if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); applyMove(code, null); } },
  },
  h('button', { class: 'remove', type: 'button', 'aria-label': `Remove ${code}`, title: 'Remove from plan', onclick: e => { e.stopPropagation(); applyMove(code, null); } }, '×'),
  h('div', { class: 'top' }, h('span', { class: 'code' }, code), h('span', { class: 'cr' }, `${c.credits} cr`)),
  h('div', { class: 'title' }, c.title),
  h('div', { class: 'meta' }, countsTag(s.assignment[code]), formatTag(code, term)));
  wireDrag(card, code, index);
  return card;
}

function renderNotes() {
  const hard = M.hardViolations(data, plan).map(v => h('div', { class: 'note bad' }, '✕ ', v.message));
  const soft = M.warnings(data, plan).map(v => h('div', { class: 'note warn' }, '! ', v.message));
  const none = h('div', { class: 'note ok' }, M.plannedCodes(plan).length
    ? '✓ No problems or warnings in this plan so far.'
    : 'Add courses to your terms and any problems or advice will appear here.');
  $('#notes').replaceChildren(...(hard.length || soft.length ? [...hard, ...soft] : [none]));
}

// ---------- moves ----------
function applyMove(code, to) {
  const r = M.tryMove(data, plan, code, to);
  if (!r.ok) { toast(`Can't ${to === null ? 'remove' : 'place'} ${code}`, r.reasons); return false; }
  plan = r.plan;
  renderPlanner();
  return true;
}

function addTerm() {
  if (plan.terms.length >= 15) return toast('That is the longest plan the simulator supports.');
  plan.terms.push({ id: M.nextTerm(plan.terms[plan.terms.length - 1].id), courses: [] });
  renderPlanner();
}

function removeTerm() {
  const last = plan.terms[plan.terms.length - 1];
  if (plan.terms.length <= 1 || last.courses.length) return;
  plan.terms.pop();
  renderPlanner();
}

// ---------- drag and drop ----------
function wireDrag(card, code, from) {
  card.addEventListener('dragstart', e => {
    const allowed = new Map();
    plan.terms.forEach((_, i) => { if (i !== from) allowed.set(i, M.tryMove(data, plan, code, i).reasons); });
    if (from !== 'library') allowed.set('library', M.tryMove(data, plan, code, null).reasons);
    drag = { code, from, allowed };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', code);
    card.classList.add('dragging');
    document.querySelectorAll('.term[data-index]').forEach(col => {
      const i = Number(col.dataset.index);
      if (i === from) return;
      const reasons = allowed.get(i);
      col.classList.add(reasons.length ? 'no-drop' : 'can-drop');
      if (reasons.length) col.title = reasons.join('\n');
    });
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    document.querySelectorAll('.term').forEach(col => { col.classList.remove('can-drop', 'no-drop', 'over'); col.removeAttribute('title'); });
    drag = null;
  });
}

function wireDrop(col, index) {
  col.addEventListener('dragover', e => {
    if (!drag || drag.from === index) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = drag.allowed.get(index)?.length ? 'none' : 'move';
    col.classList.add('over');
  });
  col.addEventListener('dragleave', () => col.classList.remove('over'));
  col.addEventListener('drop', e => {
    e.preventDefault();
    if (!drag || drag.from === index) return;
    const reasons = drag.allowed.get(index);
    if (reasons?.length) toast(`Can't place ${drag.code} in ${M.termLabel(plan.terms[index].id)}`, reasons);
    else applyMove(drag.code, index);
  });
}

function setupLibraryDropZone() {
  const lib = document.querySelector('.library');
  lib.addEventListener('dragover', e => { if (drag && drag.from !== 'library') e.preventDefault(); });
  lib.addEventListener('drop', e => {
    e.preventDefault();
    if (!drag || drag.from === 'library') return;
    const reasons = drag.allowed.get('library');
    if (reasons?.length) toast(`Can't remove ${drag.code}`, reasons);
    else applyMove(drag.code, null);
  });
}

// ---------- course dialog (click / keyboard alternative to drag) ----------
function openCourse(code) {
  const c = M.course(data, code);
  const at = where(code);
  const dlg = $('#course-dialog');
  const close = () => dlg.close();
  const termButtons = at?.completed ? [] : plan.terms.map((t, i) => {
    if (at && at.index === i) return h('button', { class: 'btn term-choice', type: 'button', disabled: true }, h('span', {}, M.termLabel(t.id)), h('span', { class: 'why' }, 'Currently here'));
    const r = M.tryMove(data, plan, code, i);
    const off = M.offering(data, code, t.id);
    const info = r.ok ? (off ? `${off.formats.join(' · ')}` : 'No schedule data — confirm before registering') : r.reasons[0];
    return h('button', { class: 'btn term-choice', type: 'button', disabled: !r.ok, onclick: () => { if (applyMove(code, i)) close(); } },
      h('span', {}, M.termLabel(t.id), ` · ${t.courses.length} planned`), h('span', { class: 'why' }, info));
  });
  const pre = c.prereqs.length ? c.prereqs.map(M.describeGroup).join('; and ') : 'None';
  $('#course-dialog-body').replaceChildren(
    h('div', {}, h('h2', {}, `${code} · ${c.title}`), h('p', { class: 'muted small' }, `${c.credits} credits · Prerequisites: ${pre}`)),
    h('div', { class: 'meta' }, ...poolTags(code)),
    h('p', { class: 'small' }, c.description),
    at?.completed ? h('p', { class: 'small' }, 'You marked this course as completed. Change that under Edit setup.')
      : h('div', {}, h('h3', {}, at ? 'Move to' : 'Add to'),
        h('p', { class: 'muted small' }, 'Choose a term. Greyed-out terms show why the course can’t go there. The formats listed are those offered that term.'),
        h('div', { class: 'term-choices' }, ...termButtons)),
    h('div', { class: 'row' },
      at && !at.completed ? h('button', { class: 'btn', type: 'button', onclick: () => { if (applyMove(code, null)) close(); } }, 'Remove from plan') : null,
      h('button', { class: 'btn primary', type: 'button', onclick: close }, 'Close')));
  dlg.showModal();
}

// ---------- toast ----------
let toastTimer;
function toast(title, reasons = []) {
  const t = $('#toast');
  t.replaceChildren(h('b', {}, title), reasons.length ? h('ul', {}, ...reasons.map(r => h('li', {}, r))) : null);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
}

// ---------- print ----------
function renderPrint() {
  const s = M.requirementSummary(data, plan);
  const v = M.VARIANTS[plan.variant];
  const row = code => {
    const c = M.course(data, code);
    const kind = s.assignment[code];
    return h('tr', {}, h('td', {}, code), h('td', {}, c.title), h('td', {}, String(c.credits)), h('td', {}, kind === 'extra' ? 'Additional' : POOL_SHORT[kind] || ''));
  };
  const head = h('tr', {}, h('th', {}, 'Course'), h('th', {}, 'Title'), h('th', {}, 'Cr'), h('th', {}, 'Counts toward'));
  const body = [];
  const done = plan.completed.filter(c => c in data.base.courses);
  if (done.length) {
    body.push(h('tr', { class: 'term-row' }, h('th', { colspan: '4' }, 'Already completed')), ...done.map(row));
  }
  for (const t of plan.terms) {
    if (!t.courses.length) continue;
    const cr = t.courses.reduce((a, c) => a + M.course(data, c).credits, 0);
    body.push(h('tr', { class: 'term-row' }, h('th', { colspan: '4' }, `${M.termLabel(t.id)} · ${cr} credits`)), ...t.courses.map(row));
  }
  const hard = M.hardViolations(data, plan);
  const soft = M.warnings(data, plan);
  const external = plan.completed.filter(c => c in data.base.external);
  $('#print-view').replaceChildren(...[
    h('h1', {}, 'MS in Health Informatics · Planned Program of Study'),
    h('p', { class: 'sub' }, [student.name || 'Student', v.label, 'No concentration', `Generated ${new Date().toLocaleDateString()}`].join(' · ')),
    h('table', {}, h('thead', {}, head), h('tbody', {}, ...body)),
    h('h2', {}, 'Requirements'),
    h('table', {}, h('tbody', {},
      ...s.groups.map(g => h('tr', {}, h('td', {}, g.label), h('td', {}, `${g.have} of ${g.need}`), h('td', {}, g.courses.join(', ') || '—'))),
      h('tr', {}, h('td', {}, 'Credits'), h('td', {}, `${s.credits}`), h('td', {}, `Minimum ${M.MIN_CREDITS} required`)))),
    h('p', {}, h('b', {}, s.complete ? 'This plan meets the degree requirements.' : 'This plan does not yet meet all degree requirements.')),
    external.length ? h('p', {}, 'Other prior coursework: ', external.join(', ')) : null,
    hard.length || soft.length ? h('div', {}, h('h2', {}, 'Notes'), h('ul', {}, ...hard.map(x => h('li', {}, x.message)), ...soft.map(x => h('li', {}, x.message)))) : null,
    h('div', { class: 'sig' }, h('div', {}, 'Student signature / date'), h('div', {}, 'Advisor signature / date')),
    h('p', { class: 'fine' }, 'Planning aid only, not a registration. Offerings for future terms are projected from past schedules and may change. Confirm your plan of study, delivery format, and prerequisites with your academic advisor. A grade of B– or higher is required in each course and a minimum 3.000 cumulative GPA.'),
  ].filter(Boolean));
}

boot();
