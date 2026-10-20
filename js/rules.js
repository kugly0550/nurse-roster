// 달력 계산, 규칙 검사기, 근무표 생성 모델(HiGHS LP 형식).
// 검사기와 생성 모델은 같은 규칙을 따로 구현한다. 화면에 보이는 위반 목록은 항상 검사기 결과다.
// 규칙 단계: 'hard' 반드시(사람별 허용 오차 안에서만 어길 수 있음), 'soft' 가능하면, 'off' 끔.
(function (g) {
  'use strict';

  const YO = '일월화수목금토';
  const LABEL = { D: 'D', E: 'E', N: 'N', O: 'off' };
  const WEIGHT = { coverage: 5000, hard: 1000, soft: 4, balance: 10 };

  // ---------- 달력 ----------
  function parseYm(ym) {
    const [y, m] = ym.split('-').map(Number);
    return { y, m };
  }
  function ymKey(y, m) {
    return y + '-' + String(m).padStart(2, '0');
  }
  function shiftYm(ym, delta) {
    let { y, m } = parseYm(ym);
    m += delta;
    while (m < 1) { m += 12; y--; }
    while (m > 12) { m -= 12; y++; }
    return ymKey(y, m);
  }
  function daysIn(ym) {
    const { y, m } = parseYm(ym);
    return new Date(y, m, 0).getDate();
  }
  function weekday(ym, d) {
    const { y, m } = parseYm(ym);
    return new Date(y, m - 1, d).getDay();
  }
  function emptyMonth() {
    return { fixed: {}, auto: {}, notes: {}, leave: {}, holidays: [] };
  }
  function dayLabel(ym, d) {
    return `${parseYm(ym).m}/${d}(${YO[weekday(ym, d)]})`;
  }

  function isOn(rule) {
    return !!rule && rule.level !== 'off';
  }
  function unavail(s, w) {
    return (s.offWeekdays || []).includes(w);
  }
  function workingDay(cfg, w) {
    const dm = cfg.demand[w];
    return !!dm && (dm.D || 0) + (dm.E || 0) + (dm.N || 0) > 0;
  }

  // 저장된 데이터를 지금 구조로 맞춘다 (예전 형식, 빠진 값 채우기).
  function normalize(store) {
    const cfg = store.config;
    for (const s of cfg.staff) {
      if (!Array.isArray(s.allowed)) s.allowed = ['D', 'E', 'N'];
      if (!Array.isArray(s.offWeekdays)) s.offWeekdays = [];
      if (!Array.isArray(s.balanceExclude)) s.balanceExclude = [];
      if (typeof s.tolerance !== 'number' || !(s.tolerance >= 0)) s.tolerance = 0;
      if (s.nMin === undefined || s.nMin === '') s.nMin = null;
      if (s.nMax === undefined || s.nMax === '') s.nMax = null;
      s.senior = !!s.senior;
    }
    for (let w = 0; w < 7; w++) {
      const dm = cfg.demand[w];
      if (dm) cfg.demand[w] = { D: dm.D || 0, E: dm.E || 0, N: dm.N || 0 };
      else cfg.demand[w] = null;
    }
    for (const k of Object.keys(cfg.rules)) {
      const r = cfg.rules[k];
      if (r.on === false) r.level = 'off';
      delete r.on;
      if (!r.level) r.level = 'hard';
    }
    if (cfg.rules.balance.level === 'hard') cfg.rules.balance.level = 'soft';
    // 이미 저장된 설정에도 새 균등 항목을 추가한다. 사용자가 꺼 둔 값은 유지한다.
    if (!Array.isArray(cfg.balance)) cfg.balance = [];
    if (!cfg.balance.some((c) => c.key === 'O')) {
      cfg.balance.unshift({ key: 'O', label: '전체 off', shift: 'O', weekdays: null, on: true });
    }
    for (const c of cfg.balance) if (c.on === undefined) c.on = true;
    cfg.dropOrder = (cfg.dropOrder || []).filter((k) => ['D', 'E', 'N'].includes(k));
    store.exportOptions = store.exportOptions || { holidayRed: false };
    for (const ym of Object.keys(store.months)) {
      const m = store.months[ym];
      m.fixed = m.fixed || {};
      m.auto = m.auto || {};
      m.notes = m.notes || {};
      m.leave = m.leave || {};
      m.holidays = m.holidays || [];
    }
    return store;
  }

  function monthDays(cfg, ym, month) {
    const out = [];
    const L = daysIn(ym);
    for (let d = 1; d <= L; d++) {
      const w = weekday(ym, d);
      const closed = !workingDay(cfg, w) || (month.holidays || []).includes(d);
      out.push({ d, w, t: d, closed, holiday: (month.holidays || []).includes(d) });
    }
    return out;
  }

  function cellOf(month, pid, d) {
    const f = month.fixed[pid] && month.fixed[pid][d];
    if (f) return { v: f, fixed: true };
    const a = month.auto[pid] && month.auto[pid][d];
    return { v: a || '', fixed: false };
  }

  // 지난달 마지막 3일. 이번 달 1일의 'N 다음날 off', 'D 연속' 판단에 쓴다.
  function prevTail(cfg, store, ym) {
    const pym = shiftYm(ym, -1);
    const pm = store.months[pym];
    if (!pm) return [];
    const L = daysIn(pym);
    const days = monthDays(cfg, pym, pm);
    const out = [];
    for (let d = Math.max(1, L - 2); d <= L; d++) {
      const day = days[d - 1];
      const cells = {};
      for (const s of cfg.staff) cells[s.id] = day.closed ? '' : cellOf(pm, s.id, d).v;
      out.push({ d, w: day.w, t: d - L, closed: day.closed, cells, ym: pym });
    }
    return out;
  }

  // 그날 필요한 인원. 신청 off·근무 안 하는 요일 등으로 일할 사람이 모자라면 dropOrder 순서로 뺀다.
  function needFor(cfg, month, day, tail) {
    if (day.closed) return null;
    const base = cfg.demand[day.w];
    const need = { D: base.D || 0, E: base.E || 0, N: base.N || 0 };
    let unavailable = 0;
    for (const s of cfg.staff) {
      const f = month.fixed[s.id] && month.fixed[s.id][day.d];
      if (f === 'O') { unavailable++; continue; }
      if (f) continue;
      if (unavail(s, day.w)) { unavailable++; continue; }
      if (isOn(cfg.rules.offAfterN) && cfg.rules.offAfterN.level === 'hard') {
        const prevN = day.d > 1
          ? month.fixed[s.id] && month.fixed[s.id][day.d - 1] === 'N'
          : tail.length && tail[tail.length - 1].cells[s.id] === 'N';
        if (prevN) unavailable++;
      }
    }
    const avail = cfg.staff.length - unavailable;
    let total = need.D + need.E + need.N;
    for (const s of cfg.dropOrder || []) {
      while (total > avail && need[s] > 0) { need[s]--; total--; }
    }
    return need;
  }

  function fullWeeks(ym) {
    const L = daysIn(ym);
    const weeks = [];
    for (let d = 1; d + 6 <= L; d++) {
      if (weekday(ym, d) === 0) weeks.push([d, d + 6]);
    }
    return weeks;
  }

  function balanceCats(cfg) {
    return isOn(cfg.rules.balance) ? cfg.balance.filter((c) => c.on) : [];
  }
  function staffInBalance(cfg, key) {
    return cfg.staff.filter((s) => !(s.balanceExclude || []).includes(key));
  }

  function countFor(cfg, ym, month, pid, cat) {
    let c = 0;
    for (const day of monthDays(cfg, ym, month)) {
      if (day.closed) continue;
      if (cat.weekdays && !cat.weekdays.includes(day.w)) continue;
      if (cellOf(month, pid, day.d).v === cat.shift) c++;
    }
    return c;
  }

  // ---------- 검사기 ----------
  // 위반마다 pid(사람 탓이면 그 사람)와 days(오차 일수)를 붙인다. 허용 오차는 사람별 days 합으로 따진다.
  function check(cfg, store, ym) {
    const month = store.months[ym];
    const R = cfg.rules;
    const days = monthDays(cfg, ym, month);
    const tail = prevTail(cfg, store, ym);
    const staff = cfg.staff;
    const out = [];
    const add = (rule, level, msg, cells, pid, n) =>
      out.push({ rule, level, msg, cells: cells || [], pid: pid || null, days: n || 1 });

    let empty = 0;
    let filled = 0;
    for (const day of days) {
      if (day.closed) continue;
      for (const s of staff) (cellOf(month, s.id, day.d).v ? filled++ : empty++);
    }
    const complete = empty === 0 && filled > 0;

    // 근무 인원, 매일 선임
    for (const day of days) {
      if (day.closed) continue;
      const need = needFor(cfg, month, day, tail);
      const cnt = { D: 0, E: 0, N: 0, O: 0 };
      let dayEmpty = false;
      for (const s of staff) {
        const v = cellOf(month, s.id, day.d).v;
        if (!v) dayEmpty = true;
        else cnt[v]++;
      }
      if (dayEmpty) continue;
      const parts = [];
      let n = 0;
      for (const k of ['D', 'E', 'N']) {
        if (cnt[k] < need[k]) { parts.push(`${k} ${need[k] - cnt[k]}명 부족`); n += need[k] - cnt[k]; }
        if (cnt[k] > need[k]) { parts.push(`${k} ${cnt[k] - need[k]}명 많음`); n += cnt[k] - need[k]; }
      }
      if (parts.length) {
        add('coverage', 'hard', `${dayLabel(ym, day.d)} ${parts.join(', ')}`, staff.map((s) => [s.id, day.d]), null, n);
      }
      if (isOn(R.seniorDaily) && need[R.seniorDaily.shift] > 0) {
        const seniors = staff.filter((s) => s.senior);
        const c = seniors.filter((s) => cellOf(month, s.id, day.d).v === R.seniorDaily.shift).length;
        if (seniors.length && c < R.seniorDaily.min) {
          add('seniorDaily', R.seniorDaily.level,
            `${dayLabel(ym, day.d)} ${seniors.map((s) => s.name).join('·')} 중 ${R.seniorDaily.shift} 근무자가 ${R.seniorDaily.min > 1 ? R.seniorDaily.min + '명이 안 됨' : '없음'}`,
            seniors.map((s) => [s.id, day.d]), null, R.seniorDaily.min - c);
        }
      }
    }

    for (const s of staff) {
      const nm = s.name;
      for (const day of days) {
        if (day.closed) continue;
        const c = cellOf(month, s.id, day.d);
        // 신청 아닌 off
        if (isOn(R.noOffUnlessRequested) && R.noOffUnlessRequested.weekdays.includes(day.w) &&
            c.v === 'O' && !c.fixed && !unavail(s, day.w)) {
          add('noOffUnlessRequested', R.noOffUnlessRequested.level,
            `${dayLabel(ym, day.d)} ${nm}: 신청하지 않은 off`, [[s.id, day.d]], s.id);
        }
        if (c.v && c.v !== 'O') {
          if (!s.allowed.includes(c.v)) {
            add('allowed', 'hard', `${dayLabel(ym, day.d)} ${nm}: ${c.v} 근무를 하지 않는 사람`, [[s.id, day.d]], s.id);
          }
          if (unavail(s, day.w)) {
            add('unavailDay', 'hard', `${dayLabel(ym, day.d)} ${nm}: 근무 안 하는 요일(${YO[day.w]})인데 ${c.v} 근무`, [[s.id, day.d]], s.id);
          }
        }
      }
      // N 다음날 off
      if (isOn(R.offAfterN)) {
        const seq = tail.map((t) => ({ t: t.t, d: t.d, closed: t.closed, v: t.cells[s.id], inMonth: false }))
          .concat(days.map((day) => ({ t: day.t, d: day.d, closed: day.closed, v: day.closed ? '' : cellOf(month, s.id, day.d).v, inMonth: true })));
        for (let i = 0; i + 1 < seq.length; i++) {
          const a = seq[i];
          const b = seq[i + 1];
          if (a.closed || b.closed || a.v !== 'N' || !b.v || b.v === 'O' || b.t - a.t !== 1 || !b.inMonth) continue;
          add('offAfterN', R.offAfterN.level, `${dayLabel(ym, b.d)} ${nm}: N 다음날인데 off가 아님`,
            [a.inMonth ? [s.id, a.d] : null, [s.id, b.d]].filter(Boolean), s.id);
        }
      }
      // D 연속
      if (isOn(R.maxConsecD)) {
        const max = R.maxConsecD.max;
        const seq = tail.map((t) => ({ d: t.d, closed: t.closed, v: t.cells[s.id], inMonth: false }))
          .concat(days.map((day) => ({ d: day.d, closed: day.closed, v: day.closed ? '' : cellOf(month, s.id, day.d).v, inMonth: true })));
        let run = [];
        const flush = () => {
          if (run.length > max && run.some((r) => r.inMonth)) {
            const inM = run.filter((r) => r.inMonth);
            add('maxConsecD', R.maxConsecD.level,
              `${dayLabel(ym, inM[0].d)}~${inM[inM.length - 1].d}일 ${nm}: D ${run.length}일 연속 (최대 ${max}일)`,
              inM.map((r) => [s.id, r.d]), s.id, run.length - max);
          }
          run = [];
        };
        for (const x of seq) {
          if (x.closed) {
            if (R.maxConsecD.closedBreaks) flush();
            continue;
          }
          if (x.v === 'D') run.push(x);
          else flush();
        }
        flush();
      }
      // 주 n회 이상 off
      if (isOn(R.weeklyOff) && complete) {
        for (const [a, b] of fullWeeks(ym)) {
          let offs = 0;
          const cells = [];
          for (let d = a; d <= b; d++) {
            if (days[d - 1].closed) continue;
            cells.push([s.id, d]);
            if (cellOf(month, s.id, d).v === 'O') offs++;
          }
          if (cells.length && offs < R.weeklyOff.min) {
            add('weeklyOff', R.weeklyOff.level,
              `${dayLabel(ym, a)}~${b}일 주 ${nm}: off ${offs}회 (주 ${R.weeklyOff.min}회 이상)`, cells, s.id, R.weeklyOff.min - offs);
          }
        }
      }
      // N 횟수
      if (complete && (s.nMin != null || s.nMax != null)) {
        const n = countFor(cfg, ym, month, s.id, { shift: 'N', weekdays: null });
        const lo = s.nMin != null ? s.nMin : 0;
        const hi = s.nMax != null ? s.nMax : Infinity;
        if (n < lo || n > hi) {
          add('nRange', 'hard', `${nm}: N ${n}회 (정한 횟수 ${lo}~${hi === Infinity ? '' : hi}회)`, [], s.id, n < lo ? lo - n : n - hi);
        }
      }
      // 신청 아닌 off 연속
      if (isOn(R.avoidConsecOff)) {
        for (let i = 0; i + 1 < days.length; i++) {
          const a = days[i];
          const b = days[i + 1];
          if (a.closed || b.closed) continue;
          const ca = cellOf(month, s.id, a.d);
          const cb = cellOf(month, s.id, b.d);
          if (ca.v === 'O' && cb.v === 'O' && !(ca.fixed && cb.fixed)) {
            add('avoidConsecOff', R.avoidConsecOff.level, `${dayLabel(ym, a.d)}~${b.d}일 ${nm}: off 연속`,
              [[s.id, a.d], [s.id, b.d]], s.id);
          }
        }
      }
    }

    // 개인별 횟수와 균등
    const stats = staff.map((s) => {
      const row = { id: s.id, name: s.name, D: 0, E: 0, N: 0, O: 0, work: 0 };
      for (const day of days) {
        if (day.closed) continue;
        const v = cellOf(month, s.id, day.d).v;
        if (v) row[v]++;
        if (v && v !== 'O') row.work++;
      }
      for (const cat of cfg.balance) row[cat.key] = countFor(cfg, ym, month, s.id, cat);
      return row;
    });
    if (complete) {
      for (const cat of balanceCats(cfg)) {
        const group = staffInBalance(cfg, cat.key);
        if (group.length < 2) continue;
        const vals = group.map((s) => stats.find((r) => r.id === s.id)[cat.key]);
        const hi = Math.max(...vals);
        const lo = Math.min(...vals);
        if (hi - lo >= 2) {
          const top = group.filter((s, i) => vals[i] === hi).map((s) => s.name).join('·');
          const low = group.filter((s, i) => vals[i] === lo).map((s) => s.name).join('·');
          add('balance', 'soft', `${cat.label} 횟수 차이 ${hi - lo}회 (${top} ${hi}회, ${low} ${lo}회)`, []);
        }
      }
    }

    // 다음 달로 넘어가는 N
    const carry = [];
    const last = days[days.length - 1];
    if (isOn(R.offAfterN) && !last.closed) {
      const nextYm = shiftYm(ym, 1);
      if (workingDay(cfg, weekday(nextYm, 1))) {
        for (const s of staff) {
          if (cellOf(month, s.id, last.d).v === 'N') carry.push(`${s.name}: ${last.d}일 N → ${parseYm(nextYm).m}월 1일 off`);
        }
      }
    }

    const hard = out.filter((v) => v.level === 'hard');
    const tolerance = staff.map((s) => ({
      id: s.id,
      name: s.name,
      used: hard.filter((v) => v.pid === s.id).reduce((a, v) => a + v.days, 0),
      allowed: s.tolerance || 0,
    }));
    const dayHard = hard.filter((v) => !v.pid);
    const withinTolerance = !dayHard.length && tolerance.every((t) => t.used <= t.allowed);

    return {
      complete, empty, filled, hard, soft: out.filter((v) => v.level !== 'hard'),
      stats, carry, tolerance, withinTolerance,
    };
  }

  // ---------- 생성 모델 ----------
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function fmtTerms(terms) {
    if (!terms.length) return '0 zero';
    const parts = [];
    terms.forEach(([c, n], i) => {
      const abs = Math.abs(c);
      const coef = abs === 1 ? '' : +abs.toFixed(4) + ' ';
      parts.push((i === 0 ? (c < 0 ? '- ' : '') : (c < 0 ? '- ' : '+ ')) + coef + n);
    });
    const lines = [];
    for (let i = 0; i < parts.length; i += 8) lines.push(parts.slice(i, i + 8).join(' '));
    return lines.join('\n   ');
  }

  // capped=true: '반드시' 조건은 사람별 허용 오차 안에서만 어길 수 있고, 인원·매일 선임처럼
  // 사람 탓이 아닌 '반드시' 조건은 어길 수 없다. capped=false: 모두 벌점으로만 따져 언제나 답이 나온다.
  function buildModel(cfg, store, ym, seed, capped) {
    const month = store.months[ym];
    const R = cfg.rules;
    const staff = cfg.staff;
    const days = monthDays(cfg, ym, month);
    const tail = prevTail(cfg, store, ym);
    const rand = seed ? rng(seed) : null;
    const rows = [];
    const obj = [];
    const bins = [];
    const bounds = [];
    const X = {};
    const personHard = {};
    const dayHard = [];
    let nv = 0;
    let usesZero = false;

    const slack = (rule, pid) => {
      const level = rule === 'coverage' ? 'hard' : rule.level;
      const w = rule === 'coverage' ? WEIGHT.coverage : (WEIGHT[level] || WEIGHT.soft);
      const n = 'v' + nv++;
      obj.push([w, n]);
      if (level === 'hard') {
        if (pid) (personHard[pid] = personHard[pid] || []).push(n);
        else dayHard.push(n);
      }
      return n;
    };
    const con = (terms, op, rhs) => {
      if (!terms.length) usesZero = true;
      rows.push(` r${rows.length}: ${fmtTerms(terms)} ${op} ${rhs}`);
    };
    const x = (i, d, s) => X[`${i}_${d}_${s}`];

    // 변수: 사람·날짜마다 D/E/N/off 중 하나
    for (const day of days) {
      if (day.closed) continue;
      const base = cfg.demand[day.w];
      staff.forEach((s, i) => {
        const f = month.fixed[s.id] && month.fixed[s.id][day.d];
        let shifts = ['D', 'E', 'N'].filter((k) => (base[k] || 0) > 0 && s.allowed.includes(k));
        if (!f && unavail(s, day.w)) shifts = [];
        if (f && f !== 'O' && !shifts.includes(f)) shifts.push(f);
        shifts.push('O');
        const terms = [];
        for (const k of shifts) {
          const n = `x${i}_${day.d}${k}`;
          X[`${i}_${day.d}_${k}`] = n;
          bins.push(n);
          terms.push([1, n]);
          if (rand && k !== 'O' && f !== k) obj.push([+(rand() * 0.2).toFixed(4), n]);
        }
        con(terms, '=', 1);
        if (f) con([[1, x(i, day.d, f)]], '=', 1);
      });
    }

    // 근무 인원, 매일 선임
    for (const day of days) {
      if (day.closed) continue;
      const need = needFor(cfg, month, day, tail);
      for (const k of ['D', 'E', 'N']) {
        const terms = staff.map((s, i) => x(i, day.d, k)).filter(Boolean).map((n) => [1, n]);
        if (!terms.length && !need[k]) continue;
        terms.push([1, slack('coverage')], [-1, slack('coverage')]);
        con(terms, '=', need[k]);
      }
      if (isOn(R.seniorDaily) && need[R.seniorDaily.shift] > 0 && staff.some((s) => s.senior)) {
        const terms = staff.map((s, i) => (s.senior ? x(i, day.d, R.seniorDaily.shift) : null))
          .filter(Boolean).map((n) => [1, n]);
        terms.push([1, slack(R.seniorDaily, null)]);
        con(terms, '>=', R.seniorDaily.min);
      }
    }

    staff.forEach((s, i) => {
      // 신청 아닌 off 금지
      if (isOn(R.noOffUnlessRequested)) {
        for (const day of days) {
          if (day.closed || !R.noOffUnlessRequested.weekdays.includes(day.w) || unavail(s, day.w)) continue;
          if (month.fixed[s.id] && month.fixed[s.id][day.d]) continue;
          con([[1, x(i, day.d, 'O')], [-1, slack(R.noOffUnlessRequested, s.id)]], '<=', 0);
        }
      }
      // N 다음날 off
      if (isOn(R.offAfterN)) {
        for (const day of days) {
          if (day.closed || !x(i, day.d, 'N')) continue;
          const nx = days[day.d];
          if (!nx || nx.closed) continue;
          con([[1, x(i, day.d, 'N')], [-1, x(i, nx.d, 'O')], [-1, slack(R.offAfterN, s.id)]], '<=', 0);
        }
        const lastPrev = tail[tail.length - 1];
        if (lastPrev && !lastPrev.closed && lastPrev.cells[s.id] === 'N' && !days[0].closed) {
          con([[1, x(i, 1, 'O')], [1, slack(R.offAfterN, s.id)]], '>=', 1);
        }
      }
      // D 연속 제한: 연속 (max+1)일 창마다 D는 max개까지
      if (isOn(R.maxConsecD)) {
        const max = R.maxConsecD.max;
        const seq = tail.map((t) => ({ closed: t.closed, c: t.cells[s.id] === 'D' ? 1 : 0, n: null }))
          .concat(days.map((day) => ({ closed: day.closed, c: 0, n: day.closed ? null : x(i, day.d, 'D') || null })));
        const segs = [];
        let cur = [];
        for (const it of seq) {
          if (it.closed) {
            if (R.maxConsecD.closedBreaks) { segs.push(cur); cur = []; }
            continue;
          }
          cur.push(it);
        }
        segs.push(cur);
        for (const seg of segs) {
          for (let a = 0; a + max < seg.length; a++) {
            const win = seg.slice(a, a + max + 1);
            const terms = win.filter((w) => w.n).map((w) => [1, w.n]);
            if (!terms.length) continue;
            const c = win.reduce((sum, w) => sum + w.c, 0);
            terms.push([-1, slack(R.maxConsecD, s.id)]);
            con(terms, '<=', max - c);
          }
        }
      }
      // 주 n회 이상 off
      if (isOn(R.weeklyOff)) {
        for (const [a, b] of fullWeeks(ym)) {
          const terms = [];
          for (let d = a; d <= b; d++) if (x(i, d, 'O')) terms.push([1, x(i, d, 'O')]);
          if (!terms.length) continue;
          terms.push([1, slack(R.weeklyOff, s.id)]);
          con(terms, '>=', R.weeklyOff.min);
        }
      }
      // N 횟수
      if (s.nMin != null || s.nMax != null) {
        const terms = days.filter((day) => !day.closed && x(i, day.d, 'N')).map((day) => [1, x(i, day.d, 'N')]);
        const nRule = { level: 'hard' };
        if (s.nMin != null) con(terms.concat([[1, slack(nRule, s.id)]]), '>=', s.nMin);
        if (s.nMax != null) con(terms.concat([[-1, slack(nRule, s.id)]]), '<=', s.nMax);
      }
      // 신청 아닌 off 연속 피하기
      if (isOn(R.avoidConsecOff)) {
        for (let k = 0; k + 1 < days.length; k++) {
          const a = days[k];
          const b = days[k + 1];
          if (a.closed || b.closed) continue;
          const fa = month.fixed[s.id] && month.fixed[s.id][a.d] === 'O';
          const fb = month.fixed[s.id] && month.fixed[s.id][b.d] === 'O';
          if (fa && fb) continue;
          con([[1, x(i, a.d, 'O')], [1, x(i, b.d, 'O')], [-1, slack(R.avoidConsecOff, s.id)]], '<=', 1);
        }
      }
    });

    // 균등: 항목마다 (가장 많은 사람 - 가장 적은 사람)을 줄인다
    balanceCats(cfg).forEach((cat, k) => {
      const group = staffInBalance(cfg, cat.key);
      if (group.length < 2) return;
      const hi = 'hi' + k;
      const lo = 'lo' + k;
      obj.push([WEIGHT.balance, hi], [-WEIGHT.balance, lo]);
      for (const s of group) {
        const i = staff.indexOf(s);
        const terms = days
          .filter((day) => !day.closed && (!cat.weekdays || cat.weekdays.includes(day.w)) && x(i, day.d, cat.shift))
          .map((day) => [1, x(i, day.d, cat.shift)]);
        con(terms.concat([[-1, hi]]), '<=', 0);
        con(terms.concat([[-1, lo]]), '>=', 0);
      }
    });

    if (capped) {
      staff.forEach((s) => {
        const vs = personHard[s.id];
        if (vs && vs.length) con(vs.map((n) => [1, n]), '<=', s.tolerance || 0);
      });
      for (const n of dayHard) bounds.push(` ${n} <= 0`);
    }

    if (!obj.length) obj.push([0, bins[0] || 'zero']);
    let lp = 'Minimize\n obj: ' + fmtTerms(obj) + '\nSubject To\n' + rows.join('\n') + '\n';
    if (usesZero) bounds.push(' zero = 0');
    if (bounds.length) lp += 'Bounds\n' + bounds.join('\n') + '\n';
    if (bins.length) {
      lp += 'Binary\n';
      for (let k = 0; k < bins.length; k += 12) lp += ' ' + bins.slice(k, k + 12).join(' ') + '\n';
    }
    lp += 'End\n';
    return { lp, X, vars: bins.length, rows: rows.length };
  }

  function readSolution(cfg, store, ym, model, result) {
    const month = store.months[ym];
    const cols = result.Columns || {};
    const auto = {};
    for (const key of Object.keys(model.X)) {
      const col = cols[model.X[key]];
      if (!col || !(col.Primal >= 0.5)) continue;
      const [i, d, s] = key.split('_');
      const pid = cfg.staff[+i].id;
      if (month.fixed[pid] && month.fixed[pid][d]) continue;
      (auto[pid] = auto[pid] || {})[d] = s;
    }
    return auto;
  }

  function hasSolution(result) {
    return ['Optimal', 'Time limit reached', 'Iteration limit reached', 'Solution limit reached'].includes(result.Status) &&
      result.Columns && Object.values(result.Columns).some((c) => typeof c.Primal === 'number');
  }

  // 1) 허용 오차 안에서 푼다. 2) 안 되면 벌점만으로 다시 풀어 '가장 적게 어기는 안'을 후보로 돌려준다.
  function solve(highs, cfg, store, ym, seed) {
    const t0 = Date.now();
    const opts = { time_limit: 20, output_flag: false };
    const strictModel = buildModel(cfg, store, ym, seed, true);
    const strict = highs.solve(strictModel.lp, opts);
    if (hasSolution(strict)) {
      return { ok: true, status: strict.Status, ms: Date.now() - t0, auto: readSolution(cfg, store, ym, strictModel, strict) };
    }
    if (strict.Status === 'Infeasible' || strict.Status === 'Primal infeasible or unbounded') {
      const looseModel = buildModel(cfg, store, ym, seed, false);
      const loose = highs.solve(looseModel.lp, opts);
      if (hasSolution(loose)) {
        return { ok: false, infeasible: true, status: loose.Status, ms: Date.now() - t0, candidate: readSolution(cfg, store, ym, looseModel, loose) };
      }
      return { ok: false, status: loose.Status, ms: Date.now() - t0 };
    }
    return { ok: false, status: strict.Status, ms: Date.now() - t0 };
  }

  g.Roster = {
    YO, LABEL, parseYm, ymKey, shiftYm, daysIn, weekday, emptyMonth, dayLabel, isOn, unavail, workingDay,
    normalize, monthDays, cellOf, prevTail, needFor, check, buildModel, solve,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
