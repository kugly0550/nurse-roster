// 달력 계산, 규칙 검사기, 근무표 생성 모델(HiGHS LP 형식).
// 검사기와 생성 모델은 같은 규칙을 따로 구현한다. 화면에 보이는 위반 목록은 항상 검사기 결과다.
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

  function monthDays(cfg, ym, month) {
    const out = [];
    const L = daysIn(ym);
    for (let d = 1; d <= L; d++) {
      const w = weekday(ym, d);
      const closed = !cfg.demand[w] || (month.holidays || []).includes(d);
      out.push({ d, w, t: d, closed });
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

  // 그날 필요한 인원. 신청 off 등으로 일할 사람이 모자라면 dropOrder 순서로 뺀다.
  function needFor(cfg, month, day, tail) {
    if (day.closed) return null;
    const base = cfg.demand[day.w];
    const need = { D: base.D || 0, E: base.E || 0, N: base.N || 0 };
    let unavailable = 0;
    for (const s of cfg.staff) {
      const f = month.fixed[s.id] && month.fixed[s.id][day.d];
      if (f === 'O') { unavailable++; continue; }
      if (f) continue;
      if (cfg.rules.offAfterN.on) {
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
  function check(cfg, store, ym) {
    const month = store.months[ym];
    const R = cfg.rules;
    const days = monthDays(cfg, ym, month);
    const tail = prevTail(cfg, store, ym);
    const staff = cfg.staff;
    const name = (pid) => (staff.find((s) => s.id === pid) || {}).name || pid;
    const out = [];
    const add = (rule, level, msg, cells) => out.push({ rule, level, msg, cells: cells || [] });

    let empty = 0;
    let filled = 0;
    for (const day of days) {
      if (day.closed) continue;
      for (const s of staff) (cellOf(month, s.id, day.d).v ? filled++ : empty++);
    }
    const complete = empty === 0;

    // 근무 인원
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
      for (const k of ['D', 'E', 'N']) {
        if (cnt[k] < need[k]) parts.push(`${k} ${need[k] - cnt[k]}명 부족`);
        if (cnt[k] > need[k]) parts.push(`${k} ${cnt[k] - need[k]}명 많음`);
      }
      if (parts.length) {
        add('coverage', 'hard', `${dayLabel(ym, day.d)} ${parts.join(', ')}`,
          staff.map((s) => [s.id, day.d]));
      }
      if (R.seniorDaily.on && need[R.seniorDaily.shift] > 0) {
        const seniors = staff.filter((s) => s.senior);
        const n = seniors.filter((s) => cellOf(month, s.id, day.d).v === R.seniorDaily.shift).length;
        if (n < R.seniorDaily.min) {
          add('seniorDaily', R.seniorDaily.level,
            `${dayLabel(ym, day.d)} ${seniors.map((s) => s.name).join('·')} 중 ${R.seniorDaily.shift} 근무자가 없음`,
            seniors.map((s) => [s.id, day.d]));
        }
      }
    }

    for (const s of staff) {
      const nm = s.name;
      // 신청 아닌 off
      if (R.noOffUnlessRequested.on) {
        for (const day of days) {
          if (day.closed || !R.noOffUnlessRequested.weekdays.includes(day.w)) continue;
          const c = cellOf(month, s.id, day.d);
          if (c.v === 'O' && !c.fixed) {
            add('noOffUnlessRequested', R.noOffUnlessRequested.level,
              `${dayLabel(ym, day.d)} ${nm}: 신청하지 않은 off`, [[s.id, day.d]]);
          }
        }
      }
      // 가능한 근무 종류
      for (const day of days) {
        if (day.closed) continue;
        const v = cellOf(month, s.id, day.d).v;
        if (v && v !== 'O' && !s.allowed.includes(v)) {
          add('allowed', 'hard', `${dayLabel(ym, day.d)} ${nm}: ${v} 근무를 하지 않는 사람`, [[s.id, day.d]]);
        }
      }
      // N 다음날 off
      if (R.offAfterN.on) {
        const seq = tail.map((t) => ({ t: t.t, d: t.d, closed: t.closed, v: t.cells[s.id], inMonth: false }))
          .concat(days.map((day) => ({ t: day.t, d: day.d, closed: day.closed, v: day.closed ? '' : cellOf(month, s.id, day.d).v, inMonth: true })));
        for (let i = 0; i + 1 < seq.length; i++) {
          const a = seq[i];
          const b = seq[i + 1];
          if (a.closed || b.closed || a.v !== 'N' || !b.v || b.v === 'O' || b.t - a.t !== 1) continue;
          if (!b.inMonth) continue;
          add('offAfterN', R.offAfterN.level, `${dayLabel(ym, b.d)} ${nm}: N 다음날인데 off가 아님`,
            [a.inMonth ? [s.id, a.d] : null, [s.id, b.d]].filter(Boolean));
        }
      }
      // D 연속
      if (R.maxConsecD.on) {
        const seq = tail.map((t) => ({ d: t.d, closed: t.closed, v: t.cells[s.id], inMonth: false }))
          .concat(days.map((day) => ({ d: day.d, closed: day.closed, v: day.closed ? '' : cellOf(month, s.id, day.d).v, inMonth: true })));
        let run = [];
        const flush = () => {
          if (run.length > R.maxConsecD.max && run.some((r) => r.inMonth)) {
            const inM = run.filter((r) => r.inMonth);
            add('maxConsecD', R.maxConsecD.level,
              `${dayLabel(ym, inM[0].d)}~${inM[inM.length - 1].d}일 ${nm}: D ${run.length}일 연속`,
              inM.map((r) => [s.id, r.d]));
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
      // 주 1회 이상 off
      if (R.weeklyOff.on && complete) {
        for (const [a, b] of fullWeeks(ym)) {
          let offs = 0;
          for (let d = a; d <= b; d++) {
            if (!days[d - 1].closed && cellOf(month, s.id, d).v === 'O') offs++;
          }
          if (offs < R.weeklyOff.min) {
            const cells = [];
            for (let d = a; d <= b; d++) if (!days[d - 1].closed) cells.push([s.id, d]);
            add('weeklyOff', R.weeklyOff.level, `${dayLabel(ym, a)}~${b}일 주 ${nm}: off가 없음`, cells);
          }
        }
      }
      // N 횟수
      if (complete && (s.nMin != null || s.nMax != null)) {
        const n = countFor(cfg, ym, month, s.id, { shift: 'N', weekdays: null });
        if ((s.nMin != null && n < s.nMin) || (s.nMax != null && n > s.nMax)) {
          add('nRange', 'hard', `${nm}: N ${n}회 (정해진 횟수 ${s.nMin ?? 0}~${s.nMax ?? '∞'}회)`, []);
        }
      }
      // 신청 아닌 off 연속 (가능하면)
      if (R.avoidConsecOff.on) {
        for (let i = 0; i + 1 < days.length; i++) {
          const a = days[i];
          const b = days[i + 1];
          if (a.closed || b.closed) continue;
          const ca = cellOf(month, s.id, a.d);
          const cb = cellOf(month, s.id, b.d);
          if (ca.v === 'O' && cb.v === 'O' && !(ca.fixed && cb.fixed)) {
            add('avoidConsecOff', R.avoidConsecOff.level, `${dayLabel(ym, a.d)}~${b.d}일 ${nm}: off 연속`,
              [[s.id, a.d], [s.id, b.d]]);
          }
        }
      }
    }

    // 균등
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
    if (R.balance.on && complete) {
      for (const cat of cfg.balance) {
        const group = staffInBalance(cfg, cat.key);
        if (group.length < 2) continue;
        const vals = group.map((s) => stats.find((r) => r.id === s.id)[cat.key]);
        const hi = Math.max(...vals);
        const lo = Math.min(...vals);
        if (hi - lo >= 2) {
          const top = group.filter((s, i) => vals[i] === hi).map((s) => s.name).join('·');
          const low = group.filter((s, i) => vals[i] === lo).map((s) => s.name).join('·');
          add('balance', R.balance.level, `${cat.label} 횟수 차이 ${hi - lo}회 (${top} ${hi}회, ${low} ${lo}회)`, []);
        }
      }
    }

    // 다음 달로 넘어가는 N
    const carry = [];
    const last = days[days.length - 1];
    if (R.offAfterN.on && !last.closed) {
      const nextYm = shiftYm(ym, 1);
      const nextClosed = !cfg.demand[weekday(nextYm, 1)];
      if (!nextClosed) {
        for (const s of staff) {
          if (cellOf(month, s.id, last.d).v === 'N') carry.push(`${s.name}: ${last.d}일 N → ${parseYm(nextYm).m}월 1일 off`);
        }
      }
    }

    return {
      complete,
      empty,
      filled,
      hard: out.filter((v) => v.level === 'hard'),
      soft: out.filter((v) => v.level !== 'hard'),
      stats,
      carry,
      name,
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
      const sign = c < 0 ? '-' : '+';
      parts.push((i === 0 ? (c < 0 ? '- ' : '') : sign + ' ') + coef + n);
    });
    const lines = [];
    for (let i = 0; i < parts.length; i += 8) lines.push(parts.slice(i, i + 8).join(' '));
    return lines.join('\n   ');
  }

  function buildModel(cfg, store, ym, seed) {
    const month = store.months[ym];
    const R = cfg.rules;
    const staff = cfg.staff;
    const days = monthDays(cfg, ym, month);
    const tail = prevTail(cfg, store, ym);
    const rand = seed ? rng(seed) : null;
    const rows = [];
    const obj = [];
    const bins = [];
    const X = {};
    let nv = 0;
    let usesZero = false;

    const slack = (w) => {
      const n = 'v' + nv++;
      obj.push([w, n]);
      return n;
    };
    const con = (terms, op, rhs) => {
      if (!terms.length) { usesZero = true; }
      rows.push(` r${rows.length}: ${fmtTerms(terms)} ${op} ${rhs}`);
    };
    const x = (i, d, s) => X[`${i}_${d}_${s}`];
    const lvl = (rule) => WEIGHT[rule.level] || WEIGHT.soft;

    // 변수
    for (const day of days) {
      if (day.closed) continue;
      const base = cfg.demand[day.w];
      staff.forEach((s, i) => {
        const f = month.fixed[s.id] && month.fixed[s.id][day.d];
        const shifts = ['D', 'E', 'N'].filter((k) => (base[k] || 0) > 0 && s.allowed.includes(k));
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

    // 근무 인원
    for (const day of days) {
      if (day.closed) continue;
      const need = needFor(cfg, month, day, tail);
      for (const k of ['D', 'E', 'N']) {
        const terms = staff.map((s, i) => x(i, day.d, k)).filter(Boolean).map((n) => [1, n]);
        if (!terms.length && !need[k]) continue;
        terms.push([1, slack(WEIGHT.coverage)], [-1, slack(WEIGHT.coverage)]);
        con(terms, '=', need[k]);
      }
      if (R.seniorDaily.on && need[R.seniorDaily.shift] > 0) {
        const terms = staff.map((s, i) => (s.senior ? x(i, day.d, R.seniorDaily.shift) : null))
          .filter(Boolean).map((n) => [1, n]);
        terms.push([1, slack(lvl(R.seniorDaily))]);
        con(terms, '>=', R.seniorDaily.min);
      }
    }

    staff.forEach((s, i) => {
      // 신청 아닌 off 금지
      if (R.noOffUnlessRequested.on) {
        for (const day of days) {
          if (day.closed || !R.noOffUnlessRequested.weekdays.includes(day.w)) continue;
          const f = month.fixed[s.id] && month.fixed[s.id][day.d];
          if (f) continue;
          con([[1, x(i, day.d, 'O')], [-1, slack(lvl(R.noOffUnlessRequested))]], '<=', 0);
        }
      }
      // N 다음날 off
      if (R.offAfterN.on) {
        for (const day of days) {
          if (day.closed || !x(i, day.d, 'N')) continue;
          const nx = days[day.d];
          if (!nx || nx.closed) continue;
          con([[1, x(i, day.d, 'N')], [-1, x(i, nx.d, 'O')], [-1, slack(lvl(R.offAfterN))]], '<=', 0);
        }
        const lastPrev = tail[tail.length - 1];
        if (lastPrev && !lastPrev.closed && lastPrev.cells[s.id] === 'N' && !days[0].closed) {
          con([[1, x(i, 1, 'O')], [1, slack(lvl(R.offAfterN))]], '>=', 1);
        }
      }
      // D 연속 제한
      if (R.maxConsecD.on) {
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
            terms.push([-1, slack(lvl(R.maxConsecD))]);
            con(terms, '<=', max - c);
          }
        }
      }
      // 주 1회 이상 off
      if (R.weeklyOff.on) {
        for (const [a, b] of fullWeeks(ym)) {
          const terms = [];
          for (let d = a; d <= b; d++) if (x(i, d, 'O')) terms.push([1, x(i, d, 'O')]);
          if (!terms.length) continue;
          terms.push([1, slack(lvl(R.weeklyOff))]);
          con(terms, '>=', R.weeklyOff.min);
        }
      }
      // N 횟수
      if (s.nMin != null || s.nMax != null) {
        const terms = days.filter((day) => !day.closed && x(i, day.d, 'N')).map((day) => [1, x(i, day.d, 'N')]);
        if (s.nMin != null) con(terms.concat([[1, slack(WEIGHT.hard)]]), '>=', s.nMin);
        if (s.nMax != null) con(terms.concat([[-1, slack(WEIGHT.hard)]]), '<=', s.nMax);
      }
      // 신청 아닌 off 연속 피하기
      if (R.avoidConsecOff.on) {
        for (let k = 0; k + 1 < days.length; k++) {
          const a = days[k];
          const b = days[k + 1];
          if (a.closed || b.closed) continue;
          const fa = month.fixed[s.id] && month.fixed[s.id][a.d] === 'O';
          const fb = month.fixed[s.id] && month.fixed[s.id][b.d] === 'O';
          if (fa && fb) continue;
          con([[1, x(i, a.d, 'O')], [1, x(i, b.d, 'O')], [-1, slack(lvl(R.avoidConsecOff))]], '<=', 1);
        }
      }
    });

    // 균등
    if (R.balance.on) {
      cfg.balance.forEach((cat, k) => {
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
    }

    let lp = 'Minimize\n obj: ' + fmtTerms(obj) + '\nSubject To\n' + rows.join('\n') + '\n';
    if (usesZero) lp += 'Bounds\n zero = 0\n';
    lp += 'Binary\n';
    for (let k = 0; k < bins.length; k += 12) lp += ' ' + bins.slice(k, k + 12).join(' ') + '\n';
    lp += 'End\n';
    return { lp, X, vars: bins.length, rows: rows.length };
  }

  function readSolution(cfg, store, ym, model, result) {
    const month = store.months[ym];
    const cols = result.Columns || {};
    const auto = {};
    for (const key of Object.keys(model.X)) {
      const col = cols[model.X[key]];
      if (!col || col.Primal < 0.5) continue;
      const [i, d, s] = key.split('_');
      const pid = cfg.staff[+i].id;
      if (month.fixed[pid] && month.fixed[pid][d]) continue;
      (auto[pid] = auto[pid] || {})[d] = s;
    }
    return auto;
  }

  // 해가 있는 상태만 받아들인다 (시간 제한에 걸려도 찾은 해가 있으면 쓴다).
  function solve(highs, cfg, store, ym, seed) {
    const model = buildModel(cfg, store, ym, seed);
    const t0 = Date.now();
    const result = highs.solve(model.lp, { time_limit: 20, output_flag: false });
    const ms = Date.now() - t0;
    const ok = ['Optimal', 'Time limit reached', 'Iteration limit reached'].includes(result.Status)
      && result.Columns && Object.values(result.Columns).some((c) => typeof c.Primal === 'number');
    return { ok, status: result.Status, ms, model, auto: ok ? readSolution(cfg, store, ym, model, result) : null };
  }

  g.Roster = {
    YO, LABEL, parseYm, ymKey, shiftYm, daysIn, weekday, emptyMonth, dayLabel,
    monthDays, cellOf, prevTail, needFor, check, buildModel, solve,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
