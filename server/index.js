require('dotenv').config();

const express = require('express');
const path = require('path');
const session = require('express-session');
const db = require('./database');
const { requireAuth, requireRole } = require('./middleware/auth');

const app = express();
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'hiyou-keisan-secret-2026',
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
  app.use('/api/export',      requireAuth, require('./routes/export'));

  // ロールごとの書き込み制限は各ルート内で制御（requireRole）

  // 週次使用量レポートのcron登録（EXPORT_ENABLED=true のときのみ）
  require('./jobs/scheduler').initScheduler();

  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  // エラーハンドラ（スタックトレースのページを返さず JSON で返す）
  app.use((err, req, res, next) => {
    // 名前の重複は入力ミスなので、サーバー障害（500）ではなく 409 で返し、ログも1行にとどめる
    if (/UNIQUE constraint/i.test(String(err.message))) {
      console.warn(`重複エラー: ${req.method} ${req.originalUrl} (${err.message})`);
      if (res.headersSent) return next(err);
      return res.status(409).json({ error: '同じ名前（ID）が既に登録されています' });
    }
    console.error('サーバーエラー:', err);
    if (res.headersSent) return next(err);
    // リクエスト本文の不正（JSONの書式誤りなど）は 4xx のまま返す
    if (err.status >= 400 && err.status < 500)
      return res.status(err.status).json({ error: 'リクエストの形式が正しくありません' });
    res.status(500).json({ error: 'サーバーでエラーが発生しました' });
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`療養介護サービス提供実績記録票 起動: http://localhost:${PORT}`);
    if (db.wasInitialAdminCreated())
      console.log('初期管理者を作成しました: admin / admin123（ログイン後にパスワードを変更してください）');
  });
}).catch(err => {
  console.error('DB初期化エラー:', err);
  process.exit(1);
});
