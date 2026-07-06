/* Unified booking form (Algueblue + cycling + Himeji castle).
 * Talks to the Apps Script Web App: GET ?action=availability / POST (text/plain JSON).
 * Deploy the Web App, then paste its /exec URL below. */
const WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbyL_cqU6-SkSg7yNXCSterbVFVM4lPp8d6W4mJQyvXKSh7Qqu2Njsr_pPz11v8rvJw/exec';

const ACTIVITIES = [
  { code: 'algueblue',    label: 'Thalassotherapy Spa (Algueblue)', kind: 'algueblue' },
  { code: 'ebike-castle', label: 'e-bike Ride around the Castle',    kind: 'tour' },
  { code: 'ebike-sea',    label: 'e-bike Ride to the Sea',          kind: 'tour' },
  { code: 'castle-guide', label: 'Himeji Castle Guide Tour',         kind: 'tour' },
];

const state = {
  availability: null,   // { 'YYYY-MM-DD': { algueblue, tours } }
  dates: [],            // ordered date strings (today, tomorrow)
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

// 共有の静的テキスト（日付選択・Summary・確定ボタン等）を、選択中アクティビティに合わせて切替。
function updateChrome() {
  const alg = isAlg();
  const dateH = document.querySelector('#date-section .step-title');
  if (dateH) dateH.textContent = alg ? '日付を選択 / Choose a date' : 'Choose a date';
  const sumH = document.querySelector('#summary-section .step-title');
  if (sumH) sumH.textContent = alg ? 'ご予約内容 / Summary' : 'Summary';
  const btn = $('#submit-btn');
  if (btn) btn.textContent = alg ? '予約する / Confirm booking' : 'Confirm booking';
  const pay = document.querySelector('#summary-section .muted.small');
  if (pay) pay.textContent = alg
    ? '今のお支払いはありません（当日現地払い）。 / No payment is taken now — you pay on site.'
    : 'No payment is taken now — you pay on site.';
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
  // 今日・明日ページのカードから activity / date を引き継いで事前選択（日付の選び直しを省く）
  const qs = new URLSearchParams(location.search);
  const preset = qs.get('activity');
  if (preset && ACTIVITIES.some((a) => a.code === preset)) state.activity = preset;
  state.presetDate = qs.get('date') || null;
  renderActivities();
  try {
    const res = await fetch(WEBAPP_URL + '?action=availability', { cache: 'no-store' });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'load failed');
    state.availability = data.days;
    state.dates = Object.keys(data.days).sort();
    // 事前選択を反映。date も渡されていて受付可なら選択し、開始時刻の選択へ直行
    if (state.activity && state.presetDate && state.dates.indexOf(state.presetDate) !== -1) {
      state.date = state.presetDate;
      if (!isDateOpen(state.date)) state.date = null; // 満席/休業なら日付選択に戻す
    }
    if (state.activity) { renderDates(); renderDetails(); renderSummary(); }
  } catch (err) {
    $('#status').textContent = 'Could not load availability. Please try again later.';
    console.error(err);
  }
}

/* ---- Step 1: activity ---- */
function renderActivities() {
  const wrap = $('#activities');
  wrap.innerHTML = '';
  ACTIVITIES.forEach((a) => {
    const b = el('button', 'choice' + (state.activity === a.code ? ' selected' : ''), esc(a.label));
    b.type = 'button';
    b.onclick = () => { Object.assign(state, { activity: a.code, date: null, plan: null, option: null, start: null, pickup: null, height: '' }); renderActivities(); renderDates(); renderDetails(); renderSummary(); };
    wrap.appendChild(b);
  });
}

function activityKind() { const a = ACTIVITIES.find((x) => x.code === state.activity); return a ? a.kind : null; }

/* ---- Step 2: date ---- */
function renderDates() {
  const sec = $('#date-section');
  const wrap = $('#dates');
  wrap.innerHTML = '';
  updateChrome();
  if (!state.activity || !state.availability) { sec.hidden = true; return; }
  sec.hidden = false;
  state.dates.forEach((d, idx) => {
    const open = isDateOpen(d);
    const b = el('button', 'choice' + (state.date === d ? ' selected' : '') + (open ? '' : ' disabled'), fmtDateLabel(d, idx));
    b.type = 'button';
    b.disabled = !open;
    b.onclick = () => { Object.assign(state, { date: d, plan: null, option: null, start: null, pickup: null }); renderDates(); renderDetails(); renderSummary(); };
    wrap.appendChild(b);
  });
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
  const input = el('input'); input.type = 'number'; input.min = '1'; input.max = '20'; input.value = state.people;
  input.oninput = () => { state.people = Math.max(1, Number(input.value) || 1); renderSummary(); };
  row.appendChild(input);
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
  $('#summary').innerHTML = lines.map(([k, v]) => '<div class="sum-row"><span>' + esc(k) + '</span><b>' + esc(v) + '</b></div>').join('');
  $('#submit-btn').disabled = !ready;
}

function isReady() {
  if (!state.activity || !state.date || !state.people) return false;
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
  $('#submit-btn').disabled = true;
  $('#status').textContent = 'Sending…';
  const body = {
    activity: state.activity, date: state.date, people: state.people,
    name: state.name, email: state.email, phone: state.phone || '', note: state.note || '',
    plan: state.plan, option: state.option, start: state.start, height: state.height || '',
    pickup: state.pickup || '',
  };
  try {
    const res = await fetch(WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoid CORS preflight
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Booking failed');
    showDone(data);
  } catch (err) {
    $('#status').textContent = 'Sorry — ' + err.message;
    $('#submit-btn').disabled = false;
  }
}

function showDone(data) {
  $('#form-body').hidden = true;
  $('#done').hidden = false;
  const alg = isAlg();
  const heading = alg ? 'ご予約を受け付けました / Booking request received' : 'Booking request received';
  const refLine = (alg ? '予約番号 / Your reference: ' : 'Your reference is ') + '<b>' + esc(data.bookingId) + '</b>.';
  const note = alg
    ? '枠をお取りしています。まもなくメールで確定のご連絡をします。お支払いは当日現地払いです。<br>We are holding your slot and will confirm by email shortly. Payment is made on site.'
    : 'We are holding your slot and will confirm by email shortly. Payment is made on site.';
  $('#done').innerHTML =
    '<div class="done-check">✓</div>' +
    '<h2>' + heading + '</h2>' +
    '<p>' + refLine + '</p>' +
    '<p class="muted">' + note + '</p>';
}

document.addEventListener('DOMContentLoaded', () => {
  $('#submit-btn').addEventListener('click', submit);
  init();
});
