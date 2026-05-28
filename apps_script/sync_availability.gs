/**
 * Google Calendar / Bokun -> Availability sync for Google Apps Script.
 *
 * Container-bound script target:
 * https://docs.google.com/spreadsheets/d/1Lyl_tjTHza8Wfp2WiDepi_ZTY_Xo6Xqpuhgog-lufFY/edit
 *
 * 2026-05-09 修正:
 *   旧版は targetDates を「今日 + 明日 + カレンダーに予定がある日 + Manual行」だけで構成し、
 *   毎回 replaceSheetRows_ でシート全消去 → targetDates だけ書き戻していた。
 *   そのため「カレンダーに予定が無い日付」は再構築のたびに消えていた。
 *   修正後は「今日 〜 今日 + syncDays」を必ず targetDates に含める。
 *   これにより fill_missing_dates.gs は不要（syncAvailability 単独で全日埋まる）。
 *
 * 2026-05-25 修正:
 *   (1) タイムアウト対策: CalendarApp の getter は1回ごとに通信が走る。旧版は
 *       calculateStaffSlotStatus_ を 約(syncDays)×2スタッフ×2枠 回呼び、毎回全予定を
 *       走査して getter を叩いていたため、予定が多い時期に6分上限を超えて失敗していた。
 *       → groupEventsByDate_ でスタッフ予定を日付インデックス化し、その日の分だけ見る。
 *   (2) 雨天中止（e-bikeのみクローズ）: カレンダーに「雨天中止」(+AM/PM)と書くと、
 *       該当日(枠)の Notes に EBIKE_CLOSED を付与。Status は Available のままなので
 *       HP 側で e-bike 2ツアーだけ非表示・姫路城ガイドは残る。
 *   (3) 全休（全ツアークローズ）: 「全休」(+AM/PM)等で該当日(枠)を全員 Off にする。
 *
 * 2026-05-28 修正（訂正ノート反映）:
 *   (1) 予約済み判定: タイトルではなくイベント「説明欄(description)」に参加スタッフ名が
 *       入っている場合、そのイベント時間に重なる枠で該当スタッフを Off（予約済み）にする。
 *       → buildStaffOccupancyMap_ / applyStaffOccupancy_。Bokunでツアー確定済みの枠と
 *       Manual Lock 行は保持する。
 *   (2) 勤務時間判定: Kana(availability)の Available 判定を「枠終了」ではなく
 *       「ツアー終了時刻(slotWindows.tourEnd)」基準に変更（AM=12:00 / PM=17:00）。
 *   (3) OFF/AVAILABLE 記号を訂正ノートに合わせて拡張（🟢 / ✗ を追加）。
 *   (4) 時間付きOFF: 「砂川✖ 9:30-13:00」のように✖に時間レンジがある場合、その時間に
 *       重なる枠だけ Off にし、重ならない枠は通常判定（昼からのツアー等は Available）。
 *       終日✖（all-day / 時間指定なし）は従来どおり終日 Off。→ offEventBlocksSlot_。
 *
 * 判定優先順位（訂正ノート）:
 *   1. Manual Lock = TRUE      → 一切変更しない
 *   2. ✖ / OFF                 → 終日 Off（時間付き✖は重なる枠のみ Off）
 *   3. 予約済みイベント重複     → 該当時間帯 Off
 *   4. 勤務時間不足             → Off（スタッフ終了時刻 < ツアー終了時刻）
 *   5. 問題なし                 → Available
 */

const CONFIG = {
  calendarId: 'comecomehimeji@gmail.com',
  timeZone: 'Asia/Tokyo',
  availabilitySheetName: 'Availability',
  archiveSheetName: 'Archive',
  syncDays: 15,
  staffPriority: ['Kana', 'Sho'],
  staff: {
    Kana: {
      aliases: ['Kana', '畑中'],
      calendarMode: 'availability',
    },
    Sho: {
      aliases: ['Sho', '砂川'],
      calendarMode: 'offOnly',
    },
  },
  slotWindows: {
    // start/end = 重複判定用の枠（カレンダー予定がこの枠に重なるか）
    // tourEnd   = Kana(availability)の勤務時間判定で「ここまで勤務していれば Available」とする時刻
    //   訂正ノート テストケース1（Kana 09:30-12:00 → AM Available）に合わせ AM の tourEnd は 12:00。
    //   ※ノート本文の「AMウィンドウ 09:30–12:30」と末尾(12:00)に食い違いがあるためテストケース優先。
    AM: { start: '09:30', end: '12:30', tourEnd: '12:00' },
    PM: { start: '13:30', end: '17:00', tourEnd: '17:00' },
  },
  headers: [
    'Date',
    'Staff',
    'Time Slot',
    'Status',
    'Tour',
    'Booked',
    'Capacity',
    'Notes',
    'Source',
    'Manual Lock',
  ],
  allowedValues: {
    'Time Slot': ['AM', 'PM'],
    Status: ['Available', 'Off'],
    Tour: [
  'e-bike Ride around the Castle',
  'Slurp Like a Local',
  'e-bike Ride to the Sea',
  'Himeji castle guide tour',
  'e-Bike Tour in the Shisō Region with Lunch at a Sake Brewery',
  'e-bike Head to the Healing Cave',
  'Himeji Hidden Land Ride and Hike',
  'RentalCycle',
],
    Source: ['Calendar', 'Bokun', 'Manual'],
    'Manual Lock': ['TRUE', 'FALSE'],
  },
tours: [
  {
    name: 'e-bike Ride around the Castle',
    capacity: 4,
    patterns: [
      /e-?bike\s+ride\s+around\s+the\s+castle.*slurp\s+like\s+a\s+local/i,
      /castle\s+town/i,
    ],
  },
  {
    name: 'e-bike Ride to the Sea',
    capacity: 4,
    patterns: [
      /e-?bike\s+ride\s+to\s+the\s+sea.*slurp\s+like\s+a\s+local/i,
      /shikama\s+kaido/i,
    ],
  },
  {
    name: 'Himeji castle guide tour',
    capacity: 8,
    patterns: [/himeji\s+castle\s+guide\s+tour/i, /castle\s+guide/i],
  },
  {
    name: 'e-Bike Tour in the Shisō Region with Lunch at a Sake Brewery',
    capacity: 4,
    patterns: [
      /e-?bike\s+tour\s+in\s+the\s+shis[oō]\s+region/i,
      /sake\s+brewery/i,
    ],
  },
  {
    name: 'e-bike Head to the Healing Cave',
    capacity: 4,
    patterns: [/healing\s+cave/i, /hidden\s+land\s+ride\s+and\s+hike/i],
  },
],
  relevantEventPatterns: [
    /畑中/,
    /砂川/,
    /Kana/i,
    /Sho/i,
    /Bokun/i,
    /e-bike/i,
    /e-Bike/i,
    /Himeji/i,
    /Castle/i,
    /tour/i,
    /Tour/i,
    /ツアー/,
    // 雨天中止（e-bikeのみ）
    /雨天中止/, /荒天中止/, /自転車中止/, /サイクリング中止/, /e-?bike\s*中止/i,
    // 全休（全ツアー）
    /全休/, /全ツアークローズ/, /臨時休業/, /\bCLOSED\b/i,
  ],
  // 訂正ノート: AVAILABLE_REGEX = /〇|○|◯|⭕|🟢/ , OFF_REGEX = /OFF|✖|❌|×|✕|✗/i
  availablePatterns: [/○/, /〇/, /◯/, /⭕/, /🟢/, /✅/, /✔/, /\bOK\b/i],
  offPatterns: [/×/, /✖/, /✕/, /✗/, /❌/, /❎/, /\bX\b/i, /休み/, /\bOFF\b/i],
  // 雨天中止: e-bike 2ツアーだけクローズ（姫路城ガイドは残す）
  ebikeClosePatterns: [/雨天中止/, /荒天中止/, /自転車中止/, /サイクリング中止/, /e-?bike\s*中止/i],
  // 全休: 全ツアー(城ガイド含む)を Off にする
  closeAllPatterns: [/全休/, /全ツアークローズ/, /臨時休業/, /\bCLOSED\b/i],
};

function syncAvailability() {

  const lock = LockService.getScriptLock();

  if (!lock.tryLock(1000)) {
    Logger.log('syncAvailability already running');
    return;
  }

  try {
  // setupSheets();←コメントアウトor削除
  archivePastRows();

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.availabilitySheetName);
  const today = startOfToday_();
  const end = addDays_(today, CONFIG.syncDays + 1);
  const todayStr = formatDate_(today);

  const calendar = CalendarApp.getCalendarById(CONFIG.calendarId);
  if (!calendar) {
    throw new Error('Calendar not found: ' + CONFIG.calendarId);
  }

  const events = calendar.getEvents(today, end).filter(isRelevantEvent_);
  const staffEvents = events.filter(isStaffCalendarEvent_);
  const bookingEvents = events.filter(isBookingCalendarEvent_);
  const bookings = bookingEvents.map(parseBookingEvent).filter(Boolean);

  // スタッフ予定を日付でインデックス化（全件走査をやめてタイムアウトを防ぐ）
  const staffEventsByDate = groupEventsByDate_(staffEvents);

  // 雨天中止 / 全休 を日付+枠で集計
  const ebikeCloseMap = buildEbikeCloseMap_(events);
  const closeAllMap = buildCloseAllMap_(events);

  // 予約済みイベント（説明欄の参加スタッフ）→ 該当スタッフを重複枠でOff
  const occupancyMap = buildStaffOccupancyMap_(events);

  const manualRows = readRows_(sheet).filter(function(row) {
    return isManualLocked_(row) || isManualLikeUnlocked_(row);
  });

  // 全日付を必ず埋める（今日〜今日+syncDays）。
  // Manual Lock 行は範囲外（過去日など）でも残す。
  const targetDates = {};
  for (let i = 0; i <= CONFIG.syncDays; i++) {
    targetDates[formatDate_(addDays_(today, i))] = true;
  }
  manualRows.forEach(function(row) {
    const dateKey = normalizeDateValue_(row.Date);
    if (dateKey && dateKey >= todayStr) targetDates[dateKey] = true;
  });

  const availabilityMap = buildBaseAvailability_(Object.keys(targetDates), staffEventsByDate);
  const warnings = preserveManualRows_(availabilityMap, manualRows, todayStr);
  applyBookings_(availabilityMap, bookings, warnings);

  // 予約済み（説明欄の参加スタッフ）→ 該当スタッフを Off（Bokunでツアー確定済みの枠は保持）
  applyStaffOccupancy_(availabilityMap, occupancyMap);

  // 雨天中止（e-bikeのみ非表示マーカー）→ その後 全休（全Off）の順で上書き
  applyEbikeCloses_(availabilityMap, ebikeCloseMap);
  applyCloseAll_(availabilityMap, closeAllMap);

  const outputRows = Object.keys(availabilityMap)
    .sort(sortAvailabilityKeys_)
    .map(function(key) {
      return rowObjectToArray_(availabilityMap[key]);
    });


    replaceSheetRows_(sheet, outputRows);

  } finally {
    lock.releaseLock();
  }
}

// スタッフ予定を { 'yyyy-MM-dd': [event, ...] } にまとめる（getter呼び出し削減）
function groupEventsByDate_(events) {
  const map = {};
  for (let i = 0; i < events.length; i++) {
    const key = formatDate_(events[i].getStartTime());
    (map[key] = map[key] || []).push(events[i]);
  }
  return map;
}

// イベント名から対象枠を判定（AM/午前 → 'AM'、PM/午後 → 'PM'、無指定or両方 → null=終日）
function detectSlotScope_(text) {
  const hasAM = /\bAM\b/i.test(text) || /午前/.test(text);
  const hasPM = /\bPM\b/i.test(text) || /午後/.test(text);
  if (hasAM && !hasPM) return 'AM';
  if (hasPM && !hasAM) return 'PM';
  return null;
}

// 雨天中止 → { 'yyyy-MM-dd|AM': true, ... }
function buildEbikeCloseMap_(events) {
  const map = {};
  for (let i = 0; i < events.length; i++) {
    const text = eventText_(events[i]);
    if (!CONFIG.ebikeClosePatterns.some(function(p) { return p.test(text); })) continue;
    const dateKey = formatDate_(events[i].getStartTime());
    const scope = detectSlotScope_(text);
    if (scope === 'AM' || scope === null) map[dateKey + '|AM'] = true;
    if (scope === 'PM' || scope === null) map[dateKey + '|PM'] = true;
  }
  return map;
}

// 全休 → { 'yyyy-MM-dd|AM': true, ... }
function buildCloseAllMap_(events) {
  const map = {};
  for (let i = 0; i < events.length; i++) {
    const text = eventText_(events[i]);
    if (!CONFIG.closeAllPatterns.some(function(p) { return p.test(text); })) continue;
    const dateKey = formatDate_(events[i].getStartTime());
    const scope = detectSlotScope_(text);
    if (scope === 'AM' || scope === null) map[dateKey + '|AM'] = true;
    if (scope === 'PM' || scope === null) map[dateKey + '|PM'] = true;
  }
  return map;
}

// 雨天中止: Status は触らず Notes に EBIKE_CLOSED を付ける（HP側で e-bike だけ消す）
function applyEbikeCloses_(map, ebikeCloseMap) {
  Object.keys(map).forEach(function(key) {
    const row = map[key];
    if (isManualLocked_(row)) return; // 手動ロックは尊重
    if (ebikeCloseMap[row.Date + '|' + row['Time Slot']]) {
      row.Notes = appendNote_(row.Notes, 'EBIKE_CLOSED');
    }
  });
}

// 全休: 該当日(枠)を全員 Off にして全ツアーを消す
function applyCloseAll_(map, closeAllMap) {
  Object.keys(map).forEach(function(key) {
    const row = map[key];
    if (isManualLocked_(row)) return; // 手動ロックは尊重
    if (closeAllMap[row.Date + '|' + row['Time Slot']]) {
      row.Status = 'Off';
      row.Tour = '';
      row.Booked = '';
      row.Capacity = '';
      row.Notes = appendNote_(row.Notes, 'Closed (全休)');
      row.Source = 'Calendar';
    }
  });
}

// 予約済みイベント → { 'yyyy-MM-dd|Staff|AM': true, ... }
// 訂正ノート: 予約済み判定はタイトルではなくイベント「説明欄(description)」を使う。
//   説明欄にスタッフ名が含まれていれば、そのイベント時間に重なる枠で該当スタッフを Off 扱い。
//   Bokunツアー予約は applyBookings_ が別途処理するため、ここでは除外する。
function buildStaffOccupancyMap_(events) {
  const map = {};
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (isBookingCalendarEvent_(event)) continue; // Bokun予約は applyBookings_ に任せる
    if (isOffEvent_(event)) continue;             // 休みイベントは占有ではない

    const description = event.getDescription() || '';
    const staffInDesc = detectAllStaffInText_(description);
    if (!staffInDesc.length) continue;

    const start = event.getStartTime();
    const end = event.getEndTime();
    if (!start || !end || isNaN(start.getTime()) || isNaN(end.getTime())) continue;
    const dateKey = formatDate_(start);

    ['AM', 'PM'].forEach(function(slot) {
      const w = CONFIG.slotWindows[slot];
      const slotStart = dateTimeFromParts_(dateKey, w.start);
      const slotEnd = dateTimeFromParts_(dateKey, w.end);
      // 重複判定式（訂正ノート）: eventStart < tourEnd AND eventEnd > tourStart
      const overlaps =
        start.getTime() < slotEnd.getTime() && end.getTime() > slotStart.getTime();
      if (!overlaps) return;
      staffInDesc.forEach(function(staffName) {
        map[dateKey + '|' + staffName + '|' + slot] = true;
      });
    });
  }
  return map;
}

// 予約済み: 該当スタッフ枠を Off にする（Manual Lock と Bokun確定枠は保持）
function applyStaffOccupancy_(map, occupancyMap) {
  Object.keys(occupancyMap).forEach(function(occKey) {
    const parts = occKey.split('|'); // [date, staff, slot]
    const key = makeKey_(parts[0], parts[1], parts[2]);
    const row = map[key] || blankRow_(parts[0], parts[1], parts[2]);
    if (isManualLocked_(row)) return;             // 1. Manual Lock 最優先
    if (row.Source === 'Bokun' && row.Tour) return; // 確定済み予約は保持
    row.Status = 'Off';
    row.Tour = '';
    row.Booked = '';
    row.Capacity = '';
    row.Notes = appendNote_(row.Notes, 'Booked (参加スタッフ)');
    row.Source = 'Calendar';
    map[key] = row;
  });
}

// テキスト（主に説明欄）に含まれる全スタッフを alias 部分一致で返す
function detectAllStaffInText_(text) {
  const found = [];
  CONFIG.staffPriority.forEach(function(staffName) {
    const matched = CONFIG.staff[staffName].aliases.some(function(alias) {
      return new RegExp(escapeRegExp_(alias), 'i').test(text);
    });
    if (matched) found.push(staffName);
  });
  return found;
}

function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const availability = getOrCreateSheet_(ss, CONFIG.availabilitySheetName);
  const archive = getOrCreateSheet_(ss, CONFIG.archiveSheetName);
  [availability, archive].forEach(function(sheet) {
    ensureHeader_(sheet);
    applyValidations_(sheet);
  });
}

function setupTrigger() {
  // 既存の syncAvailability トリガーを全削除してから作り直す
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'syncAvailability') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  // 毎日 6時 / 7時 / 8時 / 9時 / 18時 / 0時(24時) に実行（各時間帯の中で起動。分単位指定は不可）
  const hours = [6, 7, 8, 9, 18, 0];
  hours.forEach(function(hour) {
    ScriptApp.newTrigger('syncAvailability')
      .timeBased()
      .atHour(hour)
      .everyDays(1)
      .inTimezone(CONFIG.timeZone)
      .create();
  });
}

function parseBookingEvent(event) {
  const title = event.getTitle() || '';
  const description = event.getDescription() || '';
const text = [title, description].join('\n');

const isRentalCycle =
  text.includes('レンタサイクル') ||
  text.includes('rental cycle') ||
  text.includes('Rental Cycle');

const start = event.getStartTime();
  if (!start || isNaN(start.getTime())) {
    console.error('Booking event date/time could not be parsed: ' + title);
    return null;
  }

const tour = isRentalCycle
  ? { name: 'RentalCycle', capacity: '' }
  : detectTour_(text);
  const booked = detectBookedCount_(text);
  const bookingId = detectBookingId_(text);
  const bookingKey = bookingId || event.getId();
  const staff = detectStaff_(text);
  const errors = [];

  if (!tour) {
    errors.push('Tour could not be detected');
    console.error(errors[errors.length - 1] + ': ' + title);
  }
  if (!booked) {
    errors.push('Booked count could not be detected');
    console.error(errors[errors.length - 1] + ': ' + title);
  }

  return {
    eventId: event.getId(),
    bookingId: bookingKey,
    date: formatDate_(start),
    slot: start.getHours() < 12 ? 'AM' : 'PM',
    startTime: Utilities.formatDate(start, CONFIG.timeZone, 'HH:mm'),
    tour: tour ? tour.name : '',
    booked: booked || '',
    capacity: tour ? tour.capacity : '',
    staff: staff,
    notes: buildBookingNotes_(bookingKey, title, errors),
    errors: errors,
  };
}

function archivePastRows() {
 // setupSheets();

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const availability = ss.getSheetByName(CONFIG.availabilitySheetName);
  const archive = ss.getSheetByName(CONFIG.archiveSheetName);
  const todayStr = formatDate_(startOfToday_());
  const rows = readRows_(availability);
  const keep = [];
  const move = [];

  rows.forEach(function(row) {
    const dateKey = normalizeDateValue_(row.Date);
    if (dateKey && dateKey < todayStr) {
      move.push(rowObjectToArray_(row));
    } else {
      keep.push(rowObjectToArray_(row));
    }
  });

  if (move.length) {
    archive
      .getRange(archive.getLastRow() + 1, 1, move.length, CONFIG.headers.length)
      .setValues(move);
  }

  replaceSheetRows_(availability, keep);
}

function buildBaseAvailability_(dates, staffEventsByDate) {
  const map = {};
  dates.sort().forEach(function(dateKey) {
    CONFIG.staffPriority.forEach(function(staffName) {
      ['AM', 'PM'].forEach(function(slot) {
        const status = calculateStaffSlotStatus_(staffName, dateKey, slot, staffEventsByDate);
        map[makeKey_(dateKey, staffName, slot)] = {
          Date: dateKey,
          Staff: staffName,
          'Time Slot': slot,
          Status: status,
          Tour: '',
          Booked: '',
          Capacity: '',
          Notes: '',
          Source: 'Calendar',
          'Manual Lock': 'FALSE',
        };
      });
    });
  });
  return map;
}

/**
 * スタッフ×日付×枠の Status を算出（カレンダーの勤務予定ベース）。
 * 訂正ノート determineStatus 仕様:
 *   - availability(Kana): 勤務可能時間ベース。〇付き勤務予定が枠開始までに始まり、
 *     ツアー終了時刻(slotWindows.tourEnd)まで続いていれば Available、それ以外は Off。
 *   - offOnly(Sho): OFF 判定を最優先。OFF が無く、枠に重なる予定が無ければ Available。
 * ここでは優先順位 2(OFF) と 4(勤務時間不足) を扱う。
 * 1(Manual Lock) は preserveManualRows_、3(予約済み) は applyStaffOccupancy_ で処理する。
 */
function calculateStaffSlotStatus_(staffName, dateKey, slot, staffEventsByDate) {

  const staffConfig = CONFIG.staff[staffName];

  // その日の予定だけを見る（全件走査しない）
  const sameDayEvents = staffEventsByDate[dateKey] || [];
  const dayEvents = [];

  for (let i = 0; i < sameDayEvents.length; i++) {
    const event = sameDayEvents[i];
    if (!eventMatchesStaff_(event, staffName)) continue;
    dayEvents.push(event);
  }

  const slotWindow = CONFIG.slotWindows[slot];
  const slotStart = dateTimeFromParts_(dateKey, slotWindow.start);
  const slotEnd = dateTimeFromParts_(dateKey, slotWindow.end);
  // 勤務時間判定の基準終了時刻（ツアー終了時刻相当）。Kana の Available 判定に使う。
  const slotTourEnd = dateTimeFromParts_(dateKey, slotWindow.tourEnd || slotWindow.end);

  // OFF判定（優先）: ✖/OFF の予定がこの枠に重なれば Off。
  //   - 終日✖（all-day や時間指定なし）→ 全枠に重なるので終日 Off。
  //   - 時間付き✖（例: 砂川✖ 9:30-13:00）→ 重なる枠だけ Off。重ならない枠は通常判定へ。
  const hasOffOverlap = dayEvents.some(function(event) {
    return isOffEvent_(event) && offEventBlocksSlot_(event, dateKey, slotStart, slotEnd);
  });
  if (hasOffOverlap) {
    return 'Off';
  }

  // =========================
  // Kana（畑中）
  // =========================
  if (staffConfig.calendarMode === 'availability') {

    const hasAvailableEvent = dayEvents.some(function(event) {

      // ○が付いていない予定は無視
      if (!isAvailableEvent_(event)) return false;

      // 勤務時間判定: 開始 <= 枠開始 かつ 終了 >= ツアー終了時刻なら Available
      return event.getStartTime().getTime() <= slotStart.getTime() &&
             event.getEndTime().getTime() >= slotTourEnd.getTime();
    });

    return hasAvailableEvent ? 'Available' : 'Off';
  }

  // =========================
  // Sho（砂川）
  // =========================
  if (staffConfig.calendarMode === 'offOnly') {

    const hasBlockingEvent = dayEvents.some(function(event) {

      const overlapsTime =
        event.getStartTime().getTime() <= slotEnd.getTime() &&
        event.getEndTime().getTime() >= slotStart.getTime();

      if (!overlapsTime) return false;

      // 「休み」は除外
      if (isOffEvent_(event)) return false;

      return true;
    });

    return hasBlockingEvent ? 'Off' : 'Available';
  }

  return 'Available';
}
function preserveManualRows_(map, manualRows, todayStr) {
  const warnings = [];
  manualRows.forEach(function(row) {
    const dateKey = normalizeDateValue_(row.Date);
    const staff = normalizeStaff_(row.Staff);
    const slot = row['Time Slot'];
    if (!dateKey || dateKey < todayStr || !staff || !slot) return;

    const key = makeKey_(dateKey, staff, slot);
    const existing = map[key] || blankRow_(dateKey, staff, slot);
    if (isManualLocked_(row)) {
      map[key] = normalizeRow_(row, existing);
      map[key]['Manual Lock'] = 'TRUE';
      return;
    }

    if (isManualLikeUnlocked_(row)) {
      const preserved = normalizeRow_(row, existing);
      preserved.Status = existing.Status || preserved.Status || 'Off';
      preserved.Source = preserved.Source || existing.Source || '';
      preserved['Manual Lock'] = 'FALSE';
      preserved.Notes = appendNote_(
        preserved.Notes,
        'Warning: Manual-looking values exist without Manual Lock TRUE; auto sync did not clear them.'
      );
      map[key] = preserved;
      warnings.push(key);
    }
  });
  return warnings;
}

function applyBookings_(map, bookings, warnings) {
  const groupedBySlot = {};
  bookings.forEach(function(booking) {
    if (!booking.date || !booking.slot) {
      console.error('Booking date or slot could not be detected: ' + JSON.stringify(booking));
      return;
    }
    const groupKey = booking.date + '|' + booking.slot;
    groupedBySlot[groupKey] = groupedBySlot[groupKey] || [];
    groupedBySlot[groupKey].push(booking);
  });

  Object.keys(groupedBySlot).forEach(function(groupKey) {
    const bookingsInSlot = groupedBySlot[groupKey];

    bookingsInSlot.forEach(function(booking) {
      assignBooking_(map, booking, warnings);
    });
    if (bookingsInSlot[0].tour === 'RentalCycle') {
  return;
}
    closeOtherAutoRows_(map, bookingsInSlot[0].date, bookingsInSlot[0].slot);
  });
}

function assignBooking_(map, booking, warnings) {
  ensureDateSlotRows_(map, booking.date, booking.slot);

  const preferredStaff = booking.staff ? [booking.staff] : CONFIG.staffPriority.slice();
  let targetKey = null;

  for (let i = 0; i < preferredStaff.length; i++) {
    const staffName = preferredStaff[i];
    const key = makeKey_(booking.date, staffName, booking.slot);
    const row = map[key];
    if (!row || isManualLocked_(row) || row.Status !== 'Available') continue;
    if (!row.Tour || row.Tour === booking.tour || sameBooking_(row, booking)) {
      targetKey = key;
      break;
    }
  }

  if (!targetKey && booking.tour) {
    for (let i = 0; i < CONFIG.staffPriority.length; i++) {
      const key = makeKey_(booking.date, CONFIG.staffPriority[i], booking.slot);
      const row = map[key];
      if (row && !isManualLocked_(row) && row.Status === 'Available' && !row.Tour) {
        targetKey = key;
        break;
      }
    }
  }

  if (!targetKey) {
    const message = 'No available staff slot for booking ' + (booking.bookingId || booking.eventId || '');
    console.error(message);
    recordSlotError_(map, booking.date, booking.slot, message);
    return;
  }

  const row = map[targetKey];
  const existingBooked = Number(row.Booked) || 0;
  const incomingBooked = Number(booking.booked) || 0;
  const sameTour = !row.Tour || row.Tour === booking.tour;

  row.Status = 'Available';
  row.Tour = booking.tour || row.Tour;
  row.Booked = sameTour ? existingBooked + incomingBooked || booking.booked : booking.booked;
  row.Capacity = booking.capacity || row.Capacity;
  row.Notes = appendNote_(row.Notes, booking.notes);
  row.Source = 'Bokun';
  row['Manual Lock'] = 'FALSE';

  if (warnings.indexOf(targetKey) !== -1) {
    row.Notes = appendNote_(row.Notes, 'Warning: Booking updated a row that had manual-looking unlocked values.');
  }
}

function closeOtherAutoRows_(map, dateKey, slot) {
  CONFIG.staffPriority.forEach(function(staffName) {
    const key = makeKey_(dateKey, staffName, slot);
    const row = map[key];
    if (!row || isManualLocked_(row)) return;
    if (row.Source === 'Bokun' && row.Tour) return;

    row.Status = 'Off';
    row.Tour = '';
    row.Booked = '';
    row.Capacity = '';
    row.Notes = 'Closed because another tour is booked in this time slot';
    row.Source = 'Bokun';
    row['Manual Lock'] = 'FALSE';
  });
}

function ensureDateSlotRows_(map, dateKey, slot) {
  CONFIG.staffPriority.forEach(function(staffName) {
    const key = makeKey_(dateKey, staffName, slot);
    if (!map[key]) {
      map[key] = blankRow_(dateKey, staffName, slot);
      map[key].Status = CONFIG.staff[staffName].calendarMode === 'offOnly' ? 'Available' : 'Off';
      map[key].Source = 'Calendar';
    }
  });
}

function isRelevantEvent_(event) {
  const text = eventText_(event);
  return CONFIG.relevantEventPatterns.some(function(pattern) {
    return pattern.test(text);
  });
}

function isStaffCalendarEvent_(event) {
  return CONFIG.staffPriority.some(function(staffName) {
    return eventMatchesStaff_(event, staffName);
  }) && !isBookingCalendarEvent_(event);
}

function isBookingCalendarEvent_(event) {
  const text = eventText_(event);

  if (/Bokun/i.test(text)) return true;
  return !!detectTour_(text);
}

function eventMatchesStaff_(event, staffName) {
  const text = eventText_(event);
  return CONFIG.staff[staffName].aliases.some(function(alias) {
    return new RegExp(escapeRegExp_(alias), 'i').test(text);
  });
}

function isOffEvent_(event) {
  const text = eventText_(event);
  return CONFIG.offPatterns.some(function(pattern) {
    return pattern.test(text);
  });
}

function isAvailableEvent_(event) {
  const text = eventText_(event);
  return CONFIG.availablePatterns.some(function(pattern) {
    return pattern.test(text);
  });
}

// OFFイベントがこの枠(slotStart〜slotEnd)に重なるか。
//   1. タイトル/説明に時間レンジ（例 9:30-13:00）があればそれを使う（all-day予定にテキストで書いた場合に対応）
//   2. 無ければ、時間指定された予定はその start/end を使う
//   3. どちらも無い（終日✖や時間情報なし）→ 終日 Off 扱いで必ず重なる
function offEventBlocksSlot_(event, dateKey, slotStart, slotEnd) {
  const range = parseTimeRange_(eventText_(event));
  if (range) {
    const offStart = dateTimeFromParts_(dateKey, range.start);
    const offEnd = dateTimeFromParts_(dateKey, range.end);
    // 重複判定式: offStart < slotEnd AND offEnd > slotStart
    return offStart.getTime() < slotEnd.getTime() && offEnd.getTime() > slotStart.getTime();
  }
  if (!event.isAllDayEvent()) {
    const start = event.getStartTime();
    const end = event.getEndTime();
    if (start && end) {
      return start.getTime() < slotEnd.getTime() && end.getTime() > slotStart.getTime();
    }
  }
  return true; // 終日✖ / 時間情報なし → 終日 Off
}

// テキストから時間レンジを抽出: "9:30-13:00" / "9:30〜13:00" / "9:30–13:00" 等 → {start:'09:30', end:'13:00'}
function parseTimeRange_(text) {
  const m = String(text || '').match(/(\d{1,2}):(\d{2})\s*[-~〜–—ー]\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const pad = function(h) { return ('0' + h).slice(-2); };
  return {
    start: pad(m[1]) + ':' + m[2],
    end: pad(m[3]) + ':' + m[4],
  };
}

function detectStaff_(text) {
  for (let i = 0; i < CONFIG.staffPriority.length; i++) {
    const staffName = CONFIG.staffPriority[i];
    if (CONFIG.staff[staffName].aliases.some(function(alias) {
      return new RegExp(escapeRegExp_(alias), 'i').test(text);
    })) {
      return staffName;
    }
  }
  return '';
}

function normalizeStaff_(value) {
  if (!value) return '';
  const text = String(value);
  return detectStaff_(text) || (CONFIG.staff[text] ? text : '');
}

function detectTour_(text) {
  for (let i = 0; i < CONFIG.tours.length; i++) {
    const tour = CONFIG.tours[i];
    if (tour.patterns.some(function(pattern) { return pattern.test(text); })) {
      return tour;
    }
  }
  return null;
}

function detectBookedCount_(text) {
  const patterns = [
    /(?:Participants|Adults|Guests|People|Persons)\s*[:：]?\s*(\d+)/i,
    /(?:人数)\s*[:：]?\s*(\d+)/i,
    /(\d+)\s*(?:people|persons|guests|participants|adults)\b/i,
    /(\d+)\s*(?:名|人)/,
    /(\d+)\s*台/,
  ];
  for (let i = 0; i < patterns.length; i++) {
    const match = text.match(patterns[i]);
    if (match) return Number(match[1]);
  }
  return null;
}

function detectBookingId_(text) {
  const patterns = [
    /Booking\s*ID\s*[:：#]?\s*([A-Za-z0-9_-]+)/i,
    /Booking\s*#\s*([A-Za-z0-9_-]+)/i,
    /予約番号\s*[:：]?\s*([A-Za-z0-9_-]+)/,
  ];
  for (let i = 0; i < patterns.length; i++) {
    const match = text.match(patterns[i]);
    if (match) return match[1];
  }
  return '';
}

function buildBookingNotes_(bookingId, title, errors) {
  const parts = [];
  if (bookingId) parts.push('Booking ID: ' + bookingId);
  if (title) parts.push('Event: ' + title);
  errors.forEach(function(error) {
    parts.push('Error: ' + error);
  });
  return parts.join(' | ');
}

function recordSlotError_(map, dateKey, slot, message) {
  ensureDateSlotRows_(map, dateKey, slot);
  CONFIG.staffPriority.forEach(function(staffName) {
    const key = makeKey_(dateKey, staffName, slot);
    if (map[key] && !isManualLocked_(map[key])) {
      map[key].Notes = appendNote_(map[key].Notes, 'Error: ' + message);
    }
  });
}

function readRows_(sheet) {
  ensureHeader_(sheet);

  const lastRow = sheet.getLastRow();

  if (lastRow < 2) return [];

  const values = sheet
    .getRange(2, 1, lastRow - 1, CONFIG.headers.length)
    .getValues();

  return values.map(function(valuesRow) {

    const row = {};

    CONFIG.headers.forEach(function(header, index) {
      row[header] = valuesRow[index];
    });

    return normalizeRow_(row);

  }).filter(function(row) {

    return CONFIG.headers.some(function(header) {
      return row[header] !== '' && row[header] !== null;
    });

  });
}

function replaceSheetRows_(sheet, rows) {
  const lastRow = sheet.getLastRow();

  if (rows.length) {
    sheet.getRange(2, 1, rows.length, CONFIG.headers.length).setValues(rows);
  }

  // 余った古い行だけ削除
  if (lastRow > rows.length + 1) {
    sheet.getRange(
      rows.length + 2,
      1,
      lastRow - rows.length - 1,
      CONFIG.headers.length
    ).clearContent();
  }
}

function ensureHeader_(sheet) {
  const current = sheet.getRange(1, 1, 1, CONFIG.headers.length).getValues()[0];
  const needsHeader = CONFIG.headers.some(function(header, index) {
    return current[index] !== header;
  });
  if (needsHeader) {
    sheet.getRange(1, 1, 1, CONFIG.headers.length).setValues([CONFIG.headers]);
    sheet.setFrozenRows(1);
  }
}

function applyValidations_(sheet) {
  const maxRows = Math.max(sheet.getMaxRows() - 1, 1);
  Object.keys(CONFIG.allowedValues).forEach(function(header) {
    const col = CONFIG.headers.indexOf(header) + 1;
    if (col < 1) return;
    const rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(CONFIG.allowedValues[header], true)
      .setAllowInvalid(false)
      .build();
    sheet.getRange(2, col, maxRows, 1).setDataValidation(rule);
  });
  sheet.getRange(2, 1, maxRows, 1).setNumberFormat('@');
}

function getOrCreateSheet_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function normalizeRow_(row, fallback) {
  const normalized = {};
  CONFIG.headers.forEach(function(header) {
    normalized[header] = row && row[header] !== undefined && row[header] !== null
      ? row[header]
      : fallback && fallback[header] !== undefined
        ? fallback[header]
        : '';
  });
  normalized.Date = normalizeDateValue_(normalized.Date);
  normalized.Staff = normalizeStaff_(normalized.Staff) || normalized.Staff;
  normalized['Manual Lock'] = normalizeBooleanText_(normalized['Manual Lock']);
  return normalized;
}

function rowObjectToArray_(row) {
  return CONFIG.headers.map(function(header) {
    if (header === 'Date') return normalizeDateValue_(row[header]);
    if (header === 'Manual Lock') return normalizeBooleanText_(row[header]) || 'FALSE';
    return row[header] === undefined || row[header] === null ? '' : row[header];
  });
}

function blankRow_(dateKey, staffName, slot) {
  return {
    Date: dateKey,
    Staff: staffName,
    'Time Slot': slot,
    Status: 'Off',
    Tour: '',
    Booked: '',
    Capacity: '',
    Notes: '',
    Source: 'Calendar',
    'Manual Lock': 'FALSE',
  };
}

function isManualLocked_(row) {
  return normalizeBooleanText_(row['Manual Lock']) === 'TRUE';
}

function isManualLikeUnlocked_(row) {
  return normalizeBooleanText_(row['Manual Lock']) !== 'TRUE' &&
    !row.Source &&
    !!(row.Tour || row.Booked || row.Notes);
}

function sameBooking_(row, booking) {
  const notes = String(row.Notes || '');
  return booking.bookingId && notes.indexOf(booking.bookingId) !== -1;
}

function makeKey_(dateKey, staffName, slot) {
  return [dateKey, staffName, slot].join('|');
}

function sortAvailabilityKeys_(a, b) {
  const partsA = a.split('|');
  const partsB = b.split('|');
  if (partsA[0] !== partsB[0]) return partsA[0] < partsB[0] ? -1 : 1;
  const staffDiff = CONFIG.staffPriority.indexOf(partsA[1]) - CONFIG.staffPriority.indexOf(partsB[1]);
  if (staffDiff !== 0) return staffDiff;
  return partsA[2] === partsB[2] ? 0 : partsA[2] === 'AM' ? -1 : 1;
}

function eventText_(event) {
  return [event.getTitle() || '', event.getDescription() || ''].join('\n');
}

function appendNote_(existing, note) {
  if (!note) return existing || '';
  if (!existing) return note;
  if (String(existing).indexOf(note) !== -1) return existing;
  return existing + ' | ' + note;
}

function startOfToday_() {
  const todayString = Utilities.formatDate(new Date(), CONFIG.timeZone, 'yyyy-MM-dd');
  return dateTimeFromParts_(todayString, '00:00');
}

function addDays_(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function formatDate_(date) {
  return Utilities.formatDate(date, CONFIG.timeZone, 'yyyy-MM-dd');
}

function normalizeDateValue_(value) {
  if (!value) return '';
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return formatDate_(value);
  }
  const text = String(value).trim();
  const match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!match) return text;
  return [
    match[1],
    ('0' + match[2]).slice(-2),
    ('0' + match[3]).slice(-2),
  ].join('-');
}

function dateTimeFromParts_(dateKey, timeKey) {
  const parts = dateKey.split('-').map(Number);
  const time = timeKey.split(':').map(Number);
  return new Date(parts[0], parts[1] - 1, parts[2], time[0], time[1], 0, 0);
}

function normalizeBooleanText_(value) {
  if (value === true) return 'TRUE';
  if (value === false) return 'FALSE';
  const text = String(value || '').trim().toUpperCase();
  if (text === 'TRUE') return 'TRUE';
  if (text === 'FALSE') return 'FALSE';
  return '';
}

function escapeRegExp_(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
