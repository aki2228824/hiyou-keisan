// DB保存処理（server/database.js）の自己テスト。
//   node tools/selftest-db.js
// ・本番のデータには一切触れない（OSの一時フォルダに毎回新しいテスト用DBを作り、終わったら消す）。
// ・サーバーを起動せず、ポートも使わない。サーバーの稼働中に実行してもよい。所要 20〜30 秒。
// ・「保存の途中で落ちた」「ディスクが満杯になった」「ほかのプログラムがDBファイルを開いている」状況をわざと作り、
//   DBファイルが壊れないこと・0バイトのDBで黙って起動しないことを確かめる。
// 終了コード: 0 = 全項目合格 / 1 = 不合格あり
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');

const DATABASE_JS = path.join(__dirname, '..', 'server', 'database.js');

// ---------------------------------------------------------------- 子プロセス側（1シナリオ = 1プロセス）
if (process.env.SELFTEST_CHILD) {
  const mode = process.env.SELFTEST_CHILD;
  const workDir = process.env.SELFTEST_DIR;
  const DB = path.join(workDir, 'selftest.db');
  const TMP = DB + '.tmp';
  if (!path.resolve(workDir).startsWith(path.resolve(os.tmpdir()))) throw new Error('一時フォルダ以外では実行しません');
  process.env.DB_PATH = DB; // database.js は読み込み時にこの値を見る（.env は読まないので本番の DB_PATH は使われない）

  const realWriteSync = fs.writeSync, realWriteFileSync = fs.writeFileSync, realRename = fs.renameSync, realFsync = fs.fsyncSync;
  let renames = 0, armed = false;
  fs.renameSync = (...a) => { renames++; return realRename(...a); };
  const isDbTarget = p => typeof p === 'string' && (path.resolve(p) === DB || path.resolve(p) === TMP);
  const enospc = () => Object.assign(new Error('ENOSPC: no space left on device (テスト用に発生させたエラー)'), { code: 'ENOSPC' });
  if (mode === 'crash-mid-write' || mode === 'enospc-mid-write') {
    fs.writeSync = (fd, buf, off, len, ...rest) => {            // 修正後のコードが通る道
      if (!armed) return realWriteSync(fd, buf, off, len, ...rest);
      realWriteSync(fd, buf, off, Math.floor(len / 2));           // 半分だけ書いたところで…
      if (mode === 'crash-mid-write') process.exit(99);           // …落ちる
      armed = false; throw enospc();                              // …またはディスク満杯
    };
    fs.writeFileSync = (p, buf, ...rest) => {                     // 修正前のコードが通る道（直接上書き）
      if (!armed || !isDbTarget(p)) return realWriteFileSync(p, buf, ...rest);
      const fd = fs.openSync(p, 'w');                             // ここで元のファイルは0バイトになる
      const b = Buffer.from(buf); realWriteSync(fd, b, 0, Math.floor(b.length / 2)); fs.closeSync(fd);
      if (mode === 'crash-mid-write') process.exit(99);
      armed = false; throw enospc();
    };
  }
  if (mode === 'crash-before-rename') fs.fsyncSync = fd => { realFsync(fd); if (armed) process.exit(99); };

  const dbmod = require(DATABASE_JS);
  const out = { mode };
  const done = () => console.log('RESULT ' + JSON.stringify(out));
  const waitMs = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  (async () => {
    try { await dbmod.getDb(); }
    catch (e) { out.getDbError = String(e.message).split('\n')[0].slice(0, 80); return done(); }
    const names = () => dbmod.query('SELECT name FROM wards ORDER BY id').map(w => w.name);
    const add = name => dbmod.run('INSERT INTO wards (name) VALUES (?)', [name]);
    renames = 0;
    try {
      switch (mode) {
        case 'open': out.wards = names(); break;
        case 'run': add('T-run'); break;
        case 'tx-ok':
          out.returned = dbmod.transaction(() => { add('T-tx1'); add('T-tx2'); dbmod.transaction(() => add('T-tx3')); return 'value'; });
          out.renames = renames; break;
        case 'tx-rollback':
          try { dbmod.transaction(() => { add('T-rb1'); add('T-rb2'); add('T-rb1'); }); } catch (e) { out.threw = true; }   // 3つ目は名前の重複で失敗する
          out.renames = renames; out.memAfter = names(); add('T-after-rollback'); out.renamesAfterNextRun = renames; break;
        case 'tx-async':
          try { dbmod.transaction(async () => { add('T-async'); }); } catch (e) { out.threw = true; }
          out.renames = renames; out.memAfter = names(); break;
        case 'crash-mid-write': case 'crash-before-rename': armed = true; add('T-lost'); break;
        case 'enospc-mid-write': armed = true; try { add('T-enospc'); } catch (e) { out.threw = e.code; } break;
        case 'locked': {
          fs.writeFileSync(path.join(workDir, 'child.ready'), 'x');
          for (let i = 0; i < 150 && !fs.existsSync(path.join(workDir, 'holder.ready')); i++) waitMs(100);
          out.holderSeen = fs.existsSync(path.join(workDir, 'holder.ready'));
          const t0 = Date.now();
          try { add('T-locked'); out.saved = true; } catch (e) { out.saved = false; out.threw = e.code; }
          out.elapsed_ms = Date.now() - t0;
          if (!out.saved) {
            while (fs.existsSync(path.join(workDir, 'holder.ready'))) waitMs(100);
            try { add('T-after-release'); out.savedAfterRelease = true; } catch (e) { out.savedAfterRelease = false; }
          }
          break;
        }
      }
    } catch (e) { out.unexpected = String(e.message).slice(0, 120); }
    done();
  })();
  return;
}

// ---------------------------------------------------------------- 親プロセス側
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hiyou-selftest-'));
const DB = path.join(workDir, 'selftest.db');
const TMP = DB + '.tmp';
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const childEnv = mode => ({ ...process.env, SELFTEST_CHILD: mode, SELFTEST_DIR: workDir });
const parse = stdout => { const l = String(stdout || '').split(/\r?\n/).find(x => x.startsWith('RESULT ')); return l ? JSON.parse(l.slice(7)) : {}; };
function child(mode) {
  const r = spawnSync(process.execPath, [__filename], { env: childEnv(mode), encoding: 'utf8', cwd: workDir });
  return { exit: r.status, res: parse(r.stdout) };
}
async function inspect(file) {
  if (!fs.existsSync(file)) return { state: 'ファイルなし', wards: [] };
  const bytes = fs.statSync(file).size;
  if (bytes === 0) return { state: '0バイト', wards: [] };
  try {
    const SQL = await require('sql.js')();
    const d = new SQL.Database(fs.readFileSync(file));
    const pages = d.exec('PRAGMA page_count')[0].values[0][0];
    const pageSize = d.exec('PRAGMA page_size')[0].values[0][0];
    const ok = d.exec('PRAGMA integrity_check')[0].values[0][0] === 'ok' && pages * pageSize === bytes;
    const wards = d.exec('SELECT name FROM wards ORDER BY id')[0].values.map(r => r[0]).filter(n => n.startsWith('T-'));
    d.close();
    return { state: ok ? '正常' : '破損', wards };
  } catch (e) { return { state: '読めない（' + String(e.message).slice(0, 40) + '）', wards: [] }; }
}
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) passed++; else failed++;
  console.log(`${cond ? '[合格]  ' : '[不合格]'} ${name}${detail ? `\n          → ${detail}` : ''}`);
}
const fresh = () => { for (const f of fs.readdirSync(workDir)) fs.rmSync(path.join(workDir, f), { force: true }); child('open'); child('run'); };

(async () => {
  const patched = /function transaction\s*\(/.test(fs.readFileSync(DATABASE_JS, 'utf8'));
  console.log(`対象: ${DATABASE_JS}`);
  console.log(`状態: ${patched ? '修正版（transaction あり）' : '修正前（transaction なし。下の一部は不合格になるのが正常）'} / Node ${process.version} / ${process.platform}`);
  console.log(`テスト用フォルダ: ${workDir}\n`);
  let c, f, before;

  c = child('open'); f = await inspect(DB);
  check('1. 新規起動でDBが作られ、一時ファイルが残らない', c.exit === 0 && f.state === '正常' && !fs.existsSync(TMP), `DB=${f.state}`);

  c = child('run'); f = await inspect(DB);
  check('2. 1件の更新がファイルに保存される', f.wards.includes('T-run'));

  if (patched) {
    c = child('tx-ok'); f = await inspect(DB);
    check('3. まとめて更新（3件）が全部保存され、ファイルの差し替えは1回だけ', c.res.renames === 1 && ['T-tx1', 'T-tx2', 'T-tx3'].every(n => f.wards.includes(n)) && c.res.returned === 'value', `差し替え回数=${c.res.renames}`);

    c = child('tx-rollback'); f = await inspect(DB);
    check('4. まとめて更新の途中で失敗したら全部取り消され、ファイルにも書かれない。その後の更新は普通に保存される',
      c.res.threw && c.res.renames === 0 && !c.res.memAfter.some(n => n.startsWith('T-rb')) && !f.wards.some(n => n.startsWith('T-rb')) && f.wards.includes('T-after-rollback') && c.res.renamesAfterNextRun === 1);

    before = sha(DB);
    c = child('tx-async'); f = await inspect(DB);
    check('5. まとめて更新の中で非同期処理を使うと拒否され、何も変更されない', c.res.threw && !f.wards.includes('T-async') && sha(DB) === before);
  } else {
    console.log('[省略]   3〜5（transaction が無いため）');
  }

  before = sha(DB);
  c = child('crash-mid-write'); f = await inspect(DB);
  check('6. 保存の書き込み途中（半分書いた時点）でプロセスが落ちても、DBファイルは直前の完全な内容のまま', c.exit !== 0 && f.state === '正常' && sha(DB) === before, `落ちた後のDB=${f.state}`);
  c = child('open');
  check('7. その後の再起動でDBを開ける', c.exit === 0 && !c.res.getDbError && (await inspect(DB)).state === '正常', c.res.getDbError ? `起動エラー: ${c.res.getDbError}` : '');
  if ((await inspect(DB)).state !== '正常') fresh();

  if (patched) {
    before = sha(DB);
    c = child('crash-before-rename'); f = await inspect(DB);
    check('8. 一時ファイルを書き終えて差し替える直前に落ちても、DBファイルは直前の完全な内容のまま', c.exit !== 0 && f.state === '正常' && sha(DB) === before, `一時ファイルが残っている=${fs.existsSync(TMP)}`);
    c = child('open');
    check('9. 一時ファイルが残った状態から再起動でき、一時ファイルは片付く', c.exit === 0 && (await inspect(DB)).state === '正常' && !fs.existsSync(TMP));
  } else {
    console.log('[省略]   8〜9（一時ファイル方式でないため）');
  }

  before = sha(DB);
  c = child('enospc-mid-write'); f = await inspect(DB);
  check('10. 保存の途中でディスク満杯（ENOSPC）になっても、エラーが返るだけでDBファイルは直前の完全な内容のまま', c.res.threw === 'ENOSPC' && f.state === '正常' && sha(DB) === before, `満杯の後のDB=${f.state}`);
  if (f.state !== '正常') fresh();

  fs.writeFileSync(DB, Buffer.alloc(0));
  c = child('open');
  check('11. DBファイルが0バイトのときは起動を止め、空のDBで上書きしない', !!c.res.getDbError && fs.statSync(DB).size === 0,
    c.res.getDbError ? `起動エラー: ${c.res.getDbError}` : `起動してしまった（ファイルは ${fs.statSync(DB).size} バイトの新しいDBに置き換わった）`);

  fresh();
  fs.writeFileSync(DB, fs.readFileSync(DB).subarray(0, 5000));
  c = child('open');
  check('12. DBファイルが途中で切れているときは起動を止め、上書きしない', !!c.res.getDbError && fs.statSync(DB).size === 5000, `起動エラー: ${c.res.getDbError || '(なし)'}`);

  if (process.platform === 'win32') {
    let n = 13;
    for (const [share, holdMs] of [['Read', 700], ['None', 700], ['Read', 4000]]) {
      fresh();
      for (const x of ['holder.ready', 'holder.failed', 'child.ready']) fs.rmSync(path.join(workDir, x), { force: true });
      const cp = spawn(process.execPath, [__filename], { env: childEnv('locked'), cwd: workDir });
      let cout = ''; cp.stdout.on('data', d => cout += d);
      const childExit = new Promise(r => cp.on('exit', r));
      for (let i = 0; i < 150 && !fs.existsSync(path.join(workDir, 'child.ready')); i++) await new Promise(r => setTimeout(r, 100));
      const q = p => p.replace(/'/g, "''");
      const ps = `$f=$null; for($i=0;$i -lt 40 -and -not $f;$i++){ try { $f=[System.IO.File]::Open('${q(DB)}','Open','Read','${share}') } catch { Start-Sleep -Milliseconds 50 } }; ` +
        `if(-not $f){ Set-Content -LiteralPath '${q(path.join(workDir, 'holder.failed'))}' x }; Set-Content -LiteralPath '${q(path.join(workDir, 'holder.ready'))}' x; ` +
        `Start-Sleep -Milliseconds ${holdMs}; if($f){ $f.Close() }; Remove-Item -LiteralPath '${q(path.join(workDir, 'holder.ready'))}'`;
      const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' });
      await Promise.all([childExit, new Promise(r => holder.on('exit', r))]);
      const res = parse(cout); f = await inspect(DB);
      const label = `${n++}. ほかのプログラムがDBファイルを ${holdMs / 1000} 秒間開いている（共有モード ${share}）間の保存: `;
      if (fs.existsSync(path.join(workDir, 'holder.failed')) || !res.holderSeen) { console.log(`[判定不能] ${label}ファイルをロックできなかった（もう一度実行してください）`); continue; }
      if (holdMs < 2000) check(label + '待ってから成功する', res.saved && f.wards.includes('T-locked'), `保存=${res.saved ? '成功' : '失敗(' + res.threw + ')'} 所要=${res.elapsed_ms}ms`);
      else check(label + '約2秒でエラーを返し、ファイルは無傷。解放後の次の保存で両方とも保存される',
        !res.saved && res.savedAfterRelease && f.state === '正常' && f.wards.includes('T-locked') && f.wards.includes('T-after-release'), `保存=${res.saved ? '成功' : '失敗(' + res.threw + ')'} 所要=${res.elapsed_ms}ms 解放後=${res.savedAfterRelease ? '成功' : '失敗'}`);
    }
  }

  // 同じ DB を2つのプロセスで開けない（開くと、それぞれがメモリ上の内容でファイル全体を書き出すので、互いの保存を消してしまう）。
  // このプロセスが「使用中」を宣言している間に、別のプロセスから同じ DB を開いて更新しようとする
  fresh();
  const guard = require(path.join(__dirname, '..', 'server', 'services', 'singleInstance.js'));
  const childAsync = mode => new Promise(resolve => {
    const cp = spawn(process.execPath, [__filename], { env: childEnv(mode), cwd: workDir });
    let cout = ''; cp.stdout.on('data', d => cout += d);
    cp.on('exit', code => resolve({ exit: code, res: parse(cout) }));
  });
  await guard.acquire(DB, 'tool');
  before = sha(DB);
  const mtimeBefore = fs.statSync(DB).mtimeMs;
  c = await childAsync('run');
  check('16. ほかのプロセスが使用中の DB は開かず、ファイルも書き換えない（2つのプロセスが同じ DB を開くと、互いの保存を上書きして入力が消える）',
    /使用中/.test(String(c.res.getDbError || '')) && sha(DB) === before && fs.statSync(DB).mtimeMs === mtimeBefore,
    `起動エラー: ${c.res.getDbError || '(なし。開いてしまった)'}`);
  await guard.release(DB);
  c = await childAsync('open');
  check('17. 使用中でなくなれば、開ける', c.exit === 0 && !c.res.getDbError && Array.isArray(c.res.wards));
  if (process.platform === 'win32') {
    // 共有フォルダ越し（\\サーバー\共有\… の形）の DB は開かない。同じファイルでも機械や書き方によって別の扱いになり、二重に開くことを防げないため
    const codes = [];
    for (const p of ['\\\\localhost\\share\\data\\hiyou.db', '\\\\?\\UNC\\nas01\\share\\hiyou.db', '//nas01/share/hiyou.db']) {
      try { await guard.acquire(p, 'tool'); codes.push('開いた'); } catch (e) { codes.push(e.code); }
    }
    check('18. DB の場所がネットワーク上（\\\\サーバー\\共有\\… の形）のときは、開かない', codes.every(x => x === 'DB_ON_NETWORK') &&
      !guard.isNetworkPath('C:\\hiyou\\data\\hiyou.db') && !guard.isNetworkPath('\\\\?\\C:\\hiyou\\data\\hiyou.db'), codes.join(','));
  }

  fs.rmSync(workDir, { recursive: true, force: true });
  console.log(`\n結果: 合格 ${passed} / 不合格 ${failed}${failed ? '' : '（全項目合格）'}`);
  process.exit(failed ? 1 : 0);
})();
