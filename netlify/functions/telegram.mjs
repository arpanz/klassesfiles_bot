import { getStore } from '@netlify/blobs';

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const BASE_URL = 'https://klassesfiles.netlify.app';

const getSubStore = () => getStore('subscribers');

async function fetchJSON(filename) {
  const res = await fetch(`${BASE_URL}/${filename}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${filename}`);
  return res.json();
}

async function tgSend(chatId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML'
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

async function resolveQuery(queryArg, registeredUser = null) {
  const manifest = await fetchJSON('manifest.json');
  let rollNo = null;
  let sectionName = null;

  const arg = (queryArg || '').trim();

  if (arg) {
    if (/^\d{6,}$/.test(arg)) {
      rollNo = arg;
    } else {
      sectionName = arg;
    }
  } else if (registeredUser) {
    rollNo = registeredUser.rollNo;
  } else {
    return { error: 'Please register using <code>/register &lt;roll_number&gt;</code> first, or query directly using <code>/today &lt;roll_number&gt;</code> or <code>/today &lt;section&gt;</code>.' };
  }

  if (rollNo) {
    const rollPrefix = rollNo.substring(0, 2);
    const cohort = manifest.cohorts.find(c => c.rollPrefix === rollPrefix);
    if (!cohort) {
      return { error: `Batch prefix <code>${esc(rollPrefix)}</code> (from roll number <code>${esc(rollNo)}</code>) is not recognized in the manifest.` };
    }

    try {
      const rollJson = await fetchJSON(cohort.roll.name);
      const rollData = rollJson[rollNo];
      if (!rollData) {
        return { error: `Roll number <code>${esc(rollNo)}</code> was not found in the <code>${esc(cohort.label)}</code> directory.` };
      }
      const sections = Array.isArray(rollData) ? rollData : [rollData];
      return { cohort, sections, rollNo };
    } catch (e) {
      return { error: `Error loading roll mappings: ${e.message}` };
    }
  }

  if (sectionName) {
    let s = sectionName.toUpperCase().trim().replace(/[-\s]/g, '');
    const match = s.match(/^([A-Z]+)(\d+)$/);
    let normalizedSec = sectionName;
    if (match) {
      let dept = match[1];
      let num = parseInt(match[2], 10);
      let numStr = num < 10 ? '0' + num : String(num);
      normalizedSec = `${dept}-${numStr}`;
    }

    if (registeredUser) {
      const cohort = manifest.cohorts.find(c => c.batch === registeredUser.batch);
      if (cohort) {
        try {
          const timetable = await fetchJSON(cohort.timetable.name);
          if (timetable[normalizedSec]) {
            return { cohort, sections: [normalizedSec] };
          }
        } catch {}
      }
    }

    for (const cohort of manifest.cohorts) {
      try {
        const timetable = await fetchJSON(cohort.timetable.name);
        if (timetable[normalizedSec]) {
          return { cohort, sections: [normalizedSec] };
        }
      } catch {}
    }

    for (const cohort of manifest.cohorts) {
      if (cohort.electives && cohort.electives.name) {
        try {
          const electives = await fetchJSON(cohort.electives.name);
          if (electives[normalizedSec]) {
            return { cohort, sections: [normalizedSec] };
          }
        } catch {}
      }
    }

    return { error: `Section <code>${esc(sectionName)}</code> (normalized to <code>${esc(normalizedSec)}</code>) was not found in any active timetable.` };
  }

  return { error: 'Unknown query error.' };
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
           `Try <code>/today</code> to see your schedule!`;
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
  return `🎓 <b>KampusVibes Timetable Bot</b>\n\n` +
         `I can display your timetable and send daily morning notifications.\n\n` +
         `⚙️ <b>Setup:</b>\n` +
         `• <code>/register &lt;roll_number&gt;</code> - Link your roll number (e.g. <code>/register 2305074</code>)\n\n` +
         `📅 <b>Queries:</b>\n` +
         `• <code>/today</code> - Show today's timetable\n` +
         `• <code>/tomorrow</code> - Show tomorrow's timetable\n` +
         `• <code>/status</code> - View registered details\n\n` +
         `🔍 <b>Direct Query (No registration needed):</b>\n` +
         `• <code>/today &lt;roll_number&gt;</code> - Today's schedule for a roll number\n` +
         `• <code>/today &lt;section&gt;</code> - Today's schedule for a section (e.g. <code>/today CSE-01</code>)\n` +
         `• <code>/tomorrow &lt;roll_number&gt;</code> - Tomorrow's schedule for a roll number\n` +
         `• <code>/tomorrow &lt;section&gt;</code> - Tomorrow's schedule for a section\n\n` +
         `🔔 <b>Notifications:</b>\n` +
         `• <code>/subscribe</code> - Enable daily morning alerts (7:30 AM IST)\n` +
         `• <code>/unsubscribe</code> - Disable daily alerts`;
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('ok');

  let update;
  try {
    update = await req.json();
  } catch {
    return new Response('ok');
  }

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

    let responseText = '';

    if (cmd === '/start' || cmd === '/help') {
      responseText = getHelpText();
    } else if (cmd === '/register') {
      responseText = await handleRegister(chatId, arg, m.from);
    } else if (cmd === '/subscribe') {
      responseText = await handleSubscribe(chatId, true);
    } else if (cmd === '/unsubscribe') {
      responseText = await handleSubscribe(chatId, false);
    } else if (cmd === '/status') {
      responseText = await handleStatus(chatId);
    } else if (cmd === '/today') {
      const resolved = await resolveQuery(arg, sub);
      if (resolved.error) {
        responseText = resolved.error;
      } else {
        responseText = await getFormattedSchedule(resolved.cohort, resolved.sections, getISTDayAndDate(0));
      }
    } else if (cmd === '/tomorrow') {
      const resolved = await resolveQuery(arg, sub);
      if (resolved.error) {
        responseText = resolved.error;
      } else {
        responseText = await getFormattedSchedule(resolved.cohort, resolved.sections, getISTDayAndDate(1));
      }
    }

    if (responseText) {
      await tgSend(chatId, responseText);
    }
  } catch (err) {
    console.error('Webhook error:', err);
    try {
      await tgSend(chatId, `⚠️ An internal error occurred. Please try again later.`);
    } catch {}
  }

  return new Response('ok');
};
