if (!process.env.BOT_TOKEN) {
  console.error('CRITICAL: BOT_TOKEN is not set');
}



// ── Telegram API Helper ──

const TG_API = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;

function tgApi(method, body) {
  if (!body) body = {};
  const url = 'https://api.telegram.org/bot' + process.env.BOT_TOKEN + '/' + method;
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(function(r) { return r.json(); });
}

// ── Service imports ──
const db = require('../../database');
const slots = require('../../services/slots');
const SERVICES = slots.SERVICES;
const getAvailableSlots = slots.getAvailableSlots;
const getBreakForService = slots.getBreakForService;

// Инициализация таблиц при загрузке
db.initTables().catch(e => console.error('DB init error:', e));

// Флаг для однократной установки webhook
let webhookSetup = false;

async function ensureWebhook() {
  if (webhookSetup) return;
  webhookSetup = true;
  const webhookUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}/api/webhook`
    : process.env.WEBHOOK_URL || 'https://your-domain.com/api/webhook';
  try {
    await tgApi.setWebhook(webhookUrl);
    console.log('✅ Webhook set:', webhookUrl);
  } catch (e) {
    console.error('❌ Webhook error:', e.message);
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST' || !req.body) {
    return res.status(200).send('OK');
  }

  const update = req.body;
  console.log('Received update:', JSON.stringify(update).substring(0, 200));

  // Устанавливаем webhook при первом запросе от Telegram
  await ensureWebhook();

  if (update.message) {
    const msg = update.message;
    const chatId = msg.chat.id;
    const text = msg.text;
    try { await handleMessage(chatId, text, msg); } catch (err) { console.error('Msg error:', err); }
  }

  if (update.callback_query) {
    const query = update.callback_query;
    const chatId = query.message.chat.id;
    const data = query.data;
    const messageId = query.message.message_id;
    try { await handleCallback(chatId, data, messageId); } catch (err) { console.error('Callback error:', err); }
    await tgApi.answerCallbackQuery(query.id);
  }

  res.status(200).send('OK');
};

// ── Message handler ──

async function handleMessage(chatId, text, msg) {
  if (text === '/start') {
    await db.upsertClient(chatId, msg);
    const markup = {
      reply_markup: {
        keyboard: [['/services', '/free'], ['/book', '/mybookings'], ['/cancel', '/help']],
        resize_keyboard: true
      }
    };
    await tgApi.sendMessage(chatId, '💅 Добро пожаловать в маникюрный салон!\n\nВыберите действие:', markup);
    return;
  }

  if (text === '/services') {
    await showMainMenu(chatId);
    return;
  }

  if (text === '/help') {
    await tgApi.sendMessage(chatId,
      '📋 Команды:\n' +
      '/start — начать\n' +
      '/services — услуги\n' +
      '/free [дата] — свободные слоты\n' +
      '/book — запись\n' +
      '/mybookings — мои записи\n' +
      '/cancel <id> — отмена\n' +
      '/help — справка'
    );
    return;
  }

  if (text === '/mybookings') {
    const client = await db.getClientByChatId(chatId);
    if (!client) {
      await db.upsertClient(chatId, msg);
      await tgApi.sendMessage(chatId, 'Вы ещё не записаны ни на одну услугу.');
      return;
    }
    const bookings = await db.getBookingsByClientId(client.id);
    if (bookings.length === 0) {
      await tgApi.sendMessage(chatId, 'У вас нет активных записей.');
      return;
    }
    let txt = '📋 Ваши записи:\n\n';
    bookings.forEach(b => {
      txt += `🔖 №${b.id}\n💅 ${b.service}\n📅 ${b.date}\n⏰ ${b.time}\n⏱ ${b.service_duration} мин\n\n`;
    });
    await tgApi.sendMessage(chatId, txt.trim());
    return;
  }

  if (text.startsWith('/cancel')) {
    const id = parseInt(text.split(' ')[1]);
    if (isNaN(id)) { await tgApi.sendMessage(chatId, `Используйте /cancel <id>.`); return; }
    const booking = await db.getBookingById(id);
    if (!booking) { await tgApi.sendMessage(chatId, '❌ Запись не найдена.'); return; }
    const client = await db.getClientByChatId(chatId);
    if (booking.client_id !== client?.id) { await tgApi.sendMessage(chatId, '❌ Эта запись не принадлежит вам.'); return; }
    await db.updateBookingStatus(id, 'cancelled');
    await tgApi.sendMessage(chatId, `✅ Запись №${id} отменена.`);
    await notifyAdmin(client, { name: booking.service, duration: booking.service_duration }, booking.date, booking.time, id, true);
    return;
  }

  if (text.startsWith('/free')) {
    await pickDate(chatId);
    return;
  }

  if (text === '/book') {
    await pickDate(chatId);
    return;
  }

  const state = await db.getUserState(chatId);
  const parsedState = state ? JSON.parse(state.data) : null;

  if (parsedState && parsedState.waitingForDate) {
    const dateText = text.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) {
      await tgApi.sendMessage(chatId, '❌ Введите дату в формате ГГГГ-ММ-ДД (например: 2026-09-15)');
      return;
    }
    const inputDate = new Date(dateText);
    const maxDate = new Date();
    maxDate.setDate(maxDate.getDate() + 30);
    if (inputDate > maxDate) {
      await tgApi.sendMessage(chatId, '❌ Можно выбрать дату не более чем на 30 дней вперёд.');
      return;
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const inputDateOnly = new Date(dateText);
    inputDateOnly.setHours(0, 0, 0, 0);
    if (inputDateOnly < today) {
      await tgApi.sendMessage(chatId, '❌ Нельзя выбрать прошедшую дату.');
      return;
    }
    await db.setUserState(chatId, {
      waitingForTime: true,
      data: { pickedDate: dateText }
    });
    await showTimeSelection(chatId, dateText);
    return;
  }

  if (parsedState && parsedState.waitingForTime) {
    const time = text.trim();
    if (!/^\d{2}:\d{2}$/.test(time)) {
      await tgApi.sendMessage(chatId, '❌ Введите время в формате ЧЧ:ММ (например: 14:00)');
      return;
    }
    const { pickedDate } = parsedState.data;
    await db.setUserState(chatId, {
      waitingForName: true,
      data: { pickedDate, pickedTime: time }
    });
    await tgApi.sendMessage(chatId, `✅ Время ${time} на ${pickedDate} выбрано!\n\n📝 Теперь введите ваше имя:`, {
      reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'back_home' }]] }
    });
    return;
  }

  if (parsedState && parsedState.waitingForName) {
    const { pickedDate, pickedTime, svcNum } = parsedState.data;
    const service = svcNum ? SERVICES[svcNum - 1] : null;
    const client = await db.upsertClient(chatId, msg);
    const svcName = service ? service.name : 'Не указана';
    const svcDuration = service ? service.duration : 60;
    const breakAfter = service ? getBreakForService(service.name) : 15;
    const bookingId = await db.addBooking(client.id, svcName, svcDuration, breakAfter, pickedDate, pickedTime);
    await db.deleteUserState(chatId);
    await tgApi.sendMessage(chatId,
      `✅ Вы записаны!\n` +
      `💅 ${svcName}\n` +
      `📅 ${pickedDate}\n` +
      `⏰ ${pickedTime}\n` +
      `⏱ ${svcDuration} мин\n` +
      `👤 ${text.trim()}`
    );
    await notifyAdmin(client, { name: svcName, duration: svcDuration }, pickedDate, pickedTime, bookingId, false);
    return;
  }

  // Admin commands
  if (await db.isAdmin(chatId)) {
    await handleAdminCommands(chatId, text);
    return;
  }

  // Admin command from non-admin (shouldn't reach here, but safety)
  await tgApi.sendMessage(chatId, `Неизвестная команда. Используйте /help.`);
}

// ── Callback handler ──

async function handleCallback(chatId, data, messageId) {
  if (data.startsWith('service_')) {
    const parts = data.split('_');
    const serviceNum = parseInt(parts[1]);
    const date = parts[2];
    const services = SERVICES;
    if (serviceNum >= 1 && serviceNum <= services.length) {
      const service = services[serviceNum - 1];
      const markup = {
        inline_keyboard: [
          [{ text: '✅ Выбрать время', callback_data: `svc_${date}_${serviceNum}` },
           { text: '⬅️ Назад', callback_data: 'back_home' }]
        ]
      };
      await tgApi.sendMessage(
        chatId,
        `💅 ${service.name}\n⏱ ${service.duration} мин\n📅 ${date}\n\nВыберите время:`,
        { reply_markup: markup }
      );
    }
    return;
  }

  if (data.startsWith('svc_')) {
    const parts = data.split('_');
    const date = parts[1];
    const svcNum = parseInt(parts[2]);
    const service = SERVICES[svcNum - 1];
    const available = await getAvailableSlots(date, service);

    const markup = { inline_keyboard: [] };
    for (let i = 0; i < available.length; i += 2) {
      const row = [];
      const cb = `bk_${date}_${available[i]}_${svcNum}`;
      row.push({ text: available[i], callback_data: cb });
      if (available[i + 1]) {
        const cb2 = `bk_${date}_${available[i + 1]}_${svcNum}`;
        row.push({ text: available[i + 1], callback_data: cb2 });
      }
      markup.inline_keyboard.push(row);
    }

    markup.inline_keyboard.push([
      { text: '⬅️ Назад', callback_data: `service_${svcNum}_${date}` }
    ]);

    await tgApi.sendMessage(
      chatId,
      `⏰ Выберите время (${date}):\n\n${available.length === 0 ? 'Нет свободных слотов.' : 'Доступные слоты:'}`,
      { reply_markup: markup }
    );
    return;
  }

  if (data.startsWith('bk_')) {
    const parts = data.split('_');
    const date = parts[1];
    const time = parts[2];
    const svcNum = parseInt(parts[3]);
    const service = SERVICES[svcNum - 1];

    const markup = {
      inline_keyboard: [
        [{ text: '✅ Подтвердить', callback_data: `confirm_${date}_${time}_${svcNum}` },
         { text: '⬅️ Назад', callback_data: `svc_${date}_${svcNum}` }]
      ]
    };

    await tgApi.sendMessage(
      chatId,
      `📅 ${date}\n⏰ ${time}\n💅 ${service.name} (${service.duration} мин)\n\nОтправьте ваше имя для записи:`,
      { reply_markup: markup }
    );
    return;
  }

  if (data.startsWith('confirm_')) {
    const parts = data.split('_');
    const date = parts[1];
    const time = parts[2];
    const svcNum = parseInt(parts[3]);
    const service = SERVICES[svcNum - 1];

    // Сохраняем состояние в БД (serverless-safe)
    await db.setUserState(chatId, {
      waitingForName: true,
      data: { date, time, svcNum }
    });

    await tgApi.sendMessage(
      chatId,
      `📝 Подтверждение записи:\n\n📅 ${date}\n⏰ ${time}\n💅 ${service.name} (${service.duration} мин)\n\nОтправьте ваше имя:`,
      { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'back_home' }]] } }
    );
    return;
  }

  if (data === 'back_home') {
    // Очистить waitingForDate чтобы текст не интерпретировался как дата
    const savedState = await db.getUserState(chatId);
    const savedData = savedState ? JSON.parse(savedState.data) : {};
    if (savedData && savedData.waitingForDate) {
      await db.setUserState(chatId, { waitingForName: false, data: {} });
    }
    // Отправляем новое сообщение с inline-клавиатурой (не editMessageText!)
    await tgApi.sendMessage(chatId, '💅 Добро пожаловать в маникюрный салон!', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📋 Услуги', callback_data: 'show_services' },
           { text: '📅 Свободные слоты', callback_data: 'show_free' }],
          [{ text: '/book', callback_data: 'book' }]
        ]
      }
    });
    return;
  }

  if (data === 'show_services') {
    let date = new Date().toISOString().split('T')[0];
    try {
      const savedState = await db.getUserState(chatId);
      if (savedState) {
        const savedData = JSON.parse(savedState.data);
        if (savedData.pickedDate) date = savedData.pickedDate;
      }
    } catch(e) { /* ignore parse errors */ }
    const markup = { inline_keyboard: [] };
    SERVICES.forEach((s, i) => {
      markup.inline_keyboard.push([{ text: `${i + 1}. ${s.name}`, callback_data: `service_${i + 1}_${date}` }]);
    });
    markup.inline_keyboard.push([{ text: '📅 Выбрать дату', callback_data: 'pick_date' }]);
    markup.inline_keyboard.push([{ text: '⬅️ Назад', callback_data: 'back_home' }]);
    await tgApi.sendMessage(chatId, `📅 ${date}\n💅 Выберите услугу:`, {
      reply_markup: markup
    });
    return;
  }

  if (data === 'show_free') {
    const date = new Date().toISOString().split('T')[0];
    await showServiceSelection(chatId, date, null);
    return;
  }

  if (data === 'pick_date') {
    await db.setUserState(chatId, {
      waitingForDate: true,
      data: {}
    });
    await tgApi.sendMessage(chatId, '📅 Введите дату в формате ГГГГ-ММ-ДД (например: 2026-09-15):\n\nМожно выбрать не более чем на 30 дней вперёд.', {
      reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'back_home' }]] }
    });
    return;
  }

  if (data.startsWith('time_')) {
    const parts = data.split('_');
    const time = parts[1];
    const date = parts[2];
    await db.setUserState(chatId, {
      waitingForName: true,
      data: { pickedDate: date, pickedTime: time }
    });
    await tgApi.sendMessage(chatId, `✅ Время ${time} на ${date} выбрано!\n\n📝 Теперь введите ваше имя:`, {
      reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'back_home' }]] }
    });
    return;
  }

  if (data === 'help') {
    await tgApi.sendMessage(chatId,
      '📋 Помощь:\n\n' +
      '1. Нажмите "Выбрать дату"\n' +
      '2. Введите дату (ГГГГ-ММ-ДД)\n' +
      '3. Выберите время из списка\n' +
      '4. Введите ваше имя\n\n' +
      'Можно выбрать дату не более чем на 30 дней вперёд.'
    );
    return;
  }

  if (data === 'mybookings') {
    const client = await db.getClientByChatId(chatId);
    if (!client) {
      await db.upsertClient(chatId, {});
      await tgApi.sendMessage(chatId, 'Вы ещё не записаны ни на одну услугу.');
      return;
    }
    const bookings = await db.getBookingsByClientId(client.id);
    if (bookings.length === 0) {
      await tgApi.sendMessage(chatId, 'У вас нет активных записей.');
      return;
    }
    let txt = '📋 Ваши записи:\n\n';
    bookings.forEach(b => {
      txt += `🔖 №${b.id}\n💅 ${b.service}\n📅 ${b.date}\n⏰ ${b.time}\n⏱ ${b.service_duration} мин\n\n`;
    });
    await tgApi.sendMessage(chatId, txt.trim());
    return;
  }

  if (data === 'book') {
    await pickDate(chatId);
    return;
  }

}

// ── Admin commands ──

async function handleAdminCommands(chatId, text) {
  if (text.startsWith('/addslot')) {
    const parts = text.trim().split(/\s+/);
    if (parts.length < 4) { await tgApi.sendMessage(chatId, `Используйте /addslot <дата> <время>`); return; }
    await db.addManualSlot(parts[1], parts[2], 'free');
    await tgApi.sendMessage(chatId, `✅ Слот ${parts[2]} на ${parts[1]} добавлен.`);
    return;
  }

  if (text.startsWith('/blockslot')) {
    const parts = text.trim().split(/\s+/);
    if (parts.length < 4) { await tgApi.sendMessage(chatId, `Используйте /blockslot <дата> <время>`); return; }
    await db.addManualSlot(parts[1], parts[2], 'blocked');
    await tgApi.sendMessage(chatId, `✅ Слот ${parts[2]} на ${parts[1]} заблокирован.`);
    return;
  }

  if (text.startsWith('/removeslot')) {
    const parts = text.trim().split(/\s+/);
    if (parts.length < 3) { await tgApi.sendMessage(chatId, `Используйте /removeslot <дата> <время>`); return; }
    await db.removeManualSlot(parts[1], parts[2]);
    await tgApi.sendMessage(chatId, `✅ Слот удалён.`);
    return;
  }

  if (text === '/mybookings') {
    const date = new Date().toISOString().split('T')[0];
    const bookings = await db.getBookingsByDate(date);
    if (bookings.length === 0) { await tgApi.sendMessage(chatId, `Нет записей на ${date}.`); return; }
    let txt = `📋 Записи на ${date}:\n\n`;
    bookings.forEach(b => {
      txt += `🔖 №${b.id}\n👤 ${b.first_name || ''} ${b.last_name || ''}\n💅 ${b.service}\n⏰ ${b.time}\n\n`;
    });
    await tgApi.sendMessage(chatId, txt.trim());
    return;
  }

  if (text.startsWith('/cancel')) {
    const id = parseInt(text.split(' ')[1]);
    if (isNaN(id)) { await tgApi.sendMessage(chatId, `Используйте /cancel <id>.`); return; }
    const booking = await db.getBookingById(id);
    if (!booking) { await tgApi.sendMessage(chatId, '❌ Запись не найдена.'); return; }
    await db.updateBookingStatus(id, 'cancelled');
    const client = await db.getClientByChatId(booking.client_id);
    await tgApi.sendMessage(chatId, `✅ Запись №${id} отменена.`);
    await notifyAdmin(client, { name: booking.service, duration: booking.service_duration }, booking.date, booking.time, id, true);
    return;
  }

  if (text.startsWith('/reschedule')) {
    const parts = text.trim().split(/\s+/);
    if (parts.length < 5) {
      await tgApi.sendMessage(chatId, `Используйте /reschedule <id> <дата> <время>`);
      return;
    }
    const booking = await db.getBookingById(parts[1]);
    if (!booking) { await tgApi.sendMessage(chatId, '❌ Запись не найдена.'); return; }
    const breakAfter = getBreakForService(booking.service);
    await db.updateBookingStatus(parts[1], 'cancelled');
    const client = await db.upsertClient(booking.client_id, {});
    const newId = await db.addBooking(client.id, booking.service, booking.service_duration, breakAfter, parts[2], parts[3]);
    await tgApi.sendMessage(chatId, `✅ Запись №${parts[1]} перенесена на ${parts[2]} ${parts[3]} (№${newId}).`);
    await notifyAdmin(client, { name: booking.service, duration: booking.service_duration }, parts[2], parts[3], newId, false);
    return;
  }

  if (text === '/help') {
    await tgApi.sendMessage(chatId,
      '🔧 Админ-команды:\n' +
      '/addslot <дата> <время> — добавить слот\n' +
      '/blockslot <дата> <время> — заблокировать слот\n' +
      '/removeslot <дата> <время> — удалить слот\n' +
      '/mybookings — записи на сегодня\n' +
      '/cancel <id> — отменить запись\n' +
      '/reschedule <id> <дата> <время> — перенести запись\n' +
      '/clearstate — очистить все состояния пользователей'
    );
  }

  if (text === '/clearstate') {
    await db.query('DELETE FROM user_states');
    await tgApi.sendMessage(chatId, '✅ Все состояния пользователей очищены.');
    return;
  }
}

// ── Helpers ──

async function pickDate(chatId) {
  await db.setUserState(chatId, {
    waitingForDate: true,
    data: {}
  });
  await tgApi.sendMessage(chatId, '📅 Введите дату в формате ГГГГ-ММ-ДД (например: 2026-09-15):\n\nМожно выбрать не более чем на 30 дней вперёд.', {
    reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'back_home' }]] }
  });
}

async function showMainMenu(chatId) {
  const markup = {
    inline_keyboard: [
      [{ text: '📅 Выбрать дату', callback_data: 'pick_date' }],
      [{ text: '📋 Мои записи', callback_data: 'mybookings' }],
      [{ text: 'ℹ️ Помощь', callback_data: 'help' }]
    ]
  };
  await tgApi.sendMessage(chatId, '💅 Добро пожаловать в маникюрный салон!\n\nВыберите действие:', { reply_markup: markup });
}

async function showTimeSelection(chatId, date) {
  const markup = {
    inline_keyboard: [
      ['10:00', '10:30', '11:00', '11:30'],
      ['12:00', '12:30', '13:00', '13:30'],
      ['14:00', '14:30', '15:00', '15:30'],
      ['16:00', '16:30', '17:00', '17:30'],
      ['18:00', '18:30', '19:00', '19:30'],
      [{ text: '⬅️ Назад', callback_data: 'back_home' }]
    ]
  };
  await tgApi.sendMessage(chatId, `📅 Выберите время на ${date}:`, { reply_markup: markup });
}

async function showServiceSelection(chatId, date, messageId) {
  const markup = { inline_keyboard: [] };
  SERVICES.forEach((s, i) => {
    markup.inline_keyboard.push([{ text: `${i + 1}. ${s.name}`, callback_data: `service_${i + 1}_${date}` }]);
  });
  markup.inline_keyboard.push([{ text: '⬅️ Назад', callback_data: 'back_home' }]);

  await tgApi.sendMessage(chatId, `📅 ${date}\n💅 Выберите услугу:`, {
    reply_markup: markup
  });
}

// ── Notifications ──

async function notifyAdmin(client, service, date, time, bookingId, cancelled = false) {
  const admins = await db.getAllAdminChatIds();
  const text = cancelled
    ? `⚠️ ЗАПИСЬ ОТМЕНЕНА\n━━━━━━━━━━━━━━━━━━\n🔖 №${bookingId}\n👤 ${client.first_name || ''} ${client.last_name || ''}\n📱 ${client.phone || 'не указан'}\n💅 ${service.name}\n📅 ${date} ⏰ ${time}\n━━━━━━━━━━━━━━━━━━`
    : `📅 НОВАЯ ЗАПИСЬ\n━━━━━━━━━━━━━━━━━━\n👤 ${client.first_name || ''} ${client.last_name || ''}\n📱 ${client.phone || 'не указан'}\n💅 ${service.name} (${service.duration} мин)\n📅 ${date}\n⏰ ${time}\n🔖 №${bookingId}\n━━━━━━━━━━━━━━━━━━\nСтатус: подтверждена`;

  admins.forEach(adminId => {
    tgApi.sendMessage(adminId, text).catch(e => console.error('Notify error:', e));
  });
}

// ── Vercel HTTP Handler ──

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Telegram webhook is running');
    return;
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const update = JSON.parse(body);
        if (update.message) {
          await handleMessage(update.message.chat.id, update.message.text, update.message);
        } else if (update.callback_query) {
          const callback = update.callback_query;
          await handleCallback(callback.data, callback.message.chat.id, callback.message.message_id);
          await tgApi.answerCallbackQuery(callback.id);
        }
        res.writeHead(200);
        res.end();
      } catch (e) {
        console.error('Webhook error:', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  } else {
    res.writeHead(405);
    res.end();
  }
};
