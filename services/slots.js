const db = require('../database');

const SERVICES = [
  { name: 'Маникюр без покрытия', duration: 60, break: 15 },
  { name: 'Маникюр с покрытием', duration: 120, break: 20 },
  { name: 'Маникюр с дизайном (френч)', duration: 135, break: 20 },
  { name: 'Педикюр без покрытия', duration: 60, break: 15 },
  { name: 'Педикюр с покрытием', duration: 120, break: 20 }
];

function getBreakForService(serviceName) {
  const s = SERVICES.find(s => s.name === serviceName);
  return s ? s.break : 15;
}

function addMinutes(time, minutes) {
  const [hours, mins] = time.split(':').map(Number);
  const totalMinutes = hours * 60 + mins + minutes;
  const newHours = Math.floor(totalMinutes / 60);
  const newMins = totalMinutes % 60;
  return `${String(newHours).padStart(2, '0')}:${String(newMins).padStart(2, '0')}`;
}

function timeToMinutes(time) {
  const [hours, mins] = time.split(':').map(Number);
  return hours * 60 + mins;
}

function minutesToTime(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

async function getAvailableSlots(date, service) {
  const busyBookings = await db.getBookingsByDate(date);
  let blockedSlots = [];
  let freeSlots = [];
  
  try {
    blockedSlots = await db.getBlockedSlotsForDate(date);
    freeSlots = await db.getFreeSlotsForDate(date);
  } catch (e) {
    // Vercel может не иметь таблицы manual_slots
  }
  
  const startHour = 10;
  const endHour = 20;
  
  const available = [];
  
  for (let hour = startHour; hour < endHour; hour++) {
    for (let minute = 0; minute < 60; minute += 30) {
      const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      
      if (blockedSlots.includes(time)) continue;
      
      const endTime = addMinutes(time, service.duration);
      const endTimeMinutes = timeToMinutes(endTime);
      
      if (endTimeMinutes > timeToMinutes(`${String(endHour).padStart(2, '0')}:00`)) continue;
      
      let hasConflict = false;
      
      for (const booking of busyBookings) {
        const bookingStart = timeToMinutes(booking.time);
        const bookingEnd = timeToMinutes(addMinutes(booking.time, booking.service_duration));
        // Break после предыдущей записи
        const bookingBreakEnd = bookingEnd + getBreakForService(booking.service);
        
        // Проверка пересечения
        if (timeToMinutes(time) < bookingBreakEnd && endTimeMinutes > bookingStart) {
          hasConflict = true;
          break;
        }
      }
      
      if (hasConflict) continue;
      available.push(time);
    }
  }
  
  for (const freeTime of freeSlots) {
    if (!available.includes(freeTime)) {
      available.push(freeTime);
    }
  }
  
  return available.sort();
}

function formatServiceList() {
  return SERVICES.map((s, i) => `${i + 1}. ${s.name} – ${s.duration} мин`).join('\n');
}

function formatSlotList(slots) {
  if (slots.length === 0) return 'Нет свободных слотов на эту дату.';
  return `Свободные слоты:\n\n${slots.map(s => `⏰ ${s}`).join('\n')}`;
}

module.exports = {
  SERVICES,
  getAvailableSlots,
  addMinutes,
  timeToMinutes,
  minutesToTime,
  formatServiceList,
  formatSlotList,
  getBreakForService
};
