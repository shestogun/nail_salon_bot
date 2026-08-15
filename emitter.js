const { EventEmitter } = require('events');

// Глобальный emitter для отправки сообщений администратору
const emitter = new EventEmitter();

// Слушатель уведомлений
emitter.on('notification', (message) => {
  // Отправляем администратору
  if (global.adminChatIds && global.adminChatIds.includes(message.chatId)) {
    global.bot.sendMessage(message.chatId, message.text, message.options);
  }
});

module.exports = emitter;
