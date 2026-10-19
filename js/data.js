// 처음 열었을 때 들어가는 기본 데이터: 엄마가 보낸 11월 조건과 신청 일자.
(function (g) {
  'use strict';

  const config = {
    staff: [
      { id: 's1', name: '위*순', senior: true, allowed: ['D', 'N'], nMin: 1, nMax: 2, balanceExclude: ['E', 'N', 'monD'] },
      { id: 's2', name: '이*영', senior: true, allowed: ['D', 'E', 'N'] },
      { id: 's3', name: '이*숙', senior: true, allowed: ['D', 'E', 'N'] },
      { id: 's4', name: '오*진', senior: false, allowed: ['D', 'E', 'N'] },
      { id: 's5', name: '김*은', senior: false, allowed: ['D', 'E', 'N'] },
      { id: 's6', name: '정*원', senior: false, allowed: ['D', 'E', 'N'] },
    ],
    // 요일별 필요 인원 (0=일 ... 6=토). null 이면 쉬는 날.
    demand: {
      0: null,
      1: { D: 3, E: 1, N: 2 },
      2: { D: 3 },
      3: { D: 3, E: 1, N: 2 },
      4: { D: 2 },
      5: { D: 3, E: 1, N: 2 },
      6: { D: 3 },
    },
    // 일할 수 있는 사람이 모자라면 이 순서로 근무를 뺀다 (월수금 5명이면 E 없음).
    dropOrder: ['E'],
    rules: {
      offAfterN: { on: true, level: 'hard' },
      maxConsecD: { on: true, level: 'hard', max: 2, closedBreaks: true },
      noOffUnlessRequested: { on: true, level: 'hard', weekdays: [1, 3, 5] },
      seniorDaily: { on: true, level: 'hard', shift: 'D', min: 1 },
      weeklyOff: { on: true, level: 'hard', min: 1 },
      avoidConsecOff: { on: true, level: 'soft' },
      balance: { on: true, level: 'soft' },
    },
    // 한 달 기준으로 가능하면 균등하게 맞출 항목
    balance: [
      { key: 'satOff', label: '토 off', shift: 'O', weekdays: [6] },
      { key: 'E', label: 'E', shift: 'E', weekdays: null },
      { key: 'N', label: 'N', shift: 'N', weekdays: null },
      { key: 'monD', label: '월 D', shift: 'D', weekdays: [1] },
    ],
  };

  const months = {
    '2026-11': {
      fixed: {
        s1: { 7: 'O', 14: 'O' },
        s2: { 4: 'N', 11: 'N', 23: 'N' },
        s3: { 4: 'O', 5: 'O' },
        s4: { 5: 'O', 24: 'O' },
        s5: { 2: 'O' },
      },
      auto: {},
      notes: {},
      leave: {},
      holidays: [],
    },
  };

  g.RosterSeed = { version: 1, config, months, current: '2026-11' };
})(typeof globalThis !== 'undefined' ? globalThis : window);
