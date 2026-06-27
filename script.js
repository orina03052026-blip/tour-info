const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/1Lyl_tjTHza8Wfp2WiDepi_ZTY_Xo6Xqpuhgog-lufFY/export?format=csv&gid=0';

// Algueblue（Thalassotherapy Spa）の空き状況は予約用 Web App の doGet から取得する。
// booking.js と同じ /exec URL を貼ること（未設定なら Algueblue カードは出ない）。
const WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbyL_cqU6-SkSg7yNXCSterbVFVM4lPp8d6W4mJQyvXKSh7Qqu2Njsr_pPz11v8rvJw/exec';
const ALGUEBLUE_NAME = 'Thalassotherapy Spa';

const TOURS = [
  {
    name: 'e-bike Ride around the Castle, Slurp Like a Local',
    code: 'ebike-castle',  // 予約フォーム(booking.html)の activity コード
    url: 'https://www.travel-network-act.co.jp/local/en/castle-town/',
    capacity: 4,
    weatherSensitive: true  // 雨天中止で非表示にする自転車ツアー
  },
  {
    name: 'e-bike Ride to the Sea, Slurp Like a Local',
    code: 'ebike-sea',
    url: 'https://www.travel-network-act.co.jp/local/en/tour-from-the-shikama-kaido-to-the-sea/',
    capacity: 4,
    weatherSensitive: true  // 雨天中止で非表示にする自転車ツアー
  },
  {
    name: 'Himeji castle guide tour',
    code: 'castle-guide',
    url: 'https://www.travel-network-act.co.jp/local/en/himeji-castle-guide-personal-tour/',
    capacity: 8  // 徒歩ガイド。雨天でも催行するので weatherSensitive は付けない
  }
];

// 予約はすべて統一フォーム booking.html へ（activity と date を事前選択して二度手間を防ぐ）
const BOOKING_FORM_URL = 'booking.html';
function bookingUrlFor(code, date) {
  const params = [];
  if (code) params.push('activity=' + encodeURIComponent(code));
  if (date) params.push('date=' + encodeURIComponent(date));
  return params.length ? `${BOOKING_FORM_URL}?${params.join('&')}` : BOOKING_FORM_URL;
}

const REQUIRED_HEADERS = ['Date', 'Staff', 'Time Slot', 'Status', 'Tour', 'Booked', 'Capacity', 'Notes'];
const TIME_SLOTS = ['AM', 'PM'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field);
        field = '';
      } else if (ch === '\r') {
        continue;
      } else if (ch === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else {
        field += ch;
      }
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function csvToObjects(rawRows) {
  if (rawRows.length === 0) return { headers: [], rows: [] };
  const headers = rawRows[0].map(h => h.trim());
  const rows = rawRows.slice(1)
    .filter(r => r.some(c => c && c.trim() !== ''))
    .map(r => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = (r[i] || '').trim(); });
      return obj;
    });
  return { headers, rows };
}

function getJstParts() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date()).map(p => [p.type, p.value])
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: parseInt(parts.hour, 10),
    minute: parseInt(parts.minute, 10)
  };
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function formatDateLabel(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[m - 1]} ${d}`;
}

function statusInfo(remaining) {
  if (remaining <= 0) return { text: 'Fully booked', className: 'status-fully' };
  if (remaining === 1) return { text: 'Only 1 seat left', className: 'status-warning' };
  if (remaining === 2) return { text: 'Only 2 seats left', className: 'status-warning' };
  return { text: 'Available', className: 'status-available' };
}

function findTour(name) {
  return TOURS.find(t => t.name === name);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// 各ツアーの手描き風イラスト（インラインSVG・外部画像なし）
const BIKE_SVG = `
    <g class="anim-bike" stroke="#3a4a5a" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round">
      <g class="anim-wheel"><circle cx="7" cy="17" r="7.5"/><path d="M7 11 L7 23 M1 17 L13 17 M2.6 12.6 L11.4 21.4 M2.6 21.4 L11.4 12.6" stroke-width="1.2"/></g>
      <g class="anim-wheel"><circle cx="29" cy="17" r="7.5"/><path d="M29 11 L29 23 M23 17 L35 17 M24.6 12.6 L33.4 21.4 M24.6 21.4 L33.4 12.6" stroke-width="1.2"/></g>
      <path d="M7 17 L18 17 L14 7 M18 17 L25 7 L29 17 M14 7 L26 7"/>
      <path d="M26 7 L30 5"/>
      <circle cx="18" cy="17" r="1.4" fill="#3a4a5a" stroke="none"/>
    </g>`;

const CASTLE_BIKE_SVG = `
<svg viewBox="0 0 96 60" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <g transform="translate(10,8)">
    <polygon points="5,42 33,42 29,31 9,31" fill="#c9d4dc"/>
    <rect x="10" y="20" width="18" height="11" fill="#ffffff"/>
    <rect x="13" y="23" width="3.5" height="7" rx="1" fill="#bcd0db"/>
    <rect x="21" y="23" width="3.5" height="7" rx="1" fill="#bcd0db"/>
    <polygon points="3,21 19,10 35,21" fill="#356f95"/>
    <rect x="2" y="19.5" width="34" height="2.6" rx="1.2" fill="#2b5c7d"/>
    <rect x="15" y="11" width="8" height="9" fill="#ffffff"/>
    <polygon points="9,12 19,3.5 29,12" fill="#356f95"/>
    <rect x="8" y="10.6" width="22" height="2.2" rx="1" fill="#2b5c7d"/>
    <circle cx="19" cy="3.6" r="1.6" fill="#f1b434"/>
  </g>
  <g transform="translate(54,26)">${BIKE_SVG}</g>
</svg>`;

const SEA_BIKE_SVG = `
<svg viewBox="0 0 96 60" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <circle class="anim-sun" cx="80" cy="14" r="8" fill="#f6c453"/>
  <g transform="translate(22,12)">${BIKE_SVG}</g>
  <g class="anim-waves">
    <path d="M-10 42 Q2 36 14 42 T38 42 T62 42 T86 42 T110 42 L110 60 L-10 60 Z" fill="#5ec5d6"/>
    <path d="M-10 49 Q2 44 14 49 T38 49 T62 49 T86 49 T110 49 L110 60 L-10 60 Z" fill="#38a9bd"/>
  </g>
</svg>`;

const CASTLE_GUIDE_SVG = `
<svg viewBox="0 0 96 60" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <g transform="translate(8,10)">
    <polygon points="5,40 33,40 29,30 9,30" fill="#c9d4dc"/>
    <rect x="10" y="20" width="18" height="10" fill="#ffffff"/>
    <rect x="13" y="22.5" width="3.5" height="6.5" rx="1" fill="#bcd0db"/>
    <rect x="21" y="22.5" width="3.5" height="6.5" rx="1" fill="#bcd0db"/>
    <polygon points="3,21 19,11 35,21" fill="#356f95"/>
    <rect x="2" y="19.5" width="34" height="2.5" rx="1.2" fill="#2b5c7d"/>
    <rect x="15" y="12" width="8" height="8" fill="#ffffff"/>
    <polygon points="9,13 19,5 29,13" fill="#356f95"/>
    <rect x="8" y="11.6" width="22" height="2.2" rx="1" fill="#2b5c7d"/>
    <circle cx="19" cy="5" r="1.5" fill="#f1b434"/>
  </g>
  <g transform="translate(60,14)">
    <g class="anim-person">
      <rect x="16.4" y="2" width="1.6" height="11" rx="0.6" fill="#8a6d3b"/>
      <path class="anim-flag" d="M18 2.4 L25 4.6 L18 6.8 Z" fill="#e0524d"/>
      <path d="M2 32 L2 18 Q2 12 8 12 Q14 12 14 18 L14 32 Z" fill="#e07a5f"/>
      <rect x="3" y="31" width="5" height="9" rx="2" fill="#3a4a5a"/>
      <rect x="9" y="31" width="5" height="9" rx="2" fill="#3a4a5a"/>
      <path d="M11 17 L17 7" stroke="#e07a5f" stroke-width="3.4" stroke-linecap="round"/>
      <circle cx="17" cy="6" r="1.8" fill="#f4c9a4"/>
      <circle cx="8" cy="7" r="5" fill="#f4c9a4"/>
      <path d="M3 7.5 Q8 1.5 13 7.5 Q13 3 8 2 Q3 3 3 7.5 Z" fill="#5a4632"/>
    </g>
  </g>
</svg>`;

const TOUR_VISUALS = {
  'e-bike Ride around the Castle, Slurp Like a Local': { cls: 'illus-castle', svg: CASTLE_BIKE_SVG },
  'e-bike Ride to the Sea, Slurp Like a Local': { cls: 'illus-sea', svg: SEA_BIKE_SVG },
  'Himeji castle guide tour': { cls: 'illus-guide', svg: CASTLE_GUIDE_SVG }
};

// Algueblue スパ用のイラスト（海藻＝algue を思わせる葉＋雫）
const ALGUEBLUE_SVG = `
<svg viewBox="0 0 96 60" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <g transform="translate(30,6)" fill="none" stroke="#2b8a7d" stroke-width="2.4" stroke-linecap="round">
    <path class="anim-leaf" d="M18 46 C18 30 10 22 4 14 C14 16 20 24 18 38"/>
    <path class="anim-leaf" d="M18 46 C18 28 26 20 33 12 C24 16 18 24 18 38"/>
    <path d="M18 46 L18 30"/>
  </g>
  <circle class="anim-drop" cx="64" cy="20" r="4.5" fill="#5ec5d6"/>
  <circle class="anim-drop" cx="74" cy="32" r="3" fill="#38a9bd"/>
</svg>`;

// Algueblue は1日1枚・AM/PM 縛りなし。受付可(Available)／満席(Fully booked)の2状態。
function renderAlgueblueCard(open, date) {
  const status = open
    ? { text: 'Available', className: 'status-available' }
    : { text: 'Fully booked', className: 'status-fully' };
  const fullyClass = open ? '' : ' fully-booked';
  return `
    <div class="tour-card${fullyClass}">
      <div class="tour-name">${escapeHtml(ALGUEBLUE_NAME)}</div>
      <span class="tour-status ${status.className}">${status.text}</span>
      <div class="tour-illustration illus-spa">${ALGUEBLUE_SVG}</div>
      <a class="tour-button" href="${escapeHtml(bookingUrlFor('algueblue', date))}" target="_blank" rel="noopener noreferrer">Book Now!</a>
    </div>
  `;
}

// その日の Algueblue ブロック（AM/PM とは別枠で1枚）。availability 未取得 or 休業日は出さない。
function renderAlgueblueBlock(dateStr, algueblue) {
  if (!algueblue || !algueblue[dateStr]) return '';
  const ab = algueblue[dateStr].algueblue;
  if (!ab || ab.closed) return '';
  return `
    <div class="timeslot timeslot-spa">
      <div class="timeslot-label">Thalassotherapy Spa</div>
      ${renderAlgueblueCard(!!ab.anyOpen, dateStr)}
    </div>
  `;
}

// 予約用 Web App から今日・明日の Algueblue 空きを取得（失敗してもツアー表示は壊さない）
async function fetchAlgueblue() {
  if (!WEBAPP_URL || WEBAPP_URL.indexOf('PASTE_') === 0) return null;
  try {
    const res = await fetch(`${WEBAPP_URL}?action=availability&t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data && data.ok ? data.days : null;
  } catch (err) {
    console.warn('Algueblue availability unavailable:', err);
    return null;
  }
}

function processRows(rows) {
  const seen = new Set();
  const slots = new Map();

  for (const row of rows) {
    const date = row.Date;
    const staff = row.Staff;
    const ts = row['Time Slot'];
    const status = row.Status;
    const tour = row.Tour;
    const bookedRaw = row.Booked;

    if (!date) continue;

    if (!DATE_RE.test(date)) {
      console.warn(`Invalid Date format "${date}" (expected YYYY-MM-DD). Row skipped.`);
      continue;
    }

    if (status === 'Off' || !status) continue;

    if (status !== 'Available') {
      console.warn(`Unknown Status "${status}" for ${date} ${staff} ${ts}. Row skipped.`);
      continue;
    }

    if (!TIME_SLOTS.includes(ts)) {
      console.warn(`Invalid Time Slot "${ts}" for ${date} ${staff}. Row skipped.`);
      continue;
    }

    const dupKey = `${date}|${staff}|${ts}`;
    if (seen.has(dupKey)) {
      console.warn(`Duplicate row ignored: ${dupKey}`);
      continue;
    }
    seen.add(dupKey);

    const booked = parseInt(bookedRaw, 10) || 0;

    if (booked > 0 && !tour) {
      console.error(`Tour required when Booked > 0: ${dupKey}. Row skipped.`);
      continue;
    }

    const slotKey = `${date}|${ts}`;
    if (!slots.has(slotKey)) {
      slots.set(slotKey, { booked: [], unbookedCount: 0, ebikeClosed: false });
    }
    const slot = slots.get(slotKey);

    // 雨天中止マーカー（Apps Script が Notes に付与）。e-bike ツアーだけ非表示にする。
    if ((row.Notes || '').includes('EBIKE_CLOSED')) {
      slot.ebikeClosed = true;
    }

    if (booked > 0) {
      const tourDef = findTour(tour);
      if (!tourDef) {
        console.error(`Unknown Tour "${tour}" at ${dupKey}. Row skipped.`);
        continue;
      }
      slot.booked.push({ tour: tourDef, remaining: tourDef.capacity - booked });
    } else {
      slot.unbookedCount++;
    }
  }

  return slots;
}

function buildCardsForSlot(slot) {
  const cards = [];
  if (!slot) return cards;
  for (const b of slot.booked) cards.push(b);
  if (slot.unbookedCount > 0) {
    for (const t of TOURS) {
      if (slot.ebikeClosed && t.weatherSensitive) continue;  // 雨天中止枠は e-bike を出さない
      cards.push({ tour: t, remaining: t.capacity });
    }
  }
  return cards;
}

function renderTourCard({ tour, remaining }, date) {
  const status = statusInfo(remaining);
  const fullyClass = remaining <= 0 ? ' fully-booked' : '';
  const v = TOUR_VISUALS[tour.name];
  const illustration = v ? `<div class="tour-illustration ${v.cls}">${v.svg}</div>` : '';
  return `
    <div class="tour-card${fullyClass}">
      <div class="tour-name">${escapeHtml(tour.name)}</div>
      <span class="tour-status ${status.className}">${status.text}</span>
      ${illustration}
      <a class="tour-button" href="${escapeHtml(bookingUrlFor(tour.code, date))}" target="_blank" rel="noopener noreferrer">Book Now!</a>
    </div>
  `;
}

function renderTimeSlot(label, cards, date) {
  if (cards.length === 0) {
    return `
      <div class="timeslot">
        <div class="timeslot-label">${label}</div>
        <div class="no-tours-in-slot">No tours available</div>
      </div>
    `;
  }
  return `
    <div class="timeslot">
      <div class="timeslot-label">${label}</div>
      ${cards.map(c => renderTourCard(c, date)).join('')}
    </div>
  `;
}

function render(slots, algueblue) {
  const jst = getJstParts();
  const today = jst.date;
  const tomorrow = addDays(today, 1);
  const hideTodayAM = (jst.hour > 9) || (jst.hour === 9 && jst.minute >= 30);

  const days = [
    { date: today, label: 'Today', tomorrow: false, hideAM: hideTodayAM },
    { date: tomorrow, label: 'Tomorrow', tomorrow: true, hideAM: false }
  ];

  const html = days.map(d => {
    const amSlot = slots.get(`${d.date}|AM`);
    const pmSlot = slots.get(`${d.date}|PM`);
    const amCards = d.hideAM ? null : buildCardsForSlot(amSlot);
    const pmCards = buildCardsForSlot(pmSlot);

    let body = '';
    if (amCards !== null) body += renderTimeSlot('Morning (AM)', amCards, d.date);
    body += renderTimeSlot('Afternoon (PM)', pmCards, d.date);
    body += renderAlgueblueBlock(d.date, algueblue);

    return `
      <div class="day-card">
        <div class="day-header${d.tomorrow ? ' tomorrow' : ''}">
          <div class="day-label">${d.label}</div>
          <div class="day-date">${formatDateLabel(d.date)}</div>
        </div>
        ${body}
      </div>
    `;
  }).join('');

  document.getElementById('container').innerHTML = `<div class="day-grid">${html}</div>`;
}

function showError() {
  document.getElementById('container').innerHTML =
    `<div class="empty-message">No tours available</div>`;
}

async function loadData() {
  try {
    const res = await fetch(`${SHEET_CSV_URL}&t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const rawRows = parseCSV(text);
    if (rawRows.length === 0) throw new Error('Empty CSV');

    const headers = rawRows[0].map(h => h.trim());
    const missing = REQUIRED_HEADERS.filter(h => !headers.includes(h));
    if (missing.length > 0) {
      throw new Error(`CSV header mismatch. Missing: ${missing.join(', ')}`);
    }

    const { rows } = csvToObjects(rawRows);
    const slots = processRows(rows);
    const algueblue = await fetchAlgueblue();
    render(slots, algueblue);
  } catch (err) {
    console.error('Failed to load tour data:', err);
    showError();
  }
}

loadData();
