const TelegramBot = require('node-telegram-bot-api');

// ⚠️ ЭТОТ ФАЙЛ НЕ ИСПОЛЬЗУЕТСЯ ДЛЯ VERCEL DEPLOYMENT
// Для Vercel используйте api/webhook/index.js
// Этот файл только для локального тестирования с polling

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

console.log('🤖 Legacy bot (polling) запущен. Используйте api/webhook/ для Vercel.');
