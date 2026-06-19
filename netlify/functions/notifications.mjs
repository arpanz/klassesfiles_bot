import { getStore } from '@netlify/blobs';
import {
  fetchJSON,
  parseTimeToMinutes,
  formatTimeSlot,
  esc,
  getISTDayAndDate,
  getISTMinutesFromMidnight,
  tgSend,
  tgSendPhoto,
  getScheduleImageBuffer,
  getFormattedSchedule
} from './utils.mjs';

const getSubStore = () => getStore('subscribers');

export default async (req) => {
  console.log('Class schedule notifications cron job started...');

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
  const currentMinutes = getISTMinutesFromMidnight();
  console.log(`Current IST Time: ${weekday}, ${dateStr} at ${Math.floor(currentMinutes / 60)}:${String(currentMinutes % 60).padStart(2, '0')} (${currentMinutes} mins from midnight)`);

  let manifest;
  try {
    manifest = await fetchJSON('manifest.json');
  } catch (err) {
    console.error('Error fetching manifest:', err);
    return new Response('Error fetching manifest', { status: 500 });
  }

  let digestSent = 0;
  let alertSent = 0;
  let deletedCount = 0;

  // We send the morning digest between 7:25 AM and 8:30 AM IST (445 to 510 minutes from midnight)
  const isDigestWindow = currentMinutes >= 445 && currentMinutes <= 510;

  for (const blob of list.blobs) {
    const chatId = blob.key;
    try {
      const sub = await store.get(chatId, { type: 'json' });
      if (!sub) continue;

      const type = sub.notificationType || 'digest';
      if (type === 'none') continue;

      const rollPrefix = sub.rollNo.substring(0, 2);
      const cohort = manifest.cohorts.find(c => c.rollPrefix === rollPrefix);
      if (!cohort) continue;

      // 1. Fetch timetable and load electives
      const timetable = await fetchJSON(cohort.timetable.name);
      const sections = sub.sections || [sub.section];
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
          console.error(`Error loading electives for ${chatId}:`, e);
        }
      }

      const slots = Object.keys(combined);
      if (slots.length === 0) continue;

      // Sort slots
      slots.sort((a, b) => parseTimeToMinutes(a) - parseTimeToMinutes(b));

      let subUpdated = false;

      // 2. Process Morning Digest (between 7:25 AM and 8:30 AM IST, exactly once per day)
      if (isDigestWindow && (type === 'digest' || type === 'both')) {
        if (sub.lastDigestDate !== dateStr) {
          const format = sub.timetableFormat || 'text';
          let tgRes = null;

          if (format === 'image') {
            try {
              const pngBuffer = await getScheduleImageBuffer(cohort, sections, dayInfo);
              const caption = `☀️ <b>Good Morning, ${esc(sub.firstName || 'Student')}!</b>\nHere is your schedule card for today.`;
              tgRes = await tgSendPhoto(chatId, pngBuffer, caption);
            } catch (e) {
              console.error(`Failed to send morning digest image to ${chatId}, falling back to text:`, e);
            }
          }

          if (!tgRes || !tgRes.ok) {
            let text = `☀️ <b>Good Morning, ${esc(sub.firstName || 'Student')}!</b>\n\n`;
            text += await getFormattedSchedule(cohort, sections, dayInfo);
            tgRes = await tgSend(chatId, text);
          }

          if (tgRes.status === 403) {
            console.log(`Sub ${chatId} blocked the bot. Deleting subscription.`);
            await store.delete(chatId);
            deletedCount++;
            continue;
          } else if (tgRes.ok) {
            digestSent++;
            sub.lastDigestDate = dateStr;
            subUpdated = true;
          }
        }
      }

      // 3. Process Class-by-Class Alerts (Triggered near targetOffset minutes before class, exactly once per day per class)
      if (type === 'class_alert' || type === 'both') {
        const offset = sub.alertOffset || 5;
        sub.sentAlerts = sub.sentAlerts || {};

        for (const slot of slots) {
          const classStart = parseTimeToMinutes(slot);
          const targetAlertTime = classStart - offset;

          // Jitter-proof matching window tolerates up to 12 minutes of delay/jitter
          if (currentMinutes >= targetAlertTime && currentMinutes <= targetAlertTime + 12) {
            if (sub.sentAlerts[slot] !== dateStr) {
              const info = combined[slot];
              const startTimeStr = formatTimeSlot(slot).split(' - ')[0];

              let text = `⏰ <b>Upcoming Class Alert!</b>\n\n`;
              text += `📖 Your class <b>${esc(info.subject)}</b> starts in <b>${offset} minutes</b> (at ${esc(startTimeStr)})!\n`;
              if (info.room) {
                text += `📍 Room: <code>${esc(info.room)}</code>\n`;
              }
              text += `🏫 Section: <code>${esc(mainSec)}</code>`;

              const tgRes = await tgSend(chatId, text);
              if (tgRes.status === 403) {
                console.log(`Sub ${chatId} blocked the bot. Deleting subscription.`);
                await store.delete(chatId);
                deletedCount++;
                subUpdated = false;
                break; // exit slots loop for this deleted user
              } else if (tgRes.ok) {
                alertSent++;
                sub.sentAlerts[slot] = dateStr;
                subUpdated = true;
              }
            }
          }
        }
      }

      if (subUpdated) {
        await store.setJSON(chatId, sub);
      }

    } catch (subErr) {
      console.error(`Error sending notifications to ${chatId}:`, subErr);
    }
  }

  console.log(`Cron execution summary: Digest Sent: ${digestSent}, Alerts Sent: ${alertSent}, Deleted: ${deletedCount}`);
  return new Response(`Processed notifications. Digest Sent: ${digestSent}, Alerts Sent: ${alertSent}, Deleted: ${deletedCount}`);
};

export const config = {
  schedule: '*/5 2-13 * * 1-6' // every 5 minutes, 7:30 AM to 7:29 PM IST, Monday to Saturday
};
