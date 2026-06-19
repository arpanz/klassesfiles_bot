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

function parseNaturalLanguageQuery(text) {
  const normalizedText = text.toLowerCase().trim();

  // 1. Section extraction (using lookahead instead of strict word boundary at end)
  const sectionMatch = normalizedText.match(/\b(cse|csce|it|etc|csse|cs|ece|ee|me|ce)[-\s]*(\d{1,2})(?!\d)/);
  let section = null;
  if (sectionMatch) {
    const dept = sectionMatch[1].toUpperCase();
    const num = parseInt(sectionMatch[2], 10);
    const numStr = num < 10 ? '0' + num : String(num);
    section = `${dept}-${numStr}`;
  }

  // 2. Roll number extraction (6 to 8 digits)
  const rollMatch = normalizedText.match(/\b(\d{6,8})\b/);
  let rollNo = rollMatch ? rollMatch[1] : null;

  // 3. Cohort / Batch / Sem hints (removed strict boundary before sem)
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

  // 4. Date extraction
  let targetDate = null;
  const getISTNow = () => {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  };
  const nowIST = getISTNow();

  if (/\btoday\b/.test(normalizedText)) {
    targetDate = nowIST;
  } else if (/\btomorrow\b/.test(normalizedText)) {
    targetDate = new Date(nowIST.getTime() + 24 * 60 * 60 * 1000);
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

  // Check numeric or word date: "20 june", "20/06", "june 20th"
  if (!targetDate) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const numericDateMatch = normalizedText.match(/\b(\d{1,2})[-\/](\d{1,2})(?:[-\/](\d{2,4}))?\b/);
    
    if (numericDateMatch) {
      const day = parseInt(numericDateMatch[1], 10);
      const month = parseInt(numericDateMatch[2], 10) - 1;
      let year = numericDateMatch[3] ? parseInt(numericDateMatch[3], 10) : nowIST.getFullYear();
      if (year < 100) year += 2000;
      targetDate = new Date(year, month, day);
    } else {
      let alphaDateMatch = normalizedText.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/);
      let day = null;
      let monthStr = null;
      
      if (alphaDateMatch) {
        day = parseInt(alphaDateMatch[1], 10);
        monthStr = alphaDateMatch[2];
      } else {
        alphaDateMatch = normalizedText.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*(\d{1,2})(?:st|nd|rd|th)?\b/);
        if (alphaDateMatch) {
          monthStr = alphaDateMatch[1];
          day = parseInt(alphaDateMatch[2], 10);
        }
      }

      if (day !== null && monthStr !== null) {
        const monthIdx = months.findIndex(m => monthStr.startsWith(m));
        if (monthIdx !== -1) {
          const yearMatch = normalizedText.match(/\b(202\d|203\d)\b/);
          const year = yearMatch ? parseInt(yearMatch[1], 10) : nowIST.getFullYear();
          targetDate = new Date(year, monthIdx, day);
        }
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
    section,
    rollNo,
    dayInfo: { weekday, dateStr: `${dayVal} ${monthVal} ${yearVal}` },
    cohortHint: (batch || semester) ? { batch, semester } : null
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
      notificationsEnabled: true,
      updatedAt: new Date().toISOString()
    });

    return `✅ <b>Registration Successful!</b>\n\n` +
           `👤 <b>Name:</b> ${esc(fromUser.first_name)}\n` +
           `• <b>Roll Number:</b> <code>${esc(roll)}</code>\n` +
           `• <b>Section:</b> <code>${esc(mainSection)}</code>\n` +
           `• <b>Batch:</b> ${esc(cohort.label)}\n` +
           `• <b>Notifications:</b> Enabled (7:30 AM IST)\n\n` +
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

  sub.notificationsEnabled = enable;
  sub.updatedAt = new Date().toISOString();
  await store.setJSON(String(chatId), sub);

  return enable 
    ? '🔔 <b>Daily Notifications Enabled!</b>\nI will send you your class schedule every morning at 7:30 AM IST.'
    : '🔕 <b>Daily Notifications Disabled!</b>\nYou will no longer receive morning schedule alerts. You can still query manually.';
}

async function handleStatus(chatId) {
  const store = getSubStore();
  const sub = await store.get(String(chatId), { type: 'json' });
  if (!sub) {
    return '🔍 <b>Registration Status: Not Registered</b>\n\nUse <code>/register &lt;roll_number&gt;</code> to register and receive daily alerts.';
  }

  return `👤 <b>Your Registration Status</b>\n` +
         `━━━━━━━━━━━━━━━━━━\n` +
         `• <b>Roll Number:</b> <code>${esc(sub.rollNo)}</code>\n` +
         `• <b>Section:</b> <code>${esc(sub.section)}</code>\n` +
         `• <b>Batch:</b> ${esc(sub.label)} (Sem ${sub.semester})\n` +
         `• <b>Notifications:</b> ${sub.notificationsEnabled ? '✅ Enabled (7:30 AM IST)' : '❌ Disabled'}\n\n` +
         `To change registration, run <code>/register &lt;new_roll&gt;</code>.`;
}

function getHelpText() {
  return `🎓 <b>KampusVibes Timetable Bot Guide</b>\n\n` +
         `I can display your timetable and send daily morning notifications.\n\n` +
         `⚙️ <b>Setup:</b>\n` +
         `• <code>/register &lt;roll_number&gt;</code> - Link your roll number (e.g. <code>/register 2305074</code>)\n\n` +
         `📅 <b>Queries (Try typing naturally!):</b>\n` +
         `• <i>"show me tt of cse-01 3rd sem today"</i>\n` +
         `• <i>"what classes does it-2 have tomorrow?"</i>\n` +
         `• <i>"cse-03 next monday"</i>\n` +
         `• <i>"tell me about 2305074 schedule for 20 june"</i>\n\n` +
         `🔔 <b>Alerts:</b>\n` +
         `• Use the menu below to subscribe/unsubscribe from morning notifications (7:30 AM IST).`;
}

function getMainMenuMarkup() {
  return {
    inline_keyboard: [
      [
        { text: "📅 Today's Schedule", callback_data: "today" },
        { text: "⏭️ Tomorrow's Schedule", callback_data: "tomorrow" }
      ],
      [
        { text: "👤 My Status", callback_data: "status" },
        { text: "🔔 Toggle Alerts", callback_data: "toggle_alerts" }
      ],
      [
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
      } else if (action === 'status') {
        const responseText = await handleStatus(chatId);
        await tgSendOrEdit(chatId, messageId, responseText, getSubPageMarkup());
      } else if (action === 'toggle_alerts') {
        let responseText;
        if (!sub) {
          responseText = '❌ You are not registered yet. Please register using <code>/register &lt;roll_number&gt;</code> first.';
        } else {
          const newStatus = !sub.notificationsEnabled;
          responseText = await handleSubscribe(chatId, newStatus);
        }
        await tgSendOrEdit(chatId, messageId, responseText, getSubPageMarkup());
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
  const text = m.text.trim();
  const tokens = text.split(/\s+/);
  const cmd = tokens[0].toLowerCase();
  const arg = text.substring(tokens[0].length).trim();

  try {
    const store = getSubStore();
    const sub = await store.get(String(chatId), { type: 'json' });

    if (cmd === '/start' || cmd === '/help') {
      const welcome = `🎓 <b>Welcome to KampusVibes Timetable Bot!</b>\n\n` +
                      `I can look up your daily class schedule and send you morning notifications at 7:30 AM IST.\n\n` +
                      `To start, please link your roll number using <code>/register &lt;roll_number&gt;</code> (e.g. <code>/register 2305074</code>).`;
      await tgSend(chatId, welcome, getMainMenuMarkup());
      return new Response('ok');
    }
    
    if (cmd === '/register') {
      const responseText = await handleRegister(chatId, arg, m.from);
      await tgSend(chatId, responseText, getMainMenuMarkup());
      return new Response('ok');
    }

    if (cmd === '/status') {
      const responseText = await handleStatus(chatId);
      await tgSend(chatId, responseText, getMainMenuMarkup());
      return new Response('ok');
    }

    if (cmd === '/subscribe') {
      const responseText = await handleSubscribe(chatId, true);
      await tgSend(chatId, responseText, getMainMenuMarkup());
      return new Response('ok');
    }

    if (cmd === '/unsubscribe') {
      const responseText = await handleSubscribe(chatId, false);
      await tgSend(chatId, responseText, getMainMenuMarkup());
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

    // Natural Language Query (No slash command)
    const parsed = parseNaturalLanguageQuery(text);
    
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
