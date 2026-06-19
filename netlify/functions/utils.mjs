import { Resvg } from '@resvg/resvg-js';

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const BASE_URL = 'https://klassesfiles.netlify.app';

// Cache for JSON fetches
const jsonCache = {};

export async function fetchJSON(filename) {
  if (jsonCache[filename]) return jsonCache[filename];
  const res = await fetch(`${BASE_URL}/${filename}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${filename}`);
  const json = await res.json();
  jsonCache[filename] = json;
  return json;
}

export function parseTimeToMinutes(slot) {
  const startPart = slot.split('-')[0].trim();
  const timeParts = startPart.split('.');
  let hour = parseInt(timeParts[0], 10);
  let min = timeParts[1] ? parseInt(timeParts[1], 10) : 0;
  if (hour >= 1 && hour < 8) {
    hour += 12;
  }
  return hour * 60 + min;
}

export function formatPart(part) {
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

export function formatTimeSlot(slot) {
  try {
    const parts = slot.split('-');
    return `${formatPart(parts[0])} - ${formatPart(parts[1])}`;
  } catch {
    return slot;
  }
}

export function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function getISTDayAndDate(offsetDays = 0) {
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

export function getISTMinutesFromMidnight() {
  const now = new Date();
  const options = { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false };
  const formatter = new Intl.DateTimeFormat('en-US', options);
  const timeStr = formatter.format(now);
  const [hour, min] = timeStr.split(':').map(Number);
  return hour * 60 + min;
}

export async function tgSend(chatId, text, replyMarkup = null) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const body = {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML'
  };
  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

export async function tgSendPhoto(chatId, photoBuffer, caption = '', replyMarkup = null) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`;
  const formData = new FormData();
  formData.append('chat_id', chatId);
  
  const blob = new Blob([photoBuffer], { type: 'image/png' });
  formData.append('photo', blob, 'timetable.png');
  
  if (caption) {
    formData.append('caption', caption);
    formData.append('parse_mode', 'HTML');
  }
  if (replyMarkup) {
    formData.append('reply_markup', JSON.stringify(replyMarkup));
  }
  
  return fetch(url, {
    method: 'POST',
    body: formData
  });
}

export function generateScheduleSvg(weekday, dateStr, section, label, slots, combined) {
  const rowHeight = 80;
  const headerHeight = 150;
  const footerHeight = 60;
  const height = slots.length === 0 ? 350 : (headerHeight + slots.length * rowHeight + footerHeight);
  
  let svg = `<svg width="700" height="${height}" viewBox="0 0 700 ${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" style="stop-color:#0f0c20;stop-opacity:1" />
        <stop offset="50%" style="stop-color:#15102a;stop-opacity:1" />
        <stop offset="100%" style="stop-color:#06040d;stop-opacity:1" />
      </linearGradient>
      
      <linearGradient id="headerGrad" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" style="stop-color:#7f5af0;stop-opacity:1" />
        <stop offset="100%" style="stop-color:#2cb67d;stop-opacity:1" />
      </linearGradient>
      
      <linearGradient id="rowGrad" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" style="stop-color:#1e1b4b;stop-opacity:0.6" />
        <stop offset="100%" style="stop-color:#311042;stop-opacity:0.2" />
      </linearGradient>
    </defs>
    
    <rect width="700" height="${height}" rx="20" fill="url(#bgGrad)" stroke="#2d264d" stroke-width="2"/>
    
    <path d="M 20 0 L 680 0 A 20 20 0 0 1 700 20 L 700 30 L 0 30 L 0 20 A 20 20 0 0 1 20 0 Z" fill="url(#headerGrad)" opacity="0.8"/>
    
    <text x="40" y="75" font-family="system-ui, sans-serif" font-size="28" font-weight="800" fill="#ffffff">📅 Schedule for ${esc(weekday)}</text>
    <text x="40" y="105" font-family="system-ui, sans-serif" font-size="15" font-weight="500" fill="#94a3b8">${esc(dateStr)}</text>
    
    <rect x="520" y="55" width="140" height="40" rx="10" fill="#2d264d" stroke="#4c3e80" stroke-width="1"/>
    <text x="590" y="80" font-family="system-ui, sans-serif" font-size="14" font-weight="700" fill="#2cb67d" text-anchor="middle">🏫 ${esc(section)}</text>
    <text x="590" y="112" font-family="system-ui, sans-serif" font-size="11" font-weight="500" fill="#94a3b8" text-anchor="middle">${esc(label)}</text>
    
    <line x1="40" y1="135" x2="660" y2="135" stroke="#2d264d" stroke-width="1.5"/>
  `;
  
  if (slots.length === 0) {
    svg += `
      <circle cx="350" cy="220" r="40" fill="#1e1b4b" stroke="#7f5af0" stroke-width="1.5"/>
      <text x="350" y="226" font-family="system-ui, sans-serif" font-size="24" text-anchor="middle">🎉</text>
      <text x="350" y="285" font-family="system-ui, sans-serif" font-size="16" font-weight="600" fill="#ffffff" text-anchor="middle">No classes scheduled for today!</text>
      <text x="350" y="305" font-family="system-ui, sans-serif" font-size="13" font-weight="400" fill="#94a3b8" text-anchor="middle">Enjoy your day off!</text>
    `;
  } else {
    let y = headerHeight;
    slots.forEach((slot) => {
      const info = combined[slot];
      const formattedTime = formatTimeSlot(slot);
      
      svg += `
        <g transform="translate(0, ${y})">
          <rect x="40" y="5" width="620" height="70" rx="12" fill="url(#rowGrad)" stroke="#2d264d" stroke-width="1"/>
          <rect x="40" y="5" width="6" height="70" rx="3" fill="${info.isElective ? '#ff8c00' : '#7f5af0'}"/>
          <text x="65" y="44" font-family="system-ui, sans-serif" font-size="14" font-weight="700" fill="#94a3b8">⏰ ${formattedTime}</text>
          <text x="280" y="45" font-family="system-ui, sans-serif" font-size="16" font-weight="700" fill="#ffffff">${esc(info.subject)}${info.isElective ? ' (E)' : ''}</text>
          ${info.room ? `
            <rect x="540" y="24" width="100" height="30" rx="6" fill="#1e293b" stroke="#334155" stroke-width="1"/>
            <text x="590" y="43" font-family="system-ui, sans-serif" font-size="12" font-weight="700" fill="#2cb67d" text-anchor="middle">📍 ${esc(info.room)}</text>
          ` : ''}
        </g>
      `;
      y += rowHeight;
    });
  }
  
  svg += `
    <line x1="40" y1="${height - 50}" x2="660" y2="${height - 50}" stroke="#2d264d" stroke-dasharray="4 4" stroke-width="1"/>
    <text x="350" y="${height - 25}" font-family="system-ui, sans-serif" font-size="11" font-weight="400" fill="#94a3b8" text-anchor="middle">KampusVibes Timetable Bot • Generated automatically</text>
  </svg>`;
  
  return svg;
}

export async function getScheduleImageBuffer(cohort, sections, dayInfo) {
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
      console.error('Error loading electives for image:', e);
    }
  }

  const slots = Object.keys(combined);
  slots.sort((a, b) => parseTimeToMinutes(a) - parseTimeToMinutes(b));

  const svg = generateScheduleSvg(weekday, dateStr, mainSec, cohort.label, slots, combined);
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'original' }
  });
  return resvg.render().asPng();
}

export async function getFormattedSchedule(cohort, sections, dayInfo) {
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

export async function tgSendSchedule(chatId, sub, resolved, targetDay, isToday, navigationMarkup) {
  const format = sub?.timetableFormat || 'text';
  if (format === 'image') {
    try {
      const pngBuffer = await getScheduleImageBuffer(resolved.cohort, resolved.sections, targetDay);
      await tgSendPhoto(chatId, pngBuffer, `📅 <b>Schedule for ${esc(targetDay.weekday)} (${esc(targetDay.dateStr)})</b>`, navigationMarkup);
      return;
    } catch (e) {
      console.error('Failed to generate/send schedule image, falling back to text:', e);
    }
  }
  
  const schedule = await getFormattedSchedule(resolved.cohort, resolved.sections, targetDay);
  await tgSend(chatId, schedule, navigationMarkup);
}
