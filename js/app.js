// 화면: 근무표 표시, 칸 수정, 생성, 점검 결과, 저장, 이미지 내보내기, 설정 화면 연결.
(function () {
  'use strict';
  const R = window.Roster;
  const X = window.RosterExport;
  const S = window.RosterSettings;
  const KEY = 'nurse-roster-v1';
  const $ = (id) => document.getElementById(id);

  const RULE_CHIP = {
    coverage: '인원', seniorDaily: '선임', noOffUnlessRequested: '신청 외 off', allowed: '근무 종류',
    unavailDay: '안 하는 요일', offAfterN: 'N 다음날', maxConsecD: 'D 연속', weeklyOff: '주 off',
    nRange: 'N 횟수', avoidConsecOff: 'off 연속', balance: '균등',
  };

  let store = load();
  let highs = null;
  let solverError = null;
  let report = null;
  let focusIdx = null; // 선택한 위반 항목 {list, i}
  let justGenerated = false;
  let pending = null; // 허용 오차 안에서 못 만들었을 때의 후보 { ym, auto, report }
  let busy = false;
  let previewBlob = null;

  // ---------- 저장 ----------
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s && s.config && s.months) return R.normalize(s);
      }
    } catch (e) { /* 기본 데이터로 시작 */ }
    const s = R.normalize(clone(window.RosterSeed));
    s.firstRun = true;
    return s;
  }
  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(KEY, JSON.stringify(store));
        $('saveState').textContent = '저장됨';
      } catch (e) {
        $('saveState').textContent = '이 브라우저에는 저장되지 않아요. 백업 파일을 만들어 두세요.';
      }
    }, 200);
  }
  function month() {
    if (!store.months[store.current]) store.months[store.current] = R.emptyMonth();
    return store.months[store.current];
  }
  function staffById(pid) { return store.config.staff.find((s) => s.id === pid); }

  // ---------- 알림 ----------
  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  // ---------- 계산 엔진 ----------
  async function initSolver() {
    if (location.protocol === 'file:') {
      solverError = '이 파일을 더블클릭해서 열면 근무표를 만들 수 없어요. 웹 주소(https)로 열어 주세요.';
      render();
      return;
    }
    try {
      highs = await window.Module({ locateFile: (f) => 'vendor/' + f });
    } catch (e) {
      solverError = '계산 엔진을 불러오지 못했어요. 인터넷 연결을 확인하고 새로고침해 주세요.';
    }
    render();
    if (highs && store.firstRun) {
      store.firstRun = false;
      if (!Object.keys(month().auto || {}).length) generate(false);
    }
  }

  function checkWith(auto) {
    const ym = store.current;
    const tmp = Object.assign({}, store, {
      months: Object.assign({}, store.months, { [ym]: Object.assign({}, month(), { auto }) }),
    });
    return R.check(store.config, tmp, ym);
  }

  function generate(alt) {
    if (busy) return;
    if (!highs) {
      toast(solverError || '계산 엔진을 불러오는 중이에요. 잠시 후 다시 눌러 주세요.');
      return;
    }
    busy = true;
    const btn = alt ? $('altBtn') : $('genBtn');
    btn.setAttribute('aria-busy', 'true');
    btn.querySelector('span').textContent = '만드는 중…';
    setTimeout(() => {
      let res;
      try {
        const seed = alt ? 1 + Math.floor(Math.random() * 1e9) : 0;
        res = R.solve(highs, store.config, store, store.current, seed);
      } catch (e) {
        res = { ok: false, status: String((e && e.message) || e) };
      }
      busy = false;
      btn.removeAttribute('aria-busy');
      btn.querySelector('span').textContent = alt ? '다른 안 보기' : '근무표 만들기';
      focusIdx = null;
      if (res.ok) {
        month().auto = res.auto;
        pending = null;
        justGenerated = true;
        save();
        render();
        toast(alt ? '다른 안을 만들었어요' : '근무표를 만들었어요');
      } else if (res.infeasible) {
        pending = { ym: store.current, auto: res.candidate, report: checkWith(res.candidate) };
        render();
        toast('조건 안에서는 만들 수 없어요. 이유를 확인하세요.');
        $('checkTitle').scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else {
        toast('근무표를 만들지 못했어요 (' + res.status + ')');
      }
    }, 30);
  }

  // ---------- 그리기 ----------
  function render() {
    const ym = store.current;
    const { y, m } = R.parseYm(ym);
    $('monthLabel').textContent = `${y}년 ${m}월`;
    $('paperYm').textContent = `< ${y}년 ${m}월 >`;
    month();
    if (pending && pending.ym !== ym) pending = null;
    report = R.check(store.config, store, ym);
    renderSheet();
    renderReport();
    renderStats();
  }

  function cellMarks() {
    const bad = new Set();
    const warn = new Set();
    const focus = new Set();
    for (const v of report.hard) for (const c of v.cells) bad.add(c.join('|'));
    for (const v of report.soft) for (const c of v.cells) warn.add(c.join('|'));
    if (focusIdx) {
      const v = report[focusIdx.list][focusIdx.i];
      if (v) for (const c of v.cells) focus.add(c.join('|'));
    }
    return { bad, warn, focus };
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderSheet() {
    const ym = store.current;
    const cfg = store.config;
    const mo = month();
    const days = R.monthDays(cfg, ym, mo);
    const marks = cellMarks();
    const hdAttr = (d) => {
      if (!d) return '';
      const can = R.workingDay(cfg, d.w);
      const cls = (d.holiday ? ' hol' : '') + (can ? ' hd' : '');
      const label = d.holiday ? `${R.dayLabel(ym, d.d)} 휴일. 누르면 근무일로 되돌려요` : `${R.dayLabel(ym, d.d)}. 누르면 휴일로 바꿔요`;
      return can ? ` class="CLS${cls}" data-hd="${d.d}" tabindex="0" role="button" aria-label="${label}"` : ` class="CLS${cls}"`;
    };
    let h = '<thead><tr><th class="corner" rowspan="2" aria-label="이름"></th>';
    for (let i = 0; i < 31; i++) {
      const d = days[i];
      h += `<th${hdAttr(d).replace('CLS', 'dnum') || ' class="dnum"'}>${d ? d.d : ''}</th>`;
    }
    h += '<th colspan="2" class="dnum" style="font-family:var(--font-ui);font-weight:700">비고</th></tr><tr>';
    for (let i = 0; i < 31; i++) {
      const d = days[i];
      h += `<th${(hdAttr(d).replace('CLS', 'dyo' + (d && d.w === 0 ? ' sun' : '')) || ' class="dyo"')}>${d ? R.YO[d.w] : ''}</th>`;
    }
    h += '<th class="dyo"></th><th class="dyo vert" style="font-family:var(--font-paper);font-weight:400">연<br>차</th></tr></thead><tbody>';
    for (const s of cfg.staff) {
      h += `<tr><th class="nm" scope="row">${esc(s.name)}</th>`;
      for (let i = 0; i < 31; i++) {
        const d = days[i];
        if (!d) { h += '<td class="blank31 none"></td>'; continue; }
        if (d.closed) { h += `<td class="sun" aria-label="${d.holiday ? '휴일' : '쉬는 날'}"></td>`; continue; }
        const c = R.cellOf(mo, s.id, d.d);
        const key = s.id + '|' + d.d;
        const cls = ['c'];
        if (c.fixed) cls.push('fixed');
        if (c.v === 'O') cls.push('off');
        if (marks.focus.has(key)) cls.push('focus');
        else if (marks.bad.has(key)) cls.push('bad');
        else if (marks.warn.has(key)) cls.push('warn');
        const label = `${s.name} ${R.dayLabel(ym, d.d)} ${c.v ? R.LABEL[c.v] : '빈 칸'}${c.fixed ? ' 고정' : ''}`;
        h += `<td class="${cls.join(' ')}" data-p="${s.id}" data-d="${d.d}" tabindex="0" role="button" aria-label="${esc(label)}">${c.v ? R.LABEL[c.v] : ''}</td>`;
      }
      const note = (mo.notes && mo.notes[s.id]) || '';
      const leave = (mo.leave && mo.leave[s.id]) || '';
      h += `<td class="note" data-note="${s.id}" tabindex="0" role="button" aria-label="${esc(s.name)} 비고">${esc(note)}</td>`;
      h += `<td class="leave" data-note="${s.id}" tabindex="0" role="button" aria-label="${esc(s.name)} 연차">${esc(leave)}</td></tr>`;
    }
    h += '<tr><th class="nm" scope="row"></th>';
    for (let i = 0; i < 31; i++) {
      const d = days[i];
      h += `<td class="${d && d.closed ? 'sun' : 'none'}" style="height:44px"></td>`;
    }
    h += '<td class="none"></td><td class="none"></td></tr></tbody>';
    $('sheet').innerHTML = h;
  }

  function item(v, list, i, clickable) {
    const pressed = focusIdx && focusIdx.list === list && focusIdx.i === i;
    const extra = v.days > 1 && v.pid ? ` (오차 ${v.days}일)` : '';
    return `<li><button type="button"${clickable ? ` data-list="${list}" data-i="${i}" aria-pressed="${pressed}"` : ' disabled'}>` +
      `<span class="chip${list === 'soft' ? ' soft' : ''}">${RULE_CHIP[v.rule] || v.rule}</span><span>${esc(v.msg)}${extra}</span></button></li>`;
  }

  function tolLines(rep, onlyOver) {
    return rep.tolerance
      .filter((t) => (onlyOver ? t.used > t.allowed : t.used > 0))
      .map((t) => `<li><button type="button" disabled><span class="chip tol">오차</span><span>${esc(t.name)}: ${t.used}일 ${onlyOver ? '필요' : '사용'} (허용 ${t.allowed}일)</span></button></li>`)
      .join('');
  }

  function renderReport() {
    const banner = $('banner');
    const r = report;
    const mo = month();
    const nFixed = Object.values(mo.fixed || {}).reduce((a, o) => a + Object.keys(o).length, 0);
    let hardHtml = r.hard.map((v, i) => item(v, 'hard', i, true)).join('');

    if (pending) {
      const p = pending.report;
      banner.className = 'banner bad';
      banner.innerHTML = `<strong>지금 조건과 허용 오차로는 근무표를 만들 수 없어요</strong>
        <span>아래만큼 어기면 만들 수 있어요. 허용 오차를 늘리거나, 조건을 '가능하면'으로 바꾸거나, 신청을 조정해 보세요.</span>
        <div class="bactions"><button type="button" class="btn" data-bact="apply">이 안이라도 적용</button>
        <button type="button" class="btn" data-bact="settings">설정 열기</button>
        <button type="button" class="btn" data-bact="dismiss">닫기</button></div>`;
      hardHtml = p.hard.map((v, i) => item(v, 'hard', i, false)).join('') + tolLines(p, true);
    } else if (r.filled === 0 || (r.empty > 0 && !Object.keys(mo.auto || {}).length)) {
      banner.className = 'banner info';
      banner.innerHTML = `<strong>아직 근무표가 없어요</strong><span>신청한 칸 ${nFixed}개. 칸을 눌러 신청을 넣고 [근무표 만들기]를 누르세요.${solverError ? ' ' + esc(solverError) : ''}</span>`;
    } else if (r.empty > 0) {
      banner.className = 'banner info';
      banner.innerHTML = `<strong>빈 칸이 ${r.empty}개 있어요</strong><span>[근무표 만들기]를 누르면 나머지를 채워요.</span>`;
    } else if (!r.hard.length) {
      banner.className = 'banner ok';
      banner.innerHTML = `<strong>필수 조건을 모두 지켰어요</strong><span>${r.soft.length ? `가능하면 지킬 것 ${r.soft.length}건은 아래에서 확인하세요.` : '가능하면 지킬 것까지 모두 맞췄어요.'}</span>`;
    } else if (r.withinTolerance) {
      banner.className = 'banner warn';
      banner.innerHTML = `<strong>허용 오차 안에서 만들었어요</strong><span>오차를 쓴 곳 ${r.hard.length}건이에요. 항목을 누르면 표에서 보여줘요.</span>`;
      hardHtml += tolLines(r, false);
    } else {
      banner.className = 'banner bad';
      banner.innerHTML = `<strong>조건에 어긋난 곳이 ${r.hard.length}건 있어요</strong><span>${justGenerated ? '적용한 안이에요. ' : ''}항목을 누르면 표에서 해당 칸을 보여줘요.</span>`;
      hardHtml += tolLines(r, true);
    }
    $('hardList').innerHTML = hardHtml;
    $('softList').innerHTML = pending ? '' : r.soft.map((v, i) => item(v, 'soft', i, true)).join('');
    $('softHead').hidden = pending || !r.soft.length;
    $('carryList').innerHTML = r.carry.map((c) => `<li><button type="button" disabled><span class="chip carry">이월</span><span>${esc(c)}</span></button></li>`).join('');
    $('carryHead').hidden = !r.carry.length;
  }

  function renderStats() {
    const cfg = store.config;
    const r = report;
    const cats = cfg.balance;
    const balanceOn = R.isOn(cfg.rules.balance);
    const spread = {};
    for (const cat of cats) {
      const group = cfg.staff.filter((s) => !(s.balanceExclude || []).includes(cat.key));
      const vals = group.map((s) => r.stats.find((x) => x.id === s.id)[cat.key]);
      spread[cat.key] = vals.length
        ? { hi: Math.max(...vals), lo: Math.min(...vals), big: balanceOn && cat.on && Math.max(...vals) - Math.min(...vals) >= 2 }
        : { big: false };
    }

    // 기본 근무 형태는 균등 설정과 관계없이 항상 보여 준다.
    // E/N/전체 off가 균등 항목에도 있어도 열은 중복 표시하지 않는다.
    const base = [
      { key: 'work', label: '근무' },
      { key: 'D', label: 'D' },
      { key: 'E', label: 'E' },
      { key: 'N', label: 'N' },
      { key: 'O', label: 'off' },
    ];
    const extra = cats.filter((cat) => !['D', 'E', 'N', 'O'].includes(cat.key));
    const columns = base.concat(extra);

    function cell(row, s, key) {
      const cat = cats.find((c) => c.key === key);
      const excluded = !!cat && (s.balanceExclude || []).includes(key);
      const sp = spread[key];
      const warn = !!cat && !excluded && r.complete && sp && sp.big && (row[key] === sp.hi || row[key] === sp.lo);
      return `<td class="${excluded ? 'ex' : warn ? 'hi' : ''}">${row[key] || 0}</td>`;
    }

    let h = '<thead><tr><th scope="col">이름</th>';
    for (const col of columns) h += `<th scope="col">${esc(col.label)}</th>`;
    h += '</tr></thead><tbody>';
    for (const row of r.stats) {
      const s = staffById(row.id);
      h += `<tr><th scope="row">${esc(row.name)}</th>`;
      for (const col of columns) h += cell(row, s, col.key);
      h += '</tr>';
    }
    h += '<tr class="stats-total"><th scope="row">합계</th>';
    for (const col of columns) {
      const sum = r.stats.reduce((n, row) => n + (Number(row[col.key]) || 0), 0);
      h += `<td>${sum}</td>`;
    }
    $('stats').innerHTML = h + '</tr></tbody>';
  }

  // ---------- 아래 창 ----------
  let openPanelEl = null;
  let lastFocus = null;
  function openPanel(el) {
    closePanel();
    lastFocus = document.activeElement;
    $('scrim').hidden = false;
    el.hidden = false;
    openPanelEl = el;
    const first = el.querySelector('button, textarea, input');
    if (first) first.focus();
  }
  function closePanel() {
    if (!openPanelEl) return;
    openPanelEl.hidden = true;
    openPanelEl = null;
    $('scrim').hidden = true;
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }

  let editing = null;
  function openCell(pid, d) {
    const s = staffById(pid);
    const c = R.cellOf(month(), pid, d);
    editing = { pid, d };
    $('cellTitle').textContent = `${R.dayLabel(store.current, d)} · ${s.name}`;
    let sub = c.v
      ? (c.fixed ? `지금: ${R.LABEL[c.v]} (고정)` : `지금: ${R.LABEL[c.v]} (자동으로 채운 칸)`)
      : '지금: 빈 칸. 고르면 신청으로 고정돼요.';
    if (R.unavail(s, R.weekday(store.current, d))) sub += ' · 설정에서 이 요일은 근무 안 함으로 정한 사람이에요.';
    $('cellSub').textContent = sub;
    for (const b of $('choices').querySelectorAll('button')) b.classList.toggle('cur', b.dataset.v === c.v);
    $('unfixBtn').hidden = !c.fixed;
    openPanel($('cellPanel'));
  }
  function edited() {
    justGenerated = false;
    pending = null;
    save();
    render();
  }
  function setCell(v) {
    if (!editing) return;
    const mo = month();
    const { pid, d } = editing;
    (mo.fixed[pid] = mo.fixed[pid] || {})[d] = v;
    if (mo.auto[pid]) delete mo.auto[pid][d];
    closePanel();
    edited();
  }
  function unfixCell() {
    if (!editing) return;
    const mo = month();
    const { pid, d } = editing;
    const v = mo.fixed[pid] && mo.fixed[pid][d];
    if (v) {
      delete mo.fixed[pid][d];
      (mo.auto[pid] = mo.auto[pid] || {})[d] = v;
    }
    closePanel();
    edited();
  }

  function toggleHoliday(d) {
    const mo = month();
    const set = new Set(mo.holidays || []);
    const on = !set.has(d);
    if (on) set.add(d); else set.delete(d);
    mo.holidays = [...set].sort((a, b) => a - b);
    edited();
    S.refresh();
    toast(on ? `${R.dayLabel(store.current, d)}을 휴일로 정했어요` : `${R.dayLabel(store.current, d)}을 근무일로 되돌렸어요`);
  }

  let notePid = null;
  function openNote(pid) {
    notePid = pid;
    const mo = month();
    $('noteTitle').textContent = `${staffById(pid).name} · 비고와 연차`;
    $('noteText').value = (mo.notes && mo.notes[pid]) || '';
    $('leaveText').value = (mo.leave && mo.leave[pid]) || '';
    openPanel($('notePanel'));
  }
  function saveNote() {
    const mo = month();
    mo.notes[notePid] = $('noteText').value.trim();
    mo.leave[notePid] = $('leaveText').value.trim();
    closePanel();
    save();
    render();
  }

  let confirmAction = null;
  function ask(title, sub, okLabel, fn) {
    $('confirmTitle').textContent = title;
    $('confirmSub').textContent = sub;
    $('confirmOk').textContent = okLabel;
    confirmAction = fn;
    openPanel($('confirmPanel'));
  }

  // ---------- 이미지 ----------
  function exportOptions() {
    store.exportOptions = store.exportOptions || { holidayRed: false };
    return store.exportOptions;
  }

  // 옵션을 바꿀 때마다 다시 그린다. 늦게 끝난 이전 그리기가 새 결과를 덮지 않게 순번을 둔다.
  let previewSeq = 0;
  async function refreshPreview() {
    const seq = ++previewSeq;
    const img = $('previewImg');
    img.setAttribute('aria-busy', 'true');
    const canvas = await X.render(store, store.current, exportOptions());
    const blob = await X.toBlob(canvas);
    if (seq !== previewSeq) return;
    previewBlob = blob;
    const url = URL.createObjectURL(blob);
    if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
    img.src = url;
    img.dataset.url = url;
    $('printImg').src = url;
    img.removeAttribute('aria-busy');
  }

  async function openPreview() {
    toast('이미지를 만드는 중이에요');
    previewBlob = null;
    $('optHolidayRed').checked = !!exportOptions().holidayRed;
    await refreshPreview();
    $('previewHint').textContent = X.isIOS()
      ? '‘앨범에 저장’을 누르면 공유창이 열려요. 거기서 ‘이미지 저장’을 누르면 사진 앱에 들어가요. 사진을 길게 눌러 저장해도 돼요.'
      : '저장하면 갤러리의 ‘다운로드’ 앨범에 들어가요. 사진을 길게 눌러 저장해도 돼요.';
    $('preview').hidden = false;
    document.documentElement.classList.add('locked');
    $('toast').hidden = true;
    $('shareBtn').focus();
  }
  function title() {
    const { m } = R.parseYm(store.current);
    return `${m}월 근무표`;
  }

  // ---------- 백업 ----------
  function exportBackup() {
    const blob = new Blob([JSON.stringify(store, null, 1)], { type: 'application/json' });
    const d = new Date();
    const name = `근무표_백업_${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`;
    X.share(blob, name, '근무표 백업').then((r) => {
      if (r === 'downloaded') toast('백업 파일을 내려받았어요');
    });
  }
  function importBackup(file) {
    const fr = new FileReader();
    fr.onload = () => {
      let data;
      try {
        data = JSON.parse(fr.result);
      } catch (e) {
        toast('백업 파일을 읽지 못했어요. 이 앱에서 만든 .json 파일인지 확인하세요.');
        return;
      }
      if (!data || !data.config || !data.months || !Array.isArray(data.config.staff)) {
        toast('근무표 백업 파일이 아니에요');
        return;
      }
      const n = Object.keys(data.months).length;
      ask('백업 파일로 바꿀까요?', `지금 이 기기에 있는 근무표와 설정이 백업 파일 내용(${n}개월)으로 바뀌어요.`, '바꾸기', () => {
        store = R.normalize(data);
        store.firstRun = false;
        if (!store.current) store.current = Object.keys(store.months).sort().pop();
        justGenerated = false;
        pending = null;
        focusIdx = null;
        save();
        render();
        toast('백업 파일을 불러왔어요');
      });
    };
    fr.readAsText(file);
  }

  // ---------- 설정 화면 연결 ----------
  S.init({
    store: () => store,
    month,
    save,
    changed: () => {
      pending = null;
      justGenerated = false;
      focusIdx = null;
      render();
    },
    ask,
    toast,
  });

  // ---------- 이벤트 ----------
  $('genBtn').addEventListener('click', () => generate(false));
  $('altBtn').addEventListener('click', () => generate(true));
  $('imgBtn').addEventListener('click', openPreview);
  $('settingsBtn').addEventListener('click', () => S.open());
  $('prevMonth').addEventListener('click', () => moveMonth(-1));
  $('nextMonth').addEventListener('click', () => moveMonth(1));
  function moveMonth(delta) {
    store.current = R.shiftYm(store.current, delta);
    justGenerated = false;
    pending = null;
    focusIdx = null;
    month();
    save();
    render();
  }

  $('sheet').addEventListener('click', (e) => {
    const hd = e.target.closest('th[data-hd]');
    if (hd) { toggleHoliday(+hd.dataset.hd); return; }
    const td = e.target.closest('td');
    if (!td) return;
    if (td.dataset.p) openCell(td.dataset.p, +td.dataset.d);
    else if (td.dataset.note) openNote(td.dataset.note);
  });
  $('sheet').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = e.target.closest('td, th[data-hd]');
    if (!el) return;
    e.preventDefault();
    el.click();
  });
  $('choices').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) setCell(b.dataset.v);
  });
  $('unfixBtn').addEventListener('click', unfixCell);
  $('noteSave').addEventListener('click', saveNote);
  $('confirmOk').addEventListener('click', () => {
    const fn = confirmAction;
    confirmAction = null;
    closePanel();
    if (fn) fn();
  });
  $('scrim').addEventListener('click', closePanel);
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closePanel));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (openPanelEl) closePanel();
    else if (!$('preview').hidden) closePreview();
    else if (S.isOpen()) S.close();
    toggleMenu(false);
  });

  $('banner').addEventListener('click', (e) => {
    const b = e.target.closest('[data-bact]');
    if (!b) return;
    if (b.dataset.bact === 'apply' && pending) {
      month().auto = pending.auto;
      pending = null;
      justGenerated = true;
      save();
      render();
      toast('어긴 곳이 있는 안을 적용했어요');
    } else if (b.dataset.bact === 'settings') {
      S.open('people');
    } else if (b.dataset.bact === 'dismiss') {
      pending = null;
      render();
    }
  });

  const listClick = (e) => {
    const b = e.target.closest('button[data-list]');
    if (!b) return;
    const sel = { list: b.dataset.list, i: +b.dataset.i };
    focusIdx = focusIdx && focusIdx.list === sel.list && focusIdx.i === sel.i ? null : sel;
    renderSheet();
    renderReport();
    const first = document.querySelector('#sheet td.focus');
    if (first) first.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  };
  $('hardList').addEventListener('click', listClick);
  $('softList').addEventListener('click', listClick);

  function toggleMenu(open) {
    const menu = $('moreMenu');
    const show = open === undefined ? menu.hidden : open;
    menu.hidden = !show;
    $('moreBtn').setAttribute('aria-expanded', String(show));
  }
  $('moreBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
  document.addEventListener('click', (e) => { if (!e.target.closest('.more')) toggleMenu(false); });
  $('clearAutoBtn').addEventListener('click', () => {
    toggleMenu(false);
    ask('자동으로 채운 칸을 비울까요?', '신청했거나 직접 고친 파란 칸은 그대로 남아요.', '비우기', () => {
      month().auto = {};
      focusIdx = null;
      edited();
    });
  });
  $('exportBtn').addEventListener('click', () => { toggleMenu(false); exportBackup(); });
  $('importBtn').addEventListener('click', () => { toggleMenu(false); $('importFile').click(); });
  $('importFile').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) importBackup(f);
    e.target.value = '';
  });

  function closePreview() {
    $('preview').hidden = true;
    if (!S.isOpen()) document.documentElement.classList.remove('locked');
  }
  $('previewClose').addEventListener('click', closePreview);
  $('optHolidayRed').addEventListener('change', (e) => {
    exportOptions().holidayRed = e.target.checked;
    save();
    refreshPreview();
  });
  $('shareBtn').addEventListener('click', async () => {
    if (!previewBlob) return;
    const r = await X.share(previewBlob, X.fileName(store.current), title());
    if (r === 'downloaded') toast('이 기기에서는 공유창을 열 수 없어 파일로 내려받았어요');
  });
  $('saveBtn').addEventListener('click', async () => {
    if (!previewBlob) return;
    const r = await X.save(previewBlob, X.fileName(store.current), title());
    if (r === 'downloaded') toast('이미지를 저장했어요');
  });
  $('printBtn').addEventListener('click', () => window.print());

  render();
  initSolver();
  X.ensureFonts();
})();
