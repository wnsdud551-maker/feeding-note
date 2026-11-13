/* Turns a spoken Korean sentence into a feeding record.
   "3시 20분에 분유 120 먹었어"  → { hour: 15, min: 20, ml: 120 }
   "방금 소변 두 번 대변 한 번"   → { hour: now, min: now, pee: 2, poo: 1 }
   "비타민 먹였어" / "메모 트림 잘 함" / "분유포트 소독했어"
   Pure function: (text, now, cleanItems) → result. No browser APIs, so it can be tested on its own. */
(function (root) {
  const DIG = { 영: 0, 공: 0, 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 륙: 6, 칠: 7, 팔: 8, 구: 9 };
  // Sino-Korean numbers with 십/백: 백이십 → 120, 이백 → 200, 구십 → 90, 삼십오 → 35
  function sino(word) {
    let total = 0, cur = 0;
    for (const ch of word) {
      if (ch in DIG) cur = DIG[ch];
      else if (ch === "십") { total += (cur || 1) * 10; cur = 0; }
      else if (ch === "백") { total += (cur || 1) * 100; cur = 0; }
      else return null;
    }
    return total + cur;
  }
  const NATIVE_HOUR = { 한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10, 열한: 11, 열두: 12 };
  const NATIVE_COUNT = { 한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5 };

  function normalize(t) {
    t = " " + String(t).replace(/[.,!?~]/g, " ").replace(/\s+/g, " ") + " ";
    t = t.replace(/(\d)\s*(밀리리터|밀리|미리|ml|ML|mL|cc|씨씨)/g, "$1ml");
    // spelled-out numbers that contain 십/백 become digits
    t = t.replace(/[영공일이삼사오육륙칠팔구십백]*[십백][영공일이삼사오육륙칠팔구십백]*/g, (w) => { const n = sino(w); return n == null ? w : String(n); });
    // native-Korean hours: 세 시, 열두시 → 3시, 12시
    t = t.replace(/(열한|열두|다섯|여섯|일곱|여덟|아홉|한|두|세|네|열)\s*시(?!간)/g, (m, w) => NATIVE_HOUR[w] + "시");
    return t;
  }

  function parse(text, now, cleanItems) {
    now = now || new Date();
    const raw = String(text || "").trim();
    let t = normalize(raw);
    const out = { text: raw, hour: null, min: null, ml: null, pee: 0, poo: 0, vit: false, memo: "", clean: [], timeSaid: false };

    // memo: everything after the word 메모
    const mm = t.match(/메모\s*(.+)$/);
    if (mm) { out.memo = mm[1].trim(); t = t.slice(0, mm.index); }

    // when: "N분 전", "N시간 전", "(오후) 3시 (반|20분)", default now
    let when = new Date(now);
    const ago = t.match(/(\d{1,3})\s*분\s*전/);
    const agoH = t.match(/(\d{1,2})\s*시간\s*(반\s*)?전/);
    const at = t.match(/(오전|오후|새벽|아침|낮|저녁|밤)?\s*(\d{1,2})\s*시(?!간)\s*(반|(\d{1,2})\s*분)?/);
    if (ago) { when = new Date(now.getTime() - Number(ago[1]) * 60000); out.timeSaid = true; t = t.replace(ago[0], " "); }
    else if (agoH) { when = new Date(now.getTime() - (Number(agoH[1]) * 60 + (agoH[2] ? 30 : 0)) * 60000); out.timeSaid = true; t = t.replace(agoH[0], " "); }
    else if (at) {
      let h = Number(at[2]) % 24;
      const m = at[3] === "반" ? 30 : at[4] ? Math.min(59, Number(at[4])) : 0;
      const part = at[1];
      if (part === "오후" || part === "저녁" || part === "밤") { if (h < 12) h += 12; if (part === "밤" && h === 24) h = 0; }
      else if (part === "오전" || part === "새벽" || part === "아침") { if (h === 12) h = 0; }
      else if (part === "낮") { if (h < 7) h += 12; }
      else if (h <= 12) {
        // no 오전/오후: the most recent time that has already passed today
        const nowM = now.getHours() * 60 + now.getMinutes();
        const pm = (h % 12) + 12, am = h % 12;
        h = pm * 60 + m <= nowM ? pm : am * 60 + m <= nowM ? am : pm;
      }
      when = new Date(now); when.setHours(h, m, 0, 0);
      if (when > now) when.setDate(when.getDate() - 1); // a time later than now means last night
      out.timeSaid = true;
      t = t.replace(at[0], " ");
    }
    out.date = when;
    out.hour = when.getHours();
    out.min = when.getMinutes();

    // counts: "소변 두 번", "쉬 2번", "응가"
    const count = (re) => {
      const m = t.match(re);
      if (!m) return 0;
      const c = t.slice(m.index + m[0].length).match(/^\s*(\d|한|두|세|네|다섯)\s*(번|회)/);
      t = t.replace(m[0], " ");
      if (!c) return 1;
      t = t.replace(c[0], " ");
      return Math.min(5, /\d/.test(c[1]) ? Number(c[1]) : NATIVE_COUNT[c[1]]);
    };
    out.pee = count(/(소변|쉬야|쉬|오줌)/);
    out.poo = count(/(대변|응가|똥)/);
    if (/비타민/.test(t) && !/비타민\s*(안|못)/.test(t)) { out.vit = true; t = t.replace(/비타민/, " "); }

    // sterilising: an item name (or a short alias) together with 소독/세척/살균
    if (/(소독|세척|살균|씻)/.test(raw)) {
      (cleanItems || []).forEach((it) => {
        const alias = [it, it.replace(/\s+/g, "")];
        if (/포트/.test(it)) alias.push("포트");
        if (/세척기/.test(it)) alias.push("세척기");
        if (/소독기/.test(it)) alias.push("소독기");
        if (alias.some((a) => a && raw.replace(/\s+/g, "").includes(a.replace(/\s+/g, "")))) out.clean.push(it);
      });
    }

    // amount: a number with ml, or after 분유/수유, or any 10–400 number left over
    const unit = t.match(/(\d{2,3})ml/);
    const after = t.match(/(분유|수유|먹)\D{0,4}(\d{2,3})/);
    const before = t.match(/(\d{2,3})\s*(먹|정도|쯤)/);
    const any = t.match(/(?:^|\D)(\d{2,3})(?!\d)/);
    const n = unit ? unit[1] : after ? after[2] : before ? before[1] : any ? any[1] : null;
    if (n != null && Number(n) >= 10 && Number(n) <= 400) out.ml = Number(n);

    out.understood = out.ml != null || out.pee > 0 || out.poo > 0 || out.vit || !!out.memo || out.clean.length > 0;
    return out;
  }
  root.parseVoice = parse;
  if (typeof module !== "undefined") module.exports = parse;
})(typeof window !== "undefined" ? window : globalThis);
