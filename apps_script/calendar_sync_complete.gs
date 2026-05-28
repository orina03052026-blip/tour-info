/**
 * Google Calendar / Bokun -> Availability sync for Google Apps Script.
 * 
 * This script syncs Google Calendar events with the Availability spreadsheet.
 * 
 * Installation:
 * 1. Open Google Sheet: https://docs.google.com/spreadsheets/d/1Lyl_tjTHza8Wfp2WiDepi_ZTY_Xo6Xqpuhgog-lufFY/edit
 * 2. Go to Extensions > Apps Script
 * 3. Copy and paste this entire script
 * 4. Save
 * 5. Run onOpen() function first (to add menu)
 * 6. Run syncCalendarToSheet() to perform initial sync
 * 7. Set up trigger: Triggers (left menu) > Create new trigger > choose syncCalendarToSheet, time-driven, every hour
 */

const CONFIG = {
  calendarId: 'comecomehimeji@gmail.com', // 共有カレンダーID
  timeZone: 'Asia/Tokyo',
  availabilitySheetName: 'Availability',
  syncDays: 365,
  staffPriority: ['Kana', 'Sho'],
  staff: {
    Kana: {
      aliases: ['Kana', '畑中'],
      calendarMode: 'availability', // 'availability': if event exists = Available, else Off
    },
    Sho: {
      aliases: ['Sho', '砂川'],
      calendarMode: 'offOnly', // 'offOnly': if "Off" event exists = Off, else Available
    },
  },
  slotWindows: {
    AM: { start: '09:30', end: '12:30' },
    PM: { start: '13:30', end: '17:00' },
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
};

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Sync')
    .addItem('Sync Calendar Now', 'syncCalendarToSheet')
    .addSeparator()
    .addItem('View Logs', 'showLogs')
    .addToUi();
  console.log('Menu added');
}

function syncCalendarToSheet() {
  try {
    const sheet = SpreadsheetApp.openById('1Lyl_tjTHza8Wfp2WiDepi_ZTY_Xo6Xqpuhgog-lufFY')
      .getSheetByName(CONFIG.availabilitySheetName);
    
    if (!sheet) throw new Error(`Sheet "${CONFIG.availabilitySheetName}" not found`);

    const data = sheet.getDataRange().getValues();
    if (data.length < 2) throw new Error('Sheet is empty or has no header');

    const today = new Date();
    const syncStartDate = new Date(today);
    const syncEndDate = new Date(today);
    syncEndDate.setDate(syncEndDate.getDate() + CONFIG.syncDays);

    console.log(`Sync period: ${syncStartDate.toISOString().split('T')[0]} to ${syncEndDate.toISOString().split('T')[0]}`);

    // Fetch calendar events for each staff
    const calendarEvents = {};
    for (const [staffName, staffConfig] of Object.entries(CONFIG.staff)) {
      calendarEvents[staffName] = fetchCalendarEvents(staffName, staffConfig, syncStartDate, syncEndDate);
    }

    console.log(`Fetched events for: ${Object.keys(calendarEvents).join(', ')}`);

    // Update rows
    let updatedCount = 0;
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const dateStr = row[0];
      const staff = row[1];
      const timeSlot = row[2];
      const manualLock = row[9];

      if (!dateStr || !staff || !timeSlot) continue;
      if (manualLock === 'TRUE') continue; // Skip manually locked rows

      const dateKey = typeof dateStr === 'string'
        ? dateStr.split('T')[0]
        : Utilities.formatDate(dateStr, CONFIG.timeZone, 'yyyy-MM-dd');

      const newStatus = determineStatus(staff, timeSlot, dateKey, calendarEvents, CONFIG);
      const oldStatus = row[3];

      if (newStatus !== oldStatus) {
        data[i][3] = newStatus;
        data[i][8] = 'Calendar'; // Source
        updatedCount++;
        console.log(`Updated: ${dateKey} ${staff} ${timeSlot} -> ${newStatus}`);
      }
    }

    // Write back to sheet
    sheet.getDataRange().setValues(data);
    console.log(`Sync complete. Updated ${updatedCount} rows.`);
  } catch (e) {
    console.error(`Error in syncCalendarToSheet: ${e.message}`);
    throw e;
  }
}

function fetchCalendarEvents(staffName, staffConfig, startDate, endDate) {
  const events = {};
  
  try {
    // 共有カレンダーにアクセス
    let calendar = null;
    try {
      calendar = CalendarApp.getCalendarById(CONFIG.calendarId);
    } catch (e) {
      console.error(`Cannot access shared calendar: ${e.message}`);
      return events;
    }

    if (!calendar) {
      console.warn(`Shared calendar not found: ${CONFIG.calendarId}`);
      return events;
    }

    const calendarEvents = calendar.getEvents(startDate, endDate);
    console.log(`Found ${calendarEvents.length} events in shared calendar`);

    // イベントをスタッフごとに振り分け
    for (const event of calendarEvents) {
      const eventTitle = event.getTitle();
      const eventStartTime = event.getStartTime();
      const eventEndTime = event.getEndTime();
      const dateKey = Utilities.formatDate(eventStartTime, CONFIG.timeZone, 'yyyy-MM-dd');

      // イベントタイトルにスタッフ名が含まれているか確認
      const belongsToStaff = staffConfig.aliases.some(alias =>
        new RegExp(alias, 'i').test(eventTitle)
      );

      if (!belongsToStaff) continue; // このスタッフのイベントではない

      // Initialize date if needed
      if (!events[dateKey]) events[dateKey] = { AM: null, PM: null, isOff: false };

      // "Off" イベントか確認
      if (/OFF|休|休み|休業|お休み/.test(eventTitle)) {
        events[dateKey].isOff = true;
        console.log(`${dateKey} ${staffName}: marked as Off`);
      } else {
        // 実際の出勤時間をチェック（タイトルまたはイベント時間から）
        const hasAM = checkTimeOverlap(eventStartTime, eventEndTime, '09:30', '12:30');
        const hasPM = checkTimeOverlap(eventStartTime, eventEndTime, '13:30', '17:00');

        if (hasAM) {
          events[dateKey].AM = true;
          console.log(`${dateKey} ${staffName} AM: Available`);
        }
        if (hasPM) {
          events[dateKey].PM = true;
          console.log(`${dateKey} ${staffName} PM: Available`);
        }
      }
    }

    console.log(`Processed ${Object.keys(events).length} dates for ${staffName}`);
  } catch (e) {
    console.error(`Error fetching calendar for ${staffName}: ${e.message}`);
  }

  return events;
}

function checkTimeOverlap(eventStart, eventEnd, windowStart, windowEnd) {
  const [sHour, sMin] = windowStart.split(':').map(Number);
  const [eHour, eMin] = windowEnd.split(':').map(Number);
  
  const eventStartHour = eventStart.getHours();
  const eventStartMin = eventStart.getMinutes();
  const eventEndHour = eventEnd.getHours();
  const eventEndMin = eventEnd.getMinutes();
  
  const windowStartMinutes = sHour * 60 + sMin;
  const windowEndMinutes = eHour * 60 + eMin;
  const eventStartMinutes = eventStartHour * 60 + eventStartMin;
  const eventEndMinutes = eventEndHour * 60 + eventEndMin;
  
  return eventStartMinutes < windowEndMinutes && eventEndMinutes > windowStartMinutes;
}


function determineStatus(staffName, timeSlot, dateKey, calendarEvents, config) {
  const staffConfig = config.staff[staffName];
  if (!staffConfig) return 'Available'; // Unknown staff, default to Available

  const dayEvents = calendarEvents[staffName]?.[dateKey];

  if (staffConfig.calendarMode === 'offOnly') {
    // Sho: if marked as Off, return Off; otherwise Available
    if (dayEvents?.isOff) return 'Off';
    return 'Available';
  } else if (staffConfig.calendarMode === 'availability') {
    // Kana: if event exists for the slot, return Available; otherwise Off
    if (!dayEvents) return 'Off'; // No calendar data = Off

    if (timeSlot === 'AM' && dayEvents.AM) return 'Available';
    if (timeSlot === 'PM' && dayEvents.PM) return 'Available';
    if (dayEvents.isOff) return 'Off';

    return 'Off'; // No matching event for this slot
  }

  return 'Available'; // Default
}

function showLogs() {
  const logs = console.getLog ? console.getLog() : 'No logs available';
  const ui = SpreadsheetApp.getUi();
  ui.alert(logs);
}
