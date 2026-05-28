/**
 * ⚠ 廃止 (2026-05-09)
 *
 * 真の原因はこのスクリプトではなく `syncAvailability` 側にあった。
 * `syncAvailability` が targetDates を絞り込んだ上でシート全消去→書き戻しを
 * していたため、このスクリプトで追加した行も 5 分以内にすべて消されていた。
 *
 * 修正は `apps_script/sync_availability.gs` 側で完結している。
 * 当ファイルは参考のため残置。新規に走らせる必要なし。トリガーも作らないこと。
 *
 * 詳細: notes/空き状況完成.txt
 *
 * --- 以下は旧コード（参考用）---
 *
 * Google Sheets: Availability シートの欠落日を自動補完するスクリプト
 *
 * - スプレッドシート ID: 1Lyl_tjTHza8Wfp2WiDepi_ZTY_Xo6Xqpuhgog-lufFY
 * - シート名: Availability
 * - 役割:
 *     ・指定期間（既定: 今日 〜 今日 + 365 日）の中で、行が無い日付を発見
 *     ・1 日あたり Kana AM / Kana PM / Sho AM / Sho PM の 4 行をデフォルト値で追加
 *     ・既存行や Manual Lock=TRUE の行には一切触らない
 *     ・ステータスのデフォルトは calendar_sync_complete.gs の挙動に合わせて
 *         Kana = 'Off'（availability モード = カレンダーに勤務イベントがある日だけ Available）
 *         Sho  = 'Available'（offOnly モード = カレンダーに Off イベントがある日だけ Off）
 *     ・Source は 'Manual' で入れるが、後段の calendar_sync_complete.gs が
 *       カレンダー判定に応じて Status / Source を上書きする想定
 *
 * 設置方法:
 *   1. https://docs.google.com/spreadsheets/d/1Lyl_tjTHza8Wfp2WiDepi_ZTY_Xo6Xqpuhgog-lufFY/edit を開く
 *   2. Extensions > Apps Script
 *   3. このファイル全体を貼り付けて Save
 *   4. 関数選択ドロップダウンで fillMissingDates を選んで Run（初回のみ権限承認）
 *   5. 毎日自動実行したい場合は Triggers から fillMissingDatesDaily を Time-driven / Daily に登録
 */

const FILL_CONFIG = {
  spreadsheetId: '1Lyl_tjTHza8Wfp2WiDepi_ZTY_Xo6Xqpuhgog-lufFY',
  sheetName: 'Availability',
  timeZone: 'Asia/Tokyo',
  staff: ['Kana', 'Sho'],
  slots: ['AM', 'PM'],
  defaultStatusByStaff: {
    Kana: 'Off',
    Sho: 'Available',
  },
  // 末尾までに埋めたい固定の終端日（例: 営業計画上の最終日）
  // null にすると today + rollingDays までが対象
  targetEndDate: '2027-01-31',
  // targetEndDate より先（または targetEndDate=null のとき）に追加で埋めるバッファ日数
  rollingDays: 365,
};

/**
 * 手動実行用エントリポイント。設定に従って欠落日を補完する。
 */
function fillMissingDates() {
  const result = fillMissingDatesCore({});
  console.log(JSON.stringify(result, null, 2));
}

/**
 * 毎日自動実行用エントリポイント（Trigger に登録するのはこの関数）。
 * targetEndDate より先 365 日分も常に埋め続けるローリング窓。
 */
function fillMissingDatesDaily() {
  const result = fillMissingDatesCore({});
  console.log('[Daily fill] ' + JSON.stringify(result));
}

function fillMissingDatesCore(opts) {
  const cfg = Object.assign({}, FILL_CONFIG, opts || {});
  const sheet = SpreadsheetApp.openById(cfg.spreadsheetId).getSheetByName(cfg.sheetName);
  if (!sheet) throw new Error('Sheet not found: ' + cfg.sheetName);

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 1) throw new Error('Sheet is empty (no header row)');

  const data = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const headerLen = data[0].length;

  // 既存日付セットの構築（Date 型・文字列の両対応）
  const existingDates = new Set();
  for (let i = 1; i < data.length; i++) {
    const key = normalizeDateCell(data[i][0], cfg.timeZone);
    if (key) existingDates.add(key);
  }

  // 補完対象期間
  const todayKey = formatDateKey(new Date(), cfg.timeZone);
  const startKey = todayKey;
  const rollingEnd = addDaysToKey(todayKey, cfg.rollingDays);
  const targetEnd = cfg.targetEndDate || rollingEnd;
  // targetEndDate と rolling の遅い方まで埋める
  const endKey = targetEnd > rollingEnd ? targetEnd : rollingEnd;

  const allDates = enumerateDateKeys(startKey, endKey);
  const missingDates = allDates.filter(d => !existingDates.has(d));

  console.log('today=' + todayKey + '  end=' + endKey
    + '  existing=' + existingDates.size
    + '  span=' + allDates.length
    + '  missing=' + missingDates.length);

  if (missingDates.length === 0) {
    return { added: 0, missingDates: 0, start: startKey, end: endKey };
  }

  // 新規行の組み立て（ヘッダーと同じ列数で揃える）
  const headerRow = data[0];
  const headerIdx = {
    Date: headerRow.indexOf('Date'),
    Staff: headerRow.indexOf('Staff'),
    'Time Slot': headerRow.indexOf('Time Slot'),
    Status: headerRow.indexOf('Status'),
    Source: headerRow.indexOf('Source'),
    'Manual Lock': headerRow.indexOf('Manual Lock'),
  };
  for (const k of Object.keys(headerIdx)) {
    if (headerIdx[k] < 0) throw new Error('Header column not found: ' + k);
  }

  const newRows = [];
  for (const dateStr of missingDates) {
    for (const person of cfg.staff) {
      for (const slot of cfg.slots) {
        const row = new Array(headerLen).fill('');
        row[headerIdx.Date] = dateStr;
        row[headerIdx.Staff] = person;
        row[headerIdx['Time Slot']] = slot;
        row[headerIdx.Status] = cfg.defaultStatusByStaff[person] || 'Available';
        row[headerIdx.Source] = 'Manual';
        row[headerIdx['Manual Lock']] = 'FALSE';
        newRows.push(row);
      }
    }
  }

  // 末尾にまとめて書き込み → 日付列でソート
  sheet.getRange(lastRow + 1, 1, newRows.length, headerLen).setValues(newRows);
  sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn())
    .sort([
      { column: headerIdx.Date + 1, ascending: true },
      { column: headerIdx.Staff + 1, ascending: true },
      { column: headerIdx['Time Slot'] + 1, ascending: true },
    ]);

  return {
    added: newRows.length,
    missingDates: missingDates.length,
    start: startKey,
    end: endKey,
    sample: missingDates.slice(0, 5),
  };
}

/* ========== ユーティリティ ========== */

/**
 * Date セルが Date 型でも文字列でも 'yyyy-MM-dd' に正規化して返す。
 * 認識できない値は null を返す（ヘッダー行や空セル等）。
 */
function normalizeDateCell(cell, tz) {
  if (cell instanceof Date && !isNaN(cell.getTime())) {
    return Utilities.formatDate(cell, tz, 'yyyy-MM-dd');
  }
  if (typeof cell === 'string') {
    const t = cell.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
    if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(t)) {
      const [y, m, d] = t.split('/').map(n => parseInt(n, 10));
      return [y, pad2(m), pad2(d)].join('-');
    }
    if (/^\d{4}年\d{1,2}月\d{1,2}日$/.test(t)) {
      const m1 = t.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/);
      return [m1[1], pad2(parseInt(m1[2], 10)), pad2(parseInt(m1[3], 10))].join('-');
    }
  }
  return null;
}

function formatDateKey(date, tz) {
  return Utilities.formatDate(date, tz, 'yyyy-MM-dd');
}

function addDaysToKey(key, days) {
  const [y, m, d] = key.split('-').map(n => parseInt(n, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return [
    dt.getUTCFullYear(),
    pad2(dt.getUTCMonth() + 1),
    pad2(dt.getUTCDate()),
  ].join('-');
}

function enumerateDateKeys(startKey, endKey) {
  const out = [];
  let cur = startKey;
  let safety = 0;
  while (cur <= endKey && safety < 5000) {
    out.push(cur);
    cur = addDaysToKey(cur, 1);
    safety++;
  }
  return out;
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

/**
 * メニューに「Fill Gaps」を追加（onOpen は calendar_sync 側にもあるので統合は手動で）。
 */
function onOpenFillMenu() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Fill Gaps')
    .addItem('Fill missing dates (today → 2027-01-31)', 'fillMissingDates')
    .addToUi();
}
