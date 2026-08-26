const { TelegramBot } = require('node-telegram-bot-api');

const botToken = process.env.BOT_TOKEN;
const vercelUrl = process.env.VERCEL_URL;

if (!botToken) {
  console.error('ERROR: BOT_TOKEN is required');
  process.exit(1);
}

if (!vercelUrl) {
  console.error('ERROR: VERCEL_URL is required');
  process.exit(1);
}

const webhookUrl = `https://${vercelUrl}/api/webhook`;
const bot = new TelegramBot(botToken, { polling: false });

async function setup() {
  try {
    await bot.setWebHook(webhookUrl);
    console.log('✅ Webhook set to:', webhookUrl);

    const info = await bot.getWebHookInfo();
    console.log('Current webhook:', JSON.stringify(info));
  } catch (e) {
    console.error('❌ Error:', e.message);
  }
}

setup();
