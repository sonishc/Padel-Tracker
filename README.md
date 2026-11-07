# Padel Tracker Web

Вебверсія Padel Tracker на Node.js + TypeScript + Express + React + PostgreSQL. Telegram/Telegraf більше не потрібні.

## Що вже є

- Вхід, реєстрація за invite-кодом, вихід і зміна пароля.
- Ролі `admin` та `player`.
- Список гравців. Адміністратор може додати гравця без акаунта та видати йому доступ (email + пароль).
- Створення матчу рівно на 4 гравців, вибір двох гравців команди A; двоє інших стають командою B.
- Два формати: звичайні сети та Americano.
- Перевірка рахунку сетів на сервері; третій супер тай-брейк доступний лише як вирішальний сет.
- Автоматичне завершення матчу після другої виграної команди сету або явного завершення Americano.
- ELO K=32 на середньому рейтингу двох команд, з нульовою сумою змін рейтингу.
- Особиста статистика, історія матчів та рейтинг клубу.
- Адаптивний інтерфейс для desktop і mobile.

## Технології

- Node.js 22+
- Express 5
- React 19 + Vite 8
- PostgreSQL / Neon
- Argon2id для хешування паролів
- Database-backed opaque sessions, HttpOnly cookies, SameSite=Lax та synchronizer CSRF token
- Helmet CSP, rate limits, Zod validation, параметризовані SQL-запити

## Важливо перед міграцією

1. Зроби backup PostgreSQL.
2. Зупини старого Telegram-бота перед міграцією. Нова версія перейменовує `players.telegram_id` у `players.id` і переводить ідентифікатори гравців у `text`, зберігаючи попередні числові ID як текст.
3. Міграція розрахована на наявні таблиці `players`, `matches`, `match_players`, `match_sets` з колонками, які використовував старий бот. Якщо фактична схема відрізняється, спочатку звір її з `migrations/001_web_app.sql`.
4. Перевір міграцію на копії production-бази, перш ніж запускати на основній.

Міграція додає вебполя до `players` та `matches`, створює `web_sessions` і переносить збережені сети зі старого JSON `matches.score_state` у `match_sets`. Незавершений сет, який був лише в кроці підтвердження (`pendingA` / `pendingB`) і ще не був збережений, не стає результатом автоматично — перевір його до вимкнення старого бота. Старі завершені матчі та ELO не перераховуються.

## Локальний запуск

Потрібен Node.js 22.12+ і PostgreSQL.

```bash
cp .env.example .env
```

Заповни `.env`:

- `DATABASE_URL` — URL PostgreSQL.
- `SESSION_SECRET` — випадковий секрет не менше 32 байтів. Створи командою `openssl rand -base64 48`.
- `APP_INVITE_CODE` — випадковий invite-код для реєстрації учасників.
- `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` — перший адміністратор.

Встанови залежності та застосуй міграцію:

```bash
npm install
npm run db:migrate
npm run seed:admin
```

Запуск у dev-режимі:

```bash
npm run dev
```

Frontend: `http://localhost:5173`. API працює на `http://localhost:3000` через Vite proxy.

Перевірка типів і production build:

```bash
npm run typecheck
npm run build
npm start
```

Після `npm run build` Express обслуговує і API, і React frontend на порту `PORT` (за замовчуванням 3000).

## Deploy on Render

У репозиторії вже є `render.yaml` для одного Render Web Service: Express обслуговує API та зібраний React frontend з одного домену. Окремий Static Site або окремий frontend service не потрібні.

### 1. Підготуй базу даних

Цей проєкт мігрує наявну PostgreSQL-схему старого Telegram Padel Tracker. Він очікує на існуючі таблиці `players`, `matches`, `match_players` та `match_sets`; не підключай порожню БД, якщо спершу не створив у ній legacy-схему.

Перед міграцією:

1. Зупини старого Telegram-бота, щоб він не записував у БД під час переходу.
2. Зроби backup бази.
3. Локально в `.env` вкажи **той самий** PostgreSQL URL, який використовував старий бот. Для Neon з локального комп'ютера використовуй External connection string з `sslmode=require`.
4. Один раз виконай міграцію та створи адміністратора:

```bash
npm install
npm run db:migrate
npm run seed:admin
```

Для `seed:admin` заповни локальні `ADMIN_EMAIL`, `ADMIN_PASSWORD` (щонайменше 12 символів) та необов'язково `ADMIN_NAME` у `.env`. Не додавай `.env` у Git.

Міграцію навмисно не запускаємо автоматично під час кожного Render deploy: це перетворення існуючої production-схеми, яке спочатку треба перевірити з backup. `seed:admin` теж запускай вручну лише один раз: повторний запуск для існуючого email скидає пароль і призначає роль admin.

### 2. Деплой на Render через Blueprint

1. Запуш цей проєкт у GitHub.
2. У Render вибери **New → Blueprint** та підключи репозиторій.
3. Render прочитає `render.yaml` і створить Web Service `padel-tracker-web`.
4. Під час налаштування або в **Environment** заповни:
   - `DATABASE_URL` — той самий PostgreSQL URL, який уже пройшов міграцію. Для Neon використовуй External connection string з `sslmode=require`.
   - `APP_INVITE_CODE` — випадковий довгий секретний код (не менше 16 байтів), яким ділитимешся лише з учасниками групи.
   - `SESSION_SECRET` Render згенерує автоматично через `generateValue`.
5. Запусти deploy і перевір **Logs** та **Events**.

Blueprint використовує Node `24.22.1`, `npm install --include=dev --no-audit --no-fund && npm run build`, `npm start` та HTTP health check `/api/health`. Render передає порт через `PORT`; не задавай його вручну в Environment. `TRUST_PROXY=1` потрібен, щоб Express коректно працював за Render reverse proxy та правильно виставляв Secure cookies.

### 3. Якщо створюєш Web Service вручну

Вибери Runtime **Node**, Root Directory — корінь цього проєкту, Build Command:

```bash
npm install --include=dev --no-audit --no-fund && npm run build
```

Start Command:

```bash
npm start
```

Health Check Path: `/api/health`.

Додай Environment Variables: `NODE_ENV=production`, `TRUST_PROXY=1`, `DB_POOL_MAX=5`, `DATABASE_URL`, `SESSION_SECRET` (мінімум 32 байти), `APP_INVITE_CODE` (мінімум 16 байтів). Не додавай `PORT` — Render задає його автоматично.

### 4. Перевір після deploy

- Відкрий `https://<твій-сервіс>.onrender.com/api/health` — очікується JSON `{"ok":true,"service":"padel-tracker-web"}`.
- Відкрий кореневу адресу сервісу — має завантажитися Padel Tracker.
- Увійди під адміністратором, відкрий **Гравці** та видай email/пароль доступ старим гравцям.
- Створи тестовий матч і перевір додавання сету / Americano до того, як запрошувати всю групу.

Render Web Service не потребує persistent disk: застосунок не зберігає користувацькі файли локально. Дані матчів, гравців і сесій зберігаються в PostgreSQL. На безкоштовному Render сервіс може засинати після періоду неактивності; перший запит після цього може запускатися повільніше.

Не виставляй `DATABASE_URL`, `SESSION_SECRET` або `APP_INVITE_CODE` у frontend чи Git. Для Render-hosted Postgres використовуй Internal URL лише коли сервіс і БД в одному Render workspace та region; для зовнішньої Neon БД використовуй її External URL з TLS.

## Облікові записи після переходу

Старі гравці та їхня статистика зберігаються. Старі записи не мають пароля чи email. Після створення admin-акаунта відкрий розділ **Гравці** та натисни **Видати доступ** біля кожного старого гравця: задай email та початковий пароль, потім передай його гравцю приватно. Після першого входу гравець може змінити пароль у профілі.

Нові учасники можуть зареєструватися самостійно, використавши invite-код.

## Безпека та обмеження першої версії

- Паролі зберігаються лише як Argon2id-хеші.
- Ідентифікатор сесії — випадковий токен; у БД зберігається його HMAC-SHA256 хеш, а не сам токен.
- Сесії мають термін дії 7 днів; logout, зміна пароля та деактивація гравця анулюють сесії.
- Усі змінювальні API-запити потребують CSRF-токен і перевіряють `Origin`, якщо він присутній.
- Користувач може змінювати рахунок лише матчу, в якому він учасник або автор; admin має повний доступ. Видаляти незавершений матч може автор або admin. Звичайні гравці можуть переглядати клубну історію, але не можуть змінювати чужі матчі.
- Завершені матчі в цій версії незмінні. Для виправлення помилкового завершеного результату потрібен окремий admin workflow із rollback попередніх ELO-змін; напряму редагувати таблиці вручну не рекомендується.
- Реєстрація за invite-кодом не замінює підтвердження email. Забезпечуй передачу invite-коду тільки своїй групі.
- Rate limit використовує in-memory store. Для кількох server instances потрібно перейти на спільне сховище rate-limit (наприклад Redis або PostgreSQL-backed limiter).

## ELO

Командний очікуваний результат розраховується за середнім ELO команди:

`expectedA = 1 / (1 + 10 ^ ((averageB - averageA) / 400))`

`deltaA = round(32 * (actualA - expectedA))`

Кожен гравець команди отримує однакову зміну. Для команди B використовується `-deltaA`, щоб зміна рейтингу була строго zero-sum. Нічия в Americano відповідає `actualA = 0.5`.
