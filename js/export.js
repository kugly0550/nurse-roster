// 종이 양식(A4 가로) 그대로 PNG 이미지를 그린다. 저장·공유·인쇄에 같은 이미지를 쓴다.
(function (g) {
  'use strict';
  const R = g.Roster;

  const W = 3508; // A4 가로 300dpi
  const H = 2480;
  const SERIF = '"Nanum Myeongjo", "Batang", "AppleMyungjo", serif';
  const SANS = '"IBM Plex Sans KR", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';

  // 앱을 열 때 미리 불러 두어 이미지 만들 때 기다리지 않게 한다.
  let fontsReady = null;
  function ensureFonts(names) {
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    if (fontsReady && !names) return fontsReady;
    const sample = '간호사SCHEDULE년월일화수목금토비고연차0123456789offDEN<>' + (names || '');
    const p = Promise.race([
      Promise.all([
        document.fonts.load(`800 60px ${SERIF}`, sample),
        document.fonts.load(`400 60px ${SERIF}`, sample),
        document.fonts.load(`700 60px ${SANS}`, sample),
        document.fonts.load(`400 34px ${SANS}`, sample),
      ]),
      new Promise((res) => setTimeout(res, 3000)),
    ]).catch(() => { /* 시스템 글꼴로 그린다 */ });
    if (!names) fontsReady = p;
    return p;
  }

  function line(ctx, x1, y1, x2, y2, w) {
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  function wrapText(ctx, text, maxW) {
    const out = [];
    for (const para of String(text).split('\n')) {
      let cur = '';
      for (const ch of para) {
        if (ctx.measureText(cur + ch).width > maxW && cur) { out.push(cur); cur = ch; } else cur += ch;
      }
      out.push(cur);
    }
    return out;
  }

  async function render(store, ym) {
    const cfg = store.config;
    const month = store.months[ym];
    await ensureFonts();
    await ensureFonts(cfg.staff.map((s) => s.name).join('') +
      Object.values(month.notes || {}).join('') + Object.values(month.leave || {}).join(''));
    const { y, m } = R.parseYm(ym);
    const days = R.monthDays(cfg, ym, month);
    const staff = cfg.staff;

    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#111';
    ctx.strokeStyle = '#1a1a1a';
    ctx.textBaseline = 'middle';

    // 표 배치
    const x0 = 230;
    const x1 = W - 200;
    const nameW = 230;
    const noteW = 250;
    const leaveW = 100;
    const dayW = (x1 - x0 - nameW - noteW - leaveW) / 31;
    const y0 = 470;
    const h1 = 120;
    const h2 = 170;
    const rowsN = staff.length + 1;
    const rowH = Math.min(230, (H - 180 - y0 - h1 - h2) / rowsN);
    const yBody = y0 + h1 + h2;
    const y1 = yBody + rowH * rowsN;
    const colX = (i) => x0 + nameW + dayW * i; // i: 0..31
    const noteX = colX(31);
    const leaveX = noteX + noteW;

    // 제목
    ctx.textAlign = 'left';
    ctx.font = `400 64px ${SERIF}`;
    ctx.fillText(`<  ${y}년 ${m}월  >`, x0 + 150, 300);
    ctx.textAlign = 'center';
    ctx.font = `800 140px ${SERIF}`;
    ctx.fillText('간호사 SCHEDULE', (x0 + x1) / 2 + 60, 290);

    // 격자
    ctx.lineCap = 'square';
    line(ctx, x0, y0, x1, y0, 4);
    line(ctx, x0, y1, x1, y1, 4);
    line(ctx, x0, y0, x0, y1, 4);
    line(ctx, x1, y0, x1, y1, 4);
    line(ctx, x0 + nameW, y0, x0 + nameW, y1, 6);
    line(ctx, x0 + nameW, y0 + h1, x1, y0 + h1, 2.5);
    line(ctx, x0, yBody, x1, yBody, 3);
    for (let r = 1; r < rowsN; r++) line(ctx, x0, yBody + rowH * r, x1, yBody + rowH * r, 2.5);
    for (let i = 1; i <= 31; i++) line(ctx, colX(i), y0, colX(i), y1, 2.5);
    line(ctx, leaveX, y0 + h1, leaveX, y1, 2.5);
    // 왼쪽 위 대각선
    line(ctx, x0, y0, x0 + nameW, yBody, 2.5);

    // 날짜·요일 머리
    for (let i = 0; i < 31; i++) {
      const cx = colX(i) + dayW / 2;
      const day = days[i];
      if (!day) continue;
      ctx.font = `400 50px ${SERIF}`;
      ctx.fillText(String(day.d), cx, y0 + h1 / 2 + 2);
      ctx.font = `700 52px ${SANS}`;
      ctx.fillText(R.YO[day.w], cx, y0 + h1 + h2 / 2);
      if (day.w === 0) line(ctx, colX(i), yBody, colX(i + 1), yBody, 7);
    }
    ctx.font = `700 46px ${SANS}`;
    ctx.fillText('비 고', noteX + (noteW + leaveW) / 2, y0 + h1 / 2 + 2);
    ctx.font = `400 40px ${SERIF}`;
    ctx.fillText('연', leaveX + leaveW / 2, y0 + h1 + h2 / 2 - 26);
    ctx.fillText('차', leaveX + leaveW / 2, y0 + h1 + h2 / 2 + 26);

    // 사람별 행
    for (let r = 0; r < rowsN; r++) {
      const s = staff[r];
      const top = yBody + rowH * r;
      const cy = top + rowH / 2;
      if (s) {
        ctx.font = `700 56px ${SANS}`;
        ctx.fillText(s.name, x0 + nameW / 2, cy);
      }
      for (let i = 0; i < 31; i++) {
        const day = days[i];
        if (!day) continue;
        if (day.closed) {
          line(ctx, colX(i), top + rowH, colX(i + 1), top, 2.5);
          continue;
        }
        if (!s) continue;
        const v = R.cellOf(month, s.id, day.d).v;
        if (!v) continue;
        ctx.font = v === 'O' ? `400 46px ${SERIF}` : `400 54px ${SERIF}`;
        ctx.fillText(R.LABEL[v], colX(i) + dayW / 2, cy + 2);
      }
      if (s) {
        const note = (month.notes && month.notes[s.id]) || '';
        if (note) {
          ctx.font = `400 34px ${SANS}`;
          const lines = wrapText(ctx, note, noteW - 24).slice(0, Math.floor((rowH - 16) / 40));
          lines.forEach((t, k) => ctx.fillText(t, noteX + noteW / 2, cy + (k - (lines.length - 1) / 2) * 40));
        }
        const leave = (month.leave && month.leave[s.id]) || '';
        if (leave) {
          ctx.font = `400 44px ${SERIF}`;
          ctx.fillText(leave, leaveX + leaveW / 2, cy + 2);
        }
      }
    }
    return cv;
  }

  function toBlob(canvas) {
    return new Promise((res) => canvas.toBlob(res, 'image/png'));
  }

  function fileName(ym) {
    const { y, m } = R.parseYm(ym);
    return `근무표_${y}년_${m}월.png`;
  }

  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // 공유: 휴대폰 공유창(카톡 등). 안 되면 파일로 내려받는다.
  async function share(blob, name, title) {
    const file = new File([blob], name, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title });
        return 'shared';
      } catch (e) {
        if (e && e.name === 'AbortError') return 'cancelled';
      }
    }
    download(blob, name);
    return 'downloaded';
  }

  // 저장: 아이폰은 공유창의 '이미지 저장'이 사진 앱으로 가는 길이라 공유창을 연다.
  async function save(blob, name, title) {
    if (isIOS()) return share(blob, name, title);
    download(blob, name);
    return 'downloaded';
  }

  g.RosterExport = { render, toBlob, fileName, share, save, download, isIOS, ensureFonts };
})(window);
