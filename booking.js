/* Unified booking form (Algueblue + cycling + Himeji castle).
 * Talks to the Apps Script Web App: GET ?action=availability / POST (text/plain JSON).
 * Deploy the Web App, then paste its /exec URL below. */
const WEBAPP_URL = 'https://script.google.com/macros/s/AKfycby0-dTBFpVt0MyulUePlrv4hzqTqSbLbKVI_n0fzlGGb48ZM4S-YkaDnI8uI8Iiw3w3/exec';

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
  plan: null, option: null, start: null,  // Algueblue
  slot: null,                              // tours
  people: 1,
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtDateLabel(dateStr, idx) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const rel = idx === 0 ? 'Today' : idx === 1 ? 'Tomorrow' : '';
  return (rel ? rel + ' · ' : '') + months[m - 1] + ' ' + d;
}

async function init() {
  // 今日・明日ページのカードから activity を引き継いで事前選択
  const preset = new URLSearchParams(location.search).get('activity');
  if (preset && ACTIVITIES.some((a) => a.code === preset)) state.activity = preset;
  renderActivities();
  try {
    const res = await fetch(WEBAPP_URL + '?action=availability', { cache: 'no-store' });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'load failed');
    state.availability = data.days;
    state.dates = Object.keys(data.days).sort();
    if (state.activity) { renderDates(); renderSummary(); } // 事前選択を反映
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
    b.onclick = () => { Object.assign(state, { activity: a.code, date: null, plan: null, option: null, start: null, slot: null }); renderActivities(); renderDates(); renderDetails(); renderSummary(); };
    wrap.appendChild(b);
  });
}

function activityKind() { const a = ACTIVITIES.find((x) => x.code === state.activity); return a ? a.kind : null; }

/* ---- Step 2: date ---- */
function renderDates() {
  const sec = $('#date-section');
  const wrap = $('#dates');
  wrap.innerHTML = '';
  if (!state.activity || !state.availability) { sec.hidden = true; return; }
  sec.hidden = false;
  state.dates.forEach((d, idx) => {
    const open = isDateOpen(d);
    const b = el('button', 'choice' + (state.date === d ? ' selected' : '') + (open ? '' : ' disabled'), fmtDateLabel(d, idx));
    b.type = 'button';
    b.disabled = !open;
    b.onclick = () => { Object.assign(state, { date: d, plan: null, option: null, start: null, slot: null }); renderDates(); renderDetails(); renderSummary(); };
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
  if (activityKind() === 'algueblue') renderAlgueblueDetails(sec);
  else renderTourDetails(sec);
  renderPeople(sec);
  renderContact(sec);
}

function renderAlgueblueDetails(sec) {
  const ab = state.availability[state.date].algueblue;
  sec.appendChild(el('h3', 'step-title', 'Choose a plan'));
  const planWrap = el('div', 'choices');
  Object.keys(ab.plans).forEach((key) => {
    const p = ab.plans[key];
    if (!p.open) return;
    const b = el('button', 'choice plan' + (state.plan === key ? ' selected' : ''),
      '<strong>' + esc(p.name) + '</strong><span class="muted">¥' + Number(p.price).toLocaleString() + '</span>');
    b.type = 'button';
    b.onclick = () => { Object.assign(state, { plan: key, option: null, start: null }); renderDetails(); renderSummary(); };
    planWrap.appendChild(b);
  });
  if (!planWrap.children.length) planWrap.appendChild(el('p', 'muted', 'No plan available on this date.'));
  sec.appendChild(planWrap);
  if (!state.plan) return;

  const plan = ab.plans[state.plan];
  if (plan.options && plan.options.length) {
    sec.appendChild(el('h3', 'step-title', 'Course'));
    const ow = el('div', 'choices');
    plan.options.forEach((o) => {
      const b = el('button', 'choice' + (state.option === o ? ' selected' : ''), esc(o));
      b.type = 'button';
      b.onclick = () => { state.option = o; renderDetails(); renderSummary(); };
      ow.appendChild(b);
    });
    sec.appendChild(ow);
  }

  sec.appendChild(el('h3', 'step-title', 'Start time'));
  const tw = el('div', 'choices times');
  (plan.starts || []).forEach((t) => {
    const b = el('button', 'choice time' + (state.start === t ? ' selected' : ''), esc(t));
    b.type = 'button';
    b.onclick = () => { state.start = t; renderDetails(); renderSummary(); };
    tw.appendChild(b);
  });
  if (!(plan.starts || []).length) tw.appendChild(el('p', 'muted', 'No open start times.'));
  sec.appendChild(tw);
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
  sec.appendChild(el('h3', 'step-title', 'Number of people'));
  const row = el('div', 'people-row');
  const input = el('input'); input.type = 'number'; input.min = '1'; input.max = '20'; input.value = state.people;
  input.oninput = () => { state.people = Math.max(1, Number(input.value) || 1); renderSummary(); };
  row.appendChild(input);
  sec.appendChild(row);
}

function renderContact(sec) {
  sec.appendChild(el('h3', 'step-title', 'Your details'));
  const fields = [
    ['name', 'Full name *', 'text'],
    ['email', 'Email *', 'email'],
    ['phone', 'Phone', 'tel'],
    ['note', 'Note (optional)', 'text'],
  ];
  fields.forEach(([key, label, type]) => {
    const f = el('label', 'field');
    f.appendChild(el('span', 'field-label', label));
    const input = el('input'); input.type = type; input.id = 'f-' + key; input.value = state[key] || '';
    input.oninput = () => { state[key] = input.value; };
    f.appendChild(input);
    sec.appendChild(f);
  });
}

/* ---- Summary + submit ---- */
function renderSummary() {
  const sec = $('#summary-section');
  const ready = isReady();
  sec.hidden = !state.activity || !state.date;
  const a = ACTIVITIES.find((x) => x.code === state.activity);
  const lines = [];
  if (a) lines.push(['Activity', a.label]);
  if (state.date) lines.push(['Date', state.date]);
  if (activityKind() === 'algueblue' && state.plan) {
    const p = state.availability[state.date].algueblue.plans[state.plan];
    lines.push(['Plan', p.name + (state.option ? ' (' + state.option + ')' : '')]);
  }
  if (state.start) lines.push(['Start', state.start]);
  lines.push(['People', state.people]);
  $('#summary').innerHTML = lines.map(([k, v]) => '<div class="sum-row"><span>' + esc(k) + '</span><b>' + esc(v) + '</b></div>').join('');
  $('#submit-btn').disabled = !ready;
}

function isReady() {
  if (!state.activity || !state.date || !state.people) return false;
  if (!state.name || !state.email) return false;
  if (activityKind() === 'algueblue') {
    if (!state.plan || !state.start) return false;
    const plan = state.availability[state.date].algueblue.plans[state.plan];
    if (plan.options && plan.options.length && !state.option) return false;
    return true;
  }
  return !!state.start;
}

async function submit() {
  $('#submit-btn').disabled = true;
  $('#status').textContent = 'Sending…';
  const body = {
    activity: state.activity, date: state.date, people: state.people,
    name: state.name, email: state.email, phone: state.phone || '', note: state.note || '',
    plan: state.plan, option: state.option, start: state.start, slot: state.slot,
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
  $('#done').innerHTML =
    '<div class="done-check">✓</div>' +
    '<h2>Booking confirmed</h2>' +
    '<p>Your booking ID is <b>' + esc(data.bookingId) + '</b>.</p>' +
    '<p class="muted">We look forward to seeing you. Payment is made on site.</p>';
}

document.addEventListener('DOMContentLoaded', () => {
  $('#submit-btn').addEventListener('click', submit);
  init();
});
