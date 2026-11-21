// パスワードの強度チェック。ユーザーの追加時と、パスワードの変更時に適用する（routes/users.js）。
// ログイン時にも同じ基準で確かめ、満たしていなければ画面に注意を出す（routes/auth.js）。
//
// 基準の出どころ: 厚生労働省「医療情報システムの安全管理に関するガイドライン 第7.0版」システム運用編 14章
//   ・二要素認証を採用していない場合は 13 桁以上。英数字の混在を求める（大文字小文字は問わない）
//   ・類推されやすいパスワードを使用させないよう、設定可能なパスワードに制限を設ける
//   ・定期的な変更は不要
// 文字数だけは .env の PASSWORD_MIN_LENGTH で変えられる（既定 13。8 未満にはできない）。
// 初回起動時に自動で作られる admin / admin123 はこの基準の対象外（配置手順のとおり、LAN に開ける前に変更する）。

const DEFAULT_MIN_LENGTH = 13;
const MIN_LENGTH_FLOOR = 8;    // これより短い設定は受け付けない（二要素認証がある場合の下限）
const MIN_LENGTH_CEIL = 64;
const MAX_BYTES = 72;          // bcrypt が見るのは先頭72バイトまで。それより長い部分は黙って無視されるので、登録させない

// 推測されやすい文字列（小文字にして比較する。数字や記号で置き換えた書き方 pa55w0rd なども、文字に戻して比べる）
const WEAK_WORDS = [
  'password', 'pasuwado', 'admin', 'administrator', 'root', 'guest', 'login',
  'welcome', 'letmein', 'iloveyou', 'hiyou', 'keisan', 'byouin', 'hospital', 'ryouyou', 'kaigo',
  // キーボードの並び
  'qwert', 'asdfg', 'zxcvb', 'qazwsx', 'wsxedc', '1q2w3e', 'q1w2e3', 'zaq1', '1qaz', '2wsx', 'xsw2',
];

// 数字・記号で置き換えた書き方を、元の文字に戻す（5→s、0→o、1→i、3→e、4→a、@→a、$→s、7→t）
const LEET = { 5: 's', 0: 'o', 1: 'i', 3: 'e', 4: 'a', '@': 'a', $: 's', 7: 't' };
const unleet = text => text.replace(/[501347@$]/g, c => LEET[c]);

// 同じ並びの繰り返しでできているか（abc123abc123a、Abcd1234Abcd1 など）。
// 「前から p 文字ずらしても同じ」になる p があり、繰り返されている部分が全体の3分の1以上なら、繰り返しとみなす
function isRepeatedPattern(text) {
  for (let p = 1; p <= Math.floor(text.length * 2 / 3); p++) {
    let same = true;
    for (let i = p; i < text.length && same; i++) same = text[i] === text[i - p];
    if (same) return true;
  }
  return false;
}

function minLength() {
  const raw = process.env.PASSWORD_MIN_LENGTH;
  if (raw == null || String(raw).trim() === '') return DEFAULT_MIN_LENGTH;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_MIN_LENGTH;
  return Math.min(Math.max(n, MIN_LENGTH_FLOOR), MIN_LENGTH_CEIL);
}

// 12345 / abcde / 54321 のような「隣の文字へ1つずつ進む（戻る）並び」が length 文字以上続くか
function hasSequentialRun(lower, length) {
  let up = 1, down = 1;
  for (let i = 1; i < lower.length; i++) {
    const both = /[a-z0-9]/.test(lower[i]) && /[a-z0-9]/.test(lower[i - 1]);
    const step = lower.charCodeAt(i) - lower.charCodeAt(i - 1);
    up = both && step === 1 ? up + 1 : 1;
    down = both && step === -1 ? down + 1 : 1;
    if (up >= length || down >= length) return true;
  }
  return false;
}

/**
 * パスワードが基準を満たすか調べる。
 * @param {string} password
 * @param {{ username?: string }} [opts]  username を渡すと「ユーザーIDを含まない」も確かめる
 * @returns {string[]} 満たしていない点の一覧（空なら合格）
 */
function check(password, opts = {}) {
  if (typeof password !== 'string' || password === '') return ['パスワードを入力してください'];
  const errors = [];
  const min = minLength();
  const chars = [...password];

  if (!/^[\x20-\x7e]+$/.test(password))
    errors.push('半角の英字・数字・記号だけを使ってください（全角文字・日本語・改行は使えません）');
  if (password !== password.trim())
    errors.push('先頭と末尾に空白は使えません');
  if (chars.length < min)
    errors.push(`${min}文字以上にしてください（いま ${chars.length} 文字）`);
  if (Buffer.byteLength(password, 'utf8') > MAX_BYTES)
    errors.push(`長すぎます（${MAX_BYTES}文字まで）`);

  const missing = [];
  if (!/[A-Za-z]/.test(password)) missing.push('英字');
  if (!/[0-9]/.test(password)) missing.push('数字');
  if (missing.length)
    errors.push(`英字と数字を両方入れてください（足りないもの: ${missing.join('・')}）`);

  const lower = password.toLowerCase();
  const username = String(opts.username ?? '').trim().toLowerCase();
  if (username.length >= 3 && lower.includes(username))
    errors.push('ユーザーIDを含めないでください');
  const plain = unleet(lower);
  if (WEAK_WORDS.some(w => lower.includes(w) || plain.includes(w)))
    errors.push('推測されやすい文字列（password、qwerty、admin など。pa55word のように数字や記号で置き換えたものも含む）を含めないでください');
  if (/(.)\1{3,}/.test(password) || hasSequentialRun(lower, 5))
    errors.push('同じ文字の4回以上の連続（aaaa）や、順番に並んだ文字（12345、abcde）を含めないでください');
  if (isRepeatedPattern(lower))
    errors.push('同じ並びの繰り返し（abc123abc123 など）は使えません');
  if (new Set(chars).size < 6)
    errors.push('使っている文字の種類が少なすぎます（6種類以上の文字を使ってください）');

  return errors;
}

// 画面に出す説明（ユーザー管理の入力欄のそば、ログイン時の注意）
function describe() {
  return `${minLength()}文字以上。半角の英字と数字を両方含める（記号も使えます）。` +
    'ユーザーIDや、password・12345 などの推測されやすい文字列は使えません。';
}

// 400 で返すメッセージ
function errorMessage(errors) {
  return 'パスワードが基準を満たしていません。\n' + errors.map(e => '・' + e).join('\n');
}

module.exports = { check, describe, errorMessage, minLength };
