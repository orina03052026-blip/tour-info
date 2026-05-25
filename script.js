const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/1Lyl_tjTHza8Wfp2WiDepi_ZTY_Xo6Xqpuhgog-lufFY/export?format=csv&gid=0';

const TOURS = [
  {
    name: 'e-bike Ride around the Castle, Slurp Like a Local',
    url: 'https://www.travel-network-act.co.jp/local/en/castle-town/',
    capacity: 4,
    weatherSensitive: true  // 雨天中止で非表示にする自転車ツアー
  },
  {
    name: 'e-bike Ride to the Sea, Slurp Like a Local',
    url: 'https://www.travel-network-act.co.jp/local/en/tour-from-the-shikama-kaido-to-the-sea/',
    capacity: 4,
    weatherSensitive: true  // 雨天中止で非表示にする自転車ツアー
  },
  {
    name: 'Himeji castle guide tour',
    url: 'https://www.travel-network-act.co.jp/local/en/himeji-castle-guide-personal-tour/',
    capacity: 8  // 徒歩ガイド。雨天でも催行するので weatherSensitive は付けない
  }
];

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

function renderTourCard({ tour, remaining }) {
  const status = statusInfo(remaining);
  const fullyClass = remaining <= 0 ? ' fully-booked' : '';
  return `
    <div class="tour-card${fullyClass}">
      <div class="tour-name">${escapeHtml(tour.name)}</div>
      <span class="tour-status ${status.className}">${status.text}</span>
      <a class="tour-button" href="${escapeHtml(tour.url)}" target="_blank" rel="noopener noreferrer">View Tour Details</a>
    </div>
  `;
}

function renderTimeSlot(label, cards) {
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
      ${cards.map(renderTourCard).join('')}
    </div>
  `;
}

function render(slots) {
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
    if (amCards !== null) body += renderTimeSlot('Morning (AM)', amCards);
    body += renderTimeSlot('Afternoon (PM)', pmCards);

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
    render(slots);
  } catch (err) {
    console.error('Failed to load tour data:', err);
    showError();
  }
}

loadData();
