// 설정 화면: 인원, 근무환경(요일별 인원·모자랄 때 뺄 근무·휴일), 조건(반드시/가능하면/끔).
// 바꾸는 즉시 저장하고 근무표 점검을 다시 한다.
(function () {
  'use strict';
  const R = window.Roster;
  const WEEK = [1, 2, 3, 4, 5, 6, 0]; // 월~일
  const LEVELS = [['hard', '반드시'], ['soft', '가능하면'], ['off', '끔']];
  const $ = (id) => document.getElementById(id);

  let api = null; // { store(), month(), save(), changed(), ask(), toast() }
  let tab = 'people';
  const openCards = new Set();

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function cfg() { return api.store().config; }
  function commit(rerender) {
    api.save();
    api.changed();
    if (rerender !== false) render();
  }
  function toggle(arr, v) {
    const i = arr.indexOf(v);
    if (i >= 0) arr.splice(i, 1); else arr.push(v);
    return arr;
  }
  function chip(act, data, label, on, extra) {
    const attrs = Object.entries(data).map(([k, v]) => `data-${k}="${esc(v)}"`).join(' ');
    return `<button type="button" class="tog" data-act="${act}" ${attrs} aria-pressed="${on}"${extra || ''}>${esc(label)}</button>`;
  }
  function numSelect(attrs, value, from, to, label) {
    let h = `<select ${attrs} aria-label="${esc(label)}">`;
    for (let n = from; n <= to; n++) h += `<option value="${n}"${n === value ? ' selected' : ''}>${n}</option>`;
    return h + '</select>';
  }
  function seg(rule, key, allowed) {
    const levels = LEVELS.filter(([v]) => !allowed || allowed.includes(v));
    return `<div class="seg" role="radiogroup" aria-label="지킬 정도">` + levels.map(([v, l]) =>
      `<button type="button" role="radio" aria-checked="${rule.level === v}" data-act="lvl" data-r="${key}" data-v="${v}">${l}</button>`).join('') + '</div>';
  }

  // ---------- 인원 ----------
  function personSummary(s) {
    const parts = [];
    if (s.senior) parts.push('선임');
    parts.push(s.allowed.length ? s.allowed.join('·') : '근무 없음');
    if (s.nMin != null || s.nMax != null) parts.push(`N ${s.nMin != null ? s.nMin : 0}~${s.nMax != null ? s.nMax : ''}회`);
    if (s.offWeekdays.length) parts.push(s.offWeekdays.slice().sort().map((w) => R.YO[w]).join('') + ' 안 함');
    if (s.tolerance) parts.push(`오차 ${s.tolerance}일`);
    return parts.join(' · ');
  }

  function people() {
    const c = cfg();
    const shift = c.rules.seniorDaily.shift;
    const workdays = WEEK.filter((w) => R.workingDay(c, w));
    let h = `<p class="lead">사람마다 할 수 있는 근무와 지켜야 할 조건을 정해요. 이름을 누르면 펼쳐져요.</p>`;
    c.staff.forEach((s, i) => {
      const open = openCards.has(s.id);
      const bad = s.nMin != null && s.nMax != null && s.nMin > s.nMax;
      h += `<details class="pcard" data-pid="${s.id}"${open ? ' open' : ''}>
        <summary><span class="pn">${esc(s.name || '이름 없음')}</span><span class="ps">${esc(personSummary(s))}</span></summary>
        <div class="pbody">
          <label class="fld"><span class="flab">이름</span><input type="text" id="nm-${s.id}" data-f="name" data-pid="${s.id}" value="${esc(s.name)}" maxlength="10" placeholder="홍길동"></label>
          <div class="fld"><span class="flab">할 수 있는 근무</span><div class="chips">
            ${['D', 'E', 'N'].map((k) => chip('allowed', { pid: s.id, v: k }, k, s.allowed.includes(k))).join('')}
          </div></div>
          <label class="switch" for="sr-${s.id}">
            <input type="checkbox" id="sr-${s.id}" role="switch" data-act="senior" data-pid="${s.id}"${s.senior ? ' checked' : ''}>
            <span class="track" aria-hidden="true"></span>
            <span>선임<small>매일 이 그룹에서 ${esc(shift)} ${c.rules.seniorDaily.min}명 이상 (조건 탭)</small></span>
          </label>
          <div class="fld"><span class="flab">한 달 N 횟수</span>
            <div class="inline">최소 <input type="number" inputmode="numeric" min="0" max="31" id="nmin-${s.id}" data-f="nMin" data-pid="${s.id}" value="${s.nMin != null ? s.nMin : ''}">
            ~ 최대 <input type="number" inputmode="numeric" min="0" max="31" id="nmax-${s.id}" data-f="nMax" data-pid="${s.id}" value="${s.nMax != null ? s.nMax : ''}"> 회</div>
            <small>비워 두면 제한 없음</small>${bad ? '<small class="err">최소가 최대보다 커요</small>' : ''}</div>
          <div class="fld"><span class="flab">근무 안 하는 요일</span><div class="chips">
            ${workdays.map((w) => chip('offw', { pid: s.id, v: w }, R.YO[w], s.offWeekdays.includes(w))).join('')}
          </div><small>이 요일은 늘 off로 넣어요 (신청 off와 같게 봐요)</small></div>
          <div class="fld"><span class="flab">균등 계산에서 빼기</span><div class="chips">
            ${c.balance.map((cat) => chip('bex', { pid: s.id, v: cat.key }, cat.label, s.balanceExclude.includes(cat.key))).join('')}
          </div><small>D만 서는 사람처럼 횟수를 맞출 필요가 없는 항목</small></div>
          <div class="fld"><span class="flab">허용 오차</span>
            <div class="stepper"><button type="button" data-act="tol" data-pid="${s.id}" data-v="-1" aria-label="허용 오차 줄이기">−</button>
            <output>${s.tolerance}일</output>
            <button type="button" data-act="tol" data-pid="${s.id}" data-v="1" aria-label="허용 오차 늘리기">+</button></div>
            <small>'반드시' 조건을 이 사람에게 한 달에 며칠까지 어겨도 되는지. 0이면 어기지 않아요. 오차를 쓰면 점검에 알려줘요.</small></div>
          <div class="prow">
            <button type="button" class="btn sm" data-act="up" data-pid="${s.id}"${i === 0 ? ' disabled' : ''}>위로</button>
            <button type="button" class="btn sm" data-act="down" data-pid="${s.id}"${i === c.staff.length - 1 ? ' disabled' : ''}>아래로</button>
            <button type="button" class="btn sm danger" data-act="del" data-pid="${s.id}">삭제</button>
          </div>
        </div>
      </details>`;
    });
    h += `<button type="button" class="btn add" data-act="add">사람 추가</button>`;
    return h;
  }

  // ---------- 근무환경 ----------
  function env() {
    const c = cfg();
    const n = c.staff.length;
    let h = `<section class="sset"><h4>요일별 필요 인원</h4>
      <div class="tablewrap"><table class="envt"><thead><tr><th>요일</th><th>근무</th><th>D</th><th>E</th><th>N</th><th>합계</th></tr></thead><tbody>`;
    for (const w of WEEK) {
      const dm = c.demand[w];
      const open = !!dm;
      const total = open ? dm.D + dm.E + dm.N : 0;
      h += `<tr class="${open ? '' : 'closed'}"><th scope="row">${R.YO[w]}</th>
        <td><label class="switch mini" for="op-${w}"><input type="checkbox" id="op-${w}" role="switch" data-act="open" data-w="${w}"${open ? ' checked' : ''}><span class="track" aria-hidden="true"></span><span class="sr">${R.YO[w]}요일 근무</span></label></td>`;
      for (const k of ['D', 'E', 'N']) {
        h += `<td>${open ? numSelect(`id="dm-${w}${k}" data-act="dem" data-w="${w}" data-k="${k}"`, dm[k], 0, 9, `${R.YO[w]}요일 ${k} 인원`) : '–'}</td>`;
      }
      h += `<td class="${total > n ? 'over' : ''}">${open ? total + '명' : '쉼'}</td></tr>`;
    }
    h += `</tbody></table></div>
      <p class="note">지금 인원은 ${n}명이에요.${WEEK.some((w) => c.demand[w] && c.demand[w].D + c.demand[w].E + c.demand[w].N > n) ? ' <span class="err">빨간 합계는 인원보다 많아서 채울 수 없어요.</span>' : ''} 근무를 끈 요일은 표에 대각선으로 나와요.</p></section>`;

    const opt = (sel) => ['', 'D', 'E', 'N'].map((k) => `<option value="${k}"${k === sel ? ' selected' : ''}>${k || '없음'}</option>`).join('');
    h += `<section class="sset"><h4>사람이 모자라면 먼저 뺄 근무</h4>
      <p class="note">신청 off나 근무 안 하는 요일 때문에 일할 사람이 필요 인원보다 적은 날, 이 순서로 근무를 줄여요. 예: 월·수·금에 5명이면 E를 빼요.</p>
      <div class="inline">1순위 <select id="drop0" data-act="drop" data-i="0">${opt(c.dropOrder[0] || '')}</select>
      2순위 <select id="drop1" data-act="drop" data-i="1">${opt(c.dropOrder[1] || '')}</select></div></section>`;

    const ym = api.store().current;
    const mo = api.month();
    const hol = (mo.holidays || []).slice().sort((a, b) => a - b);
    h += `<section class="sset"><h4>${R.parseYm(ym).m}월 휴일</h4>
      <p class="note">근무표 위쪽 날짜를 누르면 그날을 휴일로 바꾸거나 되돌릴 수 있어요. 휴일은 일요일처럼 대각선으로 나와요.</p>
      <div class="chips">${hol.length ? hol.map((d) => `<button type="button" class="tog" data-act="unhol" data-d="${d}" aria-pressed="true" aria-label="${d}일 휴일 해제">${R.dayLabel(ym, d)} ×</button>`).join('') : '<span class="note">없음</span>'}</div></section>`;
    return h;
  }

  // ---------- 조건 ----------
  function rules() {
    const c = cfg();
    const r = c.rules;
    const seniors = c.staff.filter((s) => s.senior).map((s) => s.name);
    const workdays = WEEK.filter((w) => R.workingDay(c, w));
    const card = (key, title, desc, body, allowed) => `<article class="rcard${r[key].level === 'off' ? ' is-off' : ''}">
        <div class="rtop"><strong>${title}</strong><small>${desc}</small></div>
        ${seg(r[key], key, allowed)}${body ? `<div class="rbody">${body}</div>` : ''}</article>`;
    let h = `<p class="lead"><b>반드시</b>는 사람별 허용 오차 안에서만 어길 수 있어요. <b>가능하면</b>은 되도록 지키고, 못 지키면 점검에 알려줘요. <b>끔</b>은 따지지 않아요. 요일별 필요 인원은 항상 반드시예요.</p>`;
    h += card('offAfterN', 'N 다음날은 off', '나이트 근무 다음날은 쉬게 해요', '');
    h += card('maxConsecD', 'D 연속 제한', 'D가 너무 길게 이어지지 않게 해요',
      `<div class="inline">D는 최대 ${numSelect('id="mcd" data-act="rnum" data-r="maxConsecD" data-k="max"', r.maxConsecD.max, 1, 6, 'D 최대 연속 일수')}일까지 연속</div>
       <label class="switch" for="mcdb"><input type="checkbox" id="mcdb" role="switch" data-act="rbool" data-r="maxConsecD" data-k="closedBreaks"${r.maxConsecD.closedBreaks ? ' checked' : ''}><span class="track" aria-hidden="true"></span><span>쉬는 날이 끼면 연속이 끊긴 것으로 봐요<small>예: 토 D, 일요일, 월 D는 연속이 아님</small></span></label>`);
    h += card('noOffUnlessRequested', '신청 없으면 off 넣지 않는 요일', '이 요일에는 신청한 사람만 off',
      `<div class="chips">${workdays.map((w) => chip('rweek', { r: 'noOffUnlessRequested', v: w }, R.YO[w], r.noOffUnlessRequested.weekdays.includes(w))).join('')}</div>`);
    h += card('seniorDaily', '매일 선임 근무', '정해 둔 선임 중 누군가는 매일 근무',
      `<div class="inline">선임 중 최소 ${numSelect('id="sdm" data-act="rnum" data-r="seniorDaily" data-k="min"', r.seniorDaily.min, 1, 3, '최소 인원')}명은
       <select id="sds" data-act="rshift" data-r="seniorDaily">${['D', 'E', 'N'].map((k) => `<option${k === r.seniorDaily.shift ? ' selected' : ''}>${k}</option>`).join('')}</select> 근무</div>
       <small>선임: ${seniors.length ? esc(seniors.join('·')) : '없음'} (인원 탭에서 바꿔요)</small>`);
    h += card('weeklyOff', '주마다 off', '한 주(일~토)에 쉬는 날을 꼭 넣어요',
      `<div class="inline">한 주에 off ${numSelect('id="wo" data-act="rnum" data-r="weeklyOff" data-k="min"', r.weeklyOff.min, 1, 3, '주당 off 횟수')}회 이상</div>
       <small>일~토가 모두 이번 달에 들어 있는 주만 따져요</small>`);
    h += card('avoidConsecOff', '신청 아닌 off 연달아 넣지 않기', '신청한 off 옆에 off를 또 붙이지 않아요', '');
    h += card('balance', '한 달 기준 균등하게', '고른 항목의 횟수를 사람끼리 비슷하게 맞춰요',
      `<div class="chips">${c.balance.map((cat) => chip('bal', { v: cat.key }, cat.label, cat.on)).join('')}</div>
       <small>사람별로 빼려면 인원 탭의 '균등 계산에서 빼기'</small>`, ['soft', 'off']);
    h += `<div class="reset"><button type="button" class="btn sm" data-act="reset">처음 조건으로 되돌리기</button></div>`;
    return h;
  }

  // ---------- 그리기·이벤트 ----------
  function render() {
    const body = $('settingsBody');
    body.querySelectorAll('details.pcard').forEach((d) => {
      if (d.open) openCards.add(d.dataset.pid); else openCards.delete(d.dataset.pid);
    });
    const focusId = document.activeElement && document.activeElement.id;
    body.innerHTML = tab === 'people' ? people() : tab === 'env' ? env() : rules();
    document.querySelectorAll('#settingsTabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    if (focusId && document.getElementById(focusId)) document.getElementById(focusId).focus();
  }

  function person(pid) { return cfg().staff.find((s) => s.id === pid); }

  function onAct(act, ds, el) {
    const c = cfg();
    const s = ds.pid ? person(ds.pid) : null;
    switch (act) {
      case 'allowed': toggle(s.allowed, ds.v); s.allowed.sort((a, b) => 'DEN'.indexOf(a) - 'DEN'.indexOf(b)); break;
      case 'senior': s.senior = el.checked; break;
      case 'offw': toggle(s.offWeekdays, +ds.v); break;
      case 'bex': toggle(s.balanceExclude, ds.v); break;
      case 'tol': s.tolerance = Math.max(0, Math.min(31, (s.tolerance || 0) + +ds.v)); break;
      case 'up':
      case 'down': {
        const i = c.staff.indexOf(s);
        const j = act === 'up' ? i - 1 : i + 1;
        if (j < 0 || j >= c.staff.length) return;
        [c.staff[i], c.staff[j]] = [c.staff[j], c.staff[i]];
        break;
      }
      case 'del':
        api.ask(`${s.name || '이 사람'}을(를) 삭제할까요?`, '모든 달의 근무표와 신청에서 이 사람 줄이 사라져요.', '삭제', () => {
          c.staff.splice(c.staff.indexOf(s), 1);
          for (const m of Object.values(api.store().months)) {
            for (const k of ['fixed', 'auto', 'notes', 'leave']) if (m[k]) delete m[k][s.id];
          }
          commit();
        });
        return;
      case 'add': {
        const id = 's' + Date.now().toString(36);
        c.staff.push({ id, name: '', senior: false, allowed: ['D', 'E', 'N'], nMin: null, nMax: null, offWeekdays: [], balanceExclude: [], tolerance: 0 });
        openCards.add(id);
        commit();
        const input = document.getElementById('nm-' + id);
        if (input) { input.focus(); input.scrollIntoView({ block: 'center' }); }
        return;
      }
      case 'open': c.demand[+ds.w] = el.checked ? { D: 1, E: 0, N: 0 } : null; break;
      case 'dem': c.demand[+ds.w][ds.k] = +el.value; break;
      case 'drop': {
        const d = [c.dropOrder[0] || '', c.dropOrder[1] || ''];
        d[+ds.i] = el.value;
        c.dropOrder = d.filter((k, i) => k && d.indexOf(k) === i);
        break;
      }
      case 'unhol': {
        const mo = api.month();
        mo.holidays = (mo.holidays || []).filter((d) => d !== +ds.d);
        break;
      }
      case 'lvl': c.rules[ds.r].level = ds.v; break;
      case 'rnum': c.rules[ds.r][ds.k] = +el.value; break;
      case 'rbool': c.rules[ds.r][ds.k] = el.checked; break;
      case 'rshift': c.rules[ds.r].shift = el.value; break;
      case 'rweek': toggle(c.rules[ds.r].weekdays, +ds.v); break;
      case 'bal': { const cat = c.balance.find((x) => x.key === ds.v); cat.on = !cat.on; break; }
      case 'reset':
        api.ask('처음 조건으로 되돌릴까요?', '인원·근무환경·조건이 처음 상태(엄마가 보낸 11월 조건)로 돌아가요. 근무표와 신청은 그대로예요.', '되돌리기', () => {
          api.store().config = R.normalize({ config: JSON.parse(JSON.stringify(window.RosterSeed.config)), months: {} }).config;
          commit();
          api.toast('처음 조건으로 되돌렸어요');
        });
        return;
      default: return;
    }
    commit();
  }

  function onField(el) {
    const s = person(el.dataset.pid);
    if (!s) return;
    const f = el.dataset.f;
    if (f === 'name') {
      s.name = el.value.trim();
      const sum = el.closest('details').querySelector('summary .pn');
      if (sum) sum.textContent = s.name || '이름 없음';
      commit(false);
      return;
    }
    if (f === 'nMin' || f === 'nMax') {
      const v = el.value.trim();
      s[f] = v === '' ? null : Math.max(0, Math.min(31, Math.round(+v)));
      commit(false);
    }
  }

  function open(nextTab) {
    if (nextTab) tab = nextTab;
    render();
    $('settings').hidden = false;
    document.documentElement.classList.add('locked');
    const t = document.querySelector('#settingsTabs [aria-selected="true"]');
    if (t) t.focus();
  }
  function close() {
    $('settings').hidden = true;
    document.documentElement.classList.remove('locked');
  }

  function init(a) {
    api = a;
    const body = $('settingsBody');
    body.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (b && !b.disabled) onAct(b.dataset.act, b.dataset, b);
    });
    body.addEventListener('change', (e) => {
      const el = e.target;
      if (el.dataset.f) { onField(el); render(); return; }
      if (el.dataset.act && el.tagName !== 'BUTTON') onAct(el.dataset.act, el.dataset, el);
    });
    body.addEventListener('input', (e) => {
      if (e.target.dataset.f === 'name') onField(e.target);
    });
    $('settingsTabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (!b) return;
      tab = b.dataset.tab;
      render();
      $('settingsBody').scrollTop = 0;
    });
    $('settingsClose').addEventListener('click', close);
  }

  window.RosterSettings = { init, open, close, isOpen: () => !$('settings').hidden, refresh: () => { if (!$('settings').hidden) render(); } };
})();
