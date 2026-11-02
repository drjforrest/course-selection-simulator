// Program rules and schedule resolution. Pure functions shared by the student and faculty pages (and tests).

export const VARIANTS = {
  boston: { label: 'Boston (on-ground)', formats: ['on-ground', 'hybrid', 'online'], systemsCourse: 'HINF 5105' },
  online: { label: 'Online (general)', formats: ['online'], systemsCourse: 'HINF 5105' },
  vancouver: { label: 'Online (Vancouver)', formats: ['online'], systemsCourse: 'HINF 5106' },
};

export const POOLS = {
  business: 'Business Management',
  technical: 'Technical',
  health: 'Health Informatics',
  elective: 'General Electives',
};

export const MIN_CREDITS = 33;
export const MAX_CREDITS = 36;
export const RECOMMENDED_PER_TERM = 3;
export const CAPSTONE = 'HINF 7701';
export const INTRO = 'HINF 5101';
export const CAPSTONE_PRIOR_SEMESTERS = 3;

// ---------- terms ----------
const SEASONS = ['SP', 'SU', 'FA'];
const SEASON_NAMES = { SP: 'Spring', SU: 'Summer', FA: 'Fall' };
const FIRST_HISTORY_YEAR = 2025;

export const termLabel = id => `${SEASON_NAMES[id.slice(5)]} ${id.slice(0, 4)}`;
export const seasonName = season => SEASON_NAMES[season];
export { SEASONS };

// Chronological comparison (term ids don't sort correctly as strings: FA < SP < SU).
const termOrder = id => Number(id.slice(0, 4)) * 3 + SEASONS.indexOf(id.slice(5));
export const compareTerms = (a, b) => termOrder(a) - termOrder(b);

export function nextTerm(id) {
  const y = Number(id.slice(0, 4));
  const i = SEASONS.indexOf(id.slice(5));
  return i === 2 ? `${y + 1}-SP` : `${y}-${SEASONS[i + 1]}`;
}

export function termRange(start, count) {
  const out = [start];
  while (out.length < count) out.push(nextTerm(out[out.length - 1]));
  return out;
}

// The term after the one in progress on `date`: Jan-Apr Spring, May-Aug Summer, Sep-Dec Fall.
export function upcomingTerm(date = new Date()) {
  const m = date.getMonth();
  const current = `${date.getFullYear()}-${m < 4 ? 'SP' : m < 8 ? 'SU' : 'FA'}`;
  return nextTerm(current);
}

export function currentTerm(date = new Date()) {
  const m = date.getMonth();
  return `${date.getFullYear()}-${m < 4 ? 'SP' : m < 8 ? 'SU' : 'FA'}`;
}

// ---------- catalog ----------
export function course(data, code) {
  const c = data.base.courses[code];
  const o = data.overrides.courses[code];
  return o ? { ...c, credits: o.credits, prereqs: o.prereqs } : c;
}

// Listing order: HINF, PHTH, DA, PHIL, then any other department alphabetically; course number within each.
const DEPT_ORDER = ['HINF', 'PHTH', 'DA', 'PHIL'];
const deptRank = code => {
  const i = DEPT_ORDER.indexOf(code.split(' ')[0]);
  return i === -1 ? DEPT_ORDER.length : i;
};
export const compareCodes = (a, b) => deptRank(a) - deptRank(b) || a.localeCompare(b);

export const allCodes = data => Object.keys(data.base.courses).sort(compareCodes);

export function poolsFor(data, variant, code) {
  return data.base.pools[variant][code] || [];
}

function covers(data, term, code) {
  const cov = data.base.coverage[term];
  if (!cov) return false;
  return cov.includes(code) || (code.startsWith('HINF ') && cov.includes('HINF'));
}

// Program model: the intake courses run in these seasons, in every format, and not in other seasons,
// unless faculty say otherwise. It replaces the spreadsheet for these courses.
// There is no summer intake, so HINF 5101 is taken in a student's first Spring or Fall term and the
// healthcare-systems course in their first Spring.
const ALL_FORMATS = ['hybrid', 'on-ground', 'online'];
const PROGRAM_MODEL = {
  'HINF 5101': ['SP', 'FA'],
  'HINF 5105': ['SP'],
  'HINF 5106': ['SP'],
};

// Offering of a course in a term, from the first of:
//   1. a faculty exception for that exact term (one term only);
//   2. the course's faculty schedule (which seasons it runs, from a starting term onward);
//   3. the program model (intake courses);
//   4. the schedule spreadsheet for the same season, most recent year first.
// Returns { formats, source, from } or null when there is no data at all.
export function offering(data, code, term) {
  const own = data.overrides.terms[term]?.[code];
  if (own) return { formats: own, source: 'term', from: term };
  return regularOffering(data, code, term);
}

// The offering without one-term exceptions: what the course normally does in that term.
export function regularOffering(data, code, term) {
  const season = term.slice(5);
  const pattern = data.overrides.patterns?.[code];
  if (pattern && compareTerms(term, pattern.from) >= 0) return { formats: pattern.seasons[season] || [], source: 'pattern', from: pattern.from };
  if (PROGRAM_MODEL[code]) return { formats: PROGRAM_MODEL[code].includes(season) ? ALL_FORMATS : [], source: 'program', from: term };
  for (let y = Number(term.slice(0, 4)); y >= FIRST_HISTORY_YEAR; y--) {
    const t = `${y}-${season}`;
    if (covers(data, t, code)) return { formats: data.base.history[t]?.[code] || [], source: 'schedule', from: t };
  }
  return null;
}

export function offeringNote(off, term) {
  if (!off) return 'No schedule data';
  if (off.source === 'term') return 'Exception for this term only';
  if (off.source === 'pattern') return `Faculty schedule (from ${termLabel(off.from)})`;
  if (off.source === 'program') return 'Program default';
  return off.from === term ? 'From course schedule' : `From course schedule (as in ${termLabel(off.from)})`;
}

// ---------- plan evaluation ----------
// plan = { variant, completed: [codes], semestersDone: n, terms: [{ id, courses: [codes] }] }

export const plannedCodes = plan => plan.terms.flatMap(t => t.courses);

export function totalCredits(data, plan) {
  return [...plan.completed, ...plannedCodes(plan)]
    .filter(c => c in data.base.courses)
    .reduce((s, c) => s + course(data, c).credits, 0);
}

// Index of the term holding `code`: -1 if completed, Infinity if absent.
function position(plan, code) {
  if (plan.completed.includes(code)) return -1;
  const i = plan.terms.findIndex(t => t.courses.includes(code));
  return i === -1 ? Infinity : i;
}

export function missingPrereqs(data, plan, code, termIndex) {
  return course(data, code).prereqs.filter(group => !group.some(p => position(plan, p) < termIndex));
}

export const describeGroup = group => group.join(' or ');

function priorSemesters(plan, termIndex) {
  return plan.semestersDone + plan.terms.slice(0, termIndex).filter(t => t.courses.length).length;
}

// Problems that make a plan invalid. Each: { code, term, message }.
export function hardViolations(data, plan) {
  const out = [];
  const allowed = VARIANTS[plan.variant].formats;
  plan.terms.forEach((t, i) => {
    for (const code of t.courses) {
      const off = offering(data, code, t.id);
      if (off && !off.formats.length) {
        out.push({ code, term: t.id, short: 'Not offered this term', message: `${code} is not offered in ${termLabel(t.id)}.` });
      } else if (off && !off.formats.some(f => allowed.includes(f))) {
        out.push({ code, term: t.id, short: `Only ${off.formats.join('/')} this term`, message: `${code} runs only ${off.formats.join('/')} in ${termLabel(t.id)}, which ${VARIANTS[plan.variant].label} students cannot take.` });
      }
      for (const g of missingPrereqs(data, plan, code, i)) {
        out.push({ code, term: t.id, short: `Needs ${describeGroup(g)} first`, message: `${code} requires ${describeGroup(g)} in an earlier term.` });
      }
      if (code === CAPSTONE && priorSemesters(plan, i) < CAPSTONE_PRIOR_SEMESTERS) {
        out.push({ code, term: t.id, short: `Needs ${CAPSTONE_PRIOR_SEMESTERS} prior semesters`, message: `${CAPSTONE} requires at least ${CAPSTONE_PRIOR_SEMESTERS} prior semesters of graduate study (catalog).` });
      }
    }
  });
  const credits = totalCredits(data, plan);
  if (credits > MAX_CREDITS) out.push({ short: `Over ${MAX_CREDITS} credits`, message: `The program allows at most ${MAX_CREDITS} credits (this plan has ${credits}).` });
  return out;
}

// Advice that does not block the plan.
export function warnings(data, plan) {
  const out = [];
  const used = plan.terms.map(t => t.courses.length > 0);
  const first = used.indexOf(true);
  const last = used.lastIndexOf(true);
  plan.terms.forEach((t, i) => {
    if (t.courses.length > RECOMMENDED_PER_TERM) {
      out.push({ term: t.id, message: `${termLabel(t.id)} has ${t.courses.length} courses. We do not recommend more than ${RECOMMENDED_PER_TERM} per semester.` });
    }
    // Summer is optional; only an empty Fall or Spring inside the plan breaks consecutive enrolment.
    if (i > first && i < last && !t.courses.length && !isSummer(t.id)) {
      out.push({ term: t.id, message: `${termLabel(t.id)} is empty. Fall and Spring terms must be consecutive; a semester off must be requested from the program director as an exception.` });
    }
    for (const code of t.courses) {
      if (!offering(data, code, t.id)) {
        out.push({ code, term: t.id, message: `${code} has no schedule data for ${termLabel(t.id)}. Confirm it runs before registering.` });
      }
    }
  });
  const introAt = position(plan, INTRO);
  if (introAt > 0 && introAt !== Infinity && introAt > first) {
    out.push({ code: INTRO, message: `${INTRO} works best in your first term; later courses assume its vocabulary.` });
  }
  const capAt = position(plan, CAPSTONE);
  if (capAt >= 0 && capAt !== Infinity && capAt < last) {
    out.push({ code: CAPSTONE, message: `${CAPSTONE} is meant for your final term; courses are planned after it.` });
  }
  const all = [...plan.completed, ...plannedCodes(plan)];
  if (all.includes('HINF 6215') && all.includes('EMGT 5220')) {
    out.push({ message: 'HINF 6215 and EMGT 5220 are alternatives; only one counts toward Business Management.' });
  }
  return out;
}

// ---------- requirement allocation ----------
// Assigns each course to at most one requirement slot, maximising filled slots.
// Slots: three core courses plus two in each pool. At most one DA/INSH course may fill a Technical slot.
export function allocate(data, plan) {
  const variant = plan.variant;
  const taken = [...new Set([...plan.completed, ...plannedCodes(plan)])].filter(c => c in data.base.courses);
  const core = [INTRO, VARIANTS[variant].systemsCourse, CAPSTONE];
  const slots = [
    ...core.map(c => ({ kind: 'core', course: c })),
    ...Object.keys(POOLS).flatMap(p => [{ kind: p }, { kind: p }]),
  ];
  const limited = data.base.techLimited.filter(c => taken.includes(c));
  const skipEmgt = taken.includes('HINF 6215') && taken.includes('EMGT 5220');

  let best = null;
  for (const techPick of [null, ...limited]) {
    const fits = (code, slot) => {
      if (slot.kind === 'core') return slot.course === code;
      if (core.includes(code)) return false;
      if (skipEmgt && code === 'EMGT 5220') return false;
      if (slot.kind === 'technical' && limited.includes(code) && code !== techPick) return false;
      return poolsFor(data, variant, code).includes(slot.kind);
    };
    const match = bipartite(taken, slots, fits);
    if (!best || match.size > best.size) best = match;
  }

  const bySlot = slots.map((s, i) => ({ ...s, filledBy: [...best].find(([, si]) => si === i)?.[0] || null }));
  const assignment = Object.fromEntries(taken.map(c => [c, best.has(c) ? slots[best.get(c)].kind : 'extra']));
  return { slots: bySlot, assignment };
}

// Kuhn's augmenting-path matching. Returns Map(code -> slot index).
function bipartite(codes, slots, fits) {
  const slotOwner = new Array(slots.length).fill(null);
  const tryAssign = (code, seen) => {
    for (let i = 0; i < slots.length; i++) {
      if (seen.has(i) || !fits(code, slots[i])) continue;
      seen.add(i);
      if (slotOwner[i] === null || tryAssign(slotOwner[i], seen)) {
        slotOwner[i] = code;
        return true;
      }
    }
    return false;
  };
  // Courses with fewer options go first so flexible courses don't crowd them out.
  const order = [...codes].sort((a, b) => slots.filter(s => fits(a, s)).length - slots.filter(s => fits(b, s)).length);
  for (const c of order) tryAssign(c, new Set());
  const m = new Map();
  slotOwner.forEach((c, i) => { if (c) m.set(c, i); });
  return m;
}

export function requirementSummary(data, plan) {
  const { slots, assignment } = allocate(data, plan);
  const groups = [
    { key: 'core', label: 'Core', need: 3 },
    ...Object.entries(POOLS).map(([key, label]) => ({ key, label, need: 2 })),
  ].map(g => {
    const s = slots.filter(x => x.kind === g.key);
    return { ...g, have: s.filter(x => x.filledBy).length, courses: s.map(x => x.filledBy).filter(Boolean), missing: g.key === 'core' ? s.filter(x => !x.filledBy).map(x => x.course) : [] };
  });
  const credits = totalCredits(data, plan);
  const requirementsMet = groups.every(g => g.have >= g.need);
  return {
    groups,
    assignment,
    credits,
    requirementsMet,
    creditsOk: credits >= MIN_CREDITS && credits <= MAX_CREDITS,
    complete: requirementsMet && credits >= MIN_CREDITS && credits <= MAX_CREDITS && hardViolations(data, plan).length === 0,
  };
}

// Default starting courses: HINF 5101 and the healthcare-systems course each go in the first planned term
// where they run in a format the student can take (Spring start: both in term 1; Fall start: 5101 in Fall,
// 5105/5106 in Spring). Skips courses already completed or on the board; students can move them afterwards.
export function placeDefaults(data, plan) {
  let next = plan;
  for (const code of [INTRO, VARIANTS[plan.variant].systemsCourse]) {
    if (next.completed.includes(code) || plannedCodes(next).includes(code)) continue;
    const i = next.terms.findIndex((t, idx) => offering(data, code, t.id) && tryMove(data, next, code, idx).ok);
    if (i !== -1) next = moveCourse(next, code, i);
  }
  return next;
}

// Summer is optional and never a starting term.
export const isSummer = id => id.slice(5) === 'SU';

// Returns the plan with `code` moved to term index `to` (or removed when to === null).
export function moveCourse(plan, code, to) {
  const terms = plan.terms.map(t => ({ ...t, courses: t.courses.filter(c => c !== code) }));
  if (to !== null) terms[to].courses.push(code);
  return { ...plan, terms };
}

// Try a move; returns { ok, plan, reasons, short } where reasons (and short labels) are the new hard
// violations it would cause.
export function tryMove(data, plan, code, to) {
  const next = moveCourse(plan, code, to);
  const before = new Set(hardViolations(data, plan).map(v => v.message));
  const added = hardViolations(data, next).filter(v => !before.has(v.message));
  const reasons = added.map(v => v.message);
  const short = added.map(v => v.short);
  return reasons.length ? { ok: false, plan, reasons, short } : { ok: true, plan: next, reasons: [], short: [] };
}
