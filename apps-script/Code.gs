/**
 * 수유노트 저장소 (Google Apps Script)
 *
 * 이 코드를 구글 스프레드시트의 [확장 프로그램 → Apps Script]에 붙여넣고
 * [배포 → 새 배포 → 웹 앱] (실행: 나 / 액세스: 모든 사용자)로 배포하세요.
 * 배포된 웹 앱 주소를 열면 두 분이 쓸 "전용 링크"가 나옵니다.
 *
 * 비밀번호는 처음 실행할 때 자동으로 만들어져 이 스크립트의 속성에만 저장됩니다.
 * 이 파일(공개 저장소)에는 비밀번호가 들어 있지 않습니다.
 */

const APP_URL = 'https://wnsdud551-maker.github.io/feeding-note/';
const ROW_SHEET = '기록';
const ROW_HEAD = ['날짜', '시', '분', '분유ml', '소변', '대변', '메모', '저장시각'];
const MEMO_SHEET = '하루메모';
const MEMO_HEAD = ['날짜', '메모', '저장시각'];
const SET_SHEET = '설정';
const SET_HEAD = ['항목', '값'];

function getSecret_() {
  const props = PropertiesService.getScriptProperties();
  let s = props.getProperty('SECRET');
  if (!s) {
    s = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
    props.setProperty('SECRET', s);
  }
  return s;
}

function sheet_(name, head, textCols) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
    sh.setFrozenRows(1);
    // keep dates, hours and timestamps as plain text so Sheets doesn't reformat them
    (textCols || []).forEach(function (c) { sh.getRange(1, c, sh.getMaxRows(), 1).setNumberFormat('@'); });
  }
  return sh;
}
function rowsSheet_() { return sheet_(ROW_SHEET, ROW_HEAD, [1, 2, 7, 8]); }
function memoSheet_() { return sheet_(MEMO_SHEET, MEMO_HEAD, [1, 2, 3]); }
function setSheet_() { return sheet_(SET_SHEET, SET_HEAD, [1, 2]); }

function values_(sh) {
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, sh.getLastColumn()).getValues();
}
const str_ = function (v) { return v === null || v === undefined ? '' : String(v); };
const numOrNull_ = function (v) { return v === '' || v === null || v === undefined || isNaN(Number(v)) ? null : Number(v); };
function rowObj_(r) {
  return { min: numOrNull_(r[2]), ml: numOrNull_(r[3]), pee: Number(r[4]) || 0, poo: Number(r[5]) || 0, memo: str_(r[6]), at: str_(r[7]) };
}
function hourKey_(v) { const s = str_(v); return s.length === 1 ? '0' + s : s; }
function prevDate_(d) {
  const p = d.split('-').map(Number);
  const t = new Date(p[0], p[1] - 1, p[2] - 1);
  return t.getFullYear() + '-' + ('0' + (t.getMonth() + 1)).slice(-2) + '-' + ('0' + t.getDate()).slice(-2);
}
function settings_() {
  const out = {};
  values_(setSheet_()).forEach(function (r) { out[str_(r[0])] = str_(r[1]); });
  return {
    birth: out.birth || '',
    presets: (out.presets || '120,140,160').split(',').map(Number).filter(function (n) { return n > 0; })
  };
}
function validDate_(d) { return /^\d{4}-\d{2}-\d{2}$/.test(str_(d)); }

/* ---------- API ---------- */
function day_(req) {
  if (!validDate_(req.date)) throw new Error('bad_date');
  const prev = req.withPrev ? prevDate_(req.date) : null;
  const rows = {}, prevRows = {};
  values_(rowsSheet_()).forEach(function (r) {
    const d = str_(r[0]);
    if (d === req.date) rows[hourKey_(r[1])] = rowObj_(r);
    else if (prev && d === prev) prevRows[hourKey_(r[1])] = rowObj_(r);
  });
  let memo = '';
  values_(memoSheet_()).forEach(function (r) { if (str_(r[0]) === req.date) memo = str_(r[1]); });
  return { rows: rows, prevRows: prevRows, memo: memo, settings: settings_() };
}

function saveRow_(req) {
  if (!validDate_(req.date) || !/^\d{2}$/.test(str_(req.hour))) throw new Error('bad_row');
  const sh = rowsSheet_();
  const vals = values_(sh);
  let idx = -1;
  for (let i = 0; i < vals.length; i++) {
    if (str_(vals[i][0]) === req.date && hourKey_(vals[i][1]) === req.hour) { idx = i; break; }
  }
  const at = str_(req.at) || new Date().toISOString();
  if (idx >= 0) {
    const cur = rowObj_(vals[idx]);
    // the other phone saved this cell later: keep theirs
    if (cur.at && cur.at > at) return { applied: false, row: cur };
  }
  const v = req.row || {};
  const clamp = function (n, max) { n = numOrNull_(n); return n === null ? '' : Math.max(0, Math.min(max, Math.round(n))); };
  const line = [req.date, req.hour, clamp(v.min, 59), clamp(v.ml, 1000), clamp(v.pee, 9) || 0, clamp(v.poo, 9) || 0, str_(v.memo).slice(0, 2000), at];
  const empty = line[2] === '' && line[3] === '' && !line[4] && !line[5] && !line[6];
  if (empty) {
    if (idx >= 0) sh.deleteRow(idx + 2);
    return { applied: true, row: null };
  }
  if (idx >= 0) sh.getRange(idx + 2, 1, 1, line.length).setValues([line]);
  else {
    const r = sh.getLastRow() + 1;
    sh.getRange(r, 1, 1, line.length).setNumberFormats([['@', '@', '0', '0', '0', '0', '@', '@']]).setValues([line]);
  }
  return { applied: true, row: rowObj_(line) };
}

function saveMemo_(req) {
  if (!validDate_(req.date)) throw new Error('bad_date');
  const sh = memoSheet_();
  const vals = values_(sh);
  const at = str_(req.at) || new Date().toISOString();
  for (let i = 0; i < vals.length; i++) {
    if (str_(vals[i][0]) === req.date) {
      if (str_(vals[i][2]) > at) return { applied: false };
      sh.getRange(i + 2, 2, 1, 2).setValues([[str_(req.memo).slice(0, 5000), at]]);
      return { applied: true };
    }
  }
  if (!str_(req.memo)) return { applied: true };
  const r = sh.getLastRow() + 1;
  sh.getRange(r, 1, 1, 3).setNumberFormat('@').setValues([[req.date, str_(req.memo).slice(0, 5000), at]]);
  return { applied: true };
}

function saveSettings_(req) {
  const sh = setSheet_();
  const want = {
    birth: validDate_(req.birth) ? req.birth : '',
    presets: (req.presets || []).map(Number).filter(function (n) { return n > 0 && n <= 1000; }).slice(0, 9).join(',')
  };
  const vals = values_(sh);
  Object.keys(want).forEach(function (k) {
    let found = false;
    for (let i = 0; i < vals.length; i++) {
      if (str_(vals[i][0]) === k) { sh.getRange(i + 2, 2).setValue(want[k]); found = true; break; }
    }
    if (!found) sh.appendRow([k, want[k]]);
  });
  return {};
}

function stats_(req) {
  if (!validDate_(req.start) || !validDate_(req.end)) throw new Error('bad_date');
  const days = {};
  values_(rowsSheet_()).forEach(function (r) {
    const d = str_(r[0]);
    if (d < req.start || d > req.end) return;
    const o = days[d] || (days[d] = { feeds: 0, ml: 0, pee: 0, poo: 0 });
    const ml = Number(r[3]) || 0;
    if (ml > 0) { o.feeds++; o.ml += ml; }
    o.pee += Number(r[4]) || 0;
    o.poo += Number(r[5]) || 0;
  });
  return { days: days };
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad_request' }); }
  if (!req || req.key !== getSecret_()) return json_({ ok: false, error: 'key' });
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    let out;
    switch (req.action) {
      case 'day': out = day_(req); break;
      case 'saveRow': out = saveRow_(req); break;
      case 'saveMemo': out = saveMemo_(req); break;
      case 'saveSettings': out = saveSettings_(req); break;
      case 'stats': out = stats_(req); break;
      default: return json_({ ok: false, error: 'bad_action' });
    }
    out.ok = true;
    return json_(out);
  } catch (err) {
    return json_({ ok: false, error: 'server', message: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
}

/* Opening the web app address shows the private link to share. */
function doGet() {
  rowsSheet_(); memoSheet_(); setSheet_();
  const conn = JSON.stringify({ u: ScriptApp.getService().getUrl(), k: getSecret_() });
  const c = Utilities.base64EncodeWebSafe(conn, Utilities.Charset.UTF_8).replace(/=+$/, '');
  const link = APP_URL + '#c=' + c;
  const html =
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:24px auto;padding:0 16px;line-height:1.6;color:#1f2d3d}' +
    'h1{font-size:1.3rem}textarea{width:100%;height:120px;font:inherit;font-size:.85rem;padding:8px;border:1px solid #ccd;border-radius:8px}' +
    'a.btn{display:inline-block;background:#3b6fd8;color:#fff;padding:10px 16px;border-radius:999px;text-decoration:none;font-weight:600}' +
    '.warn{background:#fff6e0;padding:10px 12px;border-radius:8px}</style></head><body>' +
    '<h1>수유노트 연결 완료 ✓</h1>' +
    '<p>아래가 두 분만 쓰는 <b>전용 링크</b>예요. 이 링크를 본인 폰과 와이프분 폰에서 한 번씩 열면, 그다음부터는 홈 화면 아이콘으로 바로 열려요.</p>' +
    '<textarea readonly onclick="this.select()">' + link + '</textarea>' +
    '<p><a class="btn" href="' + link + '" target="_blank">수유노트 열기</a></p>' +
    '<p class="warn">이 링크를 아는 사람은 기록을 보고 쓸 수 있어요. 가족 말고는 보내지 마세요.</p>' +
    '</body></html>';
  return HtmlService.createHtmlOutput(html).setTitle('수유노트 연결').addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
