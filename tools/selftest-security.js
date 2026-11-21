// パスワードの基準・ログイン失敗時のロック・操作ログの自己テスト。
//   node tools/selftest-security.js
// ・サーバーを起動せず、ポートも使わない。本番のデータ・操作ログには一切触れない
//   （操作ログは OS の一時フォルダに書き、終わったら消す）。サーバーの稼働中に実行してもよい。所要 数秒。
// ・サーバーと画面を通した確認は tools/smoke-test.js が行う。ここでは部品ごとの細かい条件を確かめる。
// 終了コード: 0 = 全項目合格 / 1 = 不合格あり
const fs = require('fs');
const os = require('os');
const path = require('path');

// .env の設定に左右されないよう、既定値で確かめる
delete process.env.PASSWORD_MIN_LENGTH;
delete process.env.LOGIN_MAX_FAILURES;
delete process.env.LOGIN_LOCK_MINUTES;
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hiyou-selftest-sec-'));
process.env.AUDIT_LOG_DIR = path.join(workDir, 'audit');

const policy = require('../server/services/passwordPolicy');
const { createLockout } = require('../server/services/loginLockout');
const audit = require('../server/services/auditLog');
const { classify } = require('../server/middleware/audit');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) passed++; else failed++;
  console.log(`${cond ? '[合格]  ' : '[不合格]'} ${name}${detail ? `\n          → ${detail}` : ''}`);
}

(async () => {
  console.log(`テスト用フォルダ: ${workDir} / Node ${process.version}\n`);

  // ---------------------------------------------------------------- パスワードの基準
  const ok = (pw, username = 'tanaka') => policy.check(pw, { username }).length === 0;
  const why = (pw, username = 'tanaka') => policy.check(pw, { username }).join(' / ');
  check('1. 基準を満たすパスワードは通る（13文字以上・英字と数字。記号は無くてもよい）',
    ok('Sakura-2026-Haru') && ok('kaze7mori2yuki9sora') && ok('Tb9!mQz2@Lw5xR'));
  check('2. 12文字以下は通らない', !ok('Sakura-26-Ha') && /13文字以上/.test(why('admin123')), why('admin123'));
  check('3. 英字だけ・数字だけは通らない', !ok('sakuranohanagasaku') && !ok('8203917465028') && /足りないもの: 数字/.test(why('sakuranohanagasaku')));
  check('4. ユーザーIDを含むものは通らない（大文字・小文字を区別しない）', !ok('Tanaka-2026-Haru') && ok('Tanaka-2026-Haru', 'suzuki'));
  check('5. 推測されやすい文字列を含むものは通らない', !ok('Password-2026-x9') && !ok('Qwerty-kensa-7391') && !ok('hiyou-kensa-7391z'));
  check('6. 同じ文字の連続・順番に並んだ文字を含むものは通らない', !ok('Kensaaaa-you-7391') && !ok('Kensa-12345-yoyaku') && !ok('Kensa-edcba-7391z'));
  check('7. 文字の種類が少なすぎるものは通らない', !ok('A1b2A1b2A1b2A1b2'));
  check('8. 全角文字・先頭や末尾の空白は通らない', !ok('Ｓakura-2026-Haru') && !ok(' Sakura-2026-Haru') && !ok('さくら-2026-Haru-xyz'));
  check('9. 72バイトを超えるものは通らない（bcrypt が先頭72バイトしか見ないため）', !ok('Ab1-' + 'kensayou'.repeat(9)) && ok('Ab1-' + 'kensayou'.repeat(8)));
  check('10. 文字列以外・空は通らない', !ok(12345678901234) && !ok('') && !ok(null));
  process.env.PASSWORD_MIN_LENGTH = '4';
  const floor = policy.minLength();
  process.env.PASSWORD_MIN_LENGTH = '16';
  const raised = policy.minLength();
  delete process.env.PASSWORD_MIN_LENGTH;
  check('11. PASSWORD_MIN_LENGTH: 8 未満には下げられない。上げることはできる', floor === 8 && raised === 16 && policy.minLength() === 13, `4 → ${floor}、16 → ${raised}、未設定 → ${policy.minLength()}`);

  // ---------------------------------------------------------------- ログイン失敗時のロック（時刻を差し替えて確かめる）
  let t = 0;
  const make = () => createLockout({ maxFailures: 5, lockMs: 15 * 60000, now: () => t });
  let L = make();
  const failOnce = (lock, id) => { const gate = lock.begin(id, true); return gate.allowed ? lock.fail(id) : { refused: true }; };
  const states = [1, 2, 3, 4, 5].map(() => failOnce(L, 'u'));
  check('12. 4回目までの失敗ではロックされず、5回目でロックされる', states.slice(0, 4).every(s => !s.locked) && states[4].locked && states[4].seconds === 900,
    states.map(s => (s.locked ? 'ロック' : `残り${s.remaining}`)).join(', '));
  check('13. ロック中は、照合する前に断られる（正しいパスワードでも入れない）', L.begin('u', true).allowed === false && L.lockedSeconds('u') === 900);
  check('14. ほかのユーザーIDには影響しない', L.begin('v', true).allowed === true);
  t += 15 * 60000 - 1000;
  const before = L.lockedSeconds('u');
  t += 1000;
  check('15. 15分たつと自動で解除される', before === 1 && L.lockedSeconds('u') === 0 && L.begin('u', true).allowed === true);
  L = make();
  for (let i = 0; i < 4; i++) failOnce(L, 'u');
  L.begin('u', true); L.succeed('u');
  check('16. ログインに成功すると失敗の回数は数え直しになる', failOnce(L, 'u').remaining === 4);
  L = make();
  for (let i = 0; i < 4; i++) failOnce(L, 'u');
  t += 15 * 60000 + 1;
  check('17. 15分より前の失敗は数えない', failOnce(L, 'u').remaining === 4);
  L = make();
  const gates = Array.from({ length: 12 }, () => L.begin('u', true).allowed);
  check('18. 同時に大量の要求を送っても、照合されるのは5回まで', gates.filter(Boolean).length === 5 && L.lockedSeconds('u') > 0, gates.map(g => (g ? '○' : '×')).join(''));
  L = make();
  for (let i = 0; i < 5; i++) failOnce(L, 'u');
  check('19. 管理者による解除でロックが消える', L.unlock('u') === true && L.lockedSeconds('u') === 0 && L.unlock('u') === false);
  L = make();
  for (let i = 0; i < 5; i++) failOnce(L, 'ghost');   // 実在しないID（known = false で数える）
  const ghost = createLockout({ maxFailures: 5, lockMs: 60000, now: () => t });
  const ghostStates = [1, 2, 3, 4, 5].map(() => { const g = ghost.begin('nobody', false); return g.allowed ? ghost.fail('nobody') : g; });
  check('20. 実在しないユーザーIDも同じ回数でロックされる（IDが実在するかを外から調べられない）', ghostStates[4].locked === true && ghost.begin('nobody', false).allowed === false);
  L = make();
  failOnce(L, 'real');
  for (let i = 0; i < 5200; i++) L.begin('junk' + i, false);
  check('21. でたらめなIDを大量に送られても記録は 5,000 件までで、実在するユーザーの記録は消えない', L._size() <= 5001 && failOnce(L, 'real').remaining === 3, `記録数 ${L._size()}`);

  // ---------------------------------------------------------------- 操作ログ
  const dir = audit.init(path.join(workDir, 'hiyou.db'));
  check('22. 保存先フォルダが作られる', dir === process.env.AUDIT_LOG_DIR && fs.existsSync(dir));
  const req = (o = {}) => ({ ip: '::ffff:192.168.1.23', method: 'POST', originalUrl: '/api/records?x=1', session: { user: { id: 3, username: 'tanaka', role: 'staff' } }, ...o });
  const SECRET = 'Himitsu-no-pasuwa-do-1';
  audit.record(req(), 'records.save', { status: 200, ms: 12, patient_id: 8, detail: { record_date: '2026-11-20', items: [{ item_id: 1, quantity: 2 }] } });
  audit.record(req({ originalUrl: '/api/users/5' , method: 'PUT' }), 'users.update', { status: 200, target: 5, detail: { username: 'suzuki', password: SECRET, nested: { newPassword: SECRET }, memo: 'あ'.repeat(500) } });
  audit.record(req({ session: null, originalUrl: '/api/auth/login' }), 'login.failure', { user: 'evil"\n{"t":"2000-01-01T00:00:00.000+09:00","user":"admin","action":"login.success"}', status: 401 });
  audit.record(req({ method: 'GET', originalUrl: '/api/pdf?patient_id=8&year=2026&month=8' }), 'pdf.export', { status: 200, patient_id: 8, detail: { year: '2026', month: '8' }, aborted: true });
  audit.recordSystem('server.start', { node: process.version });
  const today = audit.localIso(new Date()).slice(0, 10);
  const file = path.join(dir, `audit-${today.slice(0, 7)}.jsonl`);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const first = JSON.parse(lines[0]);
  check('23. 1件が1行の JSON で、日時（時差つき）・ユーザー・接続元・操作・対象が入る',
    lines.length === 5 && lines.every(l => l.startsWith('{"t":"')) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/.test(first.t) &&
    first.user === 'tanaka' && first.role === 'staff' && first.ip === '192.168.1.23' && first.action === 'records.save' && first.patient_id === 8 && first.path === '/api/records',
    lines[0].slice(0, 200));
  check('24. パスワードは記録されない（*** に置き換わる）', !fs.readFileSync(file, 'utf8').includes(SECRET) && lines[1].includes('"password":"***"') && lines[1].includes('"newPassword":"***"'));
  check('25. 長い文字列は切られる', JSON.parse(lines[1]).detail.memo.length === 201);
  check('26. 入力に改行を混ぜても、にせの記録（行）を作れない', lines.length === 5 && JSON.parse(lines[2]).user.includes('\n') && JSON.parse(lines[2]).action === 'login.failure');
  check('27. 大きすぎる内容は、決まった長さで打ち切られる',
    (() => { audit.record(req(), 'other', { status: 400, detail: { big: Array.from({ length: 50 }, (_, i) => 'x'.repeat(190) + i) } }); const l = fs.readFileSync(file, 'utf8').trim().split('\n').pop(); return l.length < 2600 && JSON.parse(l).detail['省略'] === true; })());

  let r = await audit.read({ from: today, to: today, limit: 500 });
  check('28. 読み出しは新しい順', r.rows.length === 6 && r.rows[0].action === 'other' && r.rows[5].action === 'records.save' && r.total === 6 && !r.truncated);
  r = await audit.read({ from: today, to: today, user: 'tanaka', limit: 500 });
  const byUser = r.rows.length;
  r = await audit.read({ from: today, to: today, kind: 'denied', limit: 500 });
  const denied = r.rows.map(x => x.action).join(',');
  r = await audit.read({ from: today, to: today, kind: 'view', limit: 500 });
  const viewed = r.rows.map(x => x.action).join(',');
  r = await audit.read({ from: today, to: today, q: 'USERS.UPDATE', limit: 500 });
  check('29. ユーザー・種類・キーワードで絞り込める', byUser === 4 && denied === 'other,login.failure' && viewed === 'pdf.export' && r.rows.length === 1, `ユーザー ${byUser} 件 / 断られた操作 ${denied} / 表示 ${viewed}`);
  r = await audit.read({ from: today, to: today, limit: 2 });
  check('30. 件数の上限を超えたら、新しいものを残して「一部である」ことが分かる', r.rows.length === 2 && r.truncated && r.total === 6 && r.rows[0].action === 'other' && r.rows[1].action === 'server.start');
  r = await audit.read({ from: '2020-01-01', to: '2020-12-31', limit: 10 });
  check('31. 記録の無い期間は 0 件', r.rows.length === 0 && r.total === 0);
  fs.appendFileSync(file, '{"t":"' + today + 'T23:59:59.000+09:00","user":"途中で切れた行\n');
  r = await audit.read({ from: today, to: today, limit: 500 });
  check('32. 途中で切れた行（停電の瞬間など）があっても、ほかの記録は読める', r.rows.length === 6);

  // 月が変わったら次の月のファイルへ
  const nextMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1, 0, 0, 5);
  audit.write({ user: null, action: 'server.start' }, nextMonth);
  const nextFile = path.join(dir, `audit-${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}.jsonl`);
  check('33. 月が変わると、新しい月のファイルに書かれる', fs.existsSync(nextFile) && fs.readFileSync(nextFile, 'utf8').trim().split('\n').length === 1, path.basename(nextFile));

  // 書き込み中のファイルを消されても、作り直して書き続ける
  audit._test.setCheckInterval(0);
  audit.recordSystem('server.start', { step: '消す前' });
  audit._test.close();
  fs.rmSync(file, { force: true });
  const wroteAfterDelete = audit.recordSystem('server.start', { step: '消した後' });
  check('34. ログのファイルを消されても、作り直して書き続ける', wroteAfterDelete && fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('消した後'));

  // 保存先が使えなくなっても例外にならず、失敗した件数が分かる。直ったら書き込みを再開する
  audit._test.close();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.writeFileSync(dir, 'フォルダの代わりにファイルを置いて、書き込めない状態を作る');
  const realError = console.error; let reported = '';
  console.error = (...a) => { reported += a.join(' '); };
  const wroteWhileBroken = audit.recordSystem('server.start', { step: '保存先が壊れている間' });
  console.error = realError;
  const broken = audit.status();
  fs.rmSync(dir, { force: true });
  fs.mkdirSync(dir, { recursive: true });
  const wroteAfterRepair = audit.recordSystem('server.start', { step: '直した後' });
  check('35. 保存先に書けなくても処理は止まらず、失敗した件数と理由が残る。直れば書き込みを再開する',
    wroteWhileBroken === false && broken.failedCount === 1 && !!broken.lastError && /操作ログを書き込めません/.test(reported) && wroteAfterRepair === true,
    `失敗 ${broken.failedCount} 件（${broken.lastError && broken.lastError.message}）`);
  audit._test.close();

  // ---------------------------------------------------------------- どのリクエストを記録するか
  const kind = (m, p) => { const c = classify(m, p); return c ? c.action : null; };
  check('36. 登録・変更・削除と、患者の情報の表示・出力は記録の対象',
    kind('POST', '/api/records') === 'records.save' && kind('GET', '/api/records') === 'records.view' && kind('GET', '/api/records/summary') === 'summary.view' &&
    kind('GET', '/api/pdf') === 'pdf.export' && kind('GET', '/api/patients') === 'patients.list' && kind('DELETE', '/api/patients/12') === 'patients.delete' &&
    kind('PUT', '/api/users/3') === 'users.update' && kind('POST', '/api/users/3/unlock') === 'users.unlock' && kind('GET', '/api/audit') === 'audit.view');
  check('37. 大文字・小文字や末尾の / を変えても記録される（Express は区別しないため）', kind('GET', '/API/Patients/') === 'patients.list' && kind('get'.toUpperCase(), '/Api/PDF') === 'pdf.export');
  check('38. 参照用データの表示・画面のファイル・ログイン関係（別に記録する）は、この仕組みでは記録しない',
    kind('GET', '/api/wards') === null && kind('GET', '/api/items') === null && kind('GET', '/api/items/prices') === null &&
    kind('GET', '/css/style.css') === null && kind('GET', '/') === null && kind('POST', '/api/auth/login') === null && kind('GET', '/api/auth/me') === null);
  check('39. 一覧に無い API でも、GET 以外は「その他」として記録する', kind('DELETE', '/api/unknown') === 'other' && kind('POST', '/api/items/abc') === 'other');

  try { fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (_) { console.log(`テスト用フォルダを消せませんでした: ${workDir}`); }
  console.log(`\n結果: 合格 ${passed} / 不合格 ${failed}${failed ? '' : '（全項目合格）'}`);
  process.exitCode = failed ? 1 : 0;
})().catch(err => { console.error('自己テストが途中で止まりました:', err); process.exitCode = 1; });
