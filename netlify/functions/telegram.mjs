import { getStore } from '@netlify/blobs';

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const BASE_URL = 'https://klassesfiles.netlify.app';

const getSubStore = () => getStore('subscribers');

async function fetchJSON(filename) {
  const res = await fetch(`${BASE_URL}/${filename}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${filename}`);
  return res.json();
}

async function tgSend(chatId, text, replyMarkup = null) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const body = {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML'
  };
  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function tgSendOrEdit(chatId, messageId, text, replyMarkup = null) {
  if (messageId) {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: text,
        parse_mode: 'HTML',
        reply_markup: replyMarkup
      })
    });
    if (res.ok) return;
  }
  await tgSend(chatId, text, replyMarkup);
}

async function tgAnswerCallback(callbackQueryId, text = '') {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text: text
    })
  });
}

async function registerBotCommands() {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/setMyCommands`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commands: [
        { command: 'start', description: 'Show main menu & persistent buttons' },
        { command: 'today', description: 'View today\'s schedule' },
        { command: 'tomorrow', description: 'View tomorrow\'s schedule' },
        { command: 'weekly', description: 'View weekly timetable' },
        { command: 'next', description: 'View current and next class' },
        { command: 'settings', description: 'Manage notification settings' },
        { command: 'help', description: 'View guide on using this bot' }
      ]
    })
  });
}

function parseTimeToMinutes(slot) {
  const startPart = slot.split('-')[0].trim();
  const timeParts = startPart.split('.');
  let hour = parseInt(timeParts[0], 10);
  let min = timeParts[1] ? parseInt(timeParts[1], 10) : 0;
  if (hour >= 1 && hour < 8) {
    hour += 12;
  }
  return hour * 60 + min;
}

function formatPart(part) {
  const val = parseFloat(part);
  let hour = Math.floor(val);
  let min = Math.round((val - hour) * 100);
  let suffix = 'AM';
  if (hour === 12) {
    suffix = 'PM';
  } else if (hour >= 1 && hour < 8) {
    suffix = 'PM';
  }
  const minStr = min === 0 ? ':00' : `:${min < 10 ? '0' + min : min}`;
  return `${hour}${minStr} ${suffix}`;
}

function formatTimeSlot(slot) {
  try {
    const parts = slot.split('-');
    return `${formatPart(parts[0])} - ${formatPart(parts[1])}`;
  } catch {
    return slot;
  }
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getISTDayAndDate(offsetDays = 0) {
  const date = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  const options = { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
  const formatter = new Intl.DateTimeFormat('en-US', options);
  const parts = formatter.formatToParts(date);
  const weekday = parts.find(p => p.type === 'weekday').value;
  const day = parts.find(p => p.type === 'day').value;
  const month = parts.find(p => p.type === 'month').value;
  const year = parts.find(p => p.type === 'year').value;
  return { weekday, dateStr: `${day} ${month} ${year}` };
}

function getISTMinutesFromMidnight() {
  const now = new Date();
  const options = { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false };
  const formatter = new Intl.DateTimeFormat('en-US', options);
  const timeStr = formatter.format(now);
  const [hour, min] = timeStr.split(':').map(Number);
  return hour * 60 + min;
}

function parseNaturalLanguageQuery(text) {
  const normalizedText = text.toLowerCase().trim();

  // 1. Friendly triggers
  const isGreeting = /\b(hi|hello|hey|greetings|yo|good\s*morning|good\s*afternoon|good\s*evening)\b/.test(normalizedText);
  const isThanks = /\b(thanks|thank\s*you|ty|great|awesome|niiice|nice)\b/.test(normalizedText);

  // 2. Section extraction with lookahead and time-unit filter
  const sectionMatch = normalizedText.match(/\b(cse|csce|it|etc|csse|cs|ece|ee|me|ce)[-\s]*(\d{1,2})(?!\d)/);
  let section = null;
  if (sectionMatch) {
    const dept = sectionMatch[1].toUpperCase();
    const num = parseInt(sectionMatch[2], 10);
    
    const matchEndIndex = sectionMatch.index + sectionMatch[0].length;
    const remainingText = normalizedText.substring(matchEndIndex).trim();
    const startsWithTimeUnit = /^(day|days|min|mins|minute|minutes|hour|hours|week|weeks)\b/.test(remainingText);
    
    if (!startsWithTimeUnit) {
      const numStr = num < 10 ? '0' + num : String(num);
      section = `${dept}-${numStr}`;
    }
  }

  // 3. Roll number extraction (6 to 8 digits)
  const rollMatch = normalizedText.match(/\b(\d{6,8})\b/);
  let rollNo = rollMatch ? rollMatch[1] : null;

  // 4. Cohort / Batch / Sem hints
  let batch = null;
  let semester = null;
  const yearMatch = normalizedText.match(/\b(202\d)\b/);
  if (yearMatch) {
    batch = parseInt(yearMatch[1], 10);
  }
  const semMatch = normalizedText.match(/\b(\d)(?:st|nd|rd|th)?\s*sem/) || normalizedText.match(/(?:\b|\d)sem(?:ester)?[-\s]*(\d)/);
  if (semMatch) {
    semester = parseInt(semMatch[1], 10);
  }

  // 5. Alert configuration edits (Jargon-free NLP mapping)
  let configAlert = null;
  if (/(stop|turn\s*off|disable|unsubscribe|off)\s*(alerts|notifications|notify|remind|me)?/.test(normalizedText)) {
    configAlert = { type: 'none' };
  } else if (/(morning\s*summary|morning\s*digest|summary\s*only|digest\s*only)/.test(normalizedText)) {
    configAlert = { type: 'digest' };
  } else if (/(both|summary\s*and\s*alerts)/.test(normalizedText)) {
    configAlert = { type: 'both' };
  }

  const offsetMatch = normalizedText.match(/\b(5|10|15)\s*(?:min|mins|minute|minutes)\b/);
  if (offsetMatch) {
    const offsetVal = parseInt(offsetMatch[1], 10);
    if (!configAlert) configAlert = {};
    configAlert.offset = offsetVal;
    configAlert.type = configAlert.type || 'class_alert';
  }

  // 6. Date extraction
  let targetDate = null;
  const getISTNow = () => {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  };
  const nowIST = getISTNow();

  if (/\bday\s*after\s*tomorrow\b/.test(normalizedText)) {
    targetDate = new Date(nowIST.getTime() + 2 * 24 * 60 * 60 * 1000);
  } else if (/\byesterday\b/.test(normalizedText)) {
    targetDate = new Date(nowIST.getTime() - 24 * 60 * 60 * 1000);
  } else if (/\btoday\b/.test(normalizedText)) {
    targetDate = nowIST;
  } else if (/\btomorrow\b/.test(normalizedText)) {
    targetDate = new Date(nowIST.getTime() + 24 * 60 * 60 * 1000);
  } else {
    // Check "in X days" or "X days from now"
    const inDaysMatch = normalizedText.match(/\bin\s*(\d+)\s*days?\b/) || normalizedText.match(/\b(\d+)\s*days?\s*from\s*now\b/);
    if (inDaysMatch) {
      const days = parseInt(inDaysMatch[1], 10);
      targetDate = new Date(nowIST.getTime() + days * 24 * 60 * 60 * 1000);
    } else {
      // Check weekday: "monday", "tuesday", etc.
      const daysOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      const weekdayMatch = normalizedText.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
      
      if (weekdayMatch) {
        const targetDayIdx = daysOfWeek.indexOf(weekdayMatch[1]);
        const currentDayIdx = nowIST.getDay();
        let offset = targetDayIdx - currentDayIdx;
        const isNext = /\bnext\b/.test(normalizedText);
        if (offset < 0 || (offset === 0 && isNext)) {
          offset += 7;
        }
        if (isNext && offset > 0 && offset < 7) {
          offset += 7;
        }
        targetDate = new Date(nowIST.getTime() + offset * 24 * 60 * 60 * 1000);
      }
    }
  }

  if (!targetDate) {
    targetDate = nowIST;
  }

  const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
  const formatter = new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'Asia/Kolkata' });
  const parts = formatter.formatToParts(targetDate);
  const weekday = parts.find(p => p.type === 'weekday').value;
  const dayVal = parts.find(p => p.type === 'day').value;
  const monthVal = parts.find(p => p.type === 'month').value;
  const yearVal = parts.find(p => p.type === 'year').value;

  return {
    isGreeting,
    isThanks,
    section,
    rollNo,
    dayInfo: { weekday, dateStr: `${dayVal} ${monthVal} ${yearVal}` },
    cohortHint: (batch || semester) ? { batch, semester } : null,
    configAlert
  };
}

async function resolveUnifiedQuery(parsed, registeredUser = null) {
  const { section, rollNo, cohortHint } = parsed;
  const manifest = await fetchJSON('manifest.json');

  if (rollNo) {
    const rollPrefix = rollNo.substring(0, 2);
    const cohort = manifest.cohorts.find(c => c.rollPrefix === rollPrefix);
    if (!cohort) {
      return { error: `Batch prefix <code>${esc(rollPrefix)}</code> (from roll number <code>${esc(rollNo)}</code>) is not recognized.` };
    }

    try {
      const rollJson = await fetchJSON(cohort.roll.name);
      const rollData = rollJson[rollNo];
      if (!rollData) {
        return { error: `Roll number <code>${esc(rollNo)}</code> was not found in the <code>${esc(cohort.label)}</code> directory.` };
      }
      const sections = Array.isArray(rollData) ? rollData : [rollData];
      return { cohort, sections };
    } catch (e) {
      return { error: `Error loading roll mappings: ${e.message}` };
    }
  }

  if (section) {
    let resolvedCohort = null;
    let resolvedSections = null;

    if (cohortHint) {
      resolvedCohort = manifest.cohorts.find(c => 
        (cohortHint.batch && c.batch === cohortHint.batch) || 
        (cohortHint.semester && c.semester === cohortHint.semester)
      );
    }
    
    if (!resolvedCohort && registeredUser) {
      resolvedCohort = manifest.cohorts.find(c => c.batch === registeredUser.batch);
    }

    if (resolvedCohort) {
      try {
        const timetable = await fetchJSON(resolvedCohort.timetable.name);
        if (timetable[section]) {
          resolvedSections = [section];
        }
      } catch {}
    }

    if (!resolvedSections) {
      for (const cohort of manifest.cohorts) {
        try {
          const timetable = await fetchJSON(cohort.timetable.name);
          if (timetable[section]) {
            resolvedCohort = cohort;
            resolvedSections = [section];
            break;
          }
        } catch {}
      }
    }

    if (!resolvedSections) {
      for (const cohort of manifest.cohorts) {
        if (cohort.electives && cohort.electives.name) {
          try {
            const electives = await fetchJSON(cohort.electives.name);
            if (electives[section]) {
              resolvedCohort = cohort;
              resolvedSections = [section];
              break;
            }
          } catch {}
        }
      }
    }

    if (resolvedCohort && resolvedSections) {
      return { cohort: resolvedCohort, sections: resolvedSections };
    }

    return { error: `Section <code>${esc(section)}</code> was not found in any active timetable.` };
  }

  if (registeredUser) {
    const cohort = manifest.cohorts.find(c => c.batch === registeredUser.batch);
    if (cohort) {
      return { cohort, sections: registeredUser.sections || [registeredUser.section] };
    }
  }

  return { error: 'Please specify a section or roll number (e.g. <code>CSE-01</code> or <code>2305074</code>), or register first.' };
}

async function getFormattedSchedule(cohort, sections, dayInfo) {
  const { weekday, dateStr } = dayInfo;
  const timetable = await fetchJSON(cohort.timetable.name);
  const mainSec = sections[0];
  const mainSchedule = timetable[mainSec]?.[weekday] || {};

  const combined = { ...mainSchedule };

  if (cohort.electives && cohort.electives.name && sections.length > 1) {
    try {
      const electivesTimetable = await fetchJSON(cohort.electives.name);
      for (let i = 1; i < sections.length; i++) {
        const electiveKey = sections[i];
        const electiveSchedule = electivesTimetable[electiveKey]?.[weekday] || {};
        for (const [slot, slotInfo] of Object.entries(electiveSchedule)) {
          combined[slot] = {
            ...slotInfo,
            isElective: true
          };
        }
      }
    } catch (e) {
      console.error('Error loading electives:', e);
    }
  }

  const slots = Object.keys(combined);
  if (slots.length === 0) {
    return `🎉 <b>No classes scheduled for ${esc(weekday)} (${esc(dateStr)})!</b>\nEnjoy your day off!`;
  }

  slots.sort((a, b) => parseTimeToMinutes(a) - parseTimeToMinutes(b));

  let text = `📅 <b>Schedule for ${esc(weekday)} (${esc(dateStr)})</b>\n`;
  text += `🏫 <b>Section:</b> <code>${esc(mainSec)}</code> (${esc(cohort.label)})\n`;
  if (sections.length > 1) {
    text += `🎯 <b>Electives:</b> ${sections.slice(1).map(s => `<code>${esc(s)}</code>`).join(', ')}\n`;
  }
  text += `━━━━━━━━━━━━━━━━━━\n\n`;

  for (const slot of slots) {
    const info = combined[slot];
    text += `⏰ <b>${esc(formatTimeSlot(slot))}</b>\n`;
    text += `📖 <b>${esc(info.subject)}</b>${info.isElective ? ' <i>(Elective)</i>' : ''}\n`;
    if (info.room) {
      text += `📍 Room: <code>${esc(info.room)}</code>\n`;
    }
    text += `\n`;
  }

  return text.trim();
}

async function getWeeklyScheduleText(cohort, sections) {
  const timetable = await fetchJSON(cohort.timetable.name);
  const mainSec = sections[0];
  const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  let text = `🗓️ <b>Weekly Timetable</b>\n`;
  text += `🏫 <b>Section:</b> <code>${esc(mainSec)}</code> (${esc(cohort.label)})\n`;
  if (sections.length > 1) {
    text += `🎯 <b>Electives:</b> ${sections.slice(1).map(s => `<code>${esc(s)}</code>`).join(', ')}\n`;
  }
  text += `━━━━━━━━━━━━━━━━━━\n\n`;

  let electivesTimetable = null;
  if (cohort.electives && cohort.electives.name && sections.length > 1) {
    try {
      electivesTimetable = await fetchJSON(cohort.electives.name);
    } catch (e) {
      console.error('Error loading electives for weekly:', e);
    }
  }

  for (const day of weekdays) {
    const mainSchedule = timetable[mainSec]?.[day] || {};
    const combined = { ...mainSchedule };

    if (electivesTimetable) {
      for (let i = 1; i < sections.length; i++) {
        const electiveKey = sections[i];
        const electiveSchedule = electivesTimetable[electiveKey]?.[day] || {};
        for (const [slot, slotInfo] of Object.entries(electiveSchedule)) {
          combined[slot] = {
            ...slotInfo,
            isElective: true
          };
        }
      }
    }

    const slots = Object.keys(combined);
    text += `<b>${day}:</b>\n`;
    if (slots.length === 0) {
      text += `<i>No classes</i>\n\n`;
      continue;
    }

    slots.sort((a, b) => parseTimeToMinutes(a) - parseTimeToMinutes(b));
    for (const slot of slots) {
      const info = combined[slot];
      text += `• <code>${slot}</code>: <b>${esc(info.subject)}</b>${info.isElective ? ' (E)' : ''} ${info.room ? `[${esc(info.room)}]` : ''}\n`;
    }
    text += `\n`;
  }

  return text.trim();
}

async function getNextClassText(cohort, sections) {
  const dayInfo = getISTDayAndDate(0);
  const weekday = dayInfo.weekday;
  const currentMinutes = getISTMinutesFromMidnight();

  const timetable = await fetchJSON(cohort.timetable.name);
  const mainSec = sections[0];
  const mainSchedule = timetable[mainSec]?.[weekday] || {};

  const combined = { ...mainSchedule };

  if (cohort.electives && cohort.electives.name && sections.length > 1) {
    try {
      const electivesTimetable = await fetchJSON(cohort.electives.name);
      for (let i = 1; i < sections.length; i++) {
        const electiveKey = sections[i];
        const electiveSchedule = electivesTimetable[electiveKey]?.[weekday] || {};
        for (const [slot, slotInfo] of Object.entries(electiveSchedule)) {
          combined[slot] = {
            ...slotInfo,
            isElective: true
          };
        }
      }
    } catch (e) {
      console.error('Error loading electives for next class:', e);
    }
  }

  const slots = Object.keys(combined);
  if (slots.length === 0) {
    return `🎉 <b>No classes scheduled for today (${weekday})!</b>`;
  }

  const classes = slots.map(slot => {
    const start = parseTimeToMinutes(slot);
    const endPart = slot.split('-')[1].trim();
    const parts = endPart.split('.');
    let endHour = parseInt(parts[0], 10);
    let endMin = parts[1] ? parseInt(parts[1], 10) : 0;
    if (endHour >= 1 && endHour < 8) endHour += 12;
    const end = endHour * 60 + endMin;

    return {
      slot,
      start,
      end,
      info: combined[slot]
    };
  });

  classes.sort((a, b) => a.start - b.start);

  let currentClass = null;
  let nextClass = null;

  for (const c of classes) {
    if (currentMinutes >= c.start && currentMinutes < c.end) {
      currentClass = c;
    } else if (c.start > currentMinutes && !nextClass) {
      nextClass = c;
    }
  }

  let text = `⏭️ <b>Current & Next Class</b>\n`;
  text += `🏫 <b>Section:</b> <code>${esc(mainSec)}</code>\n`;
  text += `━━━━━━━━━━━━━━━━━━\n\n`;

  if (currentClass) {
    const remaining = currentClass.end - currentMinutes;
    text += `📖 <b>Current Class (Ongoing):</b>\n`;
    text += `• <b>${esc(currentClass.info.subject)}</b>${currentClass.info.isElective ? ' <i>(Elective)</i>' : ''}\n`;
    text += `⏰ Time: <code>${esc(formatTimeSlot(currentClass.slot))}</code>\n`;
    if (currentClass.info.room) {
      text += `📍 Room: <code>${esc(currentClass.info.room)}</code>\n`;
    }
    text += `⏳ Ends in: <b>${remaining} minutes</b>\n\n`;
  } else {
    text += `📖 <b>Current Class:</b> None\n\n`;
  }

  if (nextClass) {
    const diff = nextClass.start - currentMinutes;
    text += `⏭️ <b>Next Class:</b>\n`;
    text += `• <b>${esc(nextClass.info.subject)}</b>${nextClass.info.isElective ? ' <i>(Elective)</i>' : ''}\n`;
    text += `⏰ Time: <code>${esc(formatTimeSlot(nextClass.slot))}</code>\n`;
    if (nextClass.info.room) {
      text += `📍 Room: <code>${esc(nextClass.info.room)}</code>\n`;
    }
    text += `⏳ Starts in: <b>${diff} minutes</b>\n`;
  } else {
    text += `⏭️ <b>Next Class:</b> None (You are done for the day! 🎉)\n`;
  }

  return text;
}

async function handleRegister(chatId, rollNo, fromUser) {
  const roll = (rollNo || '').trim();
  if (!/^\d{6,}$/.test(roll)) {
    return '❌ Please provide a valid numeric roll number (at least 6 digits).\nExample: <code>/register 2305074</code>';
  }

  const manifest = await fetchJSON('manifest.json');
  const rollPrefix = roll.substring(0, 2);
  const cohort = manifest.cohorts.find(c => c.rollPrefix === rollPrefix);

  if (!cohort) {
    return `❌ Batch prefix <code>${esc(rollPrefix)}</code> is not tracked. Please check your roll number.`;
  }

  try {
    const rollJson = await fetchJSON(cohort.roll.name);
    const rollData = rollJson[roll];
    if (!rollData) {
      return `❌ Roll number <code>${esc(roll)}</code> was not found in the <code>${esc(cohort.label)}</code> directory.`;
    }

    const sections = Array.isArray(rollData) ? rollData : [rollData];
    const mainSection = sections[0];

    const store = getSubStore();
    await store.setJSON(String(chatId), {
      chatId,
      username: fromUser.username || '',
      firstName: fromUser.first_name || '',
      rollNo: roll,
      section: mainSection,
      sections,
      batch: cohort.batch,
      label: cohort.label,
      semester: cohort.semester,
      notificationType: 'digest',
      alertOffset: 5,
      updatedAt: new Date().toISOString()
    });

    return `✅ <b>Registration Successful!</b>\n\n` +
           `👤 <b>Name:</b> ${esc(fromUser.first_name)}\n` +
           `• <b>Roll Number:</b> <code>${esc(roll)}</code>\n` +
           `• <b>Section:</b> <code>${esc(mainSection)}</code>\n` +
           `• <b>Batch:</b> ${esc(cohort.label)}\n` +
           `• <b>Notifications:</b> Morning Summary (7:30 AM IST)\n\n` +
           `Try <code>/today</code> or use the menu below!`;
  } catch (e) {
    return `❌ Registration failed: ${esc(e.message)}`;
  }
}

async function handleSubscribe(chatId, enable) {
  const store = getSubStore();
  const sub = await store.get(String(chatId), { type: 'json' });
  if (!sub) {
    return '❌ You are not registered yet. Please register using <code>/register &lt;roll_number&gt;</code> first.';
  }

  sub.notificationType = enable ? 'digest' : 'none';
  sub.updatedAt = new Date().toISOString();
  await store.setJSON(String(chatId), sub);

  return enable 
    ? '🔔 <b>Alerts Enabled!</b>\nI will send you your class schedule every morning at 7:30 AM IST.'
    : '🔕 <b>Alerts Disabled!</b>\nYou will no longer receive any notifications. You can still query manually.';
}

async function handleSettings(chatId) {
  const store = getSubStore();
  const sub = await store.get(String(chatId), { type: 'json' });
  if (!sub) {
    return {
      text: '🔍 <b>Registration Status: Not Registered</b>\n\nUse <code>/register &lt;roll_number&gt;</code> to register and set up custom alerts.',
      markup: getSubPageMarkup()
    };
  }

  const typeLabels = {
    digest: '📅 Morning Summary Only',
    class_alert: '⏰ Before Each Class',
    both: '🌟 Both (Summary & Alerts)',
    none: '🔕 Alerts Turned Off'
  };
  const type = sub.notificationType || 'digest';
  const offset = sub.alertOffset || 5;

  const text = `⚙️ <b>Notification & Timetable Settings</b>\n` +
               `━━━━━━━━━━━━━━━━━━\n` +
               `👤 <b>Name:</b> ${esc(sub.firstName || 'Student')}\n` +
               `• <b>Roll Number:</b> <code>${esc(sub.rollNo)}</code>\n` +
               `• <b>Section:</b> <code>${esc(sub.section)}</code>\n` +
               `• <b>Batch:</b> ${esc(sub.label)} (Sem ${sub.semester})\n\n` +
               `• <b>Alert Style:</b> <b>${typeLabels[type]}</b>\n` +
               `• <b>Remind Time:</b> <b>${offset} minutes before class</b>\n\n` +
               `Use the buttons below to customize your alerts:`;
  return {
    text,
    markup: getSettingsMarkup(sub)
  };
}

async function handleDeleteRegistration(chatId) {
  const store = getSubStore();
  await store.delete(String(chatId));
  return {
    text: '❌ <b>Roll Number Unlinked Successfully</b>\n\nYour roll number and settings have been cleared from our database. You will no longer receive any notifications.',
    markup: { remove_keyboard: true }
  };
}

function getHelpText() {
  return `🎓 <b>KampusVibes Timetable Bot Guide</b>\n\n` +
         `I can display your timetable and send daily morning notifications or class-by-class alerts.\n\n` +
         `⚙️ <b>Setup:</b>\n` +
         `• <code>/register &lt;roll_number&gt;</code> - Link your roll number (e.g. <code>/register 2305074</code>)\n\n` +
         `📅 <b>Queries (Try typing naturally!):</b>\n` +
         `• <i>"show me tt of cse-01 3rd sem today"</i>\n` +
         `• <i>"what classes does it-2 have tomorrow?"</i>\n` +
         `• <i>"cse-03 next monday"</i>\n` +
         `• <i>"tell me about 2305074 schedule in 2 days"</i>\n\n` +
         `🔔 <b>Alerts Configuration:</b>\n` +
         `• Type naturally to tweak settings: <i>"notify me 10 mins before class"</i> or <i>"disable alerts"</i>.`;
}

function getMainMenuMarkup() {
  return {
    inline_keyboard: [
      [
        { text: "📅 Today's Schedule", callback_data: "today" },
        { text: "⏭️ Tomorrow's Schedule", callback_data: "tomorrow" }
      ],
      [
        { text: "🗓️ Weekly Timetable", callback_data: "weekly" },
        { text: "⏭️ Next Class", callback_data: "next" }
      ],
      [
        { text: "⚙️ Settings & Status", callback_data: "settings" },
        { text: "❓ Help Guide", callback_data: "help" }
      ]
    ]
  };
}

function getScheduleNavigationMarkup(isToday = true) {
  return {
    inline_keyboard: [
      [
        isToday 
          ? { text: "⏭️ Tomorrow's Schedule", callback_data: "tomorrow" }
          : { text: "📅 Today's Schedule", callback_data: "today" },
        { text: "🏠 Main Menu", callback_data: "menu" }
      ]
    ]
  };
}

function getSubPageMarkup() {
  return {
    inline_keyboard: [
      [
        { text: "🏠 Main Menu", callback_data: "menu" }
      ]
    ]
  };
}

function getSettingsMarkup(sub) {
  const typeLabels = {
    digest: '📅 Morning Summary',
    class_alert: '⏰ Before Each Class',
    both: '🌟 Both',
    none: '🔕 Turn Off Alerts'
  };
  const type = sub.notificationType || 'digest';
  const offset = sub.alertOffset || 5;

  return {
    inline_keyboard: [
      [
        { text: `🔔 Style: ${typeLabels[type]}`, callback_data: `toggle_type:${type}` }
      ],
      [
        { text: `⏱️ Remind: ${offset} mins before`, callback_data: `toggle_offset:${offset}` }
      ],
      [
        { text: "❌ Unlink Roll Number", callback_data: "delete_registration" }
      ],
      [
        { text: "🏠 Main Menu", callback_data: "menu" }
      ]
    ]
  };
}

function getMainReplyKeyboard() {
  return {
    keyboard: [
      [
        { text: "📅 Today's Schedule" },
        { text: "⏭️ Tomorrow's Schedule" }
      ],
      [
        { text: "🗓️ Weekly Timetable" },
        { text: "⏭️ Next Class" }
      ],
      [
        { text: "⚙️ Settings & Status" },
        { text: "❓ Help Guide" }
      ]
    ],
    resize_keyboard: true,
    persistent: true
  };
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('ok');

  let update;
  try {
    update = await req.json();
  } catch {
    return new Response('ok');
  }

  // Handle Callback Queries (Button taps)
  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message.chat.id;
    const messageId = cq.message.message_id;
    const action = cq.data;

    try {
      const store = getSubStore();
      const sub = await store.get(String(chatId), { type: 'json' });

      await tgAnswerCallback(cq.id);

      if (action === 'menu') {
        const text = `🏠 <b>KampusVibes Main Menu</b>\n\nUse the buttons below to check your schedule or adjust your settings.`;
        await tgSendOrEdit(chatId, messageId, text, getMainMenuMarkup());
      } else if (action === 'help') {
        await tgSendOrEdit(chatId, messageId, getHelpText(), getSubPageMarkup());
      } else if (action === 'settings') {
        const { text, markup } = await handleSettings(chatId);
        await tgSendOrEdit(chatId, messageId, text, markup);
      } else if (action === 'delete_registration') {
        const { text, markup } = await handleDeleteRegistration(chatId);
        await tgSendOrEdit(chatId, messageId, text, markup);
      } else if (action === 'today') {
        const resolved = await resolveUnifiedQuery({}, sub);
        if (resolved.error) {
          await tgSendOrEdit(chatId, messageId, resolved.error, getSubPageMarkup());
        } else {
          const schedule = await getFormattedSchedule(resolved.cohort, resolved.sections, getISTDayAndDate(0));
          await tgSendOrEdit(chatId, messageId, schedule, getScheduleNavigationMarkup(true));
        }
      } else if (action === 'tomorrow') {
        const resolved = await resolveUnifiedQuery({}, sub);
        if (resolved.error) {
          await tgSendOrEdit(chatId, messageId, resolved.error, getSubPageMarkup());
        } else {
          const schedule = await getFormattedSchedule(resolved.cohort, resolved.sections, getISTDayAndDate(1));
          await tgSendOrEdit(chatId, messageId, schedule, getScheduleNavigationMarkup(false));
        }
      } else if (action === 'weekly') {
        const resolved = await resolveUnifiedQuery({}, sub);
        if (resolved.error) {
          await tgSendOrEdit(chatId, messageId, resolved.error, getSubPageMarkup());
        } else {
          const weeklyText = await getWeeklyScheduleText(resolved.cohort, resolved.sections);
          await tgSendOrEdit(chatId, messageId, weeklyText, getSubPageMarkup());
        }
      } else if (action === 'next') {
        const resolved = await resolveUnifiedQuery({}, sub);
        if (resolved.error) {
          await tgSendOrEdit(chatId, messageId, resolved.error, getSubPageMarkup());
        } else {
          const nextText = await getNextClassText(resolved.cohort, resolved.sections);
          await tgSendOrEdit(chatId, messageId, nextText, getSubPageMarkup());
        }
      } else if (action.startsWith('toggle_type:')) {
        if (sub) {
          const types = ['digest', 'class_alert', 'both', 'none'];
          const currentType = action.split(':')[1];
          const nextType = types[(types.indexOf(currentType) + 1) % types.length];
          sub.notificationType = nextType;
          sub.updatedAt = new Date().toISOString();
          await store.setJSON(String(chatId), sub);
          const { text, markup } = await handleSettings(chatId);
          await tgSendOrEdit(chatId, messageId, text, markup);
        }
      } else if (action.startsWith('toggle_offset:')) {
        if (sub) {
          const offsets = [5, 10, 15];
          const currentOffset = parseInt(action.split(':')[1], 10);
          const nextOffset = offsets[(offsets.indexOf(currentOffset) + 1) % offsets.length];
          sub.alertOffset = nextOffset;
          sub.updatedAt = new Date().toISOString();
          await store.setJSON(String(chatId), sub);
          const { text, markup } = await handleSettings(chatId);
          await tgSendOrEdit(chatId, messageId, text, markup);
        }
      }
    } catch (err) {
      console.error('Callback error:', err);
    }

    return new Response('ok');
  }

  // Handle Messages (Text input or commands)
  const m = update.message;
  if (!m || !m.text) return new Response('ok');

  const chatId = m.chat.id;
  const rawText = m.text.trim();
  
  // Map reply keyboard button text to mock command text
  let text = rawText;
  if (rawText === "📅 Today's Schedule") text = "/today";
  else if (rawText === "⏭️ Tomorrow's Schedule") text = "/tomorrow";
  else if (rawText === "🗓️ Weekly Timetable") text = "/weekly";
  else if (rawText === "⏭️ Next Class") text = "/next";
  else if (rawText === "⚙️ Settings & Status") text = "/settings";
  else if (rawText === "❓ Help Guide") text = "/help";

  const tokens = text.split(/\s+/);
  const cmd = tokens[0].toLowerCase();
  const arg = text.substring(tokens[0].length).trim();

  try {
    const store = getSubStore();
    const sub = await store.get(String(chatId), { type: 'json' });

    if (cmd === '/start' || cmd === '/help') {
      try {
        await registerBotCommands();
      } catch (e) {
        console.error('Error setting commands:', e);
      }
      
      const welcome = `🎓 <b>Welcome to KampusVibes Timetable Bot!</b>\n\n` +
                      `I can look up your daily class schedule and send you morning notifications or class-by-class alerts.\n\n` +
                      `To start, please link your roll number using <code>/register &lt;roll_number&gt;</code> (e.g. <code>/register 2305074</code>).`;
      await tgSend(chatId, welcome, getMainReplyKeyboard());
      return new Response('ok');
    }
    
    if (cmd === '/register') {
      const responseText = await handleRegister(chatId, arg, m.from);
      await tgSend(chatId, responseText, getMainReplyKeyboard());
      return new Response('ok');
    }

    if (cmd === '/settings' || cmd === '/status') {
      const { text: settingText, markup } = await handleSettings(chatId);
      await tgSend(chatId, settingText, markup);
      return new Response('ok');
    }

    if (cmd === '/subscribe') {
      const responseText = await handleSubscribe(chatId, true);
      await tgSend(chatId, responseText, getMainReplyKeyboard());
      return new Response('ok');
    }

    if (cmd === '/unsubscribe') {
      const responseText = await handleSubscribe(chatId, false);
      await tgSend(chatId, responseText, getMainReplyKeyboard());
      return new Response('ok');
    }

    if (cmd === '/weekly') {
      const parsed = arg ? parseNaturalLanguageQuery(text) : {};
      const resolved = await resolveUnifiedQuery(parsed, sub);
      if (resolved.error) {
        await tgSend(chatId, resolved.error, getMainMenuMarkup());
      } else {
        const weeklyText = await getWeeklyScheduleText(resolved.cohort, resolved.sections);
        await tgSend(chatId, weeklyText, getSubPageMarkup());
      }
      return new Response('ok');
    }

    if (cmd === '/next') {
      const parsed = arg ? parseNaturalLanguageQuery(text) : {};
      const resolved = await resolveUnifiedQuery(parsed, sub);
      if (resolved.error) {
        await tgSend(chatId, resolved.error, getMainMenuMarkup());
      } else {
        const nextText = await getNextClassText(resolved.cohort, resolved.sections);
        await tgSend(chatId, nextText, getSubPageMarkup());
      }
      return new Response('ok');
    }

    if (cmd === '/today' || cmd === '/tomorrow') {
      const offset = cmd === '/today' ? 0 : 1;
      const dayInfo = getISTDayAndDate(offset);
      
      const parsed = arg ? parseNaturalLanguageQuery(text) : {};
      const resolved = await resolveUnifiedQuery(parsed, sub);
      
      if (resolved.error) {
        await tgSend(chatId, resolved.error, getMainMenuMarkup());
      } else {
        const targetDay = (arg && parsed.dayInfo) ? parsed.dayInfo : dayInfo;
        const schedule = await getFormattedSchedule(resolved.cohort, resolved.sections, targetDay);
        await tgSend(chatId, schedule, getScheduleNavigationMarkup(offset === 0));
      }
      return new Response('ok');
    }

    // Natural Language Query Processing
    const parsed = parseNaturalLanguageQuery(text);
    
    // A. Check for conversational responses first
    if (parsed.isGreeting) {
      const greet = `👋 <b>Hello there!</b>\n\nI am the KampusVibes Timetable Bot. I can show you class timetables and send daily notifications.\n\nHow can I help you today?`;
      await tgSend(chatId, greet, getMainMenuMarkup());
      return new Response('ok');
    }

    if (parsed.isThanks) {
      const thanks = `😊 <b>You're welcome!</b>\n\nLet me know if you need to query any other schedule or change your settings!`;
      await tgSend(chatId, thanks, getMainMenuMarkup());
      return new Response('ok');
    }

    // B. Check for NLP Alert Configuration Edits
    if (parsed.configAlert) {
      if (!sub) {
        await tgSend(chatId, `❌ You are not registered yet. Please link your roll number first using <code>/register &lt;roll_number&gt;</code> to set up custom alerts.`, getMainMenuMarkup());
      } else {
        if (parsed.configAlert.type) sub.notificationType = parsed.configAlert.type;
        if (parsed.configAlert.offset) sub.alertOffset = parsed.configAlert.offset;
        sub.updatedAt = new Date().toISOString();
        await store.setJSON(String(chatId), sub);

        const { text: settingText, markup } = await handleSettings(chatId);
        await tgSend(chatId, `✅ <b>Alert Settings Updated!</b>\n\n` + settingText, markup);
      }
      return new Response('ok');
    }

    // C. Check for NLP Timetable Queries
    if (parsed.section || parsed.rollNo) {
      const resolved = await resolveUnifiedQuery(parsed, sub);
      if (resolved.error) {
        await tgSend(chatId, resolved.error, getMainMenuMarkup());
      } else {
        const schedule = await getFormattedSchedule(resolved.cohort, resolved.sections, parsed.dayInfo);
        const isToday = parsed.dayInfo.weekday === getISTDayAndDate(0).weekday;
        await tgSend(chatId, schedule, getScheduleNavigationMarkup(isToday));
      }
    } else {
      const unrecognized = `Sorry, I couldn't find any recognized roll number or section (like <code>CSE-01</code> or <code>2305074</code>) in your message.\n\n` +
                           `Here is the main menu to query details manually:`;
      await tgSend(chatId, unrecognized, getMainMenuMarkup());
    }

  } catch (err) {
    console.error('Message routing error:', err);
    try {
      await tgSend(chatId, `⚠️ An internal error occurred. Please try again later.`);
    } catch {}
  }

  return new Response('ok');
};
