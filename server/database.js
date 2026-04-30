const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'hiyou.db');

let db;

async function getDb() {
  if (db) return db;

  const SQL = await initSqlJs();
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }

  initSchema();
  save();
  return db;
}

function save() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function initSchema() {
  db.run(`
    CREATE TABLE IF NOT EXISTS wards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS patients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ward_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      room TEXT,
      beneficiary_no TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (ward_id) REFERENCES wards(id)
    );

    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL,
      year INTEGER NOT NULL,
      month INTEGER NOT NULL,
      unit_price INTEGER NOT NULL DEFAULT 0,
      UNIQUE(item_id, year, month),
      FOREIGN KEY (item_id) REFERENCES items(id)
    );

    CREATE TABLE IF NOT EXISTS records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL,
      record_date TEXT NOT NULL,
      item_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 0,
      UNIQUE(patient_id, record_date, item_id),
      FOREIGN KEY (patient_id) REFERENCES patients(id),
      FOREIGN KEY (item_id) REFERENCES items(id)
    );

    CREATE TABLE IF NOT EXISTS meal_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL,
      record_date TEXT NOT NULL,
      breakfast INTEGER NOT NULL DEFAULT 0,
      lunch INTEGER NOT NULL DEFAULT 0,
      dinner INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      UNIQUE(patient_id, record_date),
      FOREIGN KEY (patient_id) REFERENCES patients(id)
    );

    CREATE TABLE IF NOT EXISTS patient_meal_prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL,
      year INTEGER NOT NULL,
      month INTEGER NOT NULL,
      breakfast_price INTEGER NOT NULL DEFAULT 0,
      lunch_price INTEGER NOT NULL DEFAULT 0,
      dinner_price INTEGER NOT NULL DEFAULT 0,
      UNIQUE(patient_id, year, month),
      FOREIGN KEY (patient_id) REFERENCES patients(id)
    );
  `);

  migrateSchema();
  seedInitialData();
}

function migrateSchema() {
  const cols = db.exec("PRAGMA table_info(meal_records)")[0]?.values.map(r => r[1]) ?? [];
  if (!cols.includes('service_status'))
    db.run("ALTER TABLE meal_records ADD COLUMN service_status TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('hospital_addition'))
    db.run("ALTER TABLE meal_records ADD COLUMN hospital_addition INTEGER NOT NULL DEFAULT 0");
  if (!cols.includes('hospital_special'))
    db.run("ALTER TABLE meal_records ADD COLUMN hospital_special INTEGER NOT NULL DEFAULT 0");
}

function seedInitialData() {
  const wardCount = db.exec('SELECT COUNT(*) as cnt FROM wards')[0]?.values[0][0];
  if (wardCount > 0) return;

  db.run(`INSERT INTO wards (name) VALUES ('2階病棟'), ('3階病棟'), ('4階病棟');`);

  const items = [
    ['入浴', 1, 46],
    ['バスタオル', 2, 13],
    ['小タオル', 3, 140],
    ['歯ブラシ A-S', 4, 2100],
    ['テープ止め M', 5, 3130],
    ['フレックスマキシ M', 6, 265],
    ['身体拭き', 7, 165],
    ['ビニール袋', 8, 61],
    ['ティッシュ', 9, 5],
    ['ボディーソープ', 10, 5],
    ['洗顔', 11, 5],
    ['シャンプー', 12, 5],
    ['リンス', 13, 5],
    ['おしぼり', 14, 500],
    ['洗濯', 15, 0],
  ];

  const year = new Date().getFullYear();
  const month = new Date().getMonth() + 1;

  for (const [name, sort, price] of items) {
    db.run('INSERT INTO items (name, sort_order) VALUES (?, ?)', [name, sort]);
    const itemId = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
    db.run('INSERT INTO prices (item_id, year, month, unit_price) VALUES (?, ?, ?, ?)',
      [itemId, year, month, price]);
  }
}

function query(sql, params = []) {
  const result = db.exec(sql, params);
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

function run(sql, params = []) {
  db.run(sql, params);
  save();
}

module.exports = { getDb, query, run, save };
