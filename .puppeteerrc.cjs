const { join } = require('path');

/**
 * Puppeteer が使う Chrome の置き場所を、ユーザープロファイル
 * (C:\Users\<ユーザー>\.cache\puppeteer) ではなく、このプロジェクト内の
 * .cache\puppeteer に固定する。
 *
 * - npm ci（postinstall）で Chrome がここにダウンロードされる
 * - サーバーを動かすアカウント（Windows サービスの LocalSystem など）が
 *   npm ci を実行したユーザーと違っても、同じ場所を見るので PDF 出力が失敗しない
 * - この設定ファイルは「作業ディレクトリから上のフォルダ」に向かって探されるため、
 *   npm ci や npx puppeteer browsers install chrome はプロジェクトのフォルダ内で実行すること（サーバーの起動時は server/index.js の先頭で同じ場所を環境変数 PUPPETEER_CACHE_DIR でも指定しているので、作業ディレクトリが違っても見つかる）
 *
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
