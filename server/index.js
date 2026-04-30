const express = require('express');
const path = require('path');
const session = require('express-session');
const db = require('./database');
const { requireAuth, requireRole } = require('./middleware/auth');

const app = express();
app.use(express.json());
app.use(session({
  secret: 'hiyou-keisan-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }, // 8時間
}));

app.use(express.static(path.join(__dirname, '..', 'public')));

db.getDb().then(() => {
  // 認証（ログイン不要）
  app.use('/api/auth', require('./routes/auth'));

  // 認証が必要なルート
  app.use('/api/wards',       requireAuth, require('./routes/wards'));
  app.use('/api/patients',    requireAuth, require('./routes/patients'));
  app.use('/api/items',       requireAuth, require('./routes/items'));
  app.use('/api/records',     requireAuth, require('./routes/records'));
  app.use('/api/meal-prices', requireAuth, require('./routes/mealprices'));
  app.use('/api/pdf',         requireAuth, require('./routes/pdf'));
  app.use('/api/users',       requireAuth, require('./routes/users'));

  // マスタ管理の書き込みは管理者のみ（ルート内で制御）

  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`療養介護サービス提供実績記録票 起動: http://localhost:${PORT}`);
    console.log('初期管理者: admin / admin123');
  });
}).catch(err => {
  console.error('DB初期化エラー:', err);
  process.exit(1);
});
