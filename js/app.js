// 화면: 근무표 표시, 칸 수정, 생성, 점검 결과, 저장, 이미지 내보내기.
(function () {
  'use strict';
  const R = window.Roster;
  const X = window.RosterExport;
  const KEY = 'nurse-roster-v1';
  const $ = (id) => document.getElementById(id);

  const RULE_CHIP = {
    coverage: '인원', seniorDaily: '선임 D', noOffUnlessRequested: '신청 외 off', allowed: '근무 종류',
    offAfterN: 'N 다음날', maxConsecD: 'D 연속', weeklyOff: '주 off', nRange: 'N 횟수',
    avoidConsecOff: 'off 연속', balance: '균등',
  };

  let store = load();
  let highs = null;
  let solverError = null;
  let report = null;
  let focusIdx = null; // 선택한 위반 항목 {list, i}
  let justGenerated = false;
  let busy = false;
  let previewBlob = null;

  // ---------- 저장 ----------
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s && s.config && s.months) return s;
      }
    } catch (e) { /* 기본 데이터로 시작 */ }
    const s = clone(window.RosterSeed);
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
        res = { ok: false, status: String(e && e.message || e) };
      }
      busy = false;
      btn.removeAttribute('aria-busy');
      btn.querySelector('span').textContent = alt ? '다른 안 보기' : '근무표 만들기';
      if (!res.ok) {
        toast('근무표를 만들지 못했어요 (' + res.status + ')');
        return;
      }
      month().auto = res.auto;
      justGenerated = true;
      focusIdx = null;
      save();
      render();
      toast(alt ? '다른 안을 만들었어요' : '근무표를 만들었어요');
    }, 30);
  }

  // ---------- 그리기 ----------
  function render() {
    const ym = store.current;
    const { y, m } = R.parseYm(ym);
    $('monthLabel').textContent = `${y}년 ${m}월`;
    $('paperYm').textContent = `< ${y}년 ${m}월 >`;
    month();
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
    const mo = month();
    const days = R.monthDays(store.config, ym, mo);
    const marks = cellMarks();
    let h = '<thead><tr><th class="corner" rowspan="2" aria-label="이름"></th>';
    for (let i = 0; i < 31; i++) h += `<th class="dnum">${days[i] ? days[i].d : ''}</th>`;
    h += '<th colspan="2" class="dnum" style="font-family:var(--font-ui);font-weight:700">비고</th></tr><tr>';
    for (let i = 0; i < 31; i++) {
      const d = days[i];
      h += `<th class="dyo${d && d.w === 0 ? ' sun' : ''}">${d ? R.YO[d.w] : ''}</th>`;
    }
    h += '<th class="dyo"></th><th class="dyo vert" style="font-family:var(--font-paper);font-weight:400">연<br>차</th></tr></thead><tbody>';
    for (const s of store.config.staff) {
      h += `<tr><th class="nm" scope="row">${esc(s.name)}</th>`;
      for (let i = 0; i < 31; i++) {
        const d = days[i];
        if (!d) { h += '<td class="blank31 none"></td>'; continue; }
        if (d.closed) { h += '<td class="sun" aria-label="쉬는 날"></td>'; continue; }
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

  function renderReport() {
    const banner = $('banner');
    const r = report;
    const nFixed = Object.values(month().fixed || {}).reduce((a, o) => a + Object.keys(o).length, 0);
    if (r.filled === 0 || (r.empty > 0 && !Object.keys(month().auto || {}).length)) {
      banner.className = 'banner info';
      banner.innerHTML = `<strong>아직 근무표가 없어요</strong><span>신청한 칸 ${nFixed}개. 칸을 눌러 신청을 넣고 [근무표 만들기]를 누르세요.${solverError ? ' ' + esc(solverError) : ''}</span>`;
    } else if (r.empty > 0) {
      banner.className = 'banner info';
      banner.innerHTML = `<strong>빈 칸이 ${r.empty}개 있어요</strong><span>[근무표 만들기]를 누르면 나머지를 채워요.</span>`;
    } else if (!r.hard.length) {
      banner.className = 'banner ok';
      banner.innerHTML = `<strong>필수 조건을 모두 지켰어요</strong><span>${r.soft.length ? `가능하면 지킬 것 ${r.soft.length}건은 아래에서 확인하세요.` : '가능하면 지킬 것까지 모두 맞췄어요.'}</span>`;
    } else if (justGenerated) {
      banner.className = 'banner bad';
      banner.innerHTML = `<strong>모든 조건을 지키는 근무표는 만들 수 없어요</strong><span>가장 적게 어긴 안이에요. 어긴 곳 ${r.hard.length}건을 눌러 확인하세요.</span>`;
    } else {
      banner.className = 'banner bad';
      banner.innerHTML = `<strong>조건에 어긋난 곳이 ${r.hard.length}건 있어요</strong><span>항목을 누르면 표에서 해당 칸을 보여줘요.</span>`;
    }
    const item = (v, list, i) => {
      const pressed = focusIdx && focusIdx.list === list && focusIdx.i === i;
      return `<li><button type="button" data-list="${list}" data-i="${i}" aria-pressed="${pressed}">` +
        `<span class="chip${list === 'soft' ? ' soft' : ''}">${RULE_CHIP[v.rule] || v.rule}</span><span>${esc(v.msg)}</span></button></li>`;
    };
    $('hardList').innerHTML = r.hard.map((v, i) => item(v, 'hard', i)).join('');
    $('softList').innerHTML = r.soft.map((v, i) => item(v, 'soft', i)).join('');
    $('softHead').hidden = !r.soft.length;
    $('carryList').innerHTML = r.carry.map((c) => `<li><button type="button" disabled><span class="chip carry">이월</span><span>${esc(c)}</span></button></li>`).join('');
    $('carryHead').hidden = !r.carry.length;
  }

  function renderStats() {
    const cfg = store.config;
    const r = report;
    const cats = cfg.balance;
    const spread = {};
    for (const cat of cats) {
      const group = cfg.staff.filter((s) => !(s.balanceExclude || []).includes(cat.key));
      const vals = group.map((s) => r.stats.find((x) => x.id === s.id)[cat.key]);
      spread[cat.key] = { hi: Math.max(...vals), lo: Math.min(...vals), big: Math.max(...vals) - Math.min(...vals) >= 2 };
    }
    let h = '<thead><tr><th>이름</th><th>근무</th><th>D</th><th>off</th>';
    for (const cat of cats) h += `<th>${esc(cat.label)}</th>`;
    h += '</tr></thead><tbody>';
    for (const row of r.stats) {
      const s = staffById(row.id);
      h += `<tr><td>${esc(row.name)}</td><td>${row.work}</td><td>${row.D}</td><td>${row.O}</td>`;
      for (const cat of cats) {
        const ex = (s.balanceExclude || []).includes(cat.key);
        const sp = spread[cat.key];
        const hi = !ex && r.complete && sp.big && (row[cat.key] === sp.hi || row[cat.key] === sp.lo);
        h += `<td class="${ex ? 'ex' : hi ? 'hi' : ''}">${row[cat.key]}</td>`;
      }
      h += '</tr>';
    }
    $('stats').innerHTML = h + '</tbody>';
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
    $('cellSub').textContent = c.v
      ? (c.fixed ? `지금: ${R.LABEL[c.v]} (고정)` : `지금: ${R.LABEL[c.v]} (자동으로 채운 칸)`)
      : '지금: 빈 칸. 고르면 신청으로 고정돼요.';
    for (const b of $('choices').querySelectorAll('button')) b.classList.toggle('cur', b.dataset.v === c.v);
    $('unfixBtn').hidden = !c.fixed;
    openPanel($('cellPanel'));
  }
  function setCell(v) {
    if (!editing) return;
    const mo = month();
    const { pid, d } = editing;
    (mo.fixed[pid] = mo.fixed[pid] || {})[d] = v;
    if (mo.auto[pid]) delete mo.auto[pid][d];
    justGenerated = false;
    closePanel();
    save();
    render();
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
    justGenerated = false;
    closePanel();
    save();
    render();
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
    mo.notes = mo.notes || {};
    mo.leave = mo.leave || {};
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
  async function openPreview() {
    toast('이미지를 만드는 중이에요');
    const canvas = await X.render(store, store.current);
    previewBlob = await X.toBlob(canvas);
    const url = URL.createObjectURL(previewBlob);
    const img = $('previewImg');
    if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
    img.src = url;
    img.dataset.url = url;
    $('printImg').src = url;
    $('previewHint').textContent = X.isIOS()
      ? '‘앨범에 저장’을 누르면 공유창이 열려요. 거기서 ‘이미지 저장’을 누르면 사진 앱에 들어가요. 사진을 길게 눌러 저장해도 돼요.'
      : '저장하면 갤러리의 ‘다운로드’ 앨범에 들어가요. 사진을 길게 눌러 저장해도 돼요.';
    $('preview').hidden = false;
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
      ask('백업 파일로 바꿀까요?', `지금 휴대폰에 있는 근무표가 백업 파일 내용(${n}개월)으로 바뀌어요.`, '바꾸기', () => {
        store = data;
        store.firstRun = false;
        if (!store.current) store.current = Object.keys(store.months).sort().pop();
        justGenerated = false;
        focusIdx = null;
        save();
        render();
        toast('백업 파일을 불러왔어요');
      });
    };
    fr.readAsText(file);
  }

  // ---------- 이벤트 ----------
  $('genBtn').addEventListener('click', () => generate(false));
  $('altBtn').addEventListener('click', () => generate(true));
  $('imgBtn').addEventListener('click', openPreview);
  $('prevMonth').addEventListener('click', () => moveMonth(-1));
  $('nextMonth').addEventListener('click', () => moveMonth(1));
  function moveMonth(delta) {
    store.current = R.shiftYm(store.current, delta);
    justGenerated = false;
    focusIdx = null;
    month();
    save();
    render();
  }

  $('sheet').addEventListener('click', (e) => {
    const td = e.target.closest('td');
    if (!td) return;
    if (td.dataset.p) openCell(td.dataset.p, +td.dataset.d);
    else if (td.dataset.note) openNote(td.dataset.note);
  });
  $('sheet').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const td = e.target.closest('td');
    if (!td) return;
    e.preventDefault();
    td.click();
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
    if (!$('preview').hidden) $('preview').hidden = true;
    else closePanel();
    toggleMenu(false);
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
      justGenerated = false;
      focusIdx = null;
      save();
      render();
    });
  });
  $('exportBtn').addEventListener('click', () => { toggleMenu(false); exportBackup(); });
  $('importBtn').addEventListener('click', () => { toggleMenu(false); $('importFile').click(); });
  $('importFile').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) importBackup(f);
    e.target.value = '';
  });

  $('previewClose').addEventListener('click', () => { $('preview').hidden = true; });
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
