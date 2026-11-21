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
 *   サーバーは必ずプロジェクトのルートを作業ディレクトリにして起動すること
 *
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
