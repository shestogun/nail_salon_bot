# 💅 Nail Salon Bot

Telegram-бот для записи в маникюрный салон.

## Возможности

- 📋 Просмотр услуг и свободных слотов
- 📅 Онлайн-запись с выбором даты, времени и услуги
- 🔔 Уведомления администратора о новых записях
- 🛡️ Админ-панель (блокировка слотов, управление записями)
- 📊 Мои записи для клиентов

## Установка

```bash
npm install
```

## Настройка

```bash
cp .env.example .env
# Заполните .env своими данными
```

## Запуск

```bash
# Локальная разработка
npm run dev

# Деплой на Vercel
npm run deploy
```

## Деплой на Vercel

1. Создайте репозиторий на GitHub и загрузите код
2. Подключите репозиторий в [Vercel Dashboard](https://vercel.com)
3. Добавьте environment variables:
   - `BOT_TOKEN` — токен от BotFather
   - `ADMIN_CHAT_ID` — ваш Telegram chat ID
   - Подключите Vercel Postgres (Free tier)
4. Запустите `vercel deploy`

## Команды

### Клиенты
- `/start` — главное меню
- `/services` — список услуг
- `/free [дата]` — свободные слоты
- `/book` — запись
- `/mybookings` — мои записи
- `/cancel <id>` — отмена записи
- `/help` — справка

### Администратор
- `/addslot <дата> <время>` — добавить слот
- `/blockslot <дата> <время>` — заблокировать слот
- `/removeslot <дата> <время>` — удалить слот
- `/mybookings` — записи на сегодня
- `/cancel <id>` — отменить запись
- `/reschedule <id> <дата> <время>` — перенести запись

## Структура

```
├── api/webhook/          # Vercel Serverless function
├── services/             # Бизнес-логика
│   ├── slots.js          # Расчёт слотов
│   └── sots.js           # (legacy)
├── database.js           # Vercel Postgres адаптер
├── .env.example          # Пример переменных
├── vercel.json           # Конфиг Vercel
└── package.json
```

## Лицензия

MIT
