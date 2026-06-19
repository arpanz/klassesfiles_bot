import { getStore } from '@netlify/blobs';

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const BASE_URL = 'https://klassesfiles.netlify.app';

const getSubStore = () => getStore('subscribers');

async function tgSend(chatId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML'
    })
  });
  return res;
}

// In-memory cache for the cron execution run
const jsonCache = {};

async function fetchJSONCached(filename) {
  if (jsonCache[filename]) return jsonCache[filename];
  const res = await fetch(`${BASE_URL}/${filename}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${filename}`);
  const json = await res.json();
  jsonCache[filename] = json;
  return json;
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

function getISTDayAndDate() {
  const options = { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
  const formatter = new Intl.DateTimeFormat('en-US', options);
  const parts = formatter.formatToParts(new Date());
  const weekday = parts.find(p => p.type === 'weekday').value;
  const day = parts.find(p => p.type === 'day').value;
  const month = parts.find(p => p.type === 'month').value;
  const year = parts.find(p => p.type === 'year').value;
  return { weekday, dateStr: `${day} ${month} ${year}` };
}

export default async (req) => {
  console.log('Daily timetable notifications cron job started...');

  const store = getSubStore();
  let list;
  try {
    list = await store.list();
  } catch (err) {
    console.error('Error listing subscribers:', err);
    return new Response('Error listing subscribers', { status: 500 });
  }

  const dayInfo = getISTDayAndDate();
  const { weekday, dateStr } = dayInfo;
  console.log(`Current IST Date: ${weekday}, ${dateStr}`);

  let manifest;
  try {
    manifest = await fetchJSONCached('manifest.json');
  } catch (err) {
    console.error('Error fetching manifest:', err);
    return new Response('Error fetching manifest', { status: 500 });
  }

  let sentCount = 0;
  let deletedCount = 0;

  for (const blob of list.blobs) {
    const chatId = blob.key;
    try {
      const sub = await store.get(chatId, { type: 'json' });
      if (!sub || !sub.notificationsEnabled) continue;

      const rollPrefix = sub.rollNo.substring(0, 2);
      const cohort = manifest.cohorts.find(c => c.rollPrefix === rollPrefix);
      if (!cohort) {
        console.warn(`Subscriber ${chatId} has untracked batch prefix: ${rollPrefix}`);
        continue;
      }

      const timetable = await fetchJSONCached(cohort.timetable.name);
      
      const sections = sub.sections || [sub.section];
      const mainSec = sections[0];
      const mainSchedule = timetable[mainSec]?.[weekday] || {};

      const combined = { ...mainSchedule };

      if (cohort.electives && cohort.electives.name && sections.length > 1) {
        try {
          const electivesTimetable = await fetchJSONCached(cohort.electives.name);
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
          console.error(`Error loading electives for ${chatId}:`, e);
        }
      }

      const slots = Object.keys(combined);
      if (slots.length === 0) {
        continue;
      }

      slots.sort((a, b) => parseTimeToMinutes(a) - parseTimeToMinutes(b));

      let text = `☀️ <b>Good Morning, ${esc(sub.firstName || 'Student')}!</b>\n\n`;
      text += `📅 <b>Your schedule for today (${esc(weekday)}):</b>\n`;
      text += `🏫 <b>Section:</b> <code>${esc(mainSec)}</code>\n`;
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
      
      text = text.trim();

      const tgRes = await tgSend(chatId, text);
      if (tgRes.status === 403) {
        console.log(`Sub ${chatId} blocked the bot. Deleting subscription.`);
        await store.delete(chatId);
        deletedCount++;
      } else if (!tgRes.ok) {
        console.error(`Failed to send to ${chatId}: HTTP ${tgRes.status}`);
      } else {
        sentCount++;
      }
    } catch (subErr) {
      console.error(`Error sending notification to ${chatId}:`, subErr);
    }
  }

  console.log(`Cron execution summary: Sent: ${sentCount}, Deleted: ${deletedCount}`);
  return new Response(`Processed notifications. Sent: ${sentCount}, Deleted: ${deletedCount}`);
};

export const config = {
  schedule: '0 2 * * 1-6' // 02:00 UTC = 07:30 AM IST, Monday to Saturday
};
