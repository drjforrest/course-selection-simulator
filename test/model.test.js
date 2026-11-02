import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as M from '../public/js/model.js';

const base = JSON.parse(fs.readFileSync(new URL('../data/base.json', import.meta.url)));
const data = { base, overrides: { terms: {}, courses: {} } };
const plan = (terms, extra = {}) => ({
  variant: 'boston', completed: [], semestersDone: 0,
  terms: terms.map((courses, i) => ({ id: M.termRange('2027-SP', terms.length)[i], courses })),
  ...extra,
});

test('offerings default to the most recent same-season term', () => {
  assert.deepEqual(M.offering(data, 'HINF 6355', '2028-SP').formats, ['hybrid', 'on-ground']);
  assert.equal(M.offering(data, 'HINF 6355', '2027-SP').from, '2026-SP');
  assert.deepEqual(M.offering(data, 'HINF 6355', '2027-FA').formats, []);
  assert.equal(M.offering(data, 'PHIL 5110', '2027-FA'), null);
});

test('program model sets intake courses unless faculty override', () => {
  assert.equal(M.offering(data, 'HINF 5101', '2027-SP').source, 'program');
  assert.ok(M.offering(data, 'HINF 5101', '2027-SP').formats.includes('online'));
  assert.deepEqual(M.offering(data, 'HINF 5105', '2027-FA').formats, []);
  const d = { base, overrides: { terms: {}, patterns: { 'HINF 5105': { from: '2027-FA', seasons: { SP: ['online'], FA: ['on-ground'] } } }, courses: {} } };
  assert.deepEqual(M.offering(d, 'HINF 5105', '2028-FA').formats, ['on-ground']);
});

test('term exceptions apply to one term only', () => {
  const d = { base, overrides: { terms: { '2027-FA': { 'HINF 5106': ['online'] } }, patterns: {}, courses: {} } };
  assert.equal(M.offering(d, 'HINF 5106', '2027-FA').source, 'term');
  assert.deepEqual(M.offering(d, 'HINF 5106', '2028-FA').formats, []);
});

test('faculty schedule moves a course to new seasons from a starting term', () => {
  const d = { base, overrides: { terms: {}, patterns: { 'HINF 6355': { from: '2027-FA', seasons: { FA: ['online'] } } }, courses: {} } };
  assert.deepEqual(M.offering(d, 'HINF 6355', '2027-SP').formats, ['hybrid', 'on-ground']); // before the start: spreadsheet
  assert.deepEqual(M.offering(d, 'HINF 6355', '2028-SP').formats, []);
  assert.deepEqual(M.offering(d, 'HINF 6355', '2027-FA').formats, ['online']);
  assert.equal(M.offering(d, 'HINF 6355', '2029-FA').source, 'pattern');
  const ex = { ...d, overrides: { ...d.overrides, terms: { '2028-FA': { 'HINF 6355': ['on-ground'] } } } };
  assert.deepEqual(M.offering(ex, 'HINF 6355', '2028-FA').formats, ['on-ground']); // exception beats schedule
});

test('terms compare chronologically', () => {
  assert.ok(M.compareTerms('2027-SU', '2027-FA') < 0);
  assert.ok(M.compareTerms('2027-SP', '2026-FA') > 0);
});

test('prerequisite must be in an earlier term', () => {
  const p = plan([['HINF 5101'], [], []]);
  assert.equal(M.tryMove(data, p, 'HINF 6355', 0).ok, false); // same term as 5101
  // 6355 runs in spring; Spring 2028 is index 3
  const p2 = plan([['HINF 5101'], [], [], []]);
  assert.equal(M.tryMove(data, p2, 'HINF 6355', 3).ok, true);
  const p3 = M.moveCourse(p2, 'HINF 6355', 3);
  assert.equal(M.tryMove(data, p3, 'HINF 5101', null).ok, false); // removing the prereq is blocked
});

test('online students cannot take on-ground-only sections', () => {
  const p = plan([[]], { variant: 'online' });
  // HINF 5105 in Spring 2026 had online + on-ground; HINF 5301 was on-ground only
  assert.equal(M.tryMove(data, p, 'HINF 5105', 0).ok, true);
  assert.equal(M.tryMove(data, p, 'HINF 5301', 0).ok, false);
});

test('capstone needs three prior semesters', () => {
  const p = plan([['HINF 5101'], ['HINF 5407'], [], []]);
  assert.equal(M.tryMove(data, p, 'HINF 7701', 2).ok, false);
  assert.equal(M.tryMove(data, p, 'HINF 7701', 3).ok, false); // only two used terms before it
  assert.equal(M.tryMove(data, { ...p, semestersDone: 1 }, 'HINF 7701', 3).ok, true);
});

test('credit cap of 36 blocks additions', () => {
  const completed = ['HINF 5101', 'HINF 5105', 'HINF 5200', 'HINF 5300', 'HINF 5301', 'DA 5020', 'DA 5030', 'INSH 5301', 'INSH 5302'];
  const p = plan([[]], { completed }); // 3+3+4*7 = 34
  assert.equal(M.totalCredits(data, p), 34);
  assert.equal(M.tryMove(data, p, 'HINF 6201', 0).ok, false); // 34 + 3 > 36
});

test('allocation: one DA/INSH course may fill Technical', () => {
  const completed = ['HINF 5101', 'HINF 5105', 'HINF 7701', 'HINF 6201', 'HINF 6202', 'HINF 5102', 'HINF 5110',
    'HINF 6220', 'DA 5020', 'DA 5030', 'INSH 5301'];
  const s = M.requirementSummary(data, plan([[]], { completed }));
  assert.equal(s.requirementsMet, true);
  const t2 = ['HINF 5101', 'HINF 5105', 'HINF 7701', 'HINF 6201', 'HINF 6202', 'HINF 5102', 'HINF 5110', 'DA 5020', 'DA 5030', 'HINF 6345'];
  assert.equal(M.requirementSummary(data, plan([[]], { completed: t2 })).groups.find(g => g.key === 'technical').have, 1);
});

test('HLTH 5800 pool depends on variant', () => {
  assert.deepEqual(M.poolsFor(data, 'online', 'HLTH 5800'), ['technical']);
  assert.deepEqual(M.poolsFor(data, 'vancouver', 'HLTH 5800'), ['health']);
});

test('warnings: more than 3 per term and gaps', () => {
  const p = plan([['HINF 5101', 'HINF 5105', 'HINF 6201', 'HINF 6202'], [], []]);
  const w = M.warnings(data, p).map(x => x.message).join('\n');
  assert.match(w, /do not recommend more than 3/);
});

test('default placement: first term each core course runs in an allowed format', () => {
  const place = (variant, start) => {
    const p = M.placeDefaults(data, { variant, completed: [], semestersDone: 0, terms: M.termRange(start, 6).map(id => ({ id, courses: [] })) });
    return p.terms.filter(t => t.courses.length).map(t => `${t.id}:${t.courses.join('+')}`).join(' ');
  };
  assert.equal(place('vancouver', '2027-SP'), '2027-SP:HINF 5101+HINF 5106');
  assert.equal(place('vancouver', '2027-FA'), '2027-FA:HINF 5101 2028-SP:HINF 5106');
  assert.equal(place('online', '2027-FA'), '2027-FA:HINF 5101 2028-SP:HINF 5105');
  assert.equal(place('online', '2027-SP'), '2027-SP:HINF 5101+HINF 5105');
  assert.equal(place('boston', '2027-FA'), '2027-FA:HINF 5101 2028-SP:HINF 5105');
});

test('default placement skips completed courses', () => {
  const p = M.placeDefaults(data, { variant: 'online', completed: ['HINF 5101'], semestersDone: 1, terms: [{ id: '2027-SP', courses: [] }] });
  assert.deepEqual(p.terms[0].courses, ['HINF 5105']);
});

test('empty summer is optional; empty fall or spring warns', () => {
  const onlySummerGap = plan([['HINF 5101'], [], ['HINF 6215']]); // Spring, empty Summer, Fall
  assert.doesNotMatch(M.warnings(data, onlySummerGap).map(x => x.message).join('\n'), /semester off/);
  const fallGap = plan([['HINF 5101'], [], [], ['HINF 6215']]); // empty Summer and Fall, then Spring
  const w = M.warnings(data, fallGap).filter(x => /semester off/.test(x.message));
  assert.deepEqual(w.map(x => x.term), ['2027-FA']);
});

import { clientIp } from '../client-ip.js';

test('client IP: trusts CF-Connecting-IP only from Cloudflare', () => {
  assert.equal(clientIp({ 'x-forwarded-for': '162.158.1.2', 'cf-connecting-ip': '203.0.113.9' }, '127.0.0.1'), '203.0.113.9');
  assert.equal(clientIp({ 'x-forwarded-for': '198.51.100.7', 'cf-connecting-ip': '203.0.113.9' }, '127.0.0.1'), '198.51.100.7');
  assert.equal(clientIp({ 'x-forwarded-for': '1.2.3.4, 198.51.100.7' }, '127.0.0.1'), '198.51.100.7');
  assert.equal(clientIp({ 'x-forwarded-for': '2606:4700::1', 'cf-connecting-ip': '2001:db8::5' }, '::1'), '2001:db8::5');
  assert.equal(clientIp({}, '::ffff:127.0.0.1'), '127.0.0.1');
});
