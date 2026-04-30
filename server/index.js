const express = require('express');
const path = require('path');
const db = require('./database');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ルート登録（DB初期化後に）
db.getDb().then(() => {
  app.use('/api/wards',       require('./routes/wards'));
  app.use('/api/patients',    require('./routes/patients'));
  app.use('/api/items',       require('./routes/items'));
  app.use('/api/records',     require('./routes/records'));
  app.use('/api/meal-prices', require('./routes/mealprices'));
  app.use('/api/pdf',         require('./routes/pdf'));

  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`費用計算システム起動: http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('DB初期化エラー:', err);
  process.exit(1);
});
