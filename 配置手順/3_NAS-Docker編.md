# 3. NAS で動かす（Docker コンテナ編）

（2026-11-21 作成。入口は [README.md](README.md)。調査は 2026-11-20〜21。その後の保存処理の修正に合わせて本文を直してある）

> **最初に正直な前提**: この PC には Docker が無いため、3 章のファイルは **Docker 上では一度もビルド・起動していません（未テスト）**。代わりに (a) 静的チェック、(b) Docker 無しで証明できる部分のローカル実行、(c) 公式ドキュメントと Debian パッケージ索引の照合を行いました（内訳は 11 章）。初回は必ず 6 章の確認を通してください。

## 0. 結論

1. NAS の共有フォルダにプロジェクトや `hiyou.db` を置き、各 PC で `node` を起動する方式は**不可**（保存内容が互いに消える。1 章で再現済み）。サーバープロセスは常に 1 つ、DB はそのプロセスが動く機械のローカルディスクに置く。
2. NAS 本体で動かせるのは**コンテナ機能を持つ NAS だけ**。現実的なのは Synology（Container Manager）/ QNAP（Container Station）の Intel/AMD 機・メモリ 4GB 以上。
3. **Buffalo LinkStation / TeraStation（TS＝Linux モデル）、I-O DATA LAN DISK（Linux モデル）では動かせない**。その NAS はバックアップ先にし、アプリは Windows PC 1 台（[1_Windowsサーバー編.md](1_Windowsサーバー編.md) の手順）か小型 Linux 機（7-2）で動かす。
4. Synology・QNAP・小型 Linux 機のどれでも、使うのは同じファイル一式（3 章）。

```
手持ちの NAS は？
├─ Synology でパッケージセンターに「Container Manager」が出る／QNAP に「Container Station」がある
│    ├─ CPU が Intel/AMD、メモリ 4GB 以上 ……… 4 章（Synology）／5 章（QNAP）
│    └─ ARM、またはメモリ 2GB 以下 ……………… 動く可能性はあるが非推奨 → 7-2
└─ Buffalo・I-O DATA など、コンテナ機能なし ……… NAS はバックアップ先。アプリは別の 1 台で（7-2 / Windows 手順）
```

## 1. やってはいけない置き方と、その理由（コードから）

| 根拠 | 内容 |
|---|---|
| `server/database.js` の `getDb()` | 起動時に 1 回だけ DB ファイル全体をメモリへ読み込む（sql.js はメモリ上の SQLite）。以後は読み直さない |
| `server/database.js` の `save()` | メモリの DB 全体をファイルへ丸ごと書き出す（2026-11-21 以降は一時ファイルに書いてから差し替え）。プロセス間のロックや差分の仕組みは無い |
| `server/database.js` の `run()` / `transaction()` | 更新のたびに `save()`。実績の保存などは 1 日分をまとめて最後に 1 回（修正前は 1 患者 1 か月の一括保存でファイル全体を約 480 回書き直していた） |

**1-1. 共有フォルダに置いて各 PC で node を起動 → 不可。** プロセスごとに「起動時点のコピー」を持ち、後から保存した側が相手の変更を丸ごと消します。スクラッチ DB での再現結果（2026-11-20）:

```
1) A が患者を追加   → ファイル: [元の患者, A の患者]            B から見える: [元の患者]
2) B が患者を追加   → ファイル: [元の患者, B の患者]            ← A の追加分が消えた
3) A がもう一度保存 → ファイル: [元の患者, A の患者, A の患者2] ← 今度は B の分が消えた
```

加えて、ログイン状態はプロセスごとのメモリ（express-session 既定）、週次ジョブはプロセスの数だけ重複実行されます（`server/jobs/scheduler.js` のコメントも単一インスタンス前提）。

**1-2. プロセスが 1 つなら安全。** Node.js は 1 スレッドで、`run()`→`save()` は同期処理なので、3〜10 人が同時に使っても書き込みは 1 件ずつ順番になります。全員がブラウザから同じ 1 プロセスに HTTP でつなぐ形が正解です。

**1-3. プロセスは 1 つのまま `DB_PATH` だけ SMB 共有に向ける → 勧めません。**

- 保存のたびにファイル全体を書く作りなので、SMB 越しでは遅くなります。同期 I/O なので、その間は全員の操作が止まります（修正前の実測では、1 年分の架空データ 14.8MB で 1 か月分の一括保存がローカル SSD でも 11.5 秒。2026-11-21 の修正で書き出し回数は 16 分の 1 以下になりましたが、回線の遅さと切断の影響を受ける点は変わりません）。
- 2026-11-21 の修正で保存は「一時ファイルに書いてから差し替え」になり、0 バイトの DB は起動時に拒否するようになりましたが、この安全策はローカルディスクでの動作を前提にしています（SMB 上では差し替えや書き込み確定の保証が弱い）。修正前は、途中で切れると 0 バイトや途中までのファイルになり、起動不能や空の DB（admin / admin123）での起動が起きました（実測）。
- 共有上のファイルは PC から開ける・コピーできる・消せる（個人情報）。`.env.example` 自身も「サーバー機のローカルディスク上のパスを指定する」としています。

コンテナのボリューム（NAS 内蔵ディスク上のフォルダ）は、コンテナから見ればローカルディスクなので問題ありません。SMB 共有はバックアップのコピー先としてだけ使います。

## 2. 手持ちの NAS で動くか

| 種類 | 例 | 判定 |
|---|---|---|
| Intel/AMD (x86-64)・メモリ 4GB 以上 | Synology「+」シリーズ、QNAP の Intel/AMD 機 | **動かせる（本命）**。メモリ 2GB の機種は増設してから |
| ARM 64bit (aarch64) | Synology DS223 / DS124 / DS423 など、QNAP の ARM 機 | 理屈上は同じファイルで動く（下記）が、メモリ 1〜2GB が多く非推奨。未テスト |
| ARM 32bit | 古い下位機種 | 不可（Node 公式イメージに arm/v7 が無い） |
| Buffalo LinkStation / TeraStation（TS）、I-O DATA LAN DISK（Linux モデル） | TS3220DN など | **不可**。コンテナ機能も任意ソフトの導入も無い |
| Buffalo TeraStation WS/WSH、I-O DATA LAN DISK Z（Windows Server IoT for Storage） | WSH5420DN など | 中身は Windows なので技術的には Windows 手順で動く可能性があるが、ストレージ用途向けライセンスの専用機。メーカーに確認できない限り使わない |

- **Buffalo / I-O DATA の根拠**: Buffalo の製品ページでは TS3220DN の搭載 OS は「Linuxベース独自」、CPU は Annapurna Labs Alpine AL214、メモリ 1GB。Buffalo サイトの比較表でも Linux モデルは「ソフトウェアインストール ×」（検索結果で確認）。I-O DATA の Linux モデルは、メーカー提供の「追加パッケージ」（Remote Link 3、クラウド連携、ウイルス対策など）しか足せません。LinkStation も同様（こちらは記憶ベース）。
- **ARM と Chrome の現状（2026-11）**: Chrome for Testing には linux-arm64 版が出ています（Stable 158 で確認）。本アプリの puppeteer は 2026-11-21 の更新で 25.18.1 になり、Linux の arm64 を区別するようになりました（`node_modules/@puppeteer/browsers/lib/detectPlatform.js`。更新前の 22.15.0 は Linux を一律 x86-64 として扱っていました）。3 章の Dockerfile は、どちらの CPU でも同じファイルで済むよう、**x86 でも ARM でも Debian の `chromium` パッケージを入れ、`PUPPETEER_EXECUTABLE_PATH` で使う**構成のままにしています（Debian 13 の chromium は amd64 / arm64 とも 156.0.8078.79）。
- **メモリの目安**（Windows での実測、2026-11-20）: Node 本体 約 0.1GB、PDF 1 件の生成中だけ Chrome が約 0.2〜0.3GB、3 人同時で約 0.6GB。NAS 本体の OS 分を足して**合計 4GB 以上**を推奨。PDF 生成は NAS の CPU では PC より遅くなります（未実測）。

## 3. 追加するファイル

リポジトリの `配置手順/付属ファイル/docker/` に入れてあります。**Docker 上では未テストのため、プロジェクト直下にはまだ置いていません。** NAS で動かすと決めたら、開発 PC で次を実行してプロジェクト直下へコピーしてから使います（その後は通常どおりコミット・プッシュ）。

```powershell
cd C:\temp\hiyou-keisan
Copy-Item "配置手順\付属ファイル\docker\*" . -Recurse -Force
git status --short     # Dockerfile、docker-compose.yml、.dockerignore、.gitattributes、backup-hiyou.sh、docker/ が増える
```

| ファイル | 役割 |
|---|---|
| `Dockerfile` | Node 24 LTS (Debian 13 slim) + chromium + 日本語フォント + tini |
| `docker-compose.yml` | 起動定義（ポート、data ボリューム、.env、再起動、ヘルスチェック） |
| `.dockerignore` | `.env`・`data`・`node_modules`・`.git`・`*.xlsx` をイメージに入れない |
| `docker/fonts-local.conf` | 請求書が指定する "MS Gothic" / monospace を IPA ゴシックに割り当てる |
| `docker/entrypoint.sh` | 起動時に data の所有者を直し、root をやめて uid 1000 でアプリを起動 |
| `backup-hiyou.sh` | 検証付きバックアップ（9 章） |
| `.gitattributes` | 上記を LF 改行で保つ（シェルスクリプトは CRLF だと動かない） |

設計の要点（なぜそうしたか）:

1. **ベースは `node:24-trixie-slim`**。Node 24 は 2028-04-30 まで保守される LTS で、amd64 / arm64 の両方がある。開発 PC の Node 25.9.0 は 2026-06 にサポート終了済みの非 LTS。現行 Active LTS の 26 にするなら FROM 行を `node:26-trixie-slim` に変えるだけ（どちらもこのアプリでは未実行。依存パッケージの要求は、2026-11-21 の更新後は Node 22.12 以上で、24 も 26 も満たす）。
2. **Chrome 用ライブラリは個別に列挙しない**。`apt-get install chromium` が必要な共有ライブラリを依存関係として全部入れる。
3. **日本語フォント**: 請求書の指定は `font-family: "MS Gothic", "Meiryo", monospace`（`server/routes/pdf.js`）。Linux には無いので、等幅で MS ゴシックと字幅互換の IPA ゴシックを割り当てる。フォントファイルを直接調べた結果、IPA ゴシックは Windows-31J の 7,389 字中 7,388 字（髙・﨑・德・濵を含む）を収録、**「𠮷」(U+20BB7) は未収録** → 同梱の Noto Sans CJK JP が補う（収録を確認）。そのため `fonts-noto-cjk` も入れている。Windows のフォントファイルをコピーして入れるのはライセンス上不可。
4. **タイムゾーン**: プロセスの TZ に依存するのは、DB を新規作成するときの初期単価の登録月（`database.js`）だけ（請求書の曜日計算は 2026-11-21 の修正で TZ に依存しなくなった）。週次ジョブは `timezone: 'Asia/Tokyo'` 明示（`scheduler.js`）、集計は JST 固定計算（`weeklyUsage.js`）で TZ 非依存。`TZ=Asia/Tokyo` を入れておけば PC と同じ挙動。
5. **`--no-sandbox` と非 root**: コードは `--no-sandbox` 付きで Chrome を起動する（`pdf.js`）。Docker 既定の制限下では Chrome のサンドボックスに追加権限が要り、root では `--no-sandbox` が必須なので、このフラグは残す。その代わりアプリと Chrome は root で動かさない（エントリポイントが data の所有者を直した直後に uid 1000 へ降格）。描画するのは自前で組み立てた HTML だけ（`pdf.js` の `setContent`、値はエスケープ済み）で、外部サイトは開かない。
6. **`environment` は `env_file` より優先**（Docker 公式）。`.env` に `PORT` や Windows パスの `DB_PATH` があっても、コンテナ内は 3000 番・`/app/data/hiyou.db` に固定される。`export.log` は `DB_PATH` と無関係に常に `/app/data/export.log`（`weeklyUsage.js`）なので、ボリュームは `/app/data` に付ける。操作ログ（2026-11-21 追加）も DB と同じフォルダの `/app/data/audit` に書かれるので、同じボリュームに入る。
7. **tini**: PDF のたびに起動する Chrome の子プロセスを回収し、停止シグナルを Node に届ける。
8. **`shm_size: "256m"`**: Docker 既定の /dev/shm は 64MB。Debian の chromium ランチャーは /dev/shm が小さいと自動で `--disable-dev-shm-usage` を付けるが、その判定が効かなかった場合の保険。
9. **ヘルスチェック**は状態表示用（unhealthy でも自動再起動はしない。プロセスが落ちたときは `restart: unless-stopped` が効く）。
10. BuildKit 専用の構文は使っていない（NAS の古めの Docker でもビルドできるように）。

## 4. Synology（Container Manager）での手順

1. DSM → パッケージ センターで「Container Manager」を検索。出てこなければ非対応機（→ 7 章）。DSM 7.2 以降が必要。
2. コントロール パネル → 情報センターで CPU とメモリを確認（2 章の表）。
3. NAS の IP を固定する（ルーターの DHCP 固定割当、または コントロール パネル → ネットワーク）。以下 `192.168.1.50` と書きます。
4. Container Manager をインストール（共有フォルダ `docker` ができる）。`docker` 共有は管理者だけがアクセスできる設定のままにする（DB と API キー入り `.env` が入る）。
5. File Station で `docker/hiyou-keisan` と、その中に `data` フォルダを作る（無いフォルダはマウント時にエラーになるという報告があるため先に作る）。
6. 開発 PC の PowerShell で、必要なものだけコピー（終了コード 1 は「コピー成功」）:
   ```powershell
   $src = 'C:\temp\hiyou-keisan'
   $dst = '\\192.168.1.50\docker\hiyou-keisan'
   robocopy $src $dst Dockerfile docker-compose.yml .dockerignore backup-hiyou.sh package.json package-lock.json
   robocopy "$src\server" "$dst\server" /MIR
   robocopy "$src\public" "$dst\public" /MIR
   robocopy "$src\docker" "$dst\docker" /MIR
   ```
   `node_modules`・`.git`・`data`・`.xlsx`（実績データ）は送らない。
7. `.env` を NAS 側に置き、`SESSION_SECRET` を足す（今の `.env` には無く、ソースに書かれた既定値で動いている: `server/index.js`）:
   ```powershell
   Copy-Item "$src\.env" "$dst\.env"
   [System.IO.File]::AppendAllText("$dst\.env", "SESSION_SECRET=" + (node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") + "`n")
   ```
   `.env` は UTF-8（BOM なし）であること。メモ帳で編集するのは可、PowerShell 5.1 の `>` や `Out-File` で作り直すと UTF-16 になり読めません。
8. 今のデータを引き継ぐ場合: PC のアプリを止めてから（起動中の画面で Ctrl+C）コピーし、以後 PC 側では起動しない（2 か所で別々に更新されるのを防ぐ）:
   ```powershell
   Copy-Item "$src\data\hiyou.db" "$dst\data\hiyou.db"
   ```
9. Container Manager → プロジェクト → 作成。プロジェクト名 `hiyou-keisan`、パスに `/docker/hiyou-keisan` を選び、既存の `docker-compose.yml` を使う選択肢を選ぶ。Web ポータルの設定は何もせず進めて完了。ビルドが始まる（初回は数分〜十数分。NAS からインターネットに出られる必要あり。ダウンロードは 0.4GB 前後、イメージは 1GB 強の見込み）。
   GUI でうまくいかないときは SSH（コントロール パネル → 端末と SNMP で一時的に有効化）:
   ```sh
   ssh 管理者ユーザー@192.168.1.50
   cd /volume1/docker/hiyou-keisan
   sudo docker-compose up -d --build      # 「command not found」なら: sudo docker compose up -d --build
   ```
10. 6 章の確認を行う。
11. 各 PC のブラウザで `http://192.168.1.50:3000` を開く。
12. インターネットに出さない: ルーターで 3000 番のポート転送をしない・UPnP を切る。DSM の外部アクセス（QuickConnect、リバースプロキシ、ルーター設定）にこのポートを登録しない。DSM ファイアウォールを使うなら「3000/TCP は LAN のサブネットからのみ許可」を追加する（Docker が公開したポートにはホストのファイアウォールが効かない場合があるため、最終的な防御はルーター側と考える）。

## 5. QNAP（Container Station）での要点

- 公式の最小要件は「64bit の x86 / ARM、メモリ 1GB」ですが、このアプリは 2 章のとおり 4GB 以上を推奨。QTS 5.1 以降は Container Station 3 で、コマンドは `docker compose`（ハイフン無し）。
- GUI の「アプリケーション作成」は YAML を貼り付ける方式で、`build: .`・`env_file`・`./data` といった相対パスの扱いを公式資料で確認できませんでした。**SSH で実行する**のが確実です（実機未確認）:
  1. Container Station をインストール（共有フォルダ `Container` ができる）。
  2. 4 章の 5〜8 と同じ要領で `\\NASのIP\Container\hiyou-keisan` にコピー（`data` フォルダと `.env` も）。
  3. コントロールパネル → ネットワークとファイルサービス → Telnet / SSH で SSH を有効化。
  4. `ssh 管理者ユーザー@NASのIP`（QTS 5 では既定の `admin` を無効にしていることがあるので、administrators グループの自分のユーザーで入る。`docker` が権限エラーになるときは先頭に `sudo` を付ける） → `cd /share/Container/hiyou-keisan` → `docker compose up -d --build`
  5. 6 章の確認。

## 6. 起動後の確認（期待される出力）

SSH で実行します。以下は Synology の書き方（`sudo` と `docker-compose`）。QNAP と Linux 機では `docker compose` と読み替えてください。

```sh
sudo docker ps --filter name=hiyou-keisan --format '{{.Names}}  {{.Status}}  {{.Ports}}'
# 期待: hiyou-keisan  Up 2 minutes (healthy)  0.0.0.0:3000->3000/tcp
sudo docker logs hiyou-keisan
# 期待: 「DBファイル: /app/data/hiyou.db（○○ バイト）」（データを移行したのに「見つからないため新しく作成します」と出たら hiyou.db が読まれていない）
#       「操作ログ: /app/data/audit」
#       「週次使用量レポート: cron登録 (0 6 * * 1 / Asia/Tokyo)」（無効なら「…無効」）
#       「療養介護サービス提供実績記録票 起動: http://localhost:3000」
sudo docker top hiyou-keisan
# 期待: 「node server/index.js」の行の UID が 1000（root ではない）。QNAP や Linux 機（7-2）では、ホスト側に uid 1000 のユーザーがいるとその名前で表示される（root でなければよい）
sudo docker exec hiyou-keisan fc-match "MS Gothic"
# 期待: ipag.ttf: "IPAGothic" "Regular"
sudo docker exec hiyou-keisan date
# 期待: 日本時間（JST）
```

- ログ先頭の「injected env (0) from .env」は正常です（コンテナの中には `.env` を置かず、compose が環境変数として渡しているため 0 件と表示される）。
- **データを移行したのにログに「初期管理者を作成しました: admin / admin123」と出たら、`hiyou.db` が読まれていません**（置き場所かファイル名の誤り）。すぐ停止して `data/hiyou.db` を確認。新規に始めた場合は、この表示が出るのが正常で、ログイン後すぐ admin のパスワードを変更。
- ブラウザで: ログイン → 氏名に「髙」「﨑」「𠮷」を含むテスト患者を作る → 数日分入力して保存 → 請求書 PDF を出す。□（豆腐）が無いこと、曜日が正しいこと（2026-11-01 は日曜）、A3 横 1 枚に収まることを確認。「𠮷」だけ字形がわずかに違うのは正常（Noto から補われる）。確認後にテスト患者を削除。
- うまくいかないとき:

| 症状 | 原因と対処 |
|---|---|
| プロジェクト作成時に `data` が無い旨のエラー | `data` フォルダを作る（4 章 5） |
| `env file ... .env not found` | `.env` を置く（4 章 7） |
| 再起動を繰り返し、ログに `DB初期化エラー` と `EACCES` | data に書き込めない。ログの `entrypoint: WARNING` を確認し、`sudo chown -R 1000:1000 /volume1/docker/hiyou-keisan/data` |
| ログに `database disk image is malformed`、または「DBファイルが0バイトです（破損の可能性があります）」 | DB ファイルが壊れている。9-3 の手順で復元 |
| PDF だけ失敗（画面に「PDFの生成に失敗しました」） | `sudo docker logs hiyou-keisan` の `PDF生成に失敗しました:` 以降を見る。メモリ不足なら NAS のメモリ増設。Chromium と Puppeteer 25 の相性が原因なら、x86-64 機に限り（ARM 機向けに同じ版の Chrome が配布されているかは未確認）、Dockerfile の ENV から `PUPPETEER_SKIP_DOWNLOAD` と `PUPPETEER_EXECUTABLE_PATH` を外して `PUPPETEER_CACHE_DIR=/app/.cache/puppeteer` を足すと、Puppeteer が自分で取得する Chrome 157 を使う構成になる（未テストの代替案） |
| 再起動を繰り返し、ログに `操作ログの初期化エラー` | `/app/data/audit` を作れない・書けない。data の所有者を直す（上の `chown` と同じ） |
| 3000 番が使用中 | compose の `ports` の左側だけ変える（例 `"8080:3000"`） |

## 7. 代替案

**7-1. NAS 上の仮想マシン（Synology VMM / QNAP Virtualization Station）**
Synology VMM は Btrfs ボリュームと 2GB 超のメモリが必須（公式仕様）で、対応は Intel/AMD 機。VM に Ubuntu Server を入れ、7-2 と同じ手順で動かせます。ただしコンテナが使える機種なら、VM は OS 分のメモリ（実用上 NAS に 8GB 以上）と OS 更新の手間が増えるだけなので、選ぶ理由はほぼありません。

**7-2. 小型の Linux 機（ミニ PC など）+ Docker + 同じファイル**（NAS がコンテナ非対応の場合の候補）

1. Ubuntu Server 24.04 LTS か 26.04 LTS を入れ、IP を固定、OpenSSH を有効にする（x86-64、メモリ 4GB 以上）。
2. Docker を入れる（公式ドキュメント記載の方法）:
   ```sh
   curl -fsSL https://get.docker.com -o get-docker.sh
   sudo sh get-docker.sh
   sudo docker compose version      # エラーなら: sudo apt install docker-compose-plugin
   ```
3. Linux 側で `sudo mkdir -p /opt/hiyou-keisan/data && sudo chown -R $USER /opt/hiyou-keisan` を実行してから、開発 PC の PowerShell でコピー:
   ```powershell
   cd C:\temp\hiyou-keisan
   scp -r server public docker Dockerfile docker-compose.yml .dockerignore backup-hiyou.sh package.json package-lock.json .env ユーザー@192.168.1.60:/opt/hiyou-keisan/
   scp data\hiyou.db ユーザー@192.168.1.60:/opt/hiyou-keisan/data/
   ```
   2 行目はデータを引き継ぐ場合だけ（PC 側のアプリを止めてから）。`SESSION_SECRET` は Linux 側で 1 行足す: `echo "SESSION_SECRET=$(openssl rand -hex 32)" >> /opt/hiyou-keisan/.env`
4. `cd /opt/hiyou-keisan && sudo docker compose up -d --build` → 6 章の確認。
5. Docker が公開したポートは ufw などのホスト側ファイアウォールを素通りします（Docker 公式の注意書き）。インターネットからの遮断はルーターで行う。
6. バックアップ先に NAS の共有を使う例（Buffalo / I-O DATA の NAS でも可。記憶ベース・未テスト）:
   ```sh
   sudo apt install cifs-utils
   sudo mkdir -p /mnt/nas-backup
   printf 'username=バックアップ用ユーザー\npassword=パスワード\n' | sudo tee /root/.nas-cred >/dev/null && sudo chmod 600 /root/.nas-cred
   echo '//192.168.1.50/backup /mnt/nas-backup cifs credentials=/root/.nas-cred,iocharset=utf8,_netdev,nofail 0 0' | sudo tee -a /etc/fstab
   sudo mount -a && mountpoint /mnt/nas-backup
   sudo crontab -e    # 次の 1 行を追加（毎日 2:30）
   30 2 * * * mountpoint -q /mnt/nas-backup && APP_DIR=/opt/hiyou-keisan DEST=/mnt/nas-backup/hiyou-keisan sh /opt/hiyou-keisan/backup-hiyou.sh >> /var/log/hiyou-backup.log 2>&1
   ```

**7-3. Windows PC 1 台で動かし、NAS はバックアップ先**: [1_Windowsサーバー編.md](1_Windowsサーバー編.md) の手順を参照。

## 8. 更新手順

1. 業務時間外に行う（再起動すると全員ログインし直しになり、保存前の入力は消える → 10 章）。
2. 直前にバックアップ: `sudo sh /volume1/docker/hiyou-keisan/backup-hiyou.sh` → `backup OK` を確認。
3. 開発 PC で 4 章 6 の robocopy を再実行（`data` と `.env` は対象外なので消えない）。
4. Container Manager → プロジェクト → hiyou-keisan → 停止 → ビルド。または SSH で `cd /volume1/docker/hiyou-keisan && sudo docker-compose up -d --build`。GUI と SSH を混ぜると表示が食い違うことがあるので、どちらかに統一。
5. 6 章の確認（最低限 `healthy` と PDF 1 枚）。
6. 戻すときは、前の版のソースで 3〜5 をやり直す。DB も戻すなら 9-3。
7. Debian と Chromium の更新を取り込む再ビルド（3 か月に 1 回程度）: `cd /volume1/docker/hiyou-keisan && sudo docker-compose build --pull --no-cache && sudo docker-compose up -d`、その後 `sudo docker image prune -f`。

## 9. バックアップと復元

対象は `data/hiyou.db`（全データ）、`data/audit/`（操作ログ。2026-11-21 追加）、`data/export.log`。`.env`（API キー）は別の安全な場所に 1 部。ソースは GitHub にあります。バックアップにも個人情報が入るので、保存先のアクセス権は管理者のみに。

**9-1. 画面だけで設定する方法**: Hyper Backup（QNAP は HBS 3）で `docker/hiyou-keisan` フォルダを毎晩、世代を残す設定（30〜60 世代以上）で、別ディスク・USB・別の NAS へ。Btrfs なら `docker` 共有のスナップショットも併用。

**9-2. 検証付きスクリプト `backup-hiyou.sh`**: コピー → アプリのイメージに入っている SQLite で整合性チェック（`PRAGMA integrity_check`）と「患者が 1 人以上いること」を確認 → `export.log` と操作ログ（`data/audit/audit-*.jsonl`）を保存先へ複製 → 60 日より古い世代を削除（操作ログは消さない）。保存の瞬間に重なって途中までのコピーになった場合は 3 回までやり直し、だめなら異常終了します。
Synology: 先に DSM で共有フォルダ `backup`（管理者のみアクセス可）を作っておく。次に コントロール パネル → タスク スケジューラー → 作成 → 予約タスク → ユーザー指定のスクリプト、ユーザー `root`、毎日 2:30、「異常終了時にメール通知」を有効にして、実行コマンド:

```sh
DEST=/volume1/backup/hiyou-keisan sh /volume1/docker/hiyou-keisan/backup-hiyou.sh
```

**空の DB から始めた場合、最初の患者を登録するまでは「患者が 0 人」として異常終了になる**（スクリプトの仕様。空の DB は「DB を見失って新規作成された」状態と区別できないため）。QNAP では場所を指定して実行する（実機未確認）: `APP_DIR=/share/Container/hiyou-keisan DEST=/share/backup/hiyou-keisan sh /share/Container/hiyou-keisan/backup-hiyou.sh`

期待される出力: `integrity=ok patients=120` と `backup OK: /volume1/backup/hiyou-keisan/hiyou-20261121-023000.db`。保存先は NAS 本体とは別の媒体（USB・別 NAS）にもコピーする。

**9-3. 復元（必ず 停止 → 差し替え → 起動）**:

```sh
cd /volume1/docker/hiyou-keisan
sudo docker-compose stop
sudo cp data/hiyou.db data/hiyou.db.before-restore
sudo cp /volume1/backup/hiyou-keisan/hiyou-YYYYMMDD-HHMMSS.db data/hiyou.db
sudo docker-compose start
```

動作中に差し替えても、次の保存でメモリ上の内容に上書きされて元に戻ってしまいます（`database.js`）。

**9-4. 復元テスト（月 1 回）**: バックアップを開発 PC に `C:\temp\restore-test\hiyou.db` という名前でコピーし（この場所にファイルが無いと、空の DB が新しく作られて起動してしまう。起動時の「DBファイル: …（○○ バイト）」の行で確認）、PowerShell で

```powershell
cd C:\temp\hiyou-keisan
$env:DB_PATH='C:\temp\restore-test\hiyou.db'; $env:EXPORT_ENABLED='false'; $env:PORT='3999'; node server/index.js
```

`http://localhost:3999` で中身を確認して Ctrl+C。

## 10. このアプリ固有の運用ルール

- **停止・更新・NAS の再起動は、利用者のいない時間に**。2026-11-21 の修正で、保存の途中でプロセスや電源が落ちても DB ファイルは直前の完全な内容のまま残るようになりました（その瞬間に保存中だった入力は失われます）。UPS は引き続き推奨。
- 動作中は `data/hiyou.db` を開かない・コピー以外の操作をしない・差し替えない。
- 再起動のたびに全員ログインし直し（セッションはメモリ上）。
- コンテナには `tools/` のスクリプトを入れていない。初期パスワードが残っていないかの確認は、バックアップした DB を開発 PC にコピーして `node tools\check-default-password.js <コピーしたDBのパス>` で行う。
- 週次レポート（月曜 6:00）は、その時刻に NAS が起動していて、コンテナから `https://api.dify.ai` へ出られることが条件。出られない構成なら `.env` で `EXPORT_ENABLED=false`。結果は `data/export.log`。
- 通信は、何も設定しなければ HTTP（暗号化なし）。LAN 内限定の前提で、対策は [2_運用編.md](2_運用編.md) の 3章・4章を参照。HTTPS にする場合は NAS 内蔵のリバースプロキシを使い、`.env` に `TRUST_PROXY=1` を足す（2編 3-3。アプリ側の対応は 2026-11-21 に適用済み）。
- パスワードの基準（13 文字以上・英数字混在）、ログイン失敗時のロック（5 回で 15 分）、操作ログは Windows の場合と同じ（2編 8章）。操作ログは `data/audit/audit-YYYY-MM.jsonl` に入る。

## 11. 何を確かめ、何を確かめていないか

| 項目 | 状態 |
|---|---|
| Docker でのビルド・起動（x86 / ARM とも） | **未実施**（Docker が無い） |
| Dockerfile の構文 | dockerfile-utils で診断 0 件 |
| compose の構文 | compose-spec の現行 JSON Schema で検証 OK（誤記を入れた対照は不合格になることも確認） |
| apt パッケージ名 | Debian 13 の Packages 索引（main と security、amd64 / arm64）で全て実在を確認（2026-11-21） |
| Puppeteer の環境変数名 | node_modules の puppeteer 25.18.1 のコードで再確認（2026-11-21 の更新後。`PUPPETEER_SKIP_DOWNLOAD`・`PUPPETEER_EXECUTABLE_PATH`・`PUPPETEER_CACHE_DIR` とも有効） |
| `npm ci --omit=dev` | Windows / Node 25.9.0 で成功（更新後は 103 パッケージ、脆弱性の指摘 0 件、ネイティブモジュール無し） |
| システムの Chrome を `PUPPETEER_EXECUTABLE_PATH` で使った PDF 生成 | Windows で Chrome 155（11-20）と 158（11-21）を使い成功（A3 横 1 ページ、日本語埋め込み）。puppeteer 25.18.1 に更新した後も Chrome 158 で成功（11-21）。Linux の Chromium 156 では未確認 |
| ヘルスチェックのコマンド | 稼働中 exit 0 / 停止中 exit 1 を確認 |
| フォント | Debian パッケージの実ファイルで収録文字とファミリー名を確認。Linux 上での実際の描画は未確認 |
| エントリポイント | 構文と非 root 側の分岐のみ確認。root → chown → 降格は未確認 |
| バックアップスクリプト | docker コマンドを代用品に置き換えて正常・破損・欠損・世代削除を確認。実機では未確認 |
| Synology / QNAP の画面操作、Buffalo / I-O DATA の機種別仕様 | 公式ページと検索結果からの記述。実機では未確認 |
