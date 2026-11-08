(() => {
  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, "0");
  const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseKey = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
  const WD = ["일", "월", "화", "수", "목", "금", "토"];
  const MAXC = 5;
  const cnt = (v) => (v === true ? 1 : Math.max(0, Math.min(MAXC, Number(v) || 0)));
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };

  /* ---------- connection: records live in a PRIVATE GitHub repo, reached with a token that arrives
     through the family link or the setup screen — never in this public code ---------- */
  const CKEY = "feednote-conn-v2";
  const b64url = (str) => btoa(unescape(encodeURIComponent(str))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const unb64url = (s) => { const b = s.replace(/-/g, "+").replace(/_/g, "/"); return decodeURIComponent(escape(atob(b + "===".slice((b.length + 3) % 4)))); };
  function readHashConn() {
    const m = location.hash.match(/[#&]c=([A-Za-z0-9_\-]+)/);
    if (!m) return null;
    try { const c = JSON.parse(unb64url(m[1])); if (c && /^[\w.-]+\/[\w.-]+$/.test(c.r) && c.t) return { r: c.r, t: c.t }; } catch (e) {}
    return null;
  }
  let CONN = readHashConn();
  if (CONN) ls.set(CKEY, CONN);
  else CONN = ls.get(CKEY, null);
  const familyLink = () => `${location.origin}${location.pathname}#c=${b64url(JSON.stringify(CONN))}`;
  // keep the connection in the address, so "홈 화면에 추가" saves a shortcut that is already connected
  // (home-screen apps get their own storage, separate from the browser or KakaoTalk)
  if (CONN && !readHashConn()) { try { history.replaceState(null, "", familyLink()); } catch (e) {} }

  /* ---------- GitHub contents API: one JSON file per day, plus settings.json ---------- */
  const enc64 = (str) => { const b = new TextEncoder().encode(str); let s = ""; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); return btoa(s); };
  const dec64 = (b64) => { const bin = atob(b64.replace(/\s/g, "")); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new TextDecoder().decode(u); };
  async function gh(method, path, body, conn) {
    const c = conn || CONN;
    if (!c) throw { code: "no_conn" };
    let res;
    try {
      res = await fetch(`https://api.github.com/repos/${c.r}/contents/${path}`, {
        method, cache: "no-store",
        headers: { Authorization: `Bearer ${c.t}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) { throw { code: "network" }; }
    if (res.status === 404 && method === "GET") return null;
    if (res.status === 401 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") !== "0")) throw { code: "key" };
    if (res.status === 404) throw { code: "key" };
    if (res.status === 409 || res.status === 422) throw { code: "conflict" };
    if (!res.ok) throw { code: res.status === 403 ? "rate" : "server" };
    return res.json();
  }
  const files = {}; // path -> {data, sha}
  async function readJson(path, conn) {
    const j = await gh("GET", path, null, conn);
    const f = j ? { data: JSON.parse(dec64(j.content) || "{}"), sha: j.sha } : { data: null, sha: null };
    if (!conn) files[path] = f;
    return f;
  }
  async function writeJson(path, data, sha, msg, conn) {
    const j = await gh("PUT", path, { message: msg, content: enc64(JSON.stringify(data, null, 1)), ...(sha ? { sha } : {}) }, conn);
    const f = { data, sha: j.content.sha };
    if (!conn) files[path] = f;
    return f;
  }
  // read-modify-write with retry when the other phone saved the same file first
  let chain = Promise.resolve();
  function mutate(path, blank, fn, msg) {
    const run = async () => {
      let f = files[path] || await readJson(path);
      for (let attempt = 0; attempt < 5; attempt++) {
        const data = JSON.parse(JSON.stringify(f.data || blank()));
        const result = fn(data);
        if (!result.changed) return result;
        try { await writeJson(path, data, f.sha, msg); return result; }
        catch (e) { if (e.code !== "conflict") throw e; f = await readJson(path); }
      }
      throw { code: "server" };
    };
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
  }
  const dayPath = (d) => `days/${d.slice(0, 7)}/${d}.json`;
  const blankDay = (date) => () => ({ date, hours: {}, memo: null });
  const validDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d));
  function prevKey(k) { const d = parseKey(k); d.setDate(d.getDate() - 1); return keyOf(d); }
  function daySummary(d) {
    const o = { feeds: 0, ml: 0, pee: 0, poo: 0 };
    Object.values((d && d.hours) || {}).forEach((v) => { if (v.ml) { o.feeds++; o.ml += v.ml; } o.pee += cnt(v.pee); o.poo += cnt(v.poo); });
    return o;
  }
  let settingsCache = null, settingsAt = 0;

  async function api(action, q) {
    if (action === "day") {
      if (!validDate(q.date)) throw { code: "server" };
      const jobs = [readJson(dayPath(q.date))];
      if (q.withPrev) jobs.push(readJson(dayPath(prevKey(q.date))));
      if (!settingsCache || Date.now() - settingsAt > 60000) jobs.push(readJson("settings.json").then((f) => { settingsCache = f.data || {}; settingsAt = Date.now(); }));
      const [d, p] = await Promise.all(jobs);
      return { rows: (d.data && d.data.hours) || {}, prevRows: q.withPrev ? ((p.data && p.data.hours) || {}) : {}, memo: (d.data && d.data.memo && d.data.memo.text) || "", settings: settingsCache || {} };
    }
    if (action === "saveRow") {
      const v = q.row || {};
      const clean = { min: v.min ?? null, ml: v.ml ?? null, vit: !!v.vit, pee: cnt(v.pee), poo: cnt(v.poo), memo: String(v.memo || "").slice(0, 2000), at: q.at };
      const empty = isEmpty(clean);
      const r = await mutate(dayPath(q.date), blankDay(q.date), (d) => {
        const cur = d.hours[q.hour];
        if (cur && cur.at && cur.at > q.at) return { changed: false, applied: false, row: cur };
        if (empty) { if (!cur) return { changed: false, applied: true, row: null }; delete d.hours[q.hour]; return { changed: true, applied: true, row: null }; }
        d.hours[q.hour] = clean;
        return { changed: true, applied: true, row: clean };
      }, `${q.date} ${q.hour}시`);
      return r;
    }
    if (action === "saveMemo") {
      return mutate(dayPath(q.date), blankDay(q.date), (d) => {
        if (d.memo && d.memo.at > q.at) return { changed: false, applied: false };
        if ((d.memo ? d.memo.text : "") === q.memo) return { changed: false, applied: true };
        d.memo = { text: String(q.memo).slice(0, 5000), at: q.at };
        return { changed: true, applied: true };
      }, `${q.date} 메모`);
    }
    if (action === "saveSettings") {
      const iv = Math.round(Number(q.interval));
      const want = { birth: validDate(q.birth) ? q.birth : "", presets: (q.presets || []).map(Number).filter((n) => n > 0 && n <= 1000).slice(0, 9), interval: iv >= 60 && iv <= 360 ? iv : 180 };
      await mutate("settings.json", () => ({}), (d) => {
        if (d.birth === want.birth && JSON.stringify(d.presets) === JSON.stringify(want.presets) && d.interval === want.interval) return { changed: false };
        d.birth = want.birth; d.presets = want.presets; d.interval = want.interval; return { changed: true };
      }, "설정");
      settingsCache = want; settingsAt = Date.now();
      return {};
    }
    if (action === "stats") {
      const keys = []; for (let d = parseKey(q.start); keyOf(d) <= q.end; d.setDate(d.getDate() + 1)) keys.push(keyOf(d));
      const today = keyOf(new Date());
      const got = await Promise.all(keys.filter((k) => k <= today).map((k) => readJson(dayPath(k)).then((f) => [k, f.data])));
      const days = {};
      got.forEach(([k, d]) => { if (!d) return; const s = daySummary(d); if (s.feeds || s.ml || s.pee || s.poo) days[k] = s; });
      return { days };
    }
    throw { code: "server" };
  }

  const S = { date: keyOf(new Date()), rows: {}, prevRows: {}, dayMemo: "", birth: "", presets: [120, 140, 160], interval: 180, loadToken: 0, online: true };

  /* ---------- local backup of unsent edits (survives closing the app) ---------- */
  const PKEY = "feednote-pending-v1";
  const loadPending = () => ls.get(PKEY, {}) || {};
  const savePending = (p) => ls.set(PKEY, p);
  function putPending(key, val) { const p = loadPending(); p[key] = val; savePending(p); }
  function dropPending(key, at) { const p = loadPending(); if (p[key] && (!at || p[key].at === at)) { delete p[key]; savePending(p); } }

  /* ---------- build 24 rows ---------- */
  const rowsEl = $("rows");
  const R = [];
  for (let h = 0; h < 24; h++) {
    const hh = pad(h);
    const el = document.createElement("div");
    el.className = "grid row"; el.setAttribute("role", "row");
    el.innerHTML = `
      <div class="hour">${hh}시</div>
      <input id="m${hh}" class="mlbtn" inputmode="none" readonly placeholder="분" aria-label="${hh}시 분, 누르면 선택">
      <input id="ml${hh}" class="mlbtn" inputmode="none" readonly placeholder="ml" aria-label="${hh}시 분유 ml, 누르면 선택">
      <button class="chk vit" id="v${hh}" aria-pressed="false" aria-label="${hh}시 비타민">V</button>
      <button class="chk pee" id="p${hh}" data-count="0" data-label="소">소</button>
      <button class="chk poo" id="d${hh}" data-count="0" data-label="대">대</button>
      <textarea id="n${hh}" rows="1" placeholder="메모" aria-label="${hh}시 메모"></textarea>`;
    rowsEl.appendChild(el);
    const r = { el, h: hh, m: el.querySelector(`#m${hh}`), ml: el.querySelector(`#ml${hh}`), vit: el.querySelector(`#v${hh}`),
      pee: el.querySelector(`#p${hh}`), poo: el.querySelector(`#d${hh}`), memo: el.querySelector(`#n${hh}`) };
    R.push(r);
    setCount(r.pee, 0, hh); setCount(r.poo, 0, hh);

    const onEdit = () => scheduleSave(hh, 600);
    r.m.addEventListener("click", (e) => { e.preventDefault(); r.m.blur(); openMinPicker(hh); });
    r.m.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openMinPicker(hh); } });
    r.ml.addEventListener("click", (e) => { e.preventDefault(); r.ml.blur(); openPicker(hh); });
    r.ml.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPicker(hh); } });
    r.memo.addEventListener("input", () => { grow(r.memo); onEdit(); });
    r.memo.addEventListener("blur", () => scheduleSave(hh, 0));
    r.vit.addEventListener("click", () => { setVit(r.vit, r.vit.getAttribute("aria-pressed") !== "true"); scheduleSave(hh, 300); });
    [r.pee, r.poo].forEach((b) => b.addEventListener("click", () => {
      const n = (Number(b.dataset.count) + 1) % (MAXC + 1);
      setCount(b, n, hh);
      scheduleSave(hh, 800); // short pause so 소→소2→소3 taps become one save
    }));
  }
  function setVit(b, on) { b.setAttribute("aria-pressed", on ? "true" : "false"); b.classList.toggle("on", !!on); }
  function setCount(b, n, hh) {
    b.dataset.count = String(n);
    const L = b.dataset.label;
    b.textContent = n >= 2 ? L + n : L;
    b.classList.toggle("on", n > 0);
    b.setAttribute("aria-label", `${hh}시 ${L === "소" ? "소변" : "대변"} ${n}회, 누르면 1회 추가`);
  }
  function grow(t) { t.style.height = "auto"; t.style.height = t.scrollHeight + "px"; }

  function rowFromDom(r) {
    const num = (v, max) => { if (v === "" || v == null) return null; const n = Math.round(Number(v)); return isFinite(n) ? Math.max(0, Math.min(max, n)) : null; };
    return { min: num(r.m.value, 59), ml: num(r.ml.value, 1000), vit: r.vit.getAttribute("aria-pressed") === "true", pee: Number(r.pee.dataset.count) || 0, poo: Number(r.poo.dataset.count) || 0, memo: r.memo.value.trim() };
  }
  const isEmpty = (v) => v.min == null && v.ml == null && !v.vit && !cnt(v.pee) && !cnt(v.poo) && !v.memo;
  const sameRow = (a, v) => a ? (a.min ?? null) === v.min && (a.ml ?? null) === v.ml && !!a.vit === !!v.vit && cnt(a.pee) === v.pee && cnt(a.poo) === v.poo && (a.memo || "") === v.memo : isEmpty(v);
  function summarize(rows) {
    let feeds = 0, ml = 0, pee = 0, poo = 0, vit = 0;
    Object.values(rows).forEach((v) => { if (!v) return; if (v.ml) { feeds++; ml += v.ml; } pee += cnt(v.pee); poo += cnt(v.poo); if (v.vit) vit++; });
    return { feeds, ml, pee, poo, vit };
  }

  /* ---------- saving: one request at a time per hour ---------- */
  const timers = {}, inflight = {}, dirty = {};
  function scheduleSave(hh, delay) {
    const v = rowFromDom(R[Number(hh)]);
    if (!sameRow(S.rows[hh], v)) putPending(`${S.date}/${hh}`, { ...v, at: new Date().toISOString() });
    clearTimeout(timers[hh]);
    timers[hh] = setTimeout(() => { delete timers[hh]; saveRow(hh); }, delay);
    renderTotals();
  }
  async function saveRow(hh) {
    if (inflight[hh]) { dirty[hh] = true; return; }
    const date = S.date;
    const v = rowFromDom(R[Number(hh)]);
    const pkey = `${date}/${hh}`;
    if (sameRow(S.rows[hh], v)) { dropPending(pkey); return; }
    const pend = loadPending()[pkey];
    const at = (pend && pend.at) || new Date().toISOString();
    inflight[hh] = true;
    setStatus("저장 중…");
    try {
      const j = await api("saveRow", { date, hour: hh, row: v, at });
      dropPending(pkey, at);
      if (date === S.date) {
        if (j.row) S.rows[hh] = j.row; else delete S.rows[hh];
        if (!j.applied && !timers[hh]) renderRows(); // the other phone had a newer edit
      }
      setOnline(true);
      setStatus(j.applied ? "저장됨 · 가족 화면에도 20초 안에 반영돼요" : "같은 칸을 상대방이 더 나중에 고쳐서 그 기록을 보여드려요");
    } catch (e) { handleErr(e); }
    finally {
      inflight[hh] = false;
      if (dirty[hh]) { dirty[hh] = false; saveRow(hh); }
    }
  }
  function handleErr(e) {
    if (e && e.code === "key") { setStatus("저장소에 들어갈 수 없어요. 토큰이 만료됐거나 권한이 바뀌었을 수 있어요. 아래 [연결 다시 설정]을 눌러 주세요.", true); return; }
    if (e && e.code === "rate") { setStatus("잠시 요청이 너무 많았어요. 1분쯤 뒤에 자동으로 다시 저장해요.", true); return; }
    setOnline(false);
    setStatus("지금은 저장하지 못했어요. 이 폰에 보관해 두었다가 연결되면 자동으로 올려요.", true);
  }
  function setOnline(on) { S.online = on; }

  async function replayPending() {
    const p = loadPending();
    const keys = Object.keys(p);
    if (!keys.length) return;
    let ok = 0;
    for (const key of keys) {
      const [date, part] = key.split("/");
      const val = p[key];
      try {
        if (part === "memo") await api("saveMemo", { date, memo: val.memo, at: val.at });
        else { const { at, ...row } = val; await api("saveRow", { date, hour: part, row, at }); }
        dropPending(key, val.at); ok++;
      } catch (e) { return; }
    }
    if (ok) { setStatus("저장하지 못했던 기록을 올렸어요"); loadDay(true); }
  }

  /* ---------- render: log ---------- */
  function renderRows() {
    const today = S.date === keyOf(new Date());
    const nowH = new Date().getHours();
    const pend = loadPending();
    R.forEach((r, i) => {
      const local = pend[`${S.date}/${r.h}`];
      const server = S.rows[r.h];
      const v = (local && (!server || (server.at || "") < local.at)) ? local : (server || {});
      const act = document.activeElement;
      if (!timers[r.h] && !inflight[r.h]) {
        if (pickMinHour !== r.h) r.m.value = v.min ?? "";
        if (pickHour !== r.h) r.ml.value = v.ml ?? "";
        if (act !== r.memo) { r.memo.value = v.memo || ""; grow(r.memo); }
        setVit(r.vit, !!v.vit); setCount(r.pee, cnt(v.pee), r.h); setCount(r.poo, cnt(v.poo), r.h);
      }
      r.el.classList.toggle("current", today && i === nowH);
    });
    renderTotals();
  }
  function renderTotals() {
    const rows = {}; R.forEach((r) => { rows[r.h] = rowFromDom(r); r.el.classList.toggle("filled", !isEmpty(rows[r.h])); });
    const s = summarize(rows);
    $("sFeeds").textContent = s.feeds; $("sMl").textContent = s.ml; $("sPee").textContent = s.pee; $("sPoo").textContent = s.poo;
    $("tFeeds").textContent = s.feeds + "회"; $("tMl").textContent = s.ml; $("tVit").textContent = s.vit; $("tPee").textContent = s.pee; $("tPoo").textContent = s.poo;
    renderSince();
    renderVitWarn();
  }
  // vitamin is one drop every day: warn after 18:00 when today has no V yet
  function renderVitWarn() {
    const el = $("vitWarn");
    const today = keyOf(new Date());
    const any = R.some((r) => r.vit.getAttribute("aria-pressed") === "true");
    const loaded = S.loadedDate === S.date;
    if (any || !loaded || S.date > today) { el.hidden = true; return; }
    if (S.date === today) {
      const show = new Date().getHours() >= 18;
      el.hidden = !show; el.classList.remove("past");
      $("vitText").textContent = "오후 6시가 지났는데 오늘 비타민을 아직 안 먹였어요";
      $("vitNow").hidden = false;
    } else {
      el.hidden = false; el.classList.add("past");
      $("vitText").textContent = "이 날은 비타민 체크가 없어요";
      $("vitNow").hidden = true;
    }
  }
  /* one encouraging line per day; both phones show the same one */
  const QUOTES = [
    "오늘 아린이가 먹은 한 방울 한 방울은 엄마 아빠의 사랑이에요.",
    "완벽한 부모보다 곁에 있는 부모가 아이에겐 전부예요.",
    "힘든 날도 지나가요. 아린이는 그 사이에도 자라고 있어요.",
    "오늘 잘 못 한 것보다 잘한 것 하나를 떠올려 보세요.",
    "서툴러도 괜찮아요. 아린이도 엄마 아빠도 같이 처음이에요.",
    "잠깐 눈 붙이는 것도 육아예요. 쉬어도 괜찮아요.",
    "아린이에게 세상은 엄마 아빠의 품에서 시작돼요.",
    "오늘의 피곤함은 내일의 웃음으로 돌아올 거예요.",
    "서로에게 \"수고했어\" 한마디 건네는 하루가 되길.",
    "우는 것도 아린이가 말하는 방법이에요. 잘 듣고 있어요.",
    "하루하루 쌓인 이 기록이 아린이의 첫 일기장이에요.",
    "오늘도 아린이를 지켜낸 두 사람, 정말 대단해요.",
    "조금 늦어도, 조금 달라도 괜찮아요. 아린이만의 속도가 있어요.",
    "지친 마음도 아린이의 작은 손 한 번이면 녹아요.",
    "엄마 아빠가 웃으면 아린이도 따라 웃어요.",
    "모든 걸 잘하려 하지 않아도 돼요. 사랑하는 것만으로 충분해요.",
    "새벽 수유를 함께 견디는 두 사람은 최고의 팀이에요.",
    "오늘 하루도 무사히, 그거면 충분히 잘한 거예요.",
    "아린이는 오늘도 엄마 아빠 덕분에 안전하고 따뜻했어요.",
    "내 몸도 챙겨야 아린이도 챙길 수 있어요. 물 한 잔 마셔요.",
    "지금 이 순간은 다시 오지 않아요. 작은 하품까지 예뻐요.",
    "지금의 고단한 밤들이 언젠가 가장 그리운 밤이 될 거예요.",
    "힘들다고 말해도 괜찮아요. 서로 기대며 가면 돼요.",
    "아린이가 자라는 만큼 엄마 아빠도 함께 자라고 있어요.",
    "오늘 먹은 분유 양보다 오늘 안아준 시간이 더 소중해요.",
    "잘하고 있어요. 정말로요.",
    "한 번의 미소를 위한 백 번의 토닥임, 그게 사랑이에요.",
    "오늘 못 한 일은 내일 해도 돼요. 아린이는 기다려 줘요.",
    "둘이라서 다행이에요. 오늘도 서로에게 고마운 하루.",
    "아린이의 작은 숨소리가 오늘 하루의 가장 큰 선물이에요.",
    "걱정은 반으로, 기쁨은 두 배로. 함께라서 가능해요.",
    "오늘도 꼼꼼히 기록해 줘서 고마워요. 이 정성이 아린이를 지켜요.",
    "엄마 아빠의 목소리는 아린이에게 가장 좋은 자장가예요.",
    "지친 하루 끝에 서로 손 한 번 꼭 잡아 주세요.",
    "처음 만난 날처럼, 오늘도 아린이는 기적이에요.",
    "사랑받은 아기는 단단하게 자라요. 아린이는 이미 듬뿍 받고 있어요.",
    "오늘 흘린 땀만큼 아린이 볼이 통통해지고 있어요.",
    "잠 못 드는 밤에도 별은 떠 있어요. 곧 아침이 와요.",
    "오늘의 엄마 아빠에게 큰 박수를 보내요. 짝짝짝!",
    "아린이가 엄마 아빠를 골라서 와 준 것 같아요. 그만큼 잘 맞는 가족이에요.",
  ];
  function renderQuote() {
    const d = new Date();
    const dayNo = Math.floor((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(2026, 0, 1)) / 86400000);
    const q = QUOTES[((dayNo % QUOTES.length) + QUOTES.length) % QUOTES.length];
    if ($("quote").textContent !== q) $("quote").textContent = q;
  }
  function dplus(key) {
    if (!S.birth) return 0;
    const n = Math.round((parseKey(key) - parseKey(S.birth)) / 86400000) + 1;
    return n >= 1 ? n : 0;
  }
  function renderTitle() {
    const d = parseKey(S.date);
    const isToday = S.date === keyOf(new Date());
    const n = dplus(S.date);
    $("title").innerHTML = `${d.getMonth() + 1}월 ${d.getDate()}일${n ? ` <span class="dplus">D+${n}</span>` : ""}<small>${d.getFullYear()}년 · ${WD[d.getDay()]}요일${isToday ? " · 오늘" : ""}</small>`;
    $("next").disabled = isToday;
    const tn = dplus(keyOf(new Date()));
    $("brandSub").innerHTML = tn ? `오늘로 <b>D+${tn}</b> · 오늘도 무럭무럭` : "오늘도 무럭무럭";
    renderQuote();
  }
  function lastFeed() {
    const pick = (rows, base) => {
      let best = null;
      Object.entries(rows).forEach(([hh, v]) => {
        if (!v || !v.ml) return;
        const t = new Date(base); t.setHours(Number(hh), v.min ?? 0, 0, 0);
        if (!best || t > best.t) best = { t, ml: v.ml };
      });
      return best;
    };
    const base = parseKey(S.date);
    const todayRows = {}; R.forEach((r) => { const v = rowFromDom(r); if (v.ml) todayRows[r.h] = v; });
    let f = pick(todayRows, base);
    if (!f) { const y = new Date(base); y.setDate(y.getDate() - 1); f = pick(S.prevRows, y); }
    return f;
  }
  const hm = (mins) => { const h = Math.floor(mins / 60), m = mins % 60; return h ? (m ? `${h}시간 ${m}분` : `${h}시간`) : `${m}분`; };
  function renderSince() {
    const el = $("since");
    const today = keyOf(new Date());
    const f = S.date === today ? lastFeed() : null;
    renderNextRow(f);
    if (S.date !== today) { el.textContent = "지난 날짜를 보고 있어요"; return; }
    if (!f) { el.textContent = "수유 기록을 남기면 다음 수유 시간을 알려드려요"; return; }
    const ago = Math.max(0, Math.floor((Date.now() - f.t) / 60000));
    const next = new Date(f.t.getTime() + S.interval * 60000);
    const left = Math.round((next - Date.now()) / 60000);
    const nextLabel = `${keyOf(next) !== today ? "내일 " : ""}${pad(next.getHours())}:${pad(next.getMinutes())}`;
    let line2;
    if (left > 0) line2 = `다음 수유 <strong class="nx">${nextLabel}</strong> · ${hm(left)} 남음`;
    else if (left > -5) line2 = `<span class="due">지금 수유할 시간이에요 (${nextLabel})</span>`;
    else line2 = `<span class="due">예정 ${nextLabel}보다 ${hm(-left)} 지났어요</span>`;
    el.innerHTML = `마지막 수유 <strong>${pad(f.t.getHours())}:${pad(f.t.getMinutes())}</strong> · ${f.ml}ml · ${ago < 1 ? "방금" : hm(ago) + " 전"}<br>${line2}`;
  }
  // faintly pre-fill the row where the next feed is due (last feed + interval), with the last amount
  function renderNextRow(f) {
    let nh = null, nm = null, nml = null;
    if (f) {
      const next = new Date(f.t.getTime() + S.interval * 60000);
      if (keyOf(next) === S.date) { nh = pad(next.getHours()); nm = next.getMinutes(); nml = f.ml; }
    }
    R.forEach((r) => {
      const on = r.h === nh && r.m.value === "" && r.ml.value === "";
      r.el.classList.toggle("next", on);
      r.m.placeholder = on ? pad(nm) : "분";
      r.ml.placeholder = on ? String(nml) : "ml";
      r.m.setAttribute("aria-label", `${r.h}시 분${on ? `, 다음 수유 예정 ${pad(nm)}분` : ""}, 누르면 선택`);
    });
  }
  function setStatus(t, warn) { const s = $("status"); s.textContent = t; s.classList.toggle("warn", !!warn); }

  /* ---------- loading a day (and polling for the other phone's edits) ---------- */
  async function loadDay(silent) {
    const date = S.date;
    const token = ++S.loadToken;
    if (!silent) setStatus("불러오는 중…");
    try {
      const j = await api("day", { date, withPrev: date === keyOf(new Date()) });
      if (token !== S.loadToken || date !== S.date) return;
      S.rows = j.rows || {}; S.prevRows = j.prevRows || {}; S.loadedDate = date;
      S.dayMemo = j.memo || "";
      const pm = loadPending()[`${date}/memo`];
      if (document.activeElement !== $("dayMemo") && !memoTimer && !pm) $("dayMemo").value = S.dayMemo;
      applySettings(j.settings || {});
      renderRows(); renderTitle();
      setOnline(true);
      const t = new Date();
      setStatus(`동기화됨 ${pad(t.getHours())}:${pad(t.getMinutes())} · 상대방 기록은 20초마다 새로 불러와요`);
    } catch (e) {
      if (token !== S.loadToken) return;
      handleErr(e);
      if (e.code !== "key") setStatus("기록을 불러오지 못했어요. 인터넷 연결을 확인해 주세요. 입력한 내용은 이 폰에 보관돼요.", true);
    }
  }
  function applySettings(st) {
    if (typeof st.birth === "string") { S.birth = st.birth; if (document.activeElement !== $("birth")) $("birth").value = S.birth; }
    const pr = Array.isArray(st.presets) ? parsePresets(st.presets.join(",")) : [];
    if (pr.length) { S.presets = pr; if (document.activeElement !== $("presets")) $("presets").value = pr.join(", "); }
    const iv = Number(st.interval);
    if (iv >= 60 && iv <= 360 && iv !== S.interval) { S.interval = iv; $("interval").value = String(iv); renderSince(); }
  }
  function busy() { return Object.keys(timers).length || Object.values(inflight).some(Boolean) || memoBusy || memoTimer || pickHour != null || pickMinHour != null; }
  setInterval(() => {
    if (document.hidden || !CONN || busy()) return;
    if (Object.keys(loadPending()).length) replayPending();
    else if (currentTab() === "log") loadDay(true);
    else if (currentTab() === "clean") { if (loadOps().length) flushClean(); else loadClean(true); }
  }, 20000);

  /* ---------- day memo & settings ---------- */
  let memoTimer = null, memoBusy = false, memoAgain = false;
  async function saveMemo() {
    const v = $("dayMemo").value;
    const date = S.date;
    if (v === S.dayMemo) { dropPending(`${date}/memo`); return; }
    if (memoBusy) { memoAgain = true; return; }
    memoBusy = true;
    const p = loadPending()[`${date}/memo`];
    const at = (p && p.at) || new Date().toISOString();
    try { await api("saveMemo", { date, memo: v, at }); if (date === S.date) S.dayMemo = v; dropPending(`${date}/memo`, at); setStatus("저장됨"); }
    catch (e) { handleErr(e); }
    finally { memoBusy = false; if (memoAgain) { memoAgain = false; saveMemo(); } }
  }
  $("dayMemo").addEventListener("input", () => {
    putPending(`${S.date}/memo`, { memo: $("dayMemo").value, at: new Date().toISOString() });
    clearTimeout(memoTimer); memoTimer = setTimeout(() => { memoTimer = null; saveMemo(); }, 800);
  });
  $("dayMemo").addEventListener("blur", () => { clearTimeout(memoTimer); memoTimer = null; saveMemo(); });

  async function saveSettings(msg) {
    try { await api("saveSettings", { birth: S.birth, presets: S.presets, interval: S.interval }); setStatus(msg); } catch (e) { handleErr(e); }
  }
  $("interval").addEventListener("change", () => { S.interval = Number($("interval").value) || 180; renderSince(); saveSettings("수유 간격을 저장했어요"); });
  $("birth").addEventListener("change", () => { S.birth = $("birth").value; renderTitle(); saveSettings("생일을 저장했어요"); });
  const parsePresets = (t) => [...new Set(String(t).split(/[^0-9]+/).map(Number).filter((n) => n > 0 && n <= 1000))].slice(0, 9);
  $("presets").addEventListener("change", () => {
    const list = parsePresets($("presets").value);
    if (!list.length) { $("presets").value = S.presets.join(", "); return; }
    S.presets = list; $("presets").value = list.join(", ");
    saveSettings("자주 먹는 분유량을 저장했어요");
  });

  /* ---------- phone back button: closes a picker / leaves stats instead of leaving the app ---------- */
  let openSheetId = null;
  const pushBack = () => { try { history.pushState({ fn: 1 }, "", location.href); } catch (e) {} };
  const ourState = () => !!(history.state && history.state.fn);
  function showSheet(id) { $(id).hidden = false; openSheetId = id; pushBack(); }
  function requestClose() { if (ourState()) history.back(); else hideSheet(); }
  function hideSheet() {
    if (openSheetId === "mlSheet") closePicker();
    else if (openSheetId === "minSheet") closeMinPicker();
    openSheetId = null;
  }
  // a guard entry sits on top of the start page: the first back on the log screen only shows a notice,
  // a second back within 2 seconds leaves the app
  let exitTimer = null;
  function armGuard() { if (!ourState()) pushBack(); }
  function toast(msg) {
    const t = $("toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 2000);
  }
  window.addEventListener("popstate", () => {
    if (openSheetId) { hideSheet(); return; }
    if (currentTab() !== "log") { showTab("log", true); return; }
    if (!ourState()) {
      toast("한 번 더 누르면 앱이 닫혀요");
      clearTimeout(exitTimer);
      exitTimer = setTimeout(armGuard, 2000);
    }
  });
  ["mlSheet", "minSheet"].forEach((id) => $(id).addEventListener("click", (e) => { if (e.target === $(id)) requestClose(); }));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && openSheetId) requestClose(); });

  /* ---------- formula amount picker ---------- */
  let pickHour = null;
  function markChip(box, v) { box.querySelectorAll("button").forEach((b) => b.classList.toggle("sel", v !== "" && b.dataset.v === String(v))); }
  function openPicker(hh) {
    pickHour = hh;
    const cur = R[Number(hh)].ml.value;
    $("mlTitle").textContent = `${Number(hh)}시 분유량`;
    $("chips").innerHTML = S.presets.map((v) => `<button data-v="${v}">${v}<small>ml</small></button>`).join("");
    markChip($("chips"), cur);
    $("mlCustom").value = cur;
    showSheet("mlSheet");
    const sel = $("chips").querySelector(".sel") || $("chips").querySelector("button");
    if (sel) sel.focus({ preventScroll: true });
  }
  function closePicker() {
    $("mlSheet").hidden = true;
    const hh = pickHour; pickHour = null;
    if (hh != null) { scheduleSave(hh, 0); R[Number(hh)].ml.focus({ preventScroll: true }); }
  }
  // sets the amount right away; chips close the sheet, −10/+10 and typing keep it open
  function setMl(v) {
    if (pickHour == null) return;
    const hh = pickHour, r = R[Number(hh)];
    r.ml.value = v === "" || v == null ? "" : String(Math.max(0, Math.min(1000, Math.round(Number(v)))));
    const now = new Date();
    if (r.ml.value && r.m.value === "" && S.date === keyOf(now) && Number(hh) === now.getHours()) r.m.value = nowMin5();
    markChip($("chips"), r.ml.value);
    scheduleSave(hh, 600);
  }
  $("chips").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { setMl(b.dataset.v); requestClose(); } });
  const nudge = (d) => { const raw = $("mlCustom").value; const v = Math.max(0, (raw === "" ? S.presets[0] || 0 : Number(raw)) + d); $("mlCustom").value = v; setMl(v); };
  $("mlMinus").addEventListener("click", () => nudge(-10));
  $("mlPlus").addEventListener("click", () => nudge(10));
  $("mlCustom").addEventListener("input", () => setMl($("mlCustom").value));
  $("mlCustom").addEventListener("keydown", (e) => { if (e.key === "Enter") requestClose(); });
  $("mlClear").addEventListener("click", () => { $("mlCustom").value = ""; setMl(""); requestClose(); });

  /* ---------- minute picker (5-minute steps) ---------- */
  const nowMin5 = () => Math.min(55, Math.round(new Date().getMinutes() / 5) * 5);
  let pickMinHour = null;
  function openMinPicker(hh) {
    pickMinHour = hh;
    const cur = R[Number(hh)].m.value;
    $("minTitle").textContent = `${Number(hh)}시 몇 분?`;
    let html = "";
    for (let m = 0; m < 60; m += 5) html += `<button data-v="${m}">${pad(m)}<small>분</small></button>`;
    $("minChips").innerHTML = html;
    // on the faint "next feed" row, the predicted minute is pre-selected
    const guess = cur === "" && R[Number(hh)].el.classList.contains("next") ? String(Math.min(55, Math.round(Number(R[Number(hh)].m.placeholder) / 5) * 5)) : "";
    markChip($("minChips"), cur === "" ? guess : String(Number(cur)));
    const now = new Date();
    $("minNow").hidden = !(S.date === keyOf(now) && Number(hh) === now.getHours());
    $("minNow").textContent = `지금 (${pad(nowMin5())}분)`;
    showSheet("minSheet");
    const sel = $("minChips").querySelector(".sel") || $("minChips").querySelector("button");
    if (sel) sel.focus({ preventScroll: true });
  }
  function closeMinPicker() { $("minSheet").hidden = true; const r = pickMinHour != null && R[Number(pickMinHour)]; pickMinHour = null; if (r) r.m.focus({ preventScroll: true }); }
  function setMin(v) {
    if (pickMinHour == null) return;
    const hh = pickMinHour;
    R[Number(hh)].m.value = v === "" || v == null ? "" : String(Number(v));
    scheduleSave(hh, 0);
    requestClose();
  }
  $("minChips").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setMin(b.dataset.v); });
  $("minNow").addEventListener("click", () => setMin(nowMin5()));
  $("minClear").addEventListener("click", () => setMin(""));

  /* ---------- navigation ---------- */
  function flushAll() {
    Object.keys(timers).forEach((k) => { clearTimeout(timers[k]); delete timers[k]; saveRow(k); });
    if (memoTimer) { clearTimeout(memoTimer); memoTimer = null; saveMemo(); }
  }
  function goDate(key) {
    flushAll(); S.date = key; S.rows = {}; S.prevRows = {}; S.dayMemo = "";
    const pm = loadPending()[`${key}/memo`];
    $("dayMemo").value = pm ? pm.memo : "";
    renderTitle(); renderRows(); loadDay();
  }
  function shift(n) {
    const d = parseKey(S.date); d.setDate(d.getDate() + n);
    if (keyOf(d) > keyOf(new Date())) return;
    goDate(keyOf(d));
  }
  $("prev").addEventListener("click", () => shift(-1));
  $("next").addEventListener("click", () => shift(1));
  $("nowBtn").addEventListener("click", () => {
    const now = new Date();
    if (S.date !== keyOf(now)) goDate(keyOf(now));
    const r = R[now.getHours()];
    const hadMl = r.ml.value !== "";
    if (r.m.value === "") r.m.value = nowMin5();
    if (!hadMl) r.ml.value = String(S.presets[0] || 120); // usual amount; tap the cell to change it
    scheduleSave(r.h, 0);
    r.el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    if (hadMl) setTimeout(() => openPicker(r.h), 250); // this hour already has a feed: let them adjust it
    else toast(`${now.getHours()}시 ${pad(Number(r.m.value))}분 · ${r.ml.value}ml 기록했어요`);
  });

  $("vitNow").addEventListener("click", () => {
    const now = new Date();
    if (S.date !== keyOf(now)) return;
    const r = R[now.getHours()];
    setVit(r.vit, true); scheduleSave(r.h, 0);
    r.el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  });

  setInterval(() => {
    renderSince(); renderVitWarn(); renderQuote();
    const today = keyOf(new Date()), nowH = new Date().getHours();
    R.forEach((r, i) => r.el.classList.toggle("current", S.date === today && i === nowH));
  }, 30000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flushAll();
    else if (CONN) { renderSince(); replayPending().then(() => { if (!busy()) loadDay(true); }); }
  });
  window.addEventListener("pagehide", flushAll);
  window.addEventListener("online", () => { if (CONN) replayPending(); });

  /* ---------- tabs: 수유노트 / 통계 / 소독 ---------- */
  const currentTab = () => (!$("statsView").hidden ? "stats" : !$("cleanView").hidden ? "clean" : "log");
  function showTab(name, fromPop) {
    if (name !== "log" && currentTab() === "log" && !fromPop) pushBack();
    $("tabLog").setAttribute("aria-selected", String(name === "log"));
    $("tabStats").setAttribute("aria-selected", String(name === "stats"));
    $("tabClean").setAttribute("aria-selected", String(name === "clean"));
    $("logHead").hidden = name !== "log"; $("logView").hidden = name !== "log";
    $("statsHead").hidden = name !== "stats"; $("statsView").hidden = name !== "stats";
    $("cleanView").hidden = name !== "clean";
    if (name === "stats") { flushAll(); loadStats(); }
    if (name === "clean") { flushAll(); openClean(); }
    window.scrollTo(0, 0);
  }
  const leaveStats = () => { if (currentTab() !== "log" && ourState()) history.back(); else showTab("log"); };
  $("tabLog").addEventListener("click", leaveStats);
  $("tabStats").addEventListener("click", () => showTab("stats"));
  $("tabClean").addEventListener("click", () => showTab("clean"));

  /* ---------- 소독: when were the formula kettle, bottle washer … sterilised ---------- */
  // one file, clean.json = { items: [...], log: [{ id, item, at: "YYYY-MM-DDTHH:MM", memo }] }
  // edits queue locally first (survive closing the app), then merge into the file
  const CL = { data: null, items: ["분유포트", "젖병 세척기"], pick: null, armed: null, flushing: false };
  const COPS = "feednote-clean-ops-v1";
  const loadOps = () => ls.get(COPS, []) || [];
  const saveOps = (o) => ls.set(COPS, o);
  function applyOps(d, ops) {
    d.items = Array.isArray(d.items) && d.items.length ? d.items : CL.items.slice();
    d.log = Array.isArray(d.log) ? d.log : [];
    ops.forEach((o) => {
      if (o.op === "add" && !d.log.some((e) => e.id === o.e.id)) d.log.push(o.e);
      if (o.op === "del") d.log = d.log.filter((e) => e.id !== o.id);
      if (o.op === "items") d.items = o.items;
    });
    d.log.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0));
    return d;
  }
  const cleanView = () => applyOps(JSON.parse(JSON.stringify(CL.data || {})), loadOps());
  function queueOp(o) { const ops = loadOps(); ops.push(o); saveOps(ops); renderClean(); flushClean(); }
  async function flushClean() {
    if (CL.flushing) return;
    const ops = loadOps();
    if (!ops.length) return;
    CL.flushing = true;
    try {
      const r = await mutate("clean.json", () => ({ items: CL.items.slice(), log: [] }), (d) => { applyOps(d, ops); return { changed: true, data: d }; }, "소독 기록");
      CL.data = r.data;
      saveOps(loadOps().slice(ops.length));
      setStatus("소독 기록을 저장했어요");
    } catch (e) { handleErr(e); }
    finally { CL.flushing = false; renderClean(); if (loadOps().length && !document.hidden) setTimeout(flushClean, 5000); }
  }
  async function loadClean(silent) {
    try {
      const f = await readJson("clean.json");
      CL.data = f.data || { items: CL.items.slice(), log: [] };
      renderClean();
    } catch (e) { if (!silent) handleErr(e); }
  }
  const localStamp = (d) => `${keyOf(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  function openClean() {
    const now = new Date();
    $("cleanDate").value = keyOf(now);
    $("cleanDate").max = keyOf(now);
    $("cleanTime").value = `${pad(now.getHours())}:${pad(Math.floor(now.getMinutes() / 5) * 5)}`;
    renderClean();
    flushClean().then(() => loadClean());
  }
  function agoText(at) {
    const [d, t] = at.split("T"); const [hh, mm] = t.split(":").map(Number);
    const when = parseKey(d); when.setHours(hh, mm, 0, 0);
    const mins = Math.floor((Date.now() - when) / 60000);
    if (mins < 1) return "방금";
    if (mins < 60) return `${mins}분 전`;
    if (mins < 1440) return `${Math.floor(mins / 60)}시간 전`;
    const days = Math.round((parseKey(keyOf(new Date())) - parseKey(d)) / 86400000);
    return days === 1 ? "어제" : `${days}일 전`;
  }
  const dayLabel = (k) => { const d = parseKey(k); const today = keyOf(new Date()); const y = parseKey(today); y.setDate(y.getDate() - 1);
    return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WD[d.getDay()]})${k === today ? " · 오늘" : k === keyOf(y) ? " · 어제" : ""}`; };
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function renderClean() {
    const v = cleanView();
    const items = v.items;
    if (!CL.pick || !items.includes(CL.pick)) CL.pick = items[0];
    // one card per item: last time it was sterilised + a one-tap button
    $("cleanItems").innerHTML = items.map((it) => {
      const last = v.log.find((e) => e.item === it);
      const when = last ? `마지막 <b>${Number(last.at.slice(5, 7))}/${Number(last.at.slice(8, 10))} ${last.at.slice(11)}</b><br>${agoText(last.at)}` : "아직 기록이 없어요";
      return `<div class="citem"><h4>${esc(it)}</h4><div class="when">${when}</div><button type="button" data-now="${esc(it)}">지금 소독했어요</button></div>`;
    }).join("");
    $("cleanPick").innerHTML = items.map((it) => `<button type="button" role="radio" aria-checked="${it === CL.pick}" data-pick="${esc(it)}">${esc(it)}</button>`).join("");
    if (document.activeElement !== $("cleanItemsEdit")) $("cleanItemsEdit").value = items.join(", ");
    // log grouped by date, newest first
    const groups = []; let cur = null;
    v.log.slice(0, 150).forEach((e) => { const k = e.at.slice(0, 10); if (!cur || cur.k !== k) { cur = { k, list: [] }; groups.push(cur); } cur.list.push(e); });
    $("cleanLog").innerHTML = groups.length ? groups.map((g) => `<div class="cday"><h5>${dayLabel(g.k)}</h5>${g.list.map((e) => `
      <div class="centry"><span class="t">${e.at.slice(11)}</span><span class="w">${esc(e.item)}${e.memo ? `<small>${esc(e.memo)}</small>` : ""}</span>
      <button type="button" data-del="${esc(e.id)}" class="${CL.armed === e.id ? "arm" : ""}" aria-label="${esc(e.item)} 기록 지우기">${CL.armed === e.id ? "지우기" : "✕"}</button></div>`).join("")}</div>`).join("")
      : `<p class="empty-note">아직 소독 기록이 없어요. 위에서 [지금 소독했어요]를 눌러 보세요.</p>`;
  }
  function addClean(item, at, memo) {
    const e = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), item, at, memo: memo || "" };
    queueOp({ op: "add", e });
  }
  $("cleanItems").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-now]"); if (!b) return;
    addClean(b.dataset.now, localStamp(new Date()), "");
    toast(`${b.dataset.now} 소독 기록했어요`);
  });
  $("cleanPick").addEventListener("click", (ev) => { const b = ev.target.closest("button[data-pick]"); if (b) { CL.pick = b.dataset.pick; renderClean(); } });
  $("cleanForm").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const d = $("cleanDate").value, t = $("cleanTime").value;
    if (!validDate(d) || !/^\d{2}:\d{2}$/.test(t) || !CL.pick) { toast("날짜와 시간을 확인해 주세요"); return; }
    addClean(CL.pick, `${d}T${t}`, $("cleanMemo").value.trim().slice(0, 200));
    $("cleanMemo").value = "";
    toast(`${Number(d.slice(5, 7))}/${Number(d.slice(8))} ${t} ${CL.pick} 기록했어요`);
  });
  $("cleanLog").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-del]"); if (!b) return;
    const id = b.dataset.del;
    if (CL.armed === id) { CL.armed = null; queueOp({ op: "del", id }); return; }
    CL.armed = id; renderClean();
    clearTimeout(CL.armT); CL.armT = setTimeout(() => { CL.armed = null; renderClean(); }, 3000);
  });
  $("cleanItemsEdit").addEventListener("change", () => {
    const list = [...new Set($("cleanItemsEdit").value.split(/[,，]/).map((x) => x.trim().slice(0, 20)).filter(Boolean))].slice(0, 12);
    if (!list.length) { renderClean(); return; }
    queueOp({ op: "items", items: list });
  });

  /* ---------- stats ---------- */
  const ST = { mode: "week", ref: new Date(), days: [], data: {}, token: 0 };
  function periodRange() {
    const r = new Date(ST.ref.getFullYear(), ST.ref.getMonth(), ST.ref.getDate());
    let start, end;
    if (ST.mode === "week") {
      const dow = (r.getDay() + 6) % 7;
      start = new Date(r); start.setDate(r.getDate() - dow);
      end = new Date(start); end.setDate(start.getDate() + 6);
    } else {
      start = new Date(r.getFullYear(), r.getMonth(), 1);
      end = new Date(r.getFullYear(), r.getMonth() + 1, 0);
    }
    const days = []; for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) days.push(keyOf(d));
    return { start: keyOf(start), end: keyOf(end), days };
  }
  function renderStatsTitle(range) {
    const s = parseKey(range.start), e = parseKey(range.end), today = keyOf(new Date());
    let main, sub;
    if (ST.mode === "week") {
      main = range.days.includes(today) ? "이번 주" : `${s.getMonth() + 1}월 ${s.getDate()}일 주`;
      sub = `${s.getMonth() + 1}.${s.getDate()} (월) – ${e.getMonth() + 1}.${e.getDate()} (일)`;
    } else {
      main = `${s.getMonth() + 1}월`;
      sub = `${s.getFullYear()}년${range.days.includes(today) ? " · 이번 달" : ""}`;
    }
    $("sTitle").innerHTML = `${main}<small>${sub}</small>`;
    $("sNext").disabled = range.end >= today;
  }
  async function loadStats() {
    const range = periodRange();
    renderStatsTitle(range);
    ST.days = range.days;
    const token = ++ST.token;
    $("chartSub").textContent = "불러오는 중…";
    try {
      const j = await api("stats", { start: range.start, end: range.end });
      if (token !== ST.token) return;
      ST.data = j.days || {};
      $("chartSub").textContent = "막대를 누르면 그날 자세한 숫자가 보여요";
    } catch (e) {
      if (token !== ST.token) return;
      ST.data = {};
      $("chartSub").textContent = "통계를 불러오지 못했어요. 인터넷 연결을 확인해 주세요.";
    }
    renderStats();
  }
  const fmt1 = (n) => (Math.round(n * 10) / 10).toLocaleString("ko-KR");
  function renderStats() {
    const today = keyOf(new Date());
    const recs = ST.days.map((k) => ST.data[k]).filter(Boolean);
    const done = ST.days.filter((k) => k < today && ST.data[k]).map((k) => ST.data[k]);
    const base = done.length ? done : recs;
    const n = base.length;
    const sum = (list) => list.reduce((a, r) => ({ feeds: a.feeds + (r.feeds || 0), ml: a.ml + (r.ml || 0), pee: a.pee + (r.pee || 0), poo: a.poo + (r.poo || 0) }), { feeds: 0, ml: 0, pee: 0, poo: 0 });
    const b = sum(base), tot = sum(recs);
    const avg = (x) => (n ? fmt1(x / n) : "–");
    $("kAvgMl").innerHTML = `${n ? Math.round(b.ml / n).toLocaleString("ko-KR") : "–"}<small>ml</small>`;
    $("kTotMl").textContent = `합계 ${tot.ml.toLocaleString("ko-KR")}ml · 평균은 ${n}일 기준${done.length && done.length < recs.length ? "(오늘 제외)" : ""}`;
    $("kAvgFeeds").innerHTML = `${avg(b.feeds)}<small>회</small>`;
    $("kPerFeed").textContent = `1회 평균 ${tot.feeds ? Math.round(tot.ml / tot.feeds) : "–"}ml`;
    $("kAvgPee").innerHTML = `${avg(b.pee)}<small>회</small>`;
    $("kTotPee").textContent = `합계 ${tot.pee}회`;
    $("kAvgPoo").innerHTML = `${avg(b.poo)}<small>회</small>`;
    $("kTotPoo").textContent = `합계 ${tot.poo}회`;
    renderChart();
    const rowsHtml = ST.days.filter((k) => k <= today).reverse().map((k) => {
      const d = parseKey(k), r = ST.data[k], dp = dplus(k);
      const label = `${d.getMonth() + 1}/${d.getDate()} (${WD[d.getDay()]})${dp ? ` <span style="color:var(--muted);font-size:.72rem">D+${dp}</span>` : ""}`;
      if (!r) return `<tr class="go" data-k="${k}"><td>${label}</td><td class="empty">–</td><td class="empty">–</td><td class="empty">–</td><td class="empty">–</td></tr>`;
      return `<tr class="go" data-k="${k}"><td>${label}</td><td>${r.feeds || 0}회</td><td>${(r.ml || 0).toLocaleString("ko-KR")}</td><td>${r.pee || 0}</td><td>${r.poo || 0}</td></tr>`;
    }).join("");
    $("dailyTable").innerHTML = `<thead><tr><th>날짜</th><th>수유</th><th>분유ml</th><th>소변</th><th>대변</th></tr></thead>
      <tbody>${rowsHtml || `<tr><td colspan="5" class="empty-note">아직 지나간 날이 없어요</td></tr>`}</tbody>
      <tfoot><tr><td>합계</td><td>${tot.feeds}회</td><td>${tot.ml.toLocaleString("ko-KR")}</td><td>${tot.pee}</td><td>${tot.poo}</td></tr></tfoot>`;
  }
  $("dailyTable").addEventListener("click", (e) => {
    const tr = e.target.closest("tr.go"); if (!tr) return;
    leaveStats(); goDate(tr.dataset.k);
  });
  function niceMax(v) {
    if (v <= 0) return 400;
    for (const s of [100, 200, 250, 500, 1000]) { const m = Math.ceil(v / s) * s; if (m / s <= 5) return m; }
    return Math.ceil(v / 1000) * 1000;
  }
  function renderChart() {
    const box = $("chart");
    const W = Math.max(260, box.clientWidth || 320), H = 190;
    const L = 34, Rm = 4, T = 10, B = 24;
    const pw = W - L - Rm, ph = H - T - B;
    const days = ST.days, today = keyOf(new Date());
    const vals = days.map((k) => (ST.data[k] && ST.data[k].ml) || 0);
    const max = niceMax(Math.max(...vals));
    const slot = pw / days.length;
    const bw = Math.max(3, Math.min(28, slot - 2));
    const y = (v) => T + ph - (v / max) * ph;
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="날짜별 분유량 막대그래프">`;
    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i, yy = y(v);
      svg += `<line class="grid-l" x1="${L}" x2="${W - Rm}" y1="${yy}" y2="${yy}"/><text x="${L - 6}" y="${yy + 3}" text-anchor="end">${Math.round(v)}</text>`;
    }
    days.forEach((k, i) => {
      const v = vals[i], cx = L + slot * i + slot / 2;
      if (v > 0) {
        const top = y(v), h = T + ph - top, r = Math.min(4, bw / 2, h);
        const x0 = cx - bw / 2, x1 = cx + bw / 2, yb = T + ph;
        svg += `<path class="bar" d="M${x0},${yb} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x1 - r} Q${x1},${top} ${x1},${top + r} V${yb} Z"/>`;
      }
      const d = parseKey(k);
      if (ST.mode === "week" || d.getDate() === 1 || d.getDate() % 5 === 0) svg += `<text x="${cx}" y="${H - 8}" text-anchor="middle"${k === today ? ' style="fill:var(--accent);font-weight:600"' : ""}>${ST.mode === "week" ? WD[d.getDay()] : d.getDate()}</text>`;
      svg += `<rect class="hit" data-i="${i}" x="${L + slot * i}" y="${T}" width="${slot}" height="${ph}"/>`;
    });
    svg += `</svg><div class="tip" id="tip" hidden></div>`;
    box.innerHTML = svg;
    const tip = $("tip");
    const show = (i) => {
      const k = days[i], r = ST.data[k], d = parseKey(k);
      const cx = ((L + slot * i + slot / 2) / W) * box.clientWidth;
      const ty = ((vals[i] > 0 ? y(vals[i]) : T + ph) / H) * box.clientHeight - 6;
      tip.innerHTML = `<b>${d.getMonth() + 1}/${d.getDate()} (${WD[d.getDay()]})</b><br>` + (r ? `분유 ${(r.ml || 0).toLocaleString("ko-KR")}ml · ${r.feeds || 0}회<br>소변 ${r.pee || 0} · 대변 ${r.poo || 0}` : "기록 없음");
      tip.hidden = false;
      const half = tip.offsetWidth / 2;
      tip.style.left = Math.max(half, Math.min(box.clientWidth - half, cx)) + "px";
      tip.style.top = Math.max(tip.offsetHeight, ty) + "px";
    };
    box.querySelectorAll(".hit").forEach((h) => { const i = Number(h.dataset.i); h.addEventListener("pointerenter", () => show(i)); h.addEventListener("click", () => show(i)); });
    box.querySelector("svg").addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") tip.hidden = true; });
  }
  let rzT; window.addEventListener("resize", () => { clearTimeout(rzT); rzT = setTimeout(() => { if (!$("statsView").hidden) renderChart(); }, 150); });
  function setMode(m) { ST.mode = m; $("modeWeek").setAttribute("aria-pressed", String(m === "week")); $("modeMonth").setAttribute("aria-pressed", String(m === "month")); loadStats(); }
  $("modeWeek").addEventListener("click", () => setMode("week"));
  $("modeMonth").addEventListener("click", () => setMode("month"));
  function shiftPeriod(n) {
    const r = new Date(ST.ref);
    if (ST.mode === "week") r.setDate(r.getDate() + 7 * n); else { r.setDate(1); r.setMonth(r.getMonth() + n); }
    ST.ref = keyOf(r) > keyOf(new Date()) ? new Date() : r;
    loadStats();
  }
  $("sPrev").addEventListener("click", () => shiftPeriod(-1));
  $("sNext").addEventListener("click", () => shiftPeriod(1));

  /* ---------- setup screen + family link ---------- */
  $("connRepo").value = (CONN && CONN.r) || "wnsdud551-maker/feeding-note-data";
  $("connForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const raw = $("connToken").value.trim();
    const m = raw.match(/[#&]c=([A-Za-z0-9_\-]+)/);
    let c;
    if (m) { try { c = JSON.parse(unb64url(m[1])); } catch (er) {} }
    else c = { r: $("connRepo").value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/$/, ""), t: raw };
    if (!c || !/^[\w.-]+\/[\w.-]+$/.test(c.r || "") || !c.t) { $("connErr").textContent = "저장소 이름과 토큰을 확인해 주세요."; return; }
    $("connErr").textContent = "연결을 확인하는 중…";
    try {
      const f = await readJson("settings.json", c);
      // a test write proves the token can save records
      await writeJson("settings.json", { birth: "", presets: [120, 140, 160], ...(f.data || {}) }, f.sha, "연결 확인", c);
    } catch (er) {
      $("connErr").textContent = er.code === "network" ? "인터넷 연결을 확인해 주세요." : "저장소에 저장할 수 없어요. 저장소 이름, 토큰 권한(Contents: Read and write)을 확인해 주세요.";
      return;
    }
    ls.set(CKEY, { r: c.r, t: c.t });
    location.reload();
  });
  $("copyLink").addEventListener("click", async () => {
    const link = familyLink();
    $("linkBox").value = link; $("linkBox").hidden = false;
    try { await navigator.clipboard.writeText(link); $("copyLink").textContent = "복사했어요 ✓ 카톡에 붙여넣어 보내세요"; }
    catch (e) { $("linkBox").select(); $("copyLink").textContent = "아래 링크를 길게 눌러 복사하세요"; }
  });
  $("setupBack").addEventListener("click", () => { $("setupView").hidden = true; $("app").hidden = false; });
  $("resetConn").addEventListener("click", () => { $("setupView").hidden = false; $("app").hidden = true; window.scrollTo(0, 0); });

  /* ---------- updates: phones keep old copies, so check for a newer version and reload ---------- */
  const APP_VERSION = "20261108075223";
  async function checkUpdate() {
    if (busy()) return;
    try {
      const r = await fetch("version.json?t=" + Date.now(), { cache: "no-store" });
      const j = await r.json();
      if (j.v && j.v !== APP_VERSION && !busy()) {
        // reload once per new version, so a stale cache can never cause a reload loop
        let tried = null; try { tried = sessionStorage.getItem("feednote-reload"); } catch (e) {}
        if (tried === j.v) return;
        try { sessionStorage.setItem("feednote-reload", j.v); } catch (e) {}
        flushAll(); location.reload();
      }
    } catch (e) {}
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) checkUpdate(); });

  /* ---------- boot ---------- */
  renderTitle(); renderRows();
  if (!CONN) {
    $("setupView").hidden = false; $("app").hidden = true; $("setupBack").hidden = true;
    return;
  }
  armGuard();
  replayPending().finally(() => loadDay());
  flushClean();
  checkUpdate();
})();
