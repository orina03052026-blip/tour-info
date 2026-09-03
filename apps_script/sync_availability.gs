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
  // ツアー/送迎の自動割当対象（booking_webapp.gsでも共有利用=Kana/Shoのまま変更しない）
  staffPriority: ['Kana', 'Sho'],
  // Availabilityシートの休み追跡・close連動だけの対象（ツアー自動割当の候補には含めない）
  absenceOnlyStaff: ['Iwata'],
  staff: {
    Kana: {
      aliases: ['Kana', '畑中'],
      calendarMode: 'availability',
    },
    Sho: {
      aliases: ['Sho', '砂川'],
      calendarMode: 'offOnly',
    },
    Iwata: {
      // 2026-09-02追加（2026-09-03 役割訂正）: アクティビティジャパン(AJ)経由のツアーは
      // 岩田さんのみが担当可能。このシステム(Bokun/自社予約フォーム)が扱う宍粟・安富の
      // 2名体制ツアーでは補助員としてのみ使う（twoPersonTeams参照）。姫路城ガイドは担当しない。
      // 判定はエイリアス文字列ではなくカレンダー予定の「作成者」= creatorEmail で行う
      // （ユーザー指定。Algueblueの作成者判定と同方式）。creatorEmail一致イベントが無い枠は
      // 砂川と同じoffOnly方式で「予定なし=Available」判定になる。
      aliases: ['Iwata', '岩田'],
      calendarMode: 'offOnly',
      creatorEmail: 'yrock1979@gmail.com',
      defaultWorkingHours: '9:30–18:00', // 砂川さんと同じ値（2026-09-03 ユーザー確認済み）
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
    'Working Hours', // 人が読む用: Kana=○予定の実時刻 / Sho=9:30–18:00から✖を除いた範囲 / 休み
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
    capacity: 5, // 2026-09-02: 4→5
    patterns: [
      /e-?bike\s+ride\s+around\s+the\s+castle.*slurp\s+like\s+a\s+local/i,
      /castle\s+town/i,
    ],
  },
  {
    name: 'e-bike Ride to the Sea',
    capacity: 5, // 2026-09-02: 4→5
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
    capacity: 8, // 2026-09-02: 4→8（宍粟）
    patterns: [
      /e-?bike\s+tour\s+in\s+the\s+shis[oō]\s+region/i,
      /sake\s+brewery/i,
    ],
  },
  {
    name: 'e-bike Head to the Healing Cave',
    capacity: 8, // 2026-09-02: 4→8（安富）
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

// Availabilityシートに行を出す・close連動させる対象の全スタッフ（staffPriority + absenceOnlyStaff）。
// ツアー自動割当(assignBooking_/ensureDateSlotRows_)は引き続きstaffPriorityのみを使う。
CONFIG.allTrackedStaff = CONFIG.staffPriority.concat(CONFIG.absenceOnlyStaff || []);

// RentalCycle（ガイドなしレンタル自転車）: 2026-09-02指定。身長帯別の在庫内訳（合計9台）。
// 予約メモに身長の記載が無い場合は151cm帯(3台=旧「標準3台」に相当)だけを使う。
// 151cm+153cm=5台が旧「Max5台・要相談」に相当し、160cm/165cm帯はそれを身長条件付きで
// さらに拡張したもの。tiersはminHeightCm昇順で保持する。
CONFIG.rentalCycle = {
  tiers: [
    { minHeightCm: 151, count: 3 },
    { minHeightCm: 153, count: 2 },
    { minHeightCm: 160, count: 2 },
    { minHeightCm: 165, count: 2 },
  ],
};

// 宍粟・安富: ガイド1名+補助1名の計2名体制が必須（2026-09-02指定）。
// 優先ペアは順に試す。通常はKana+Sho。どちらかが休みの時のみ岩田さんで対称的に代替。
// 2名そろわない場合（岩田さん1名だけ等）は催行不可。
CONFIG.twoPersonTours = [
  'e-Bike Tour in the Shisō Region with Lunch at a Sake Brewery', // 宍粟
  'e-bike Head to the Healing Cave', // 安富
];
CONFIG.twoPersonTeams = [
  ['Kana', 'Sho'],
  ['Sho', 'Iwata'],
  ['Kana', 'Iwata'],
];

// 自転車の共有プール（2026-09-02指定）: 総保有9台。RentalCycle標準3台は割当の目安であって
// 別プールではない。ツアー(旧街道/飾磨街道/宍粟/安富)が無ければRentalCycleにも9台まで融通可。
// → 同一日+枠でこの5種の予約Booked合計が9台を超えないことだけをチェックする。
CONFIG.bikeFleet = { totalBikes: 9 };
CONFIG.bikeTours = [
  'e-bike Ride around the Castle',
  'e-bike Ride to the Sea',
  'e-Bike Tour in the Shisō Region with Lunch at a Sake Brewery',
  'e-bike Head to the Healing Cave',
  'RentalCycle',
];

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
  CONFIG.allTrackedStaff.forEach(function(staffName) {
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

  // 60分間隔（毎時）で実行。Algueblue 同期も syncAvailability に統合済みなので
  // この1本で Availability シート（ツアー＋Algueblueのスタッフ空き）が更新される。
  // ※ 5分間隔は Gmail の「トリガー合計実行時間90分/日」上限に当たるため不可。60分に決定（2026-06-27）。
  ScriptApp.newTrigger('syncAvailability')
    .timeBased()
    .everyHours(1)
    .create();
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
  ? { name: 'RentalCycle', capacity: CONFIG.bikeFleet.totalBikes }
  : detectTour_(text);
  const booked = detectBookedCount_(text);
  const bookingId = detectBookingId_(text);
  const bookingKey = bookingId || event.getId();
  const staff = detectStaff_(text);
  // 宍粟・安富(2名体制)向け: メモ欄に書かれている担当者名を全員拾う（岩田さんも検出対象）。
  // 「担当:砂川、岩田」のようにメモへ明記されていれば、優先順位の自動推測より
  // これを優先して使う（assignTwoPersonBooking_側で参照）。
  const staffList = detectAllStaffInText_(text);
  // RentalCycle向け: メモに身長記載があれば拾う（無ければnull=151cm帯のみ使用）。
  const heightCm = isRentalCycle ? detectHeightCm_(text) : null;
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
    staffList: staffList,
    heightCm: heightCm,
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
    CONFIG.allTrackedStaff.forEach(function(staffName) {
      // 実勤務時間（読みやすい表示）は日付×スタッフで1回だけ算出し、AM/PM両方に入れる
      const workingHours = staffWorkingHoursText_(staffName, dateKey, staffEventsByDate);
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
          'Working Hours': workingHours,
        };
      });
    });
  });
  return map;
}

/**
 * 人が読む用の「実勤務時間」テキストを返す。AM/PM判定とは別に、カレンダーの実時刻を出す。
 *   - Kana（availability）: ○付きの時間予定の実時刻レンジ（例 9:30–15:00）。○予定が無ければ「休み」。
 *   - Sho（offOnly）: 既定 9:30–18:00 から ✖（時間付き）を除いた表記。終日✖なら「休み」。
 * 失敗しても同期を止めないよう try/catch で空文字を返す。
 */
function staffWorkingHoursText_(staffName, dateKey, staffEventsByDate) {
  try {
    const cfg = CONFIG.staff[staffName];
    const evs = (staffEventsByDate[dateKey] || []).filter(function(e) {
      return eventMatchesStaff_(e, staffName);
    });
    const fmt = function(d) { return Utilities.formatDate(d, CONFIG.timeZone, 'H:mm'); };

    // 終日OFF（終日✖ / 時間情報の無い✖）→ 休み
    const allDayOff = evs.some(function(e) {
      return isOffEvent_(e) && e.isAllDayEvent();
    });

    if (cfg.calendarMode === 'availability') {
      if (allDayOff) return '休み';
      const avail = evs.filter(function(e) {
        return isAvailableEvent_(e) && !e.isAllDayEvent() && e.getStartTime() && e.getEndTime();
      });
      if (!avail.length) return '休み';
      let minS = null, maxE = null;
      avail.forEach(function(e) {
        const s = e.getStartTime(), en = e.getEndTime();
        if (minS === null || s.getTime() < minS.getTime()) minS = s;
        if (maxE === null || en.getTime() > maxE.getTime()) maxE = en;
      });
      return fmt(minS) + '–' + fmt(maxE);
    }

    if (cfg.calendarMode === 'offOnly') {
      if (allDayOff) return '休み';
      const baseHours = cfg.defaultWorkingHours || '9:30–18:00';
      const offs = evs.filter(function(e) { return isOffEvent_(e) && !e.isAllDayEvent(); })
        .map(function(e) {
          const r = parseTimeRange_(eventText_(e));
          if (r) return r.start + '–' + r.end;
          const s = e.getStartTime(), en = e.getEndTime();
          return (s && en) ? (fmt(s) + '–' + fmt(en)) : null;
        })
        .filter(Boolean);
      return offs.length ? (baseHours + '（休 ' + offs.join(', ') + '）') : baseHours;
    }
    return '';
  } catch (err) {
    return '';
  }
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
    // 同一日+枠の自転車消費（旧街道/飾磨街道/宍粟/安富/RentalCycle 共通9台プール）を積算しながら割当。
    // 台数が足りない予約はスタッフ枠を消費させず、Notesにエラーを残すだけにする。
    let bikesUsed = 0;
    // RentalCycleの身長帯別在庫の残数（CONFIG.rentalCycle.tiersの並び順で保持）。
    // 身長未記載の予約は151cm帯(3台)しか使えない。
    const rentalCycleTierRemaining = CONFIG.rentalCycle.tiers.map(function(tier) { return tier.count; });

    bookingsInSlot.forEach(function(booking) {
      const needsBikes = CONFIG.bikeTours.indexOf(booking.tour) !== -1;
      const neededBikes = needsBikes ? (Number(booking.booked) || 0) : 0;
      const isRentalCycleBooking = booking.tour === 'RentalCycle';

      if (isRentalCycleBooking &&
          !allocateRentalCycleTierBikes_(rentalCycleTierRemaining, booking.heightCm, neededBikes)) {
        const message = 'Not enough height-eligible RentalCycle bikes' +
          (booking.heightCm != null ? ' (height ' + booking.heightCm + 'cm)' : ' (height not specified, 151cm tier only)') +
          ' for booking ' + (booking.bookingId || booking.eventId || '');
        console.error(message);
        recordSlotError_(map, booking.date, booking.slot, message);
        return;
      }

      if (needsBikes && bikesUsed + neededBikes > CONFIG.bikeFleet.totalBikes) {
        const message = 'Not enough bikes in shared fleet (total ' + CONFIG.bikeFleet.totalBikes +
          ', already committed ' + bikesUsed + ') for booking ' + (booking.bookingId || booking.eventId || '');
        console.error(message);
        recordSlotError_(map, booking.date, booking.slot, message);
        return;
      }

      if (CONFIG.twoPersonTours.indexOf(booking.tour) !== -1) {
        assignTwoPersonBooking_(map, booking, warnings);
      } else {
        assignBooking_(map, booking, warnings);
      }
      if (needsBikes) bikesUsed += neededBikes;
    });
    if (bookingsInSlot[0].tour === 'RentalCycle') {
  return;
}
    if (CONFIG.twoPersonTours.indexOf(bookingsInSlot[0].tour) !== -1) {
      // 2名体制ツアーは assignTwoPersonBooking_ 側で両名を直接締める。
      // Kana+Sho以外(岩田さん含む代替ペア)の場合に一般closeOtherAutoRows_を
      // 通すと、まだ判定していない別ペアの成立可否と無関係にstaffPriority側を
      // 誤って閉じてしまうため、ここでは何もしない。
      return;
    }
    closeOtherAutoRows_(map, bookingsInSlot[0].date, bookingsInSlot[0].slot);
  });
}

// 宍粟・安富: ガイド1名+補助1名の計2名体制が必須。
// CONFIG.twoPersonTeams を優先順に試し、両名ともAvailable(かつ未使用/同一予約)なら成立。
// どのペアも揃わない場合は割当不可（岩田さん1名だけ等では催行しない）。
function assignTwoPersonBooking_(map, booking, warnings) {
  ensureDateSlotRows_(map, booking.date, booking.slot);
  ensureStaffSlotRow_(map, booking.date, 'Iwata', booking.slot);

  function pairIsValid_(pair) {
    const rows = pair.map(function(staffName) {
      return map[makeKey_(booking.date, staffName, booking.slot)];
    });
    return rows.every(function(row) {
      return row && !isManualLocked_(row) && row.Status === 'Available' &&
        (!row.Tour || row.Tour === booking.tour || sameBooking_(row, booking));
    });
  }

  let chosenPair = null;

  // 1. 予約メモに担当者名が明記されていれば最優先（人の判断を信頼する）。
  //    定義済みペアと一致しない、または空きと矛盾する場合はエラー記録のみで、
  //    自動推測へのフォールバックはしない（メモと違うペアを勝手に割り当てて
  //    現場を混乱させないため）。
  const namedStaff = (booking.staffList || []).filter(function(name) {
    return CONFIG.allTrackedStaff.indexOf(name) !== -1;
  });
  if (namedStaff.length === 2) {
    const isRecognizedPair = CONFIG.twoPersonTeams.some(function(pair) {
      return pairMatches_(pair, namedStaff);
    });
    if (!isRecognizedPair) {
      const message = 'Memo names an unsupported staff pair (' + namedStaff.join('+') + ') for booking ' +
        (booking.bookingId || booking.eventId || '');
      console.error(message);
      recordSlotError_(map, booking.date, booking.slot, message);
      return;
    }
    if (!pairIsValid_(namedStaff)) {
      const message = 'Memo names ' + namedStaff.join('+') + ' but one of them is unavailable for booking ' +
        (booking.bookingId || booking.eventId || '');
      console.error(message);
      recordSlotError_(map, booking.date, booking.slot, message);
      return;
    }
    chosenPair = namedStaff;
  }

  // 2. メモに担当者名が無い場合（外部Bokun同期直後でまだ内部注記が無い等）のみ、
  //    優先順位 [Kana+Sho] → [Sho+Iwata] → [Kana+Iwata] で自動推測する。
  if (!chosenPair) {
    for (let i = 0; i < CONFIG.twoPersonTeams.length; i++) {
      if (pairIsValid_(CONFIG.twoPersonTeams[i])) {
        chosenPair = CONFIG.twoPersonTeams[i];
        break;
      }
    }
  }

  if (!chosenPair) {
    const message = 'No available 2-person team (Kana+Sho / Sho+Iwata / Kana+Iwata) for booking ' +
      (booking.bookingId || booking.eventId || '');
    console.error(message);
    recordSlotError_(map, booking.date, booking.slot, message);
    return;
  }

  chosenPair.forEach(function(staffName, idx) {
    const key = makeKey_(booking.date, staffName, booking.slot);
    const row = map[key];
    const existingBooked = Number(row.Booked) || 0;
    const incomingBooked = Number(booking.booked) || 0;
    const sameTour = !row.Tour || row.Tour === booking.tour;

    row.Status = 'Available';
    row.Tour = booking.tour || row.Tour;
    row.Booked = sameTour ? existingBooked + incomingBooked || booking.booked : booking.booked;
    row.Capacity = booking.capacity || row.Capacity;
    row.Notes = appendNote_(row.Notes, idx === 0 ? booking.notes : appendNote_(booking.notes, '補助'));
    row.Source = 'Bokun';
    row['Manual Lock'] = 'FALSE';

    if (warnings.indexOf(key) !== -1) {
      row.Notes = appendNote_(row.Notes, 'Warning: Booking updated a row that had manual-looking unlocked values.');
    }
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
  // staffPriority(Kana/Sho)限定。岩田さんは宍粟/安富の2名体制でのみ使う要員なので、
  // 旧街道・飾磨街道・姫路城ガイド等の単独ツアー予約では自動closeの対象に含めない
  // （宍粟/安富の2名締めは assignTwoPersonBooking_ が個別に行う）。
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
    ensureStaffSlotRow_(map, dateKey, staffName, slot);
  });
}

function ensureStaffSlotRow_(map, dateKey, staffName, slot) {
  const key = makeKey_(dateKey, staffName, slot);
  if (!map[key]) {
    map[key] = blankRow_(dateKey, staffName, slot);
    map[key].Status = CONFIG.staff[staffName].calendarMode === 'offOnly' ? 'Available' : 'Off';
    map[key].Source = 'Calendar';
  }
  return map[key];
}

function isRelevantEvent_(event) {
  // タイトル/説明に何も追跡用の文言が無くても、追跡対象スタッフ(岩田さん等)が
  // 作成したイベントなら関連イベントとして扱う（休み予定に名前が入らない場合の対策）。
  if (isCreatorRelevant_(event)) return true;
  const text = eventText_(event);
  return CONFIG.relevantEventPatterns.some(function(pattern) {
    return pattern.test(text);
  });
}

function isCreatorRelevant_(event) {
  return Object.keys(CONFIG.staff).some(function(staffName) {
    const cfg = CONFIG.staff[staffName];
    return cfg.creatorEmail && eventCreatedBy_(event, cfg.creatorEmail);
  });
}

function isStaffCalendarEvent_(event) {
  return CONFIG.allTrackedStaff.some(function(staffName) {
    return eventMatchesStaff_(event, staffName);
  }) && !isBookingCalendarEvent_(event);
}

function isBookingCalendarEvent_(event) {
  const text = eventText_(event);

  if (/Bokun/i.test(text)) return true;
  return !!detectTour_(text);
}

function eventMatchesStaff_(event, staffName) {
  const staffConfig = CONFIG.staff[staffName];
  // creatorEmail設定あり（岩田さん）: その作成者のイベントは無条件に本人の予定として扱う。
  // タイトル/説明に名前が入っていない予定（休みの✖等）でも判定できるようにするため。
  if (staffConfig.creatorEmail && eventCreatedBy_(event, staffConfig.creatorEmail)) {
    return true;
  }
  const text = eventText_(event);
  return staffConfig.aliases.some(function(alias) {
    return new RegExp(escapeRegExp_(alias), 'i').test(text);
  });
}

// イベントの作成者がemailと一致するか（Algueblue判定と同じ getCreators() 方式）。
// 取得失敗時は安全側でfalseを返し、同期全体は止めない。
function eventCreatedBy_(event, email) {
  try {
    const creators = event.getCreators() || [];
    return creators.some(function(c) {
      return String(c).toLowerCase() === String(email).toLowerCase();
    });
  } catch (err) {
    return false;
  }
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

// RentalCycle予約メモの身長記載を検出（例: "160cm" "身長160" "160センチ" "160㎝"）。
// 複数の身長が書かれている場合（グループ予約）は一番低い値＝一番厳しい条件を採用する。
function detectHeightCm_(text) {
  const pattern = /(\d{2,3})\s*(?:cm|センチ|㎝)|身長\s*[:：]?\s*(\d{2,3})/gi;
  let match;
  let minHeight = null;
  while ((match = pattern.exec(String(text || ''))) !== null) {
    const value = Number(match[1] || match[2]);
    if (!isNaN(value) && (minHeight === null || value < minHeight)) {
      minHeight = value;
    }
  }
  return minHeight;
}

// RentalCycleの身長帯別在庫からneededBikes台を確保できるか判定し、できれば在庫を消費する。
// 温存のため、条件を満たす帯の中でminHeightCmが高い(=適用範囲が狭い)帯から優先的に使う。
// heightCmがnull（身長未記載）の場合は151cm帯のみ対象。
function allocateRentalCycleTierBikes_(tierRemaining, heightCm, neededBikes) {
  const eligible = [];
  for (let t = 0; t < CONFIG.rentalCycle.tiers.length; t++) {
    const tier = CONFIG.rentalCycle.tiers[t];
    const ok = heightCm == null ? tier.minHeightCm === 151 : heightCm >= tier.minHeightCm;
    if (ok) eligible.push(t);
  }
  eligible.sort(function(a, b) {
    return CONFIG.rentalCycle.tiers[b].minHeightCm - CONFIG.rentalCycle.tiers[a].minHeightCm;
  });

  let available = 0;
  eligible.forEach(function(idx) { available += tierRemaining[idx]; });
  if (available < neededBikes) return false;

  let remaining = neededBikes;
  eligible.forEach(function(idx) {
    if (remaining <= 0) return;
    const use = Math.min(remaining, tierRemaining[idx]);
    tierRemaining[idx] -= use;
    remaining -= use;
  });
  return true;
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

// 2つのスタッフ名配列が同じペアかどうか（順不同）
function pairMatches_(pairA, pairB) {
  if (pairA.length !== pairB.length) return false;
  const sortedA = pairA.slice().sort();
  const sortedB = pairB.slice().sort();
  return sortedA.every(function(name, i) { return name === sortedB[i]; });
}

function makeKey_(dateKey, staffName, slot) {
  return [dateKey, staffName, slot].join('|');
}

function sortAvailabilityKeys_(a, b) {
  const partsA = a.split('|');
  const partsB = b.split('|');
  if (partsA[0] !== partsB[0]) return partsA[0] < partsB[0] ? -1 : 1;
  const staffDiff = CONFIG.allTrackedStaff.indexOf(partsA[1]) - CONFIG.allTrackedStaff.indexOf(partsB[1]);
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
