/**
 * Unified booking Web App  (Algueblue + cycling e-bike + Himeji castle guide)
 * ---------------------------------------------------------------------------
 * 同一 Apps Script プロジェクト内で sync_availability.gs と global を共有する。
 * 以下のヘルパー/定数は sync_availability.gs 側の定義をそのまま使う:
 *   CONFIG, formatDate_, dateTimeFromParts_, addDays_, startOfToday_,
 *   isRelevantEvent_, isOffEvent_, offEventBlocksSlot_, eventMatchesStaff_,
 *   isBookingCalendarEvent_, detectTour_, escapeRegExp_, appendNote_
 *
 * エンドポイント（Web App としてデプロイ）:
 *   GET  ?action=availability&date=YYYY-MM-DD   -> その日の予約可能枠を JSON で返す
 *        ?action=availability                    -> 今日＋明日をまとめて返す
 *   POST (text/plain で JSON 文字列)             -> 予約を作成し結果を JSON で返す
 *
 * 設計（2026-06-27 合意）:
 *   - 一覧表示の源泉は Availability シート（sync が算出済みの Kana/Sho 空きを再利用）。
 *   - 予約確定は LockService で直列化し、カレンダーを直接再チェックしてから確定（最終ガード）。
 *   - Algueblue は「施術室の空き」＋「Kana か Sho の送迎可否」の両方を満たすときのみ受付可。
 *     施術室ブロック = 施術時間のみ（Plan01=90 / Plan02=120 / Plan03=200 分）。
 *     送迎 = 片道30分。スタッフ占有は 行き[T-30,T] と 帰り[T+D,T+D+30] の2区間のみ。
 *   - 決済なし（現地払い）。記録先 = Bookings シート＋カレンダー予定の両方。
 */

const BOOKING_CONFIG = {
  bookingsSheetName: 'Bookings',
  bookingsHeaders: [
    'Timestamp', 'Booking ID', 'Status', 'Activity', 'Plan/Option',
    'Date', 'Start', 'End', 'People', 'Customer', 'Email', 'Phone',
    'Transfer Staff', 'Calendar Event IDs', 'Notes',
  ],

  // 本システムが作成したイベントを識別するためのマーカー（description に埋め込む）
  webMarker: '#WEBBOOKING',

  algueblue: {
    marker: '#ALGUEBLUE',          // 施術イベントの目印（占有計算で algue.blue 作成分と同等に扱う）
    transferMarker: '#ALGTRANSFER',// 送迎イベントの目印
    creatorEmail: 'algue.blue@gmail.com',
    open: '10:00',                 // 予約開始の最早
    lastStart: '16:00',            // 予約開始の最遅（終了は超過可）
    transferMin: 30,               // 送迎 片道（分）
    stepMin: 15,                   // 開始候補を刻む粒度（“すき間に入る限り”を細かく提示）
    plans: {
      plan01: { code: 'plan01', name: 'Luxury Thalasso Foot Spa', treatmentMin: 90,  sameDay: true,  price: 22000, options: [] },
      plan02: { code: 'plan02', name: 'Premium Japanese Spa',     treatmentMin: 120, sameDay: true,  price: 27500, options: ['Facial', 'Body'] },
      plan03: { code: 'plan03', name: 'Ultimate J-Spa Retreat',   treatmentMin: 200, sameDay: false, price: 44000, options: [] },
    },
  },

  // サイクリング / 城ガイド。スタッフ(Kana/Sho)の空きに収まる開始時刻を30分刻みで提示。
  // name は Availability シート/CSV の Tour 値・script.js の表示名と対応づける。
  tours: {
    'ebike-castle': { code: 'ebike-castle', name: 'e-bike Ride around the Castle, Slurp Like a Local', sheetTour: 'e-bike Ride around the Castle', capacity: 4, weatherSensitive: true },
    'ebike-sea':    { code: 'ebike-sea',    name: 'e-bike Ride to the Sea, Slurp Like a Local',        sheetTour: 'e-bike Ride to the Sea',        capacity: 4, weatherSensitive: true },
    'castle-guide': { code: 'castle-guide', name: 'Himeji castle guide tour',                           sheetTour: 'Himeji castle guide tour',      capacity: 8, weatherSensitive: false },
  },

  // ツアー予約の時間モデル（2026-06-27 決定）: 全ツアー所要3時間、9:30〜15:00 の30分刻みで開始、
  // Kana/Sho の勤務時間に合わせる。スタッフの在席は Availability シートの AM/PM を勤務窓に変換して判定。
  tourBooking: {
    durationMin: 180,
    open: '09:30',       // 開始の最早
    lastStart: '15:00',  // 開始の最遅（15:00開始→18:00終了）
    stepMin: 30,
    amWindow: { start: '09:30', end: '12:30' },  // AM 在席 → この窓で勤務
    pmWindow: { start: '13:30', end: '18:00' },  // PM 在席 → この窓で勤務（18:00まで）
  },
};

/* =========================================================================
 *  HTTP エントリポイント
 * ========================================================================= */

function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    if (params.action === 'availability') {
      const todayStr = formatDate_(startOfToday_());
      const dates = params.date ? [params.date] : [todayStr, formatDate_(addDays_(startOfToday_(), 1))];
      const out = {};
      dates.forEach(function (d) { out[d] = computeDayAvailability_(d); });
      return jsonOut_({ ok: true, generatedAt: new Date().toISOString(), days: out });
    }
    return jsonOut_({ ok: true, message: 'Booking Web App. Use ?action=availability' });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  let payload;
  try {
    payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (parseErr) {
    return jsonOut_({ ok: false, error: 'Invalid JSON body' });
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    return jsonOut_({ ok: false, error: 'Server busy, please retry' });
  }
  try {
    const result = (payload.activity === 'algueblue')
      ? bookAlgueblue_(payload)
      : bookTour_(payload);
    return jsonOut_(result);
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* =========================================================================
 *  空き状況の算出（doGet 用） — シート＋Algueblue計算
 * ========================================================================= */

function computeDayAvailability_(dateStr) {
  const isToday = dateStr === formatDate_(startOfToday_());
  return {
    date: dateStr,
    algueblue: computeAlgueblueAvailability_(dateStr, isToday),
    tours: computeToursAvailability_(dateStr, isToday),
  };
}

// サイクリング / 城ガイド: Kana/Sho の勤務窓に [T, T+180分] が収まる開始時刻 T を
// 30分刻み（9:30〜15:00）で列挙。当日は現在時刻以降。e-bike は雨天中止の枠を除外。
function computeToursAvailability_(dateStr, isToday) {
  const rows = readAvailabilityRows_().filter(function (r) { return r.Date === dateStr; });
  const tb = BOOKING_CONFIG.tourBooking;
  const ebikeClosed = ebikeClosedHalves_(rows);
  const nowMin = isToday ? nowMinutesJst_() : -1;
  const out = {};

  Object.keys(BOOKING_CONFIG.tours).forEach(function (code) {
    const t = BOOKING_CONFIG.tours[code];
    const startSet = {};
    CONFIG.staffPriority.forEach(function (staffName) {
      const win = tourStaffWindow_(staffName, t, dateStr, rows, ebikeClosed);
      if (!win) return;
      for (let T = toMin_(tb.open); T <= toMin_(tb.lastStart); T += tb.stepMin) {
        if (nowMin >= 0 && T < nowMin) continue;
        if (T >= win.start && T + tb.durationMin <= win.end) startSet[T] = true;
      }
    });
    const starts = Object.keys(startSet).map(Number).sort(function (a, b) { return a - b; }).map(fromMin_);
    out[code] = { name: t.name, capacity: t.capacity, duration: tb.durationMin, open: starts.length > 0, starts: starts };
  });
  return out;
}

// e-bike 雨天中止が AM/PM どちらに掛かっているか
function ebikeClosedHalves_(dayRows) {
  const closed = { AM: false, PM: false };
  dayRows.forEach(function (r) {
    if ((r.Notes || '').indexOf('EBIKE_CLOSED') !== -1) closed[r['Time Slot']] = true;
  });
  return closed;
}

// スタッフ staffName の、ツアー t に使える「勤務窓」（分）。在席は Availability シートの AM/PM。
//   AM在席&PM在席 → 9:30〜18:00（昼をまたぐ催行OK）／AMのみ → 9:30〜12:30／PMのみ → 13:30〜18:00
// e-bike ツアーは雨天中止の半日を在席から除外。両方ダメなら null。
function tourStaffWindow_(staffName, t, dateStr, dayRows, ebikeClosed) {
  const tb = BOOKING_CONFIG.tourBooking;
  let amOK = staffSlotAvailable_(staffName, dateStr, 'AM', dayRows);
  let pmOK = staffSlotAvailable_(staffName, dateStr, 'PM', dayRows);
  if (t.weatherSensitive && ebikeClosed.AM) amOK = false;
  if (t.weatherSensitive && ebikeClosed.PM) pmOK = false;
  if (amOK && pmOK) return { start: toMin_(tb.amWindow.start), end: toMin_(tb.pmWindow.end) };
  if (amOK) return { start: toMin_(tb.amWindow.start), end: toMin_(tb.amWindow.end) };
  if (pmOK) return { start: toMin_(tb.pmWindow.start), end: toMin_(tb.pmWindow.end) };
  return null;
}

// Algueblue: 施術室の空き＋送迎スタッフ可否から、各プランの受付可否と開始候補時刻を出す。
function computeAlgueblueAvailability_(dateStr, isToday) {
  const cal = CalendarApp.getCalendarById(CONFIG.calendarId);
  const dayStart = dateTimeFromParts_(dateStr, '00:00');
  const dayEnd = addDays_(dayStart, 1);
  const events = cal.getEvents(dayStart, dayEnd);

  // 休業日: algue.blue 作成の終日予定があればその日は受付なし
  const closed = events.some(function (ev) {
    return ev.isAllDayEvent() && isAlgueblueOccupancyEvent_(ev);
  });

  const ab = BOOKING_CONFIG.algueblue;
  const result = { closed: closed, anyOpen: false, plans: {} };
  if (closed) {
    Object.keys(ab.plans).forEach(function (k) { result.plans[k] = { open: false, starts: [] }; });
    return result;
  }

  const roomBusy = algueblueRoomBusyIntervals_(events, dateStr);
  const nowMin = isToday ? nowMinutesJst_() : -1;

  Object.keys(ab.plans).forEach(function (planKey) {
    const plan = ab.plans[planKey];
    if (isToday && !plan.sameDay) { result.plans[planKey] = { open: false, starts: [], reason: 'advance-only' }; return; }
    const starts = computeAlgueblueStarts_(dateStr, plan.treatmentMin, roomBusy, nowMin);
    result.plans[planKey] = {
      name: plan.name, price: plan.price, options: plan.options,
      open: starts.length > 0, starts: starts,
    };
    if (starts.length > 0) result.anyOpen = true;
  });
  return result;
}

// 施術可能な開始時刻(HH:mm)の配列。stepMin 刻みで lastStart まで走査し、
// 施術室が空き かつ Kana/Sho のどちらかが送迎2区間とも空くものだけ返す。
function computeAlgueblueStarts_(dateStr, treatmentMin, roomBusy, nowMin) {
  const ab = BOOKING_CONFIG.algueblue;
  const openMin = toMin_(ab.open);
  const lastMin = toMin_(ab.lastStart);
  const staffRows = readAvailabilityRows_().filter(function (r) { return r.Date === dateStr; });
  const out = [];
  for (let t = openMin; t <= lastMin; t += ab.stepMin) {
    if (nowMin >= 0 && t < nowMin) continue;                       // 当日は現在時刻以降
    if (overlapsAny_(t, t + treatmentMin, roomBusy)) continue;      // 施術室が空いているか
    if (!transferStaffAvailable_(dateStr, t, treatmentMin, staffRows)) continue; // 送迎できるスタッフがいるか
    out.push(fromMin_(t));
  }
  return out;
}

/* =========================================================================
 *  Algueblue: 施術室の占有・送迎スタッフ判定
 * ========================================================================= */

// algue.blue が作成したイベント、または本システムの #ALGUEBLUE マーカー付きイベントを占有とみなす
function isAlgueblueOccupancyEvent_(ev) {
  try {
    const creators = ev.getCreators ? ev.getCreators() : [];
    if (creators && creators.indexOf(BOOKING_CONFIG.algueblue.creatorEmail) !== -1) return true;
  } catch (ignore) { /* getCreators 不可の場合は description で判定 */ }
  const desc = ev.getDescription() || '';
  return desc.indexOf(BOOKING_CONFIG.algueblue.marker) !== -1;
}

// その日の施術室の占有区間 [{start,end}]（分・0:00 起点）を返す
function algueblueRoomBusyIntervals_(events, dateStr) {
  const out = [];
  events.forEach(function (ev) {
    if (ev.isAllDayEvent()) return;
    if (!isAlgueblueOccupancyEvent_(ev)) return;
    const s = ev.getStartTime(), e = ev.getEndTime();
    if (!s || !e) return;
    out.push({ start: minutesOfDay_(s, dateStr), end: minutesOfDay_(e, dateStr) });
  });
  return out;
}

// 開始 t（分）の予約に対し、Kana か Sho のどちらかが送迎2区間とも空いているか。
// スタッフの空きは Availability シート（AM/PM）を権威として用いる。
function transferStaffAvailable_(dateStr, tStart, treatmentMin, staffRows) {
  const trans = BOOKING_CONFIG.algueblue.transferMin;
  const pickup = { start: tStart - trans, end: tStart };
  const dropoff = { start: tStart + treatmentMin, end: tStart + treatmentMin + trans };
  return CONFIG.staffPriority.some(function (staffName) {
    return staffFreeInInterval_(staffName, dateStr, pickup, staffRows)
        && staffFreeInInterval_(staffName, dateStr, dropoff, staffRows);
  });
}

// スタッフ staffName が区間 iv（分）に空いているか。
// iv が触れる AM/PM 枠すべてで該当スタッフ行が Status=Available であることを要求。
// （区間が枠外＝早朝/夜/昼休みのみに収まる場合は、隣接枠が Available なら可とみなす）
function staffFreeInInterval_(staffName, dateStr, iv, staffRows) {
  const touched = slotsTouchedByInterval_(iv);
  if (touched.length === 0) {
    // 営業枠外のみ（例: 9:30 以前）。最も近い枠(AM)の在席で代替判定。
    return staffSlotAvailable_(staffName, dateStr, 'AM', staffRows);
  }
  return touched.every(function (slot) { return staffSlotAvailable_(staffName, dateStr, slot, staffRows); });
}

function staffSlotAvailable_(staffName, dateStr, slot, staffRows) {
  const row = staffRows.filter(function (r) {
    return r.Staff === staffName && r['Time Slot'] === slot;
  })[0];
  return !!row && row.Status === 'Available';
}

// 区間 iv（分）が重なる AM/PM 枠を返す
function slotsTouchedByInterval_(iv) {
  const out = [];
  ['AM', 'PM'].forEach(function (slot) {
    const w = CONFIG.slotWindows[slot];
    const s = toMin_(w.start), e = toMin_(w.end);
    if (iv.start < e && iv.end > s) out.push(slot);
  });
  return out;
}

/* =========================================================================
 *  予約作成（doPost 用）
 * ========================================================================= */

function bookAlgueblue_(p) {
  const ab = BOOKING_CONFIG.algueblue;
  const plan = ab.plans[p.plan];
  if (!plan) return { ok: false, error: 'Unknown plan' };
  const v = validateCommon_(p);
  if (!v.ok) return v;
  if (!/^\d{2}:\d{2}$/.test(p.start || '')) return { ok: false, error: 'start (HH:mm) is required' };

  const dateStr = p.date;
  const isToday = dateStr === formatDate_(startOfToday_());
  if (isToday && !plan.sameDay) return { ok: false, error: 'This plan requires booking at least 1 day in advance.' };

  const tStart = toMin_(p.start);
  const treat = plan.treatmentMin;
  if (tStart < toMin_(ab.open) || tStart > toMin_(ab.lastStart)) {
    return { ok: false, error: 'Start time is outside booking hours (10:00–16:00).' };
  }
  if (isToday && tStart < nowMinutesJst_()) return { ok: false, error: 'That start time has already passed.' };

  // --- ロック下の最終再チェック（カレンダー直読み） ---
  const cal = CalendarApp.getCalendarById(CONFIG.calendarId);
  const dayStart = dateTimeFromParts_(dateStr, '00:00');
  const events = cal.getEvents(dayStart, addDays_(dayStart, 1));

  if (events.some(function (ev) { return ev.isAllDayEvent() && isAlgueblueOccupancyEvent_(ev); })) {
    return { ok: false, error: 'Algueblue is closed on this date.' };
  }
  const roomBusy = algueblueRoomBusyIntervals_(events, dateStr);
  if (overlapsAny_(tStart, tStart + treat, roomBusy)) {
    return { ok: false, error: 'Just booked by someone else. Please choose another time.' };
  }
  const staffRows = readAvailabilityRows_().filter(function (r) { return r.Date === dateStr; });
  const staff = pickTransferStaff_(dateStr, tStart, treat, staffRows);
  if (!staff) return { ok: false, error: 'No transfer staff (Kana/Sho) available for this time.' };

  // --- 確定: カレンダー作成（施術＋送迎2件）＋シート記録 ---
  const bookingId = newBookingId_();
  const startDt = dateTimeFromParts_(dateStr, p.start);
  const endDt = new Date(startDt.getTime() + treat * 60000);
  const planLabel = plan.name + (p.option ? (' (' + p.option + ')') : '');

  const treatEv = cal.createEvent(
    '[Algueblue] ' + planLabel + ' / ' + p.name + ' x' + p.people,
    startDt, endDt,
    { description: buildEventDesc_(bookingId, p, planLabel, [ab.marker]) }
  );

  const pickStart = new Date(startDt.getTime() - ab.transferMin * 60000);
  const dropEnd = new Date(endDt.getTime() + ab.transferMin * 60000);
  const pickEv = cal.createEvent(
    '[Algueblue送迎/pickup] ' + staff + ' - ' + p.name,
    pickStart, startDt,
    { description: buildEventDesc_(bookingId, p, planLabel + ' pickup', [ab.transferMarker, staff]) }
  );
  const dropEv = cal.createEvent(
    '[Algueblue送迎/dropoff] ' + staff + ' - ' + p.name,
    endDt, dropEnd,
    { description: buildEventDesc_(bookingId, p, planLabel + ' dropoff', [ab.transferMarker, staff]) }
  );

  appendBookingRow_({
    bookingId: bookingId, activity: 'Algueblue', planOption: planLabel,
    date: dateStr, start: p.start, end: fromMin_(tStart + treat), people: p.people,
    name: p.name, email: p.email, phone: p.phone, staff: staff,
    eventIds: [treatEv.getId(), pickEv.getId(), dropEv.getId()].join(' | '),
    notes: 'transfer ' + ab.transferMin + 'min each way',
  });

  return {
    ok: true, bookingId: bookingId, activity: 'Algueblue', plan: planLabel,
    date: dateStr, start: p.start, end: fromMin_(tStart + treat), transferStaff: staff,
  };
}

function pickTransferStaff_(dateStr, tStart, treatmentMin, staffRows) {
  const trans = BOOKING_CONFIG.algueblue.transferMin;
  const pickup = { start: tStart - trans, end: tStart };
  const dropoff = { start: tStart + treatmentMin, end: tStart + treatmentMin + trans };
  return CONFIG.staffPriority.filter(function (staffName) {
    return staffFreeInInterval_(staffName, dateStr, pickup, staffRows)
        && staffFreeInInterval_(staffName, dateStr, dropoff, staffRows);
  })[0] || '';
}

function bookTour_(p) {
  const t = BOOKING_CONFIG.tours[p.activity];
  if (!t) return { ok: false, error: 'Unknown activity' };
  const v = validateCommon_(p);
  if (!v.ok) return v;
  if (!/^\d{2}:\d{2}$/.test(p.start || '')) return { ok: false, error: 'start (HH:mm) is required' };
  if (Number(p.people) > t.capacity) return { ok: false, error: 'Too many people (max ' + t.capacity + ').' };

  const tb = BOOKING_CONFIG.tourBooking;
  const T = toMin_(p.start);
  const dur = tb.durationMin;
  if (T < toMin_(tb.open) || T > toMin_(tb.lastStart)) {
    return { ok: false, error: 'Start time is outside booking hours (09:30–15:00).' };
  }
  const isToday = p.date === formatDate_(startOfToday_());
  if (isToday && T < nowMinutesJst_()) return { ok: false, error: 'That start time has already passed.' };

  // --- ロック下の最終再チェック（カレンダー直読みで担当者の空きを確認） ---
  const rows = readAvailabilityRows_().filter(function (r) { return r.Date === p.date; });
  const ebikeClosed = ebikeClosedHalves_(rows);
  if (t.weatherSensitive && (ebikeClosed.AM || ebikeClosed.PM)) {
    // 雨天中止が掛かる半日に T+dur が掛かるかは tourStaffWindow_ 側で除外されるが、念のため明示エラーは下の担当者不在で処理
  }
  const cal = CalendarApp.getCalendarById(CONFIG.calendarId);
  const dayStart = dateTimeFromParts_(p.date, '00:00');
  const events = cal.getEvents(dayStart, addDays_(dayStart, 1));

  const staff = pickTourStaff_(p.date, T, t, rows, ebikeClosed, events);
  if (!staff) return { ok: false, error: 'No staff (Kana/Sho) available for this tour time.' };

  // --- 確定: カレンダー予定（180分）＋シート記録 ---
  const bookingId = newBookingId_();
  const startDt = dateTimeFromParts_(p.date, p.start);
  const endDt = new Date(startDt.getTime() + dur * 60000);
  const ev = cal.createEvent(
    '[Booking] ' + t.name + ' / ' + p.name + ' x' + p.people + ' (' + staff + ')',
    startDt, endDt,
    { description: buildEventDesc_(bookingId, p, t.name, [staff, 'People: ' + p.people]) }
  );

  appendBookingRow_({
    bookingId: bookingId, activity: t.name, planOption: '',
    date: p.date, start: p.start, end: fromMin_(T + dur), people: p.people,
    name: p.name, email: p.email, phone: p.phone, staff: staff,
    eventIds: ev.getId(), notes: 'tour self-booking (180min)',
  });

  return { ok: true, bookingId: bookingId, activity: t.name, date: p.date, start: p.start, end: fromMin_(T + dur), staff: staff };
}

// 開始 T のツアーを担当できるスタッフ（Kana/Sho）を1名返す。
// 勤務窓に [T, T+180] が収まり、かつカレンダー上その時間に占有が無い者。
function pickTourStaff_(dateStr, T, t, rows, ebikeClosed, events) {
  const dur = BOOKING_CONFIG.tourBooking.durationMin;
  return CONFIG.staffPriority.filter(function (staffName) {
    const win = tourStaffWindow_(staffName, t, dateStr, rows, ebikeClosed);
    if (!win || T < win.start || T + dur > win.end) return false;
    const busy = staffBusyIntervals_(staffName, events, dateStr);
    return !overlapsAny_(T, T + dur, busy);
  })[0] || '';
}

// スタッフ staffName のその日の占有区間（分）。カレンダー直読み（doPost の最終ガード用）。
//   - 予約/ツアー(Bokun・本システム)・Algueblue送迎など、スタッフ名を含む時間つき予定 → 占有
//   - OFF 予定（×/休み）→ テキストの時間レンジ、無ければ予定時間、終日なら丸一日
//   - 在席マーカー(○ など)で予約でないものは占有としない
function staffBusyIntervals_(staffName, events, dateStr) {
  const out = [];
  events.forEach(function (ev) {
    if (!eventMatchesStaff_(ev, staffName)) return;
    if (ev.isAllDayEvent()) {
      if (isOffEvent_(ev)) out.push({ start: 0, end: 24 * 60 });
      return;
    }
    if (isAvailableEvent_(ev) && !isBookingCalendarEvent_(ev)) return; // ○在席マーカー
    if (isOffEvent_(ev)) {
      const range = parseTimeRange_(eventText_(ev));
      if (range) { out.push({ start: toMin_(range.start), end: toMin_(range.end) }); return; }
    }
    const s = ev.getStartTime(), e = ev.getEndTime();
    if (!s || !e) return;
    out.push({ start: minutesOfDay_(s, dateStr), end: minutesOfDay_(e, dateStr) });
  });
  return out;
}

function validateCommon_(p) {
  if (!p.date || !/^\d{4}-\d{2}-\d{2}$/.test(p.date)) return { ok: false, error: 'date (YYYY-MM-DD) is required' };
  if (p.date < formatDate_(startOfToday_())) return { ok: false, error: 'Date is in the past' };
  if (!p.name) return { ok: false, error: 'name is required' };
  if (!p.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email)) return { ok: false, error: 'valid email is required' };
  const ppl = Number(p.people);
  if (!ppl || ppl < 1) return { ok: false, error: 'people must be >= 1' };
  return { ok: true };
}

/* =========================================================================
 *  Bookings シート / 共通ユーティリティ
 * ========================================================================= */

function setupBookingSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(BOOKING_CONFIG.bookingsSheetName);
  if (!sheet) sheet = ss.insertSheet(BOOKING_CONFIG.bookingsSheetName);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(BOOKING_CONFIG.bookingsHeaders);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function appendBookingRow_(b) {
  const sheet = setupBookingSheet_();
  sheet.appendRow([
    new Date(), b.bookingId, 'Confirmed', b.activity, b.planOption,
    b.date, b.start, b.end, b.people, b.name, b.email, b.phone,
    b.staff, b.eventIds, b.notes || '',
  ]);
}

function buildEventDesc_(bookingId, p, label, tags) {
  return [
    BOOKING_CONFIG.webMarker, (tags || []).join(' '),
    'Booking ID: ' + bookingId,
    'Plan: ' + label,
    'Name: ' + p.name,
    'People: ' + p.people,
    'Email: ' + (p.email || ''),
    'Phone: ' + (p.phone || ''),
    (p.note ? ('Note: ' + p.note) : ''),
  ].filter(String).join('\n');
}

function newBookingId_() {
  return 'WB' + Utilities.formatDate(new Date(), CONFIG.timeZone, 'yyyyMMdd-HHmmss') +
    '-' + Math.floor(Math.random() * 900 + 100);
}

// Availability シートを {header:value} の配列で読む（CSV ではなく直接シート）
function readAvailabilityRows_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.availabilitySheetName);
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map(function (h) { return String(h).trim(); });
  return values.slice(1).map(function (r) {
    const o = {};
    headers.forEach(function (h, i) {
      o[h] = (h === 'Date') ? normalizeDateValue_(r[i]) : String(r[i] == null ? '' : r[i]).trim();
    });
    return o;
  }).filter(function (o) { return o.Date; });
}

// 区間が占有リストのいずれかと重なるか（分）
function overlapsAny_(start, end, intervals) {
  return intervals.some(function (iv) { return start < iv.end && end > iv.start; });
}

function toMin_(hhmm) { const a = String(hhmm).split(':'); return Number(a[0]) * 60 + Number(a[1]); }
function fromMin_(m) { const h = Math.floor(m / 60), mm = m % 60; return ('0' + h).slice(-2) + ':' + ('0' + mm).slice(-2); }

// Date を「その日の 0:00 からの分」に変換（JST 前提＝プロジェクトTZがJST）
function minutesOfDay_(date, dateStr) {
  const base = dateTimeFromParts_(dateStr, '00:00').getTime();
  return Math.round((date.getTime() - base) / 60000);
}

function nowMinutesJst_() {
  const s = Utilities.formatDate(new Date(), CONFIG.timeZone, 'HH:mm');
  return toMin_(s);
}
