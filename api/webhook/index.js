const TelegramBot = require('node-telegram-bot-api');
const db = require('../../database');
const slots = require('../../services/slots');

if (!process.env.BOT_TOKEN) {
  console.error('CRITICAL: BOT_TOKEN is not set');
}

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false, handlerTimeout: 10 });

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
    await bot.setWebHook(webhookUrl);
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
    await bot.answerCallbackQuery(query.id);
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
    await bot.sendMessage(chatId, '💅 Добро пожаловать в маникюрный салон!\n\nВыберите действие:', markup);
    return;
  }

  if (text === '/services') {
    const date = new Date().toISOString().split('T')[0];
    await showServiceSelection(chatId, date, null);
    return;
  }

  if (text === '/help') {
    await bot.sendMessage(chatId,
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
      await bot.sendMessage(chatId, 'Вы ещё не записаны ни на одну услугу.');
      return;
    }
    const bookings = await db.getBookingsByClientId(client.id);
    if (bookings.length === 0) {
      await bot.sendMessage(chatId, 'У вас нет активных записей.');
      return;
    }
    let txt = '📋 Ваши записи:\n\n';
    bookings.forEach(b => {
      txt += `🔖 №${b.id}\n💅 ${b.service}\n📅 ${b.date}\n⏰ ${b.time}\n⏱ ${b.service_duration} мин\n\n`;
    });
    await bot.sendMessage(chatId, txt.trim());
    return;
  }

  if (text.startsWith('/cancel')) {
    const id = parseInt(text.split(' ')[1]);
    if (isNaN(id)) { await bot.sendMessage(chatId, `Используйте /cancel <id>.`); return; }
    const booking = await db.getBookingById(id);
    if (!booking) { await bot.sendMessage(chatId, '❌ Запись не найдена.'); return; }
    const client = await db.getClientByChatId(chatId);
    if (booking.client_id !== client?.id) { await bot.sendMessage(chatId, '❌ Эта запись не принадлежит вам.'); return; }
    await db.updateBookingStatus(id, 'cancelled');
    await bot.sendMessage(chatId, `✅ Запись №${id} отменена.`);
    await notifyAdmin(client, { name: booking.service, duration: booking.service_duration }, booking.date, booking.time, id, true);
    return;
  }

  if (text.startsWith('/free')) {
    const date = text.split(' ')[1] || new Date().toISOString().split('T')[0];
    await showServiceSelection(chatId, date);
    return;
  }

  if (text === '/book') {
    await bot.sendMessage(chatId, `Используйте /free для выбора слота.`);
    return;
  }

  const state = await db.getUserState(chatId);
  const parsedState = state ? JSON.parse(state.data) : null;

  if (parsedState && parsedState.waitingForDate) {
    const dateText = text.trim();
    // Проверяем формат даты
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) {
      await bot.sendMessage(chatId, '❌ Введите дату в формате ГГГГ-ММ-ДД (например: 2026-08-25)');
      return;
    }
    // Сохраняем выбранную дату
    await db.setUserState(chatId, {
      waitingForName: false,
      data: { pickedDate: dateText }
    });
    await showServiceSelection(chatId, dateText);
    return;
  }

  if (parsedState && parsedState.waitingForName) {
    const { date, time, svcNum } = parsedState.data;
    const service = slots.SERVICES[svcNum - 1];
    const client = await db.upsertClient(chatId, msg);
    const breakAfter = slots.getBreakForService(service.name);
    const bookingId = await db.addBooking(client.id, service.name, service.duration, breakAfter, date, time);
    await db.deleteUserState(chatId);
    await bot.sendMessage(chatId,
      `✅ Вы записаны!\n` +
      `💅 ${service.name}\n` +
      `📅 ${date}\n` +
      `⏰ ${time}\n` +
      `⏱ ${service.duration} мин`
    );
    await notifyAdmin(client, service, date, time, bookingId, false);
    return;
  }

  // Admin commands
  if (await db.isAdmin(chatId)) {
    await handleAdminCommands(chatId, text);
    return;
  }

  // Admin command from non-admin (shouldn't reach here, but safety)
  await bot.sendMessage(chatId, `Неизвестная команда. Используйте /help.`);
}

// ── Callback handler ──

async function handleCallback(chatId, data, messageId) {
  if (data.startsWith('service_')) {
    const parts = data.split('_');
    const serviceNum = parseInt(parts[1]);
    const date = parts[2];
    const services = slots.SERVICES;
    if (serviceNum >= 1 && serviceNum <= services.length) {
      const service = services[serviceNum - 1];
      const markup = {
        inline_keyboard: [
          [{ text: '✅ Выбрать время', callback_data: `svc_${date}_${serviceNum}` },
           { text: '⬅️ Назад', callback_data: 'back_home' }]
        ]
      };
      await bot.editMessageText(
        `💅 ${service.name}\n⏱ ${service.duration} мин\n📅 ${date}\n\nВыберите время:`,
        { chat_id: chatId, message_id: messageId, reply_markup: markup }
      );
    }
    return;
  }

  if (data.startsWith('svc_')) {
    const parts = data.split('_');
    const date = parts[1];
    const svcNum = parseInt(parts[2]);
    const service = slots.SERVICES[svcNum - 1];
    const available = await slots.getAvailableSlots(date, service);

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

    await bot.editMessageText(
      `⏰ Выберите время (${date}):\n\n${available.length === 0 ? 'Нет свободных слотов.' : 'Доступные слоты:'}`,
      { chat_id: chatId, message_id: messageId, reply_markup: markup }
    );
    return;
  }

  if (data.startsWith('bk_')) {
    const parts = data.split('_');
    const date = parts[1];
    const time = parts[2];
    const svcNum = parseInt(parts[3]);
    const service = slots.SERVICES[svcNum - 1];

    const markup = {
      inline_keyboard: [
        [{ text: '✅ Подтвердить', callback_data: `confirm_${date}_${time}_${svcNum}` },
         { text: '⬅️ Назад', callback_data: `svc_${date}_${svcNum}` }]
      ]
    };

    await bot.editMessageText(
      `📅 ${date}\n⏰ ${time}\n💅 ${service.name} (${service.duration} мин)\n\nОтправьте ваше имя для записи:`,
      { chat_id: chatId, message_id: messageId, reply_markup: markup }
    );
    return;
  }

  if (data.startsWith('confirm_')) {
    const parts = data.split('_');
    const date = parts[1];
    const time = parts[2];
    const svcNum = parseInt(parts[3]);
    const service = slots.SERVICES[svcNum - 1];

    // Сохраняем состояние в БД (serverless-safe)
    await db.setUserState(chatId, {
      waitingForName: true,
      data: { date, time, svcNum }
    });

    await bot.editMessageText(
      `📝 Подтверждение записи:\n\n📅 ${date}\n⏰ ${time}\n💅 ${service.name} (${service.duration} мин)\n\nОтправьте ваше имя:`,
      { chat_id: chatId, message_id: messageId }
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
    await bot.sendMessage(chatId, '💅 Добро пожаловать в маникюрный салон!', {
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
    slots.SERVICES.forEach((s, i) => {
      markup.inline_keyboard.push([{ text: `${i + 1}. ${s.name}`, callback_data: `service_${i + 1}_${date}` }]);
    });
    markup.inline_keyboard.push([{ text: '📅 Выбрать дату', callback_data: 'pick_date' }]);
    markup.inline_keyboard.push([{ text: '⬅️ Назад', callback_data: 'back_home' }]);
    await bot.editMessageText(`📅 ${date}\n💅 Выберите услугу:`, {
      chat_id: chatId, message_id: messageId, reply_markup: markup
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
    await bot.editMessageText('📅 Введите дату в формате ГГГГ-ММ-ДД:', {
      chat_id: chatId, message_id: messageId
    });
    return;
  }
}

// ── Admin commands ──

async function handleAdminCommands(chatId, text) {
  if (text.startsWith('/addslot')) {
    const parts = text.trim().split(/\s+/);
    if (parts.length < 4) { await bot.sendMessage(chatId, `Используйте /addslot <дата> <время>`); return; }
    await db.addManualSlot(parts[1], parts[2], 'free');
    await bot.sendMessage(chatId, `✅ Слот ${parts[2]} на ${parts[1]} добавлен.`);
    return;
  }

  if (text.startsWith('/blockslot')) {
    const parts = text.trim().split(/\s+/);
    if (parts.length < 4) { await bot.sendMessage(chatId, `Используйте /blockslot <дата> <время>`); return; }
    await db.addManualSlot(parts[1], parts[2], 'blocked');
    await bot.sendMessage(chatId, `✅ Слот ${parts[2]} на ${parts[1]} заблокирован.`);
    return;
  }

  if (text.startsWith('/removeslot')) {
    const parts = text.trim().split(/\s+/);
    if (parts.length < 3) { await bot.sendMessage(chatId, `Используйте /removeslot <дата> <время>`); return; }
    await db.removeManualSlot(parts[1], parts[2]);
    await bot.sendMessage(chatId, `✅ Слот удалён.`);
    return;
  }

  if (text === '/mybookings') {
    const date = new Date().toISOString().split('T')[0];
    const bookings = await db.getBookingsByDate(date);
    if (bookings.length === 0) { await bot.sendMessage(chatId, `Нет записей на ${date}.`); return; }
    let txt = `📋 Записи на ${date}:\n\n`;
    bookings.forEach(b => {
      txt += `🔖 №${b.id}\n👤 ${b.first_name || ''} ${b.last_name || ''}\n💅 ${b.service}\n⏰ ${b.time}\n\n`;
    });
    await bot.sendMessage(chatId, txt.trim());
    return;
  }

  if (text.startsWith('/cancel')) {
    const id = parseInt(text.split(' ')[1]);
    if (isNaN(id)) { await bot.sendMessage(chatId, `Используйте /cancel <id>.`); return; }
    const booking = await db.getBookingById(id);
    if (!booking) { await bot.sendMessage(chatId, '❌ Запись не найдена.'); return; }
    await db.updateBookingStatus(id, 'cancelled');
    const client = await db.getClientByChatId(booking.client_id);
    await bot.sendMessage(chatId, `✅ Запись №${id} отменена.`);
    await notifyAdmin(client, { name: booking.service, duration: booking.service_duration }, booking.date, booking.time, id, true);
    return;
  }

  if (text.startsWith('/reschedule')) {
    const parts = text.trim().split(/\s+/);
    if (parts.length < 5) {
      await bot.sendMessage(chatId, `Используйте /reschedule <id> <дата> <время>`);
      return;
    }
    const booking = await db.getBookingById(parts[1]);
    if (!booking) { await bot.sendMessage(chatId, '❌ Запись не найдена.'); return; }
    const breakAfter = slots.getBreakForService(booking.service);
    await db.updateBookingStatus(parts[1], 'cancelled');
    const client = await db.upsertClient(booking.client_id, {});
    const newId = await db.addBooking(client.id, booking.service, booking.service_duration, breakAfter, parts[2], parts[3]);
    await bot.sendMessage(chatId, `✅ Запись №${parts[1]} перенесена на ${parts[2]} ${parts[3]} (№${newId}).`);
    await notifyAdmin(client, { name: booking.service, duration: booking.service_duration }, parts[2], parts[3], newId, false);
    return;
  }

  if (text === '/help') {
    await bot.sendMessage(chatId,
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
    await bot.sendMessage(chatId, '✅ Все состояния пользователей очищены.');
    return;
  }
}

// ── Helpers ──

async function showServiceSelection(chatId, date, messageId) {
  const markup = { inline_keyboard: [] };
  slots.SERVICES.forEach((s, i) => {
    markup.inline_keyboard.push([{ text: `${i + 1}. ${s.name}`, callback_data: `service_${i + 1}_${date}` }]);
  });
  markup.inline_keyboard.push([{ text: '⬅️ Назад', callback_data: 'back_home' }]);

  if (messageId) {
    await bot.editMessageText(`📅 ${date}\n💅 Выберите услугу:`, {
      chat_id: chatId, message_id: messageId, reply_markup: markup
    });
  } else {
    await bot.sendMessage(chatId, `📅 ${date}\n💅 Выберите услугу:`, { reply_markup: markup });
  }
}

// ── Notifications ──

async function notifyAdmin(client, service, date, time, bookingId, cancelled = false) {
  const admins = await db.getAllAdminChatIds();
  const text = cancelled
    ? `⚠️ ЗАПИСЬ ОТМЕНЕНА\n━━━━━━━━━━━━━━━━━━\n🔖 №${bookingId}\n👤 ${client.first_name || ''} ${client.last_name || ''}\n📱 ${client.phone || 'не указан'}\n💅 ${service.name}\n📅 ${date} ⏰ ${time}\n━━━━━━━━━━━━━━━━━━`
    : `📅 НОВАЯ ЗАПИСЬ\n━━━━━━━━━━━━━━━━━━\n👤 ${client.first_name || ''} ${client.last_name || ''}\n📱 ${client.phone || 'не указан'}\n💅 ${service.name} (${service.duration} мин)\n📅 ${date}\n⏰ ${time}\n🔖 №${bookingId}\n━━━━━━━━━━━━━━━━━━\nСтатус: подтверждена`;

  admins.forEach(adminId => {
    bot.sendMessage(adminId, text).catch(e => console.error('Notify error:', e));
  });
}
