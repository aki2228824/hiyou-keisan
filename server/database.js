const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

// DBファイルの場所。環境変数 DB_PATH があればそれを使い、無ければ従来どおり data/hiyou.db
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '..', 'data', 'hiyou.db');

// 保存時の一時ファイル。DBと同じフォルダに置く（同じディスク内でないと rename で差し替えられないため）
const TMP_PATH = DB_PATH + '.tmp';

let db;
let initialAdminCreated = false; // 今回の起動で初期管理者を作成したか
let inTransaction = false;       // transaction() の実行中か（実行中は run() ごとの保存をしない）

async function getDb() {
  if (db) return db;

  const SQL = await initSqlJs();
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  if (fs.existsSync(DB_PATH)) {
    const file = fs.readFileSync(DB_PATH);
    // 0バイトのファイルは sql.js では「空の新規DB」として開けてしまい、そのまま空のDBで上書きされる。
    // 保存中の停電・ディスク満杯などで壊れた可能性が高いので、上書きせずに起動を止める。
    if (file.length === 0) {
      throw new Error(
        `DBファイルが0バイトです（破損の可能性があります）: ${DB_PATH}\n` +
        'このファイルは上書きしていません。バックアップから戻してから起動し直してください。' +
        '本当に空の状態から始める場合だけ、このファイルを別の場所へ移動してから起動してください。');
    }
    db = new SQL.Database(file);
    console.log(`DBファイル: ${DB_PATH}（${file.length.toLocaleString()} バイト）`);
  } else {
    db = new SQL.Database();
    console.log(`DBファイル: ${DB_PATH}（見つからないため新しく作成します）`);
  }

  initSchema();
  save();
  return db;
}

/**
 * メモリ上のDB全体をファイルへ書き出す。
 * DBファイルを直接上書きすると、書き込み途中の停電・異常終了・ディスク満杯でファイルが
 * 0バイトや途中までの状態になる。そのため一時ファイルへ全部書いてディスクへ確定（fsync）させてから、
 * rename で差し替える。DBファイルは常に「保存前の内容」か「保存後の内容」のどちらかになる。
 */
function save() {
  const data = db.export();
  const fd = fs.openSync(TMP_PATH, 'w');
  try {
    let offset = 0;
    while (offset < data.length) offset += fs.writeSync(fd, data, offset, data.length - offset);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  renameWithRetry(TMP_PATH, DB_PATH);
}

// Windows では、ほかのプログラム（バックアップ・ウイルス対策・エクスプローラーでのコピー等）が
// DBファイルを開いている間は rename が EPERM / EBUSY / EACCES で失敗する。
// 短い待ちを入れて再試行する（50ミリ秒 × 最大40回 ＝ 約2秒。それでも駄目ならエラーにする）。
function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (attempt > 40 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); // 同期的に50ミリ秒待つ
    }
  }
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

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'staff',
      active INTEGER NOT NULL DEFAULT 1
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

  const pmpCols = db.exec("PRAGMA table_info(patient_meal_prices)")[0]?.values.map(r => r[1]) ?? [];
  if (!pmpCols.includes('meal_cap'))
    db.run("ALTER TABLE patient_meal_prices ADD COLUMN meal_cap INTEGER NOT NULL DEFAULT 0");

  seedAdminUser();
}

function seedAdminUser() {
  const bcrypt = require('bcryptjs');
  const count = db.exec('SELECT COUNT(*) FROM users')[0]?.values[0][0];
  if (count > 0) return;
  const hash = bcrypt.hashSync('admin123', 10);
  db.run("INSERT INTO users (username, password_hash, role) VALUES ('admin', ?, 'admin')", [hash]);
  initialAdminCreated = true;
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
  if (!inTransaction) save(); // transaction() の中では、最後にまとめて1回だけ保存する
}

/**
 * 複数の更新を「全部成功」か「全部取り消し」のひとまとまりで実行し、
 * 成功したら最後に1回だけファイルへ保存する（run() 1回ごとにDB全体を書き出さない）。
 * fn の中は同期処理だけにすること（await を挟むと、ほかのリクエストの更新が混ざる）。
 */
function transaction(fn) {
  if (inTransaction) return fn(); // 入れ子で呼ばれたら外側のまとまりに合流する

  db.run('BEGIN');
  inTransaction = true;
  let result;
  try {
    result = fn();
    if (result && typeof result.then === 'function')
      throw new Error('transaction() の中では非同期処理（async / Promise）は使えません');
    db.run('COMMIT');
  } catch (err) {
    try { db.run('ROLLBACK'); } catch (_) { /* 取り消し済みなら何もしない */ }
    throw err;
  } finally {
    inTransaction = false;
  }
  save();
  return result;
}

function wasInitialAdminCreated() {
  return initialAdminCreated;
}

// dbPath: DBファイルの場所（操作ログの既定の保存先を「DBと同じフォルダの audit」にするために使う）
module.exports = { getDb, query, run, save, transaction, wasInitialAdminCreated, dbPath: DB_PATH };
