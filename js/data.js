// 처음 열었을 때 들어가는 기본 데이터: 엄마가 보낸 11월 조건과 신청 일자.
// 인원·근무환경·조건은 앱의 설정 화면에서 바꾼다.
(function (g) {
  'use strict';

  const person = (id, name, senior, extra) => Object.assign({
    id, name, senior, allowed: ['D', 'E', 'N'], nMin: null, nMax: null,
    offWeekdays: [], balanceExclude: [], tolerance: 0,
  }, extra || {});

  const config = {
    staff: [
      person('s1', '위*순', true, { allowed: ['D', 'N'], nMin: 1, nMax: 2, balanceExclude: ['E', 'N', 'monD'] }),
      person('s2', '이*영', true),
      person('s3', '이*숙', true),
      person('s4', '오*진', false),
      person('s5', '김*은', false),
      person('s6', '정*원', false),
    ],
    // 요일별 필요 인원 (0=일 ... 6=토). null 이면 쉬는 날.
    demand: {
      0: null,
      1: { D: 3, E: 1, N: 2 },
      2: { D: 3, E: 0, N: 0 },
      3: { D: 3, E: 1, N: 2 },
      4: { D: 2, E: 0, N: 0 },
      5: { D: 3, E: 1, N: 2 },
      6: { D: 3, E: 0, N: 0 },
    },
    // 일할 수 있는 사람이 모자라면 이 순서로 근무를 뺀다 (월수금 5명이면 E 없음).
    dropOrder: ['E'],
    // level: 'hard' 반드시, 'soft' 가능하면, 'off' 끔
    rules: {
      offAfterN: { level: 'hard' },
      maxConsecD: { level: 'hard', max: 2, closedBreaks: true },
      noOffUnlessRequested: { level: 'hard', weekdays: [1, 3, 5] },
      seniorDaily: { level: 'hard', shift: 'D', min: 1 },
      weeklyOff: { level: 'hard', min: 1 },
      avoidConsecOff: { level: 'soft' },
      balance: { level: 'soft' },
    },
    // 한 달 기준으로 가능하면 균등하게 맞출 항목
    balance: [
      { key: 'satOff', label: '토 off', shift: 'O', weekdays: [6], on: true },
      { key: 'E', label: 'E', shift: 'E', weekdays: null, on: true },
      { key: 'N', label: 'N', shift: 'N', weekdays: null, on: true },
      { key: 'monD', label: '월 D', shift: 'D', weekdays: [1], on: true },
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

  g.RosterSeed = { version: 2, config, months, current: '2026-11' };
})(typeof globalThis !== 'undefined' ? globalThis : window);
