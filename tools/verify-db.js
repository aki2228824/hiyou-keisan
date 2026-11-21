// Usage: node verify-db.js <db file to check> [app root folder]
// Reads the file into memory with sql.js (the same library the app uses) and checks that it is a
// complete, healthy SQLite database. It never writes to the file.
// Run it on a COPY (a backup), not on the live file while the app is running.
// Prints one line to STDOUT ("OK ..." or "NG ...").  Exit code 0 = OK, 1 = broken / unreadable.
const fs = require('fs');
const path = require('path');

const file = process.argv[2];
const appRoot = process.argv[3] || path.join(__dirname, '..');

(async () => {
  try {
    if (!file) throw new Error('usage: node verify-db.js <db file> [app root]');
    const initSqlJs = require(path.join(appRoot, 'node_modules', 'sql.js'));
    const SQL = await initSqlJs();
    const buf = fs.readFileSync(file);

    // 1) header checks: catches empty / truncated copies (e.g. copied while the app was saving)
    if (buf.length < 100) throw new Error(`file too small (${buf.length} bytes)`);
    if (buf.subarray(0, 15).toString('latin1') !== 'SQLite format 3') throw new Error('bad header (not an SQLite file)');
    let pageSize = buf.readUInt16BE(16); if (pageSize === 1) pageSize = 65536;
    const pages = buf.readUInt32BE(28);
    const sizeValid = buf.readUInt32BE(24) === buf.readUInt32BE(92);
    if (sizeValid && pages > 0 && pages * pageSize !== buf.length)
      throw new Error(`truncated or padded: header says ${pages * pageSize} bytes, file has ${buf.length}`);

    // 2) SQLite's own consistency check
    const db = new SQL.Database(buf);
    const check = db.exec('PRAGMA integrity_check')[0].values.map(r => r[0]).join('; ');
    if (check !== 'ok') throw new Error('integrity_check failed: ' + check.replace(/\s+/g, ' ').slice(0, 160));

    // 3) content sanity: row counts (logged so that a sudden drop is visible to a human)
    const count = t => db.exec(`SELECT COUNT(*) FROM ${t}`)[0].values[0][0];
    const tables = ['users', 'wards', 'patients', 'items', 'records', 'meal_records'];
    const counts = tables.map(t => `${t}=${count(t)}`).join(' ');
    if (count('users') === 0) throw new Error('users table is empty');
    const last = db.exec('SELECT MAX(record_date) FROM records')[0].values[0][0];
    db.close();
    console.log(`OK size=${buf.length} ${counts} last_record_date=${last}`);
    process.exitCode = 0;
  } catch (e) {
    console.log(`NG ${e.message}`);
    process.exitCode = 1;   // do not call process.exit(): on Windows it can abort Node right after sql.js was loaded
  }
})();
