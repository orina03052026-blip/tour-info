/* Unified booking form (Algueblue + cycling + Himeji castle).
 * Talks to the Apps Script Web App: GET ?action=availability / POST (text/plain JSON).
 * Deploy the Web App, then paste its /exec URL below. */
const WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbyL_cqU6-SkSg7yNXCSterbVFVM4lPp8d6W4mJQyvXKSh7Qqu2Njsr_pPz11v8rvJw/exec';

// アルグブルーの「先の予約」で表示する日数（今日から HORIZON_DAYS 日先まで）。GAS の algueblueOpenDays と揃える。
const HORIZON_DAYS = 30;

// ▼メンテナンス用スイッチ。true の間は「停止対象アクティビティ」だけ申込を止め、案内を表示する。
//   ツアー等は通常どおり受付。作業が終わったら false に戻して push すれば通常運用に復帰する。
const MAINTENANCE = false;
// 停止対象（activityKind の値）。今回はアルグブルーのみ停止。
const MAINTENANCE_KINDS = ['algueblue'];
const MAINTENANCE_MSG =
  '<h3>アルグブルーはただいま予約調整中です</h3>'
  + '<p>アルグブルーのオンライン予約を一時的に停止しています。ご不便をおかけしますが、少し時間をおいて再度お試しください。</p>'
  + '<p class="muted">Algueblue online booking is temporarily paused. Please try again a little later.</p>'
  + '<p class="muted small">お急ぎの場合 / Urgent: WhatsApp +81 70-2013-1181 ・ comecomehimeji@gmail.com</p>';

// プレビュー用バイパス：?preview=algueblue2026 付きURLの時だけメンテナンスを無視（本人確認用）。
//   一般のお客様には引き続きメンテ表示。公開時はこの合言葉付きURLを共有しなければよい。
function maintenanceBypassed() { return new URLSearchParams(location.search).get('preview') === 'algueblue2026'; }

// 選択中のアクティビティが停止対象か
function activityUnderMaintenance() { return MAINTENANCE && !maintenanceBypassed() && MAINTENANCE_KINDS.indexOf(activityKind()) !== -1; }

const ACTIVITIES = [
  // maxPeople: 予約フォームで選べる人数の上限（アルグブルーは個室のため2名）。
  // minPeople: 予約フォームで選べる人数の下限（未指定は1）。午後工芸ツアーはガイド1名が最大6名を引率する少人数制のため最少2名。
  { code: 'algueblue',    label: 'Thalassotherapy Spa (Algueblue)', kind: 'algueblue', maxPeople: 2 },
  { code: 'ebike-castle', label: 'e-bike Ride around the Castle',    kind: 'tour', maxPeople: 4 },
  { code: 'ebike-sea',    label: 'e-bike Ride to the Sea',          kind: 'tour', maxPeople: 4 },
  // payFirst: バックエンド(BOOKING_CONFIG.tours['castle-guide'].payFirst)と揃える。2026-08 先払い制トライアル第1弾。
  { code: 'castle-guide', label: 'Himeji Castle Guide Tour',         kind: 'tour', maxPeople: 8, payFirst: true },
  { code: 'craft-course1', label: 'Afternoon Craft Tour — Calligraphy + Wagashi Making', kind: 'tour', maxPeople: 6, minPeople: 2 },
  { code: 'craft-course2', label: 'Afternoon Craft Tour — Calligraphy + Gold Leaf Application', kind: 'tour', maxPeople: 6, minPeople: 2 },
  { code: 'craft-course3', label: 'Afternoon Craft Tour — Indigo Dyeing + Gold Leaf Application', kind: 'tour', maxPeople: 6, minPeople: 2 },
];

const state = {
  availability: null,   // 日付キャッシュ { 'YYYY-MM-DD': { algueblue, tours } }（初期は今日・明日。先の日はクリック時に単日追加）
  dates: [],            // ツアー用の日付（today, tomorrow）
  openDays: [],         // アルグブルーの予約候補日（出勤予定あり＆休業でない日）'YYYY-MM-DD' の配列
  tourOpenDays: {},     // ツアー用の予約候補日キャッシュ { activityCode: ['YYYY-MM-DD', ...] }（「See more dates」で取得）
  showTourCalendar: false, // ツアーで「See more dates」を開いているか
  calMonth: null,       // カレンダー（アルグブルー・ツアー共通）で表示中の月 {y, m(0-11)}
  presetPlan: null,     // ?plan= で来たプラン（WPのプランボタンから）
  activity: null,
  date: null,
  plan: null, option: null, start: null,  // Algueblue: plan/option/start; tours: start
  pickup: null,                            // Algueblue: pickup hotel
  height: '',                              // e-bike tours: rider height(s)
  people: 1,
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// クライアント方針：アルグブルーのみ日本語＋英語併記。ツアーは英語のみ。
const isAlg = () => activityKind() === 'algueblue';
const bi = (ja, en) => isAlg() ? (ja + ' / ' + en) : en;

// PayPal.Me 受取リンク（末尾に金額を付けて使う。例 .../44000JPY）。会社アカウント @himejiact。
const PAYPAL_ME = 'https://paypal.me/himejiact/';

// この予約の合計金額（円）。バックエンド(booking_webapp.gs)と同じ計算式にする：
//   アルグブルー＝プラン単価×人数（soloPriceなし）／ツアー＝1名はsoloPrice・2名以上は単価×人数。
function bookingTotalYen() {
  if (!state.date || !state.availability || !state.availability[state.date]) return null;
  const day = state.availability[state.date];
  const ppl = Math.max(1, Number(state.people) || 1);
  if (activityKind() === 'algueblue') {
    const plan = day.algueblue && day.algueblue.plans && day.algueblue.plans[state.plan];
    if (!plan || plan.price == null) return null;
    return plan.price * ppl;
  }
  const tour = day.tours && day.tours[state.activity];
  if (!tour || tour.pricePerPerson == null) return null;
  return (ppl === 1 && tour.soloPrice) ? tour.soloPrice : tour.pricePerPerson * ppl;
}

// 予約日が「当日（今日）」か。バックエンド由来の state.dates[0]（今日, JST基準）と比較するので端末TZに依存しない。
// 当日のみ現地払いも可（時間が無く、PayPal未登録／請求書送付が間に合わないケースの救済）。
function isSameDay() {
  return !!(state.date && state.dates && state.dates.length && state.date === state.dates[0]);
}

// 共有の静的テキスト（日付選択・Summary・確定ボタン等）を、選択中アクティビティに合わせて切替。
function updateChrome() {
  const alg = isAlg();
  const dateH = document.querySelector('#date-section .step-title');
  if (dateH) dateH.textContent = alg ? '日付を選択 / Choose a date' : 'Choose a date';
  const sumH = document.querySelector('#summary-section .step-title');
  if (sumH) sumH.textContent = alg ? 'ご予約内容 / Summary' : 'Summary';
  const btn = $('#submit-btn');
  if (btn) btn.textContent = activityPayFirst() ? 'Continue to payment' : (alg ? '予約する / Confirm booking' : 'Confirm booking');
  const pay = document.querySelector('#summary-section .muted.small');
  if (pay) {
    let t;
    if (activityPayFirst()) {
      // 先払い制：現地払いの選択肢は無い。送信後は必ずPayPalの決済ページへ移動する旨を明確に伝える。
      t = 'You will be taken to PayPal to pay now. Your booking is confirmed once payment is completed.';
    } else {
      t = alg
        ? 'ご確定後、次の画面でPayPalにてお支払いいただけます。ご入金の確認をもってご予約完了となります。 / After you confirm, you can pay by PayPal on the next screen. Your booking is complete once we receive your payment.'
        : 'After you confirm, you can pay by PayPal on the next screen. Your booking is complete once we receive your payment.';
      if (isSameDay()) t += alg
        ? '　当日のご予約に限り、当日現地でのお支払いも可能です。 / For same-day bookings, you may also pay on site.'
        : ' For same-day bookings, you may also pay on site.';
    }
    pay.textContent = t;
  }
  const priv = $('#privacy-note');
  if (priv) priv.textContent = alg
    ? 'ご入力の個人情報（お名前・ご連絡先など）は、ご予約の受付・確認のご連絡にのみ使用し、法令に基づく場合を除き第三者へ提供しません。データはGoogleのサービス上に安全に保管します。お問い合わせ：comecomehimeji@gmail.com（株式会社あくと） / The personal information you provide is used only to process and confirm your booking; we do not share it with third parties except as required by law. Data is stored securely on Google. Contact: comecomehimeji@gmail.com (ACT Co., Ltd.).'
    : 'The personal information you provide (name and contact details) is used only to process and confirm your booking. We do not share it with third parties except as required by law. Your data is stored securely on Google services. Contact: comecomehimeji@gmail.com (ACT Co., Ltd.).';
}

function fmtDateLabel(dateStr, idx) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const rel = idx === 0 ? 'Today' : idx === 1 ? 'Tomorrow' : '';
  return (rel ? rel + ' · ' : '') + months[m - 1] + ' ' + d;
}

// "HH:mm" から min 分を引いた "HH:mm"（お迎え時刻の目安表示に使用）
function subtractMinutes(hhmm, min) {
  const [h, m] = String(hhmm).split(':').map(Number);
  let total = h * 60 + m - Number(min);
  if (total < 0) total = 0;
  const hh = Math.floor(total / 60), mm = total % 60;
  return ('0' + hh).slice(-2) + ':' + ('0' + mm).slice(-2);
}

async function init() {
  const qs = new URLSearchParams(location.search);

  // 先払い制（PayPal Orders v2）からの戻り。通常のウィザードは出さず、専用の画面だけ表示する。
  if (qs.get('cancelled') === '1') { showPaymentCancelled(); return; }
  if (qs.get('paypalReturn') === '1' && qs.get('token')) { showPaymentPendingConfirmation(); return; }

  // 今日・明日ページのカードや WPのプランボタンから activity / date / plan を引き継いで事前選択
  const preset = qs.get('activity');
  if (preset && ACTIVITIES.some((a) => a.code === preset)) state.activity = preset;
  state.presetDate = qs.get('date') || null;
  const presetPlan = qs.get('plan');
  if (presetPlan && ['plan01', 'plan02', 'plan03'].indexOf(presetPlan) !== -1) state.presetPlan = presetPlan;
  renderActivities();
  try {
    // 今日・明日の空き（全アクティビティ共通）と、アルグブルーの候補日（60日分）を並行取得
    const [availRes, openRes] = await Promise.all([
      fetch(WEBAPP_URL + '?action=availability', { cache: 'no-store' }),
      fetch(WEBAPP_URL + '?action=algueblueOpenDays&days=' + HORIZON_DAYS, { cache: 'no-store' }).catch(() => null),
    ]);
    const data = await availRes.json();
    if (!data.ok) throw new Error(data.error || 'load failed');
    state.availability = data.days;              // キャッシュに今日・明日を投入
    state.dates = Object.keys(data.days).sort(); // ツアー用の日付リスト
    if (openRes) { try { const od = await openRes.json(); if (od && od.ok) state.openDays = od.openDays || []; } catch (e) { /* 候補日が取れなくても今日明日は動く */ } }
    // 事前選択を反映（今日・明日のカードから来た場合。先の日付は presetDate に来ない想定）
    if (state.activity && state.presetDate && state.availability[state.presetDate]) {
      state.date = state.presetDate;
      if (!isDateOpen(state.date)) state.date = null; // 満席/休業なら日付選択に戻す
    }
    if (state.activity) {
      renderDates();
      if (state.date && !activityUnderMaintenance()) { maybePresetPlan(); renderDetails(); renderSummary(); }
    }
  } catch (err) {
    $('#status').textContent = 'Could not load availability. Please try again later.';
    console.error(err);
  }
}

// ?plan= で来たプランを、その日に選択可能なら自動選択する（WPのプランボタン用）
function maybePresetPlan() {
  if (!state.presetPlan || state.plan) return;
  if (activityKind() !== 'algueblue' || !state.date) return;
  const day = state.availability[state.date];
  const ab = day && day.algueblue;
  if (ab && ab.plans && ab.plans[state.presetPlan] && ab.plans[state.presetPlan].open) {
    state.plan = state.presetPlan;
  }
}

/* ---- Step 1: activity ---- */
function renderActivities() {
  const wrap = $('#activities');
  wrap.innerHTML = '';
  ACTIVITIES.forEach((a) => {
    const b = el('button', 'choice' + (state.activity === a.code ? ' selected' : ''), esc(a.label));
    b.type = 'button';
    b.onclick = () => { Object.assign(state, { activity: a.code, date: null, plan: null, option: null, start: null, pickup: null, height: '', showTourCalendar: false, calMonth: null }); renderActivities(); renderDates(); renderDetails(); renderSummary(); };
    wrap.appendChild(b);
  });
}

function activityKind() { const a = ACTIVITIES.find((x) => x.code === state.activity); return a ? a.kind : null; }
// 選択中アクティビティの人数上限（未定義なら従来どおり20）。
function activityMaxPeople() { const a = ACTIVITIES.find((x) => x.code === state.activity); return (a && a.maxPeople) || 20; }
// 選択中アクティビティの人数下限（未定義なら1。午後工芸ツアーは少人数制のため2）。
function activityMinPeople() { const a = ACTIVITIES.find((x) => x.code === state.activity); return (a && a.minPeople) || 1; }
// 選択中アクティビティが先払い制（PayPal Orders v2、送信後は必ず決済ページへ移動＝現地払い選択肢なし）か。
function activityPayFirst() { const a = ACTIVITIES.find((x) => x.code === state.activity); return !!(a && a.payFirst); }

/* ---- Step 2: date ---- */
function renderDates() {
  const sec = $('#date-section');
  const wrap = $('#dates');
  wrap.innerHTML = '';
  updateChrome();
  if (!state.activity || !state.availability) { sec.hidden = true; return; }
  sec.hidden = false;
  // 停止対象アクティビティ（アルグブルー）は案内のみ表示し、日付・詳細・確定は出さない。
  if (activityUnderMaintenance()) {
    wrap.innerHTML = '<div class="maint-notice">' + MAINTENANCE_MSG + '</div>';
    $('#details-section').hidden = true;
    $('#summary-section').hidden = true;
    return;
  }
  // アルグブルーは「先の予約」対応の月カレンダー。ツアーは今日・明日をすぐ選べるボタン＋「See more dates」で同じカレンダーを展開。
  if (activityKind() === 'algueblue') { renderAlgueblueCalendar(wrap); return; }
  renderTourDates(wrap);
}

// ツアー（e-bike／城ガイド／午後工芸ツアー）の日付選択：今日・明日はボタンで即選択、
// それより先は「See more dates」を押すとアルグブルーと同じ月カレンダーが展開される。
function renderTourDates(wrap) {
  state.dates.forEach((d, idx) => {
    const open = isDateOpen(d);
    const b = el('button', 'choice' + (state.date === d ? ' selected' : '') + (open ? '' : ' disabled'), fmtDateLabel(d, idx));
    b.type = 'button';
    b.disabled = !open;
    b.onclick = () => { Object.assign(state, { date: d, plan: null, option: null, start: null, pickup: null }); renderDates(); renderDetails(); renderSummary(); };
    wrap.appendChild(b);
  });

  const toggle = el('button', 'link-toggle', state.showTourCalendar ? 'Hide calendar' : 'See more dates ›');
  toggle.type = 'button';
  toggle.onclick = () => { state.showTourCalendar = !state.showTourCalendar; renderDates(); };
  wrap.appendChild(toggle);

  if (state.showTourCalendar) {
    const calWrap = el('div', 'tour-calendar');
    wrap.appendChild(calWrap);
    renderTourCalendar(calWrap);
  }
}

/* ---- アルグブルー用 月カレンダー（今日〜HORIZON_DAYS日先） ---- */
const CAL_MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const CAL_DOW = ['日/Su', '月/Mo', '火/Tu', '水/We', '木/Th', '金/Fr', '土/Sa'];

const todayYmd = () => dateToYmd(new Date());
const ymdToDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const dateToYmd = (dt) => dt.getFullYear() + '-' + ('0' + (dt.getMonth() + 1)).slice(-2) + '-' + ('0' + dt.getDate()).slice(-2);
const addDaysYmd = (s, n) => { const dt = ymdToDate(s); dt.setDate(dt.getDate() + n); return dateToYmd(dt); };

// その日がアルグブルーで予約可能か。候補日(openDays)にあり、かつ（キャッシュ済で満席と判明していない）
function isAlgueblueDayOpen(ds) {
  if ((state.openDays || []).indexOf(ds) === -1) return false;
  const cached = state.availability[ds];
  if (cached && cached.algueblue && cached.algueblue.anyOpen === false) return false;
  return true;
}

// 月カレンダーの共通描画（アルグブルー・ツアー兼用）。isOpenFn(ds)で開いている日を判定し、onSelect(ds)で選択する。
function renderCalendarGrid(wrap, isOpenFn, onSelect) {
  const today = todayYmd();
  const endYmd = addDaysYmd(today, HORIZON_DAYS - 1);
  const todayD = ymdToDate(today), endD = ymdToDate(endYmd);
  if (!state.calMonth) state.calMonth = { y: todayD.getFullYear(), m: todayD.getMonth() };
  const y = state.calMonth.y, m = state.calMonth.m;

  // 月移動（表示範囲＝今日の月〜HORIZON末日の月）
  const prevAllowed = (y > todayD.getFullYear()) || (y === todayD.getFullYear() && m > todayD.getMonth());
  const nextAllowed = (y < endD.getFullYear()) || (y === endD.getFullYear() && m < endD.getMonth());
  const head = el('div', 'cal-head');
  const prev = el('button', 'cal-nav', '‹'); prev.type = 'button'; prev.disabled = !prevAllowed;
  prev.onclick = () => { state.calMonth = (m === 0) ? { y: y - 1, m: 11 } : { y: y, m: m - 1 }; renderDates(); };
  const next = el('button', 'cal-nav', '›'); next.type = 'button'; next.disabled = !nextAllowed;
  next.onclick = () => { state.calMonth = (m === 11) ? { y: y + 1, m: 0 } : { y: y, m: m + 1 }; renderDates(); };
  head.appendChild(prev);
  head.appendChild(el('div', 'cal-title', (m + 1) + '月 / ' + CAL_MONTHS_EN[m] + ' ' + y));
  head.appendChild(next);
  wrap.appendChild(head);

  const dow = el('div', 'cal-grid cal-dow');
  CAL_DOW.forEach((d) => dow.appendChild(el('div', 'cal-dowcell', d)));
  wrap.appendChild(dow);

  const grid = el('div', 'cal-grid');
  const startPad = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  for (let i = 0; i < startPad; i++) grid.appendChild(el('div', 'cal-cell empty'));
  for (let dnum = 1; dnum <= daysInMonth; dnum++) {
    const ds = dateToYmd(new Date(y, m, dnum));
    const inRange = ds >= today && ds <= endYmd;
    const open = inRange && isOpenFn(ds);
    const cls = 'cal-cell' + (inRange ? (open ? ' open' : ' closed') : ' out')
      + (state.date === ds ? ' selected' : '') + (ds === today ? ' today' : '');
    const cell = el('button', cls, String(dnum));
    cell.type = 'button';
    cell.disabled = !open;
    if (open) cell.onclick = () => onSelect(ds);
    grid.appendChild(cell);
  }
  wrap.appendChild(grid);
}

function renderAlgueblueCalendar(wrap) {
  renderCalendarGrid(wrap, isAlgueblueDayOpen, selectAlgueblueDate);
  if (!(state.openDays || []).length) {
    wrap.appendChild(el('p', 'muted small',
      '現在ご予約いただける日がありません。カレンダーにスタッフの出勤予定が入り次第、ここに表示されます。 / No open dates yet — dates appear once staff shifts are added to the calendar.'));
  }
}

// ツアー用「See more dates」カレンダー。選択中アクティビティの候補日を初回だけ取得してキャッシュする。
function isTourDayOpen(ds) {
  const days = state.tourOpenDays[state.activity] || [];
  if (days.indexOf(ds) === -1) return false;
  const cached = state.availability[ds];
  if (cached && cached.tours && cached.tours[state.activity] && cached.tours[state.activity].open === false) return false;
  return true;
}

function renderTourCalendar(wrap) {
  const code = state.activity;
  if (!state.tourOpenDays[code]) {
    wrap.appendChild(el('p', 'muted small', 'Loading available dates…'));
    fetch(WEBAPP_URL + '?action=tourOpenDays&activity=' + encodeURIComponent(code) + '&days=' + HORIZON_DAYS, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { state.tourOpenDays[code] = (d && d.ok && d.openDays) || []; if (state.activity === code) renderDates(); })
      .catch(() => { state.tourOpenDays[code] = []; if (state.activity === code) renderDates(); });
    return;
  }
  renderCalendarGrid(wrap, isTourDayOpen, selectTourDate);
  if (!(state.tourOpenDays[code] || []).length) {
    wrap.appendChild(el('p', 'muted small', 'No open dates in the next ' + HORIZON_DAYS + ' days.'));
  }
}

// カレンダーでツアーの日付を選択。未取得なら単日の空きを取得してから詳細を描画（selectAlgueblueDateと同じ形）。
async function selectTourDate(ds) {
  Object.assign(state, { date: ds, plan: null, option: null, start: null, pickup: null });
  renderDates();
  if (!state.availability[ds]) {
    const sec = $('#details-section');
    sec.hidden = false;
    sec.innerHTML = '';
    sec.appendChild(el('p', 'muted', 'Checking availability…'));
    try {
      const res = await fetch(WEBAPP_URL + '?action=availability&date=' + ds, { cache: 'no-store' });
      const data = await res.json();
      if (!(data.ok && data.days && data.days[ds])) throw new Error(data.error || 'load failed');
      state.availability[ds] = data.days[ds];
    } catch (err) {
      const sec2 = $('#details-section');
      sec2.innerHTML = '';
      sec2.appendChild(el('p', 'muted', 'Could not load availability. Please try again.'));
      console.error(err);
      return;
    }
    renderDates();
  }
  renderDetails();
  renderSummary();
}

// カレンダーで日付を選択。未取得なら単日の空きを取得してから詳細を描画。
async function selectAlgueblueDate(ds) {
  Object.assign(state, { date: ds, plan: null, option: null, start: null, pickup: null });
  renderDates();
  if (!state.availability[ds]) {
    const sec = $('#details-section');
    sec.hidden = false;
    sec.innerHTML = '';
    sec.appendChild(el('p', 'muted', '空き状況を確認中… / Checking availability…'));
    try {
      const res = await fetch(WEBAPP_URL + '?action=availability&date=' + ds, { cache: 'no-store' });
      const data = await res.json();
      if (!(data.ok && data.days && data.days[ds])) throw new Error(data.error || 'load failed');
      state.availability[ds] = data.days[ds];
    } catch (err) {
      const sec2 = $('#details-section');
      sec2.innerHTML = '';
      sec2.appendChild(el('p', 'muted', '空き状況を取得できませんでした。もう一度お試しください。 / Could not load availability. Please try again.'));
      console.error(err);
      return;
    }
    // 満席と判明したらカレンダー表示を更新（クリック不可に）
    renderDates();
  }
  maybePresetPlan();
  renderDetails();
  renderSummary();
}

function isDateOpen(d) {
  const day = state.availability[d];
  if (!day) return false;
  if (activityKind() === 'algueblue') return day.algueblue && !day.algueblue.closed && day.algueblue.anyOpen;
  const t = day.tours[state.activity];
  return t && t.starts && t.starts.length > 0;
}

/* ---- Step 3: details (plan/option/start OR slot) + people ---- */
function renderDetails() {
  const sec = $('#details-section');
  sec.innerHTML = '';
  if (!state.activity || !state.date) { sec.hidden = true; return; }
  sec.hidden = false;
  updateChrome();
  if (activityKind() === 'algueblue') renderAlgueblueDetails(sec);
  else renderTourDetails(sec);
  renderPeople(sec);
  if (activityRequiresHeight()) renderHeight(sec);
  renderContact(sec);
}

// e-bike ツアーは自転車サイズ確認のため身長が必要（doGet の requiresHeight で判定）
function activityRequiresHeight() {
  if (activityKind() !== 'tour' || !state.date) return false;
  const t = state.availability[state.date].tours[state.activity];
  return !!(t && t.requiresHeight);
}

function renderHeight(sec) {
  sec.appendChild(el('h3', 'step-title', 'Rider height — for bike sizing'));
  const f = el('label', 'field');
  f.appendChild(el('span', 'field-label', 'Height in cm (one per rider, e.g. 165, 172) *'));
  const input = el('input');
  input.type = 'text';
  input.placeholder = 'e.g. 165, 172';
  input.value = state.height || '';
  input.oninput = () => { state.height = input.value; renderSummary(); };
  f.appendChild(input);
  sec.appendChild(f);
}

function renderAlgueblueDetails(sec) {
  const ab = state.availability[state.date].algueblue;
  sec.appendChild(el('h3', 'step-title', 'プランを選択 / Choose a plan'));
  const planWrap = el('div', 'choices');
  Object.keys(ab.plans).forEach((key) => {
    const p = ab.plans[key];
    if (!p.open) return;
    const b = el('button', 'choice plan' + (state.plan === key ? ' selected' : ''),
      '<strong>' + esc(p.name) + '</strong><span class="muted">¥' + Number(p.price).toLocaleString() + '</span>');
    b.type = 'button';
    b.onclick = () => { Object.assign(state, { plan: key, option: null, pickup: null, start: null }); renderDetails(); renderSummary(); };
    planWrap.appendChild(b);
  });
  if (!planWrap.children.length) planWrap.appendChild(el('p', 'muted', 'この日は選べるプランがありません。 / No plan available on this date.'));
  sec.appendChild(planWrap);
  if (!state.plan) return;

  const plan = ab.plans[state.plan];
  if (plan.options && plan.options.length) {
    sec.appendChild(el('h3', 'step-title', 'コース / Course'));
    const ow = el('div', 'choices');
    plan.options.forEach((o) => {
      const b = el('button', 'choice' + (state.option === o ? ' selected' : ''), esc(o));
      b.type = 'button';
      b.onclick = () => { state.option = o; renderDetails(); renderSummary(); };
      ow.appendChild(b);
    });
    sec.appendChild(ow);
  }

  // 送迎ホテルを先に選ぶ（ホテルで送迎時間が違い、取れる開始時刻も変わるため）
  const startsByHotel = plan.startsByHotel || {};
  sec.appendChild(el('h3', 'step-title', 'お迎え場所 / Pickup hotel'));
  const hw = el('div', 'choices');
  (ab.pickupHotels || []).forEach((h) => {
    const openForHotel = (startsByHotel[h.name] || []).length > 0;
    const b = el('button', 'choice' + (state.pickup === h.name ? ' selected' : '') + (openForHotel ? '' : ' disabled'), esc(h.name));
    b.type = 'button';
    b.disabled = !openForHotel;
    b.onclick = () => { Object.assign(state, { pickup: h.name, start: null }); renderDetails(); renderSummary(); };
    hw.appendChild(b);
  });
  sec.appendChild(hw);
  sec.appendChild(el('p', 'muted small', 'ご宿泊のホテルまでお迎えに伺います。下の開始時刻は送迎の移動時間を含んだ表示です。 / Our staff will pick you up at your hotel. The start times below already include travel to Algueblue.'));
  if (!state.pickup) return;

  // 選んだホテルで取れる開始時刻だけを表示。各ボタンに「施術開始」と「お迎え時刻」を併記して分かりやすく。
  const starts = startsByHotel[state.pickup] || [];
  const hotel = (ab.pickupHotels || []).find((x) => x.name === state.pickup);
  sec.appendChild(el('h3', 'step-title', '施術開始時間 / Treatment start time'));
  sec.appendChild(el('p', 'muted small', '施術が始まる時刻をお選びください。各ボタンの下にお迎え時刻を表示しています。 / Pick when your treatment starts — the hotel pickup time is shown under each.'));
  const tw = el('div', 'choices times');
  starts.forEach((t) => {
    const pk = (hotel && hotel.toSalonMin != null) ? subtractMinutes(t, hotel.toSalonMin) : null;
    const label = '<span class="time-main">' + esc(t) + '</span>'
      + (pk ? '<span class="pickup-sub">お迎え/pickup ' + esc(pk) + '</span>' : '');
    const b = el('button', 'choice time' + (state.start === t ? ' selected' : ''), label);
    b.type = 'button';
    b.onclick = () => { state.start = t; renderDetails(); renderSummary(); };
    tw.appendChild(b);
  });
  if (!starts.length) tw.appendChild(el('p', 'muted', 'このホテルで空いている開始時刻がありません。別のお迎え場所をお試しください。 / No open start times for this hotel. Please try another pickup hotel.'));
  sec.appendChild(tw);

  // 選択後の確認（施術開始とお迎え時刻を明示）
  if (state.start && hotel && hotel.toSalonMin != null) {
    const pk = subtractMinutes(state.start, hotel.toSalonMin);
    sec.appendChild(el('p', 'muted small',
      '施術開始 ' + esc(state.start) + ' ・ お迎え目安 ' + esc(pk) + '（時間はメールで確定します）'
      + ' / Treatment starts ' + esc(state.start) + ' · hotel pickup around ' + esc(pk) + ' (we will confirm by email).'));
  }
}

function renderTourDetails(sec) {
  const t = state.availability[state.date].tours[state.activity];
  sec.appendChild(el('h3', 'step-title', 'Start time (3-hour tour)'));
  const wrap = el('div', 'choices times');
  (t.starts || []).forEach((time) => {
    const b = el('button', 'choice time' + (state.start === time ? ' selected' : ''), esc(time));
    b.type = 'button';
    b.onclick = () => { state.start = time; renderDetails(); renderSummary(); };
    wrap.appendChild(b);
  });
  if (!(t.starts || []).length) wrap.appendChild(el('p', 'muted', 'No open start times on this date.'));
  sec.appendChild(wrap);
}

function renderPeople(sec) {
  sec.appendChild(el('h3', 'step-title', bi('人数', 'Number of people')));
  const row = el('div', 'people-row');
  // アクティビティごとの人数上限（アルグブルー2／e-bike各4／姫路城ガイド8／午後工芸ツアー6）と下限（工芸ツアーのみ2）。
  const maxPeople = activityMaxPeople();
  const minPeople = activityMinPeople();
  if (state.people > maxPeople) state.people = maxPeople;
  if (state.people < minPeople) state.people = minPeople;
  const input = el('input'); input.type = 'number'; input.min = String(minPeople); input.max = String(maxPeople); input.value = state.people;
  // min/max属性だけだと手入力で超過できるため、状態も上下限で丸める。
  input.oninput = () => { state.people = Math.min(maxPeople, Math.max(minPeople, Number(input.value) || minPeople)); renderSummary(); };
  input.onchange = () => { input.value = state.people; }; // 確定時に見た目も上下限へ揃える
  row.appendChild(input);
  if (minPeople > 1) row.appendChild(el('p', 'muted small', bi('最少' + minPeople + '名から承ります', 'Minimum ' + minPeople + ' people for this tour')));
  sec.appendChild(row);
}

function renderContact(sec) {
  sec.appendChild(el('h3', 'step-title', bi('お客様情報', 'Your details')));
  const fields = [
    ['name', bi('お名前', 'Full name') + ' *', 'text'],
    ['email', bi('メール', 'Email') + ' *', 'email'],
    ['phone', bi('電話番号', 'Phone'), 'tel'],
    ['note', bi('備考（任意）', 'Note (optional)'), 'text'],
  ];
  fields.forEach(([key, label, type]) => {
    const f = el('label', 'field');
    f.appendChild(el('span', 'field-label', label));
    const input = el('input'); input.type = type; input.id = 'f-' + key; input.value = state[key] || '';
    input.oninput = () => { state[key] = input.value; renderSummary(); };
    f.appendChild(input);
    sec.appendChild(f);
  });
}

/* ---- Summary + submit ---- */
function renderSummary() {
  const sec = $('#summary-section');
  const ready = isReady();
  sec.hidden = !state.activity || !state.date;
  updateChrome();
  const a = ACTIVITIES.find((x) => x.code === state.activity);
  const lines = [];
  if (a) lines.push([bi('アクティビティ', 'Activity'), a.label]);
  if (state.date) lines.push([bi('日付', 'Date'), state.date]);
  if (activityKind() === 'algueblue' && state.plan) {
    const p = state.availability[state.date].algueblue.plans[state.plan];
    lines.push([bi('プラン', 'Plan'), p.name + (state.option ? ' (' + state.option + ')' : '')]);
  }
  if (state.start) lines.push([activityKind() === 'algueblue' ? bi('施術開始', 'Treatment start') : 'Start', state.start]);
  if (activityKind() === 'algueblue' && state.pickup) {
    lines.push([bi('お迎え場所', 'Pickup hotel'), state.pickup]);
    const hotel = (state.availability[state.date].algueblue.pickupHotels || []).find((x) => x.name === state.pickup);
    if (hotel && hotel.toSalonMin != null && state.start) lines.push([bi('お迎え時刻', 'Pickup time'), subtractMinutes(state.start, hotel.toSalonMin)]);
  }
  lines.push([bi('人数', 'People'), state.people]);
  if (activityRequiresHeight() && state.height) lines.push(['Height (cm)', state.height]);
  // 料金表示（ツアー）。バックエンドが availability で返す pricePerPerson / soloPrice から算出。
  //   計算式は確認メール(booking_webapp.gs)と同じ：1名は単独料金、2名以上は人数×単価。
  //   料金の出所は GAS の BOOKING_CONFIG.tours（フロントには持たない＝二重管理を避ける）。
  if (activityKind() === 'tour' && state.date) {
    const tour = state.availability[state.date].tours[state.activity];
    if (tour && tour.pricePerPerson) {
      const ppl = Number(state.people) || 1;
      let total, note;
      if (ppl === 1 && tour.soloPrice) {
        total = tour.soloPrice; note = bi('1名', '1 person');
      } else {
        total = tour.pricePerPerson * ppl;
        note = '¥' + Number(tour.pricePerPerson).toLocaleString() + bi('／人', '/person') + ' × ' + ppl;
      }
      lines.push([bi('料金', 'Price'), '¥' + Number(total).toLocaleString() + ' (' + note + ')']);
    }
  }
  $('#summary').innerHTML = lines.map(([k, v]) => '<div class="sum-row"><span>' + esc(k) + '</span><b>' + esc(v) + '</b></div>').join('');
  $('#submit-btn').disabled = !ready;
}

function isReady() {
  if (!state.activity || !state.date || !state.people) return false;
  if (Number(state.people) < activityMinPeople()) return false;
  if (!state.name || !state.email) return false;
  if (activityKind() === 'algueblue') {
    if (!state.plan || !state.start || !state.pickup) return false;
    const plan = state.availability[state.date].algueblue.plans[state.plan];
    if (plan.options && plan.options.length && !state.option) return false;
    return true;
  }
  if (!state.start) return false;
  if (activityRequiresHeight() && !String(state.height || '').trim()) return false;
  return true;
}

async function submit() {
  if (activityUnderMaintenance()) return; // 停止対象は送信させない（防御）
  $('#submit-btn').disabled = true;
  $('#status').textContent = 'Sending…';
  const body = {
    activity: state.activity, date: state.date, people: state.people,
    name: state.name, email: state.email, phone: state.phone || '', note: state.note || '',
    plan: state.plan, option: state.option, start: state.start, height: state.height || '',
    pickup: state.pickup || '',
  };
  try {
    const res = await fetch(WEBAPP_URL + '?action=createBooking', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoid CORS preflight
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Booking failed');
    // 先払い制のアクティビティはここで approveUrl が返る＝PayPalの決済ページへ移動する。
    // 従来どおりのアクティビティは approveUrl が無いので、これまでと同じ完了画面を出す。
    if (data.approveUrl) {
      location.href = data.approveUrl;
      return;
    }
    showDone(data);
  } catch (err) {
    $('#status').textContent = 'Sorry — ' + err.message;
    $('#submit-btn').disabled = false;
  }
}

// PayPalでの支払い承認が完了し、booking.html に戻ってきた直後の画面。
// この時点ではまだ Webhook 側の確定処理（カレンダー確保）が完了しているとは限らないため、
// 「確認中」であることを伝える（過度な確約はしない）。
function showPaymentPendingConfirmation() {
  $('#form-body').hidden = true;
  $('#done').hidden = false;
  $('#done').innerHTML =
    '<div class="done-check">✓</div>' +
    '<h2>Payment received</h2>' +
    '<p class="muted">We are finalizing your booking now. You will receive a confirmation email within a few minutes.</p>' +
    '<p class="muted small">If you do not receive an email within 30 minutes, please contact ' +
    '<a href="mailto:comecomehimeji@gmail.com">comecomehimeji@gmail.com</a>.</p>';
}

// PayPalの決済ページで「キャンセル」して戻ってきた画面。支払いも予約枠の確保もされていない旨を明確にする。
function showPaymentCancelled() {
  $('#form-body').hidden = true;
  $('#done').hidden = false;
  $('#done').innerHTML =
    '<h2>Payment not completed</h2>' +
    '<p class="muted">No payment was taken and no time slot was held. Feel free to book again whenever you are ready.</p>' +
    '<a class="pay-btn" href="' + location.pathname + '">Back to booking form</a>';
}

function showDone(data) {
  $('#form-body').hidden = true;
  $('#done').hidden = false;
  const alg = isAlg();
  const heading = alg ? 'ご予約を受け付けました / Booking received' : 'Booking received';
  const refLine = (alg ? '予約番号 / Your reference: ' : 'Your reference is ') + '<b>' + esc(data.bookingId) + '</b>.';

  // お支払い金額（バックエンドから返れば優先、なければフロントで計算）。
  const amount = (data && Number(data.amount)) ? Number(data.amount) : bookingTotalYen();
  let payBlock = '';
  if (amount) {
    const label = (alg ? 'PayPalでお支払い / Pay with PayPal ' : 'Pay with PayPal ') + '¥' + amount.toLocaleString();
    payBlock =
      '<a class="pay-btn" href="' + PAYPAL_ME + amount + 'JPY" target="_blank" rel="noopener noreferrer">' + esc(label) + '</a>';
  }

  const note = alg
    ? '下の「PayPalでお支払い」ボタンからお支払いください。<strong>ご入金を確認しましたら、ご予約完了のご連絡をメールでお送りします。</strong>'
      + '<br><br>PayPalをお持ちでない方は、クレジットカードでもお支払いいただけます。カード払いをご希望の場合は、下記メールアドレスへご連絡ください。カード用のお支払いページをお送りします。'
      + '<br>ご不明な点も <a href="mailto:comecomehimeji@gmail.com">comecomehimeji@gmail.com</a> までご連絡ください。'
      + '<br><br>Please pay with the PayPal button below. Once we receive your payment, we will email you to confirm your booking.'
      + '<br>No PayPal account? You can also pay by credit or debit card. Just email us and we will send you a card payment page.'
      + '<br>Questions? Contact <a href="mailto:comecomehimeji@gmail.com">comecomehimeji@gmail.com</a>.'
    : 'Please pay with the PayPal button below. Once we receive your payment, we will email you to confirm your booking.'
      + '<br>No PayPal account? You can also pay by credit or debit card. Just email us and we will send you a card payment page.'
      + '<br>Questions? Contact <a href="mailto:comecomehimeji@gmail.com">comecomehimeji@gmail.com</a>.';

  // 当日（今日）のご予約に限り現地払いも可（時間が無く、PayPal未登録／請求書送付が間に合わない場合の救済）。
  const sameDayNote = isSameDay()
    ? (alg
        ? '<br><br><strong>当日のご予約に限り、当日現地でのお支払いも可能です。</strong>'
          + '<br>For same-day bookings, you may also pay on site.'
        : '<br><br>For same-day bookings, you may also pay on site.')
    : '';

  // 金額が取れなかった場合の保険：ボタンを出さず、リンクを別途お送りする案内にする。
  const fallbackNote = alg
    ? '<strong>お支払い用のPayPalリンクをメールでお送りします。</strong>ご入金の確認をもってご予約完了となります。'
      + '<br>We will email you a PayPal payment link. Your booking is complete once we receive your payment.'
    : 'We will email you a PayPal payment link. Your booking is complete once we receive your payment.';

  $('#done').innerHTML =
    '<div class="done-check">✓</div>' +
    '<h2>' + heading + '</h2>' +
    '<p>' + refLine + '</p>' +
    (payBlock
      ? '<p class="muted">' + note + sameDayNote + '</p>' + payBlock
      : '<p class="muted">' + fallbackNote + sameDayNote + '</p>');
}

document.addEventListener('DOMContentLoaded', () => {
  $('#submit-btn').addEventListener('click', submit);
  init();
});
