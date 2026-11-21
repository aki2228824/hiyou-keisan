// ログインに続けて失敗したユーザーIDを、一定時間ログインできなくする（総当たり対策）。
//
// ・失敗の回数はメモリ上だけで数える（DBには書かない）。sql.js は更新のたびにDB全体をファイルへ書き出すので、
//   未ログインの人が起こせる「ログイン失敗」でDBを書き換えると、それだけでサーバーを重くできてしまうため。
//   サーバーを再起動すると回数とロックは消える（＝再起動がロックの緊急解除を兼ねる）。
// ・数える単位は「入力されたユーザーIDの文字列」。実在しないIDでも同じように数えてロックするので、
//   ロックされるかどうかで「そのIDが実在するか」を外から調べることはできない。
// ・ロック中は、正しいパスワードでもログインできない（そうしないと総当たりを止められない）。

const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_LOCK_MINUTES = 15;
const MAX_UNKNOWN_ENTRIES = 5000;   // 実在しないIDの記録の上限（でたらめなIDを大量に送ってメモリを埋められないように）

function envInt(name, min, max, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

// 時計を戻されても影響を受けないよう、経過時間は「起動してからのミリ秒」で数える
const monotonicNow = () => Number(process.hrtime.bigint() / 1000000n);

/**
 * @param {{ maxFailures?: number, lockMs?: number, now?: () => number }} [opts]  テスト用に差し替えられる
 */
function createLockout(opts = {}) {
  const maxFailures = opts.maxFailures ?? envInt('LOGIN_MAX_FAILURES', 3, 20, DEFAULT_MAX_FAILURES);
  const lockMs = opts.lockMs ?? envInt('LOGIN_LOCK_MINUTES', 1, 1440, DEFAULT_LOCK_MINUTES) * 60 * 1000;
  const now = opts.now ?? monotonicNow;
  const entries = new Map();   // ユーザーID → { count, lastAt, lockedUntil, known }

  // 期限の切れた記録を捨てて、有効な記録だけを返す
  function current(key) {
    const e = entries.get(key);
    if (!e) return null;
    const t = now();
    const expired = e.lockedUntil ? e.lockedUntil <= t : t - e.lastAt > lockMs;
    if (expired) { entries.delete(key); return null; }
    return e;
  }

  // ロック中なら残り秒数（1以上）、ロックされていなければ 0
  function lockedSeconds(key) {
    const e = current(key);
    return e && e.lockedUntil ? Math.max(1, Math.ceil((e.lockedUntil - now()) / 1000)) : 0;
  }

  /**
   * ログインの照合を始める前に呼ぶ。この時点で「失敗1回」として数えておき、成功したら succeed() で取り消す。
   * （照合が終わってから数えると、同時に大量の要求を送って上限より多く試せてしまうため）
   * @param {boolean} known  そのIDの有効なユーザーが実在するか
   * @returns {{ allowed: true } | { allowed: false, seconds: number }}
   */
  function begin(key, known) {
    const seconds = lockedSeconds(key);
    if (seconds) return { allowed: false, seconds };
    let e = current(key);
    if (!e) {
      e = { count: 0, lastAt: 0, lockedUntil: 0, known: !!known };
      entries.set(key, e);
      evictIfNeeded();
    }
    e.known = e.known || !!known;
    e.count++;
    e.lastAt = now();
    if (e.count > maxFailures) {   // 同時に来た要求が上限を超えた分。照合せずに断る
      e.lockedUntil = now() + lockMs;
      return { allowed: false, seconds: Math.ceil(lockMs / 1000) };
    }
    return { allowed: true };
  }

  // 照合に失敗したときに呼ぶ。この失敗で上限に達したらロックする
  // @returns {{ locked: boolean, seconds: number, remaining: number }} remaining = ロックまでの残り回数
  function fail(key) {
    const e = entries.get(key);
    if (!e) return { locked: false, seconds: 0, remaining: maxFailures };
    if (e.count >= maxFailures && !e.lockedUntil) e.lockedUntil = now() + lockMs;
    return {
      locked: !!e.lockedUntil,
      seconds: e.lockedUntil ? Math.max(1, Math.ceil((e.lockedUntil - now()) / 1000)) : 0,
      remaining: Math.max(0, maxFailures - e.count),
    };
  }

  // ログインに成功したら数え直す
  function succeed(key) { entries.delete(key); }

  // 管理者によるロック解除（パスワードの変更時も呼ぶ）。ロックされていたら true
  function unlock(key) {
    const wasLocked = lockedSeconds(key) > 0;
    entries.delete(key);
    return wasLocked;
  }

  // 実在しないIDの記録が増えすぎたら、古いものから捨てる（実在するユーザーの記録は捨てない）
  function evictIfNeeded() {
    if (entries.size <= MAX_UNKNOWN_ENTRIES) return;
    for (const [key, e] of entries) {
      if (entries.size <= MAX_UNKNOWN_ENTRIES) break;
      if (!e.known) entries.delete(key);
    }
  }

  return {
    begin, fail, succeed, unlock, lockedSeconds,
    maxFailures, lockMinutes: Math.round(lockMs / 60000),
    _size: () => entries.size,
  };
}

module.exports = { ...createLockout(), createLockout };
