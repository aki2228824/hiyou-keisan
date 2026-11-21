// ログインに続けて失敗したユーザーIDを、一定時間ログインできなくする（総当たり対策）。
//
// ロックの単位は2段階:
//   ① 「ユーザーID ＋ 接続元（IPアドレス）」ごと … maxFailures 回続けて失敗すると、その接続元からそのIDへのログインを止める
//   ② ユーザーIDごと（すべての接続元の合計）… maxFailures × GLOBAL_FACTOR 回の失敗で、そのIDへのログインをどこからでも止める
// ①だけだと、接続元を変えながら試せば回数の制限をすり抜けられる。
// ②だけだと、だれかが1台のPCからわざと間違え続けるだけで、本人や管理者までログインできなくなる。そこで両方を組み合わせる。
//
// ・失敗の回数はメモリ上だけで数える（DBには書かない）。sql.js は更新のたびにDB全体をファイルへ書き出すので、
//   未ログインの人が起こせる「ログイン失敗」でDBを書き換えると、それだけでサーバーを重くできてしまうため。
//   サーバーを再起動すると回数とロックは消える（＝再起動がロックの緊急解除を兼ねる）。
// ・実在しないユーザーIDでも同じように数えてロックするので、ロックされるかどうかで
//   「そのIDが実在するか」を外から調べることはできない。
// ・ロック中は、正しいパスワードでもログインできない（そうしないと総当たりを止められない）。
// ・数えるのは、過去 lockMs の間の失敗だけ（それより前の失敗は数えない）。

const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_LOCK_MINUTES = 15;
const GLOBAL_FACTOR = 4;        // ②の回数 = ①の回数 × これ（既定では 20 回）
const MAX_ENTRIES = 100000;     // 記録の数の上限（メモリを使い切らないための安全弁。通常は期限切れの掃除だけで収まる）

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
 * @param {{ maxFailures?: number, lockMs?: number, now?: () => number, maxEntries?: number }} [opts]  テスト用に差し替えられる
 */
function createLockout(opts = {}) {
  const maxFailures = opts.maxFailures ?? envInt('LOGIN_MAX_FAILURES', 3, 20, DEFAULT_MAX_FAILURES);
  const lockMs = opts.lockMs ?? envInt('LOGIN_LOCK_MINUTES', 1, 1440, DEFAULT_LOCK_MINUTES) * 60 * 1000;
  const now = opts.now ?? monotonicNow;
  const maxEntries = opts.maxEntries ?? MAX_ENTRIES;
  const globalLimit = maxFailures * GLOBAL_FACTOR;
  // 記録: キー → { times: 失敗（と照合中の試行）の時刻の一覧, lockedUntil: ロックの終わり（0 = ロックなし） }
  //   'P' + ID + '\n' + 接続元 … ①の記録 / 'G' + ID … ②の記録
  const entries = new Map();
  const pairKey = (id, ip) => 'P' + id + '\n' + ip;
  const globalKey = id => 'G' + id;

  // 古い失敗と、終わったロックを片付けてから、その記録を返す（無ければ null）
  function current(key) {
    const e = entries.get(key);
    if (!e) return null;
    const t = now();
    if (e.lockedUntil && e.lockedUntil <= t) { entries.delete(key); return null; }   // ロックが明けたら数え直し
    if (!e.lockedUntil) {
      while (e.times.length && t - e.times[0] > lockMs) e.times.shift();
      if (!e.times.length) { entries.delete(key); return null; }
    }
    return e;
  }

  function ensure(key) {
    let e = current(key);
    if (!e) {
      e = { times: [], lockedUntil: 0 };
      entries.set(key, e);
    }
    return e;
  }

  const secondsLeft = e => (e && e.lockedUntil ? Math.max(1, Math.ceil((e.lockedUntil - now()) / 1000)) : 0);

  /**
   * ログインの照合を始める前に呼ぶ。この時点で「失敗1回」として数えておき、成功したら succeed() で取り消す。
   * （照合が終わってから数えると、同時に大量の要求を送って上限より多く試せてしまうため）
   * @returns {{ allowed: true, token: number } | { allowed: false, seconds: number }}
   */
  function begin(id, ip) {
    const locked = Math.max(secondsLeft(current(globalKey(id))), secondsLeft(current(pairKey(id, ip))));
    if (locked) return { allowed: false, seconds: locked };
    if (entries.size >= maxEntries) sweep();   // 新しい記録を作る前に掃除する（作った直後の空の記録を消さないように）
    const pair = ensure(pairKey(id, ip));
    const global = ensure(globalKey(id));
    // 同時に来た要求が上限を超えた分は、照合せずに断る
    if (pair.times.length >= maxFailures) { pair.lockedUntil = now() + lockMs; return { allowed: false, seconds: Math.ceil(lockMs / 1000) }; }
    if (global.times.length >= globalLimit) { global.lockedUntil = now() + lockMs; return { allowed: false, seconds: Math.ceil(lockMs / 1000) }; }
    const token = now();
    pair.times.push(token);
    global.times.push(token);
    return { allowed: true, token };
  }

  /**
   * 照合に失敗したときに呼ぶ。この失敗で上限に達したらロックする。
   * @returns {{ locked: boolean, seconds: number, remaining: number }} remaining = この接続元から、ロックまでに残っている回数
   */
  function fail(id, ip) {
    const pair = entries.get(pairKey(id, ip));
    const global = entries.get(globalKey(id));
    if (pair && !pair.lockedUntil && pair.times.length >= maxFailures) pair.lockedUntil = now() + lockMs;
    if (global && !global.lockedUntil && global.times.length >= globalLimit) global.lockedUntil = now() + lockMs;
    const seconds = Math.max(secondsLeft(pair), secondsLeft(global));
    return { locked: seconds > 0, seconds, remaining: Math.max(0, maxFailures - (pair ? pair.times.length : 0)) };
  }

  // ログインに成功したら、その接続元の回数は数え直しにする。全体の回数（②）からは、今回の試行の分だけを取り消す
  function succeed(id, ip, token) {
    entries.delete(pairKey(id, ip));
    const global = entries.get(globalKey(id));
    if (global && !global.lockedUntil) {
      const i = global.times.lastIndexOf(token);
      if (i >= 0) global.times.splice(i, 1);
      if (!global.times.length) entries.delete(globalKey(id));
    }
  }

  // そのユーザーIDに関係する記録のキー（①は接続元ごとにあるので、全部を拾う）
  function keysOf(id) {
    const prefix = 'P' + id + '\n';
    const keys = [];
    for (const key of entries.keys()) if (key === globalKey(id) || key.startsWith(prefix)) keys.push(key);
    return keys;
  }

  // そのユーザーIDが（どこかの接続元から、または全体として）ロック中なら、解除までの残り秒数の最大値。ロックが無ければ 0
  function lockedSeconds(id) {
    let seconds = 0;
    for (const key of keysOf(id)) seconds = Math.max(seconds, secondsLeft(current(key)));
    return seconds;
  }

  // 管理者によるロック解除（パスワードの変更時も呼ぶ）。そのユーザーIDの回数とロックをすべて消す。ロックされていたら true
  function unlock(id) {
    const wasLocked = lockedSeconds(id) > 0;
    for (const key of keysOf(id)) entries.delete(key);
    return wasLocked;
  }

  // 期限の切れた記録を捨てる。それでも上限を超えていたら、ロック中でないものを古い順に捨てる
  // （ロック中の記録は、実在するIDかどうかに関係なく残す。捨てると「ロックが消えた＝実在しないID」と見分けられてしまう）
  function sweep() {
    for (const key of [...entries.keys()]) current(key);
    if (entries.size <= maxEntries) return;
    for (const [key, e] of entries) {
      if (entries.size <= maxEntries) return;
      if (!e.lockedUntil) entries.delete(key);
    }
    for (const key of entries.keys()) {   // すべてロック中という極端な場合だけ、古い順に捨てる
      if (entries.size <= maxEntries) return;
      entries.delete(key);
    }
  }

  return {
    begin, fail, succeed, unlock, lockedSeconds,
    maxFailures, globalLimit, lockMinutes: Math.round(lockMs / 60000),
    _size: () => entries.size,
  };
}

module.exports = { ...createLockout(), createLockout };
