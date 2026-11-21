# 1. Windows の PC／サーバーに置く手順

（2026-11-21 作成。入口は [README.md](README.md)、運用は [2_運用編.md](2_運用編.md)。調査と実験は 2026-11-20〜21 に開発PCで実施）

## 0. 結論と検証範囲

| 項目 | 推奨 |
|---|---|
| 置き先 | 常時稼働できる 64bit の Windows 11 Pro（または Windows Server 2019 以降）を 1 台。有線 LAN・スリープ無効 |
| Node.js | **26 系 LTS「Lithium」**（2026-11-21 時点の最新 v26.13.1）を MSI か winget で入れる |
| 自動起動・自動再起動 | **WinSW v2.12.0 で Windows サービス化**（スタートアップ=自動、異常終了は 10 秒後に Windows が再起動、標準出力はローテーション付きログ） |
| PDF（Puppeteer）の罠 | **対応済み**。リポジトリに `.puppeteerrc.cjs` を追加し、Chrome の置き場所をプロジェクト内 `.cache\puppeteer` に固定した（`npm ci` でそこに入る）。サービスの作業フォルダはプロジェクトのルートにする |
| 公開範囲 | Windows ファイアウォールで TCP 3000 の受信を「同一サブネットからのみ」許可 |

**検証できたこと**（開発PC: Windows 11 Pro / Node 25.9.0 / 管理者権限なし。ポート 3141、作業用コピーとテスト用 DB）

- `git archive` の zip → 展開 → `.puppeteerrc.cjs` 追加 → `.env`（BOM 付き UTF-8）→ 別アカウントを模した環境（USERPROFILE / APPDATA / TEMP を別フォルダに変更）で起動 → ログインと PDF 出力（HTTP 200、3〜5 秒）
- `npm ci --omit=dev`（約 1 分、196 パッケージ、Chrome がプロジェクト内 `.cache` に入る）と 2 回目（27 秒、Chrome の再ダウンロードなし）
- 全インターフェースで待ち受けていること（`::`）、LAN 側 IP でも HTTP 200
- 強制終了時の終了コード（`taskkill /F` → 1）、二重起動は 2 つ目が `EADDRINUSE` で終了すること
- フォルダ権限コマンド（icacls）、ファイアウォールのコマンド（`-WhatIf` のみ）、本書の PowerShell コマンドの構文とパラメーター名
- （2026-11-21 追加）修正後のコードで、ホームフォルダに Chrome が無い別アカウント相当・プロジェクト外の作業フォルダから起動し、`.env` の読み込み・ログイン・保存・PDF 出力（HTTP 200、約 3 秒）ができること

**検証できていないこと**（サーバー機での確認手順を本文に入れてある）

- **Node 26 での起動。** 依存パッケージの engines 要件（最も厳しいのは node-cron 4.6.0 の `>=20`）と、Node 26.0.0 で削除された API を使っていないことの確認まで。ダウンロードした Node 26 をこの PC で実行する操作は権限設定で拒否されたため未実施 → Step 0 で開発PCを Node 26 にして一度動かす
- **サービス登録そのもの**（WinSW の実行、起動時の自動開始、異常終了後の再起動）。この PC では管理者権限がなく登録も禁止のため、WinSW v2.12.0 の公式ドキュメントとソースを読んで手順化した
- **LocalSystem（サービス用のセッション）での Chrome 起動** → Step 7 の確認 4 で必ず PDF を 1 枚出す
- 別端末からの接続とホスト名での名前解決（この PC 1 台しかないため）

## 1. 用意するマシン

| 項目 | 目安 | 根拠 |
|---|---|---|
| OS | Windows 11 Pro 64bit、または Windows Server 2019 / 2022 / 2025 | Node 26 の対象は 64bit の Windows 10 / Server 2016 以降。Home でも動くが、保守（リモートデスクトップ、更新の制御）は Pro が楽 |
| CPU / メモリ | 2 コア以上 / 8GB（最低 4GB） | 実測: node.exe 待機時 約 82MB。PDF 出力中は Chrome が 8 プロセス合計で最大 約 410MB、1 枚 3〜5 秒 |
| ディスク | SSD、空き 5GB 以上 | 実測: Chrome 541MB + node_modules 63MB。DB は現在 64KB。ログは最大 約 180MB |
| ネットワーク | 有線 LAN、IP 固定（DHCP 予約） | Wi-Fi のノート PC は蓋・省電力・再接続で止まりやすい |

- 数年前の事務用 PC やミニ PC で足りる。3〜10 人の利用で CPU を使うのは PDF 出力のときだけ。
- Windows 10 は 2025-10-14 にサポート終了。更新を受け続けるには ESU（延長セキュリティ更新）への登録が必要（個人向けは 2027-10-12 まで延長、法人向けは有償で最長 2028-10-10。報道ベース）。ESU に入っていない Windows 10 機は、患者情報を置くサーバーにしない。

## 2. この手順でのフォルダ構成

```
C:\hiyou\app      コード（git clone 先）。.env、.cache（Chrome）、node_modules もここ
C:\hiyou\data     hiyou.db（.env の DB_PATH で指定。コードと分け、git 操作の影響を受けないようにする）
C:\hiyou\logs     サービスのログ
C:\hiyou\service  WinSW（hiyou-service.exe と hiyou-service.xml）
C:\hiyou\backup   毎晩のバックアップ（daily / monthly。2_運用編の 2章）と、更新前の DB コピー
```

サーバー機でのコマンドはすべて **「管理者として実行」した Windows PowerShell** で実行する（スタートを右クリック →「ターミナル（管理者）」）。

## 3. 手順

### Step 0. 開発PCでの準備

1. 開発PCの Node.js を 26 LTS に上げ、`npm ci` → `npm start` → ログイン → PDF 出力まで一度確認する。現在の v25.9.0 は 2026-06-01 でサポートが終わっており、本番と同じ系列にそろえる。**これが Node 26 での動作確認を兼ねる。**
2. Chrome の置き場所の固定（`.puppeteerrc.cjs` の追加）は **対応済み**。2026-11-21 にリポジトリへ追加し、開発PCでも Chrome をプロジェクト内の `.cache` に入れ直して PDF 出力を確認した。別の PC で開発を続ける場合は、`git pull` のあとに一度 `npm ci`（または `npx.cmd puppeteer browsers install chrome`）を実行する。理由は §6。

### Step 1. サーバー機の下準備

1. **PC 名と IP を固定する。**

```powershell
Rename-Computer -NewName "HIYOU-SV" -Restart      # 任意。再起動される
Get-NetAdapter -Physical | Where-Object Status -eq 'Up' | Format-Table Name, MacAddress, LinkSpeed
Get-NetIPAddress -AddressFamily IPv4 | Format-Table InterfaceAlias, IPAddress, PrefixLength, PrefixOrigin
```

   表示された MAC アドレスを、ルーターの管理画面の「DHCP 固定割当（IP アドレス予約）」に登録する（例: 192.168.1.10）。PC 側は自動取得のままでよいので、設定ミスで通信できなくなる心配がない。ルーターで予約できない場合だけ、DHCP の配布範囲外のアドレスを PC に手動設定する（値は例）:

```powershell
New-NetIPAddress -InterfaceAlias "イーサネット" -IPAddress 192.168.1.10 -PrefixLength 24 -DefaultGateway 192.168.1.1
Set-DnsClientServerAddress -InterfaceAlias "イーサネット" -ServerAddresses 192.168.1.1
```

2. **ネットワークの種類を「プライベート」にする。** Step 8 のファイアウォール規則はプライベート / ドメインでだけ有効にするため。

```powershell
Get-NetConnectionProfile | Format-Table InterfaceAlias, NetworkCategory
Set-NetConnectionProfile -InterfaceAlias "イーサネット" -NetworkCategory Private
```

   `InterfaceAlias` は 1 行目の表示に合わせる。ドメイン参加機は `DomainAuthenticated` と出るので、そのままでよい。

3. **スリープと休止を止める。** スリープ中は誰も使えず、月曜 6:00 の週次ジョブも動かない。

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /hibernate off
```

   3 行目で「高速スタートアップ」も無効になり、電源を入れるたびにサービスが起動し直す。画面オフは構わない。可能なら BIOS で「停電復帰後に自動で電源オン」にする。

4. **時刻**: `Get-TimeZone` が `Tokyo Standard Time` であること（違えば `Set-TimeZone -Id "Tokyo Standard Time"`）。

### Step 2. Node.js 26 LTS と Git を入れる

```powershell
winget install --id OpenJS.NodeJS.LTS -e --source winget
winget install --id Git.Git -e --source winget
```

- winget が無い Windows Server 2019 / 2022 では `https://nodejs.org/dist/v26.13.1/node-v26.13.1-x64.msi` を実行する（SHA-256: `0398ced8446e119478c724d1aa37c5afd6aa1a76fceab12787eb9714c5ed8b45`。実行前に、ダウンロードしたフォルダで `(Get-FileHash .\node-v26.13.1-x64.msi -Algorithm SHA256).Hash` を実行して同じ値か確かめる。大文字・小文字の違いは無視してよい）。途中の「Tools for Native Modules」のチェックは**入れない**（このアプリにビルドが必要なモジュールは無い。bcryptjs は純 JavaScript、sql.js は WASM）。
- nvm-windows / fnm / Volta は使わない。ユーザーごとの場所に入るので、サービスのアカウントから node.exe が見えなくなる。

PowerShell を**開き直して**確認する:

```powershell
node -v                      # v26.13.1 など v26.x
npm.cmd -v                   # 11.20.0 など
(Get-Command node).Source    # C:\Program Files\nodejs\node.exe
git --version
```

PowerShell では `npm` が `npm.ps1` に解決され、実行ポリシーが既定（Restricted）の PC では「スクリプトの実行が無効」と出て止まる。本書では常に `npm.cmd` / `npx.cmd` と書く。

### Step 3. フォルダを作り、権限を絞る（必須）

```powershell
New-Item -ItemType Directory -Force -Path C:\hiyou\data, C:\hiyou\logs, C:\hiyou\service, C:\hiyou\backup | Out-Null
icacls C:\hiyou /inheritance:r /grant:r "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F"
icacls C:\hiyou
```

期待する表示（この 2 行だけになる）:

```
C:\hiyou NT AUTHORITY\SYSTEM:(OI)(CI)(F)
         BUILTIN\Administrators:(OI)(CI)(F)
```

C:\ 直下に作ったフォルダは、既定で「その PC にログオンできる全ユーザーが変更可」になる（開発PCの C:\temp で確認: `Authenticated Users:(M)`）。そのままだと (1) 患者情報入りの DB と API キー入りの .env を誰でも読める、(2) サービスは SYSTEM 権限で動くので、プログラムを書き換えられると PC 全体を乗っ取られる。SID 指定（`*S-1-5-32-544` = Administrators、`*S-1-5-18` = SYSTEM）は表示言語に依存しない。以後このフォルダの操作は管理者 PowerShell から行う（メモ帳も `notepad <パス>` とそこから起動する）。

### Step 4. コードを置いて依存パッケージを入れる

**A. git clone（推奨。あとの更新が `git pull` で済む）**

```powershell
cd C:\hiyou
git clone https://github.com/aki2228824/hiyou-keisan.git app
```

このリポジトリは 2026-11-21 時点で**公開設定**（誰でも閲覧できる）なので、サインインなしで clone できる。非公開に変えた場合は、初回にブラウザーで GitHub へのサインインを求められる（サーバーに GitHub の認証情報を残したくない場合は B）。

**B. zip で持ち込む（サーバーに Git 不要）**

```powershell
git archive --format=zip -o hiyou-app.zip HEAD                        # 開発PCのリポジトリで。git で管理しているファイルだけの zip
Expand-Archive -Path .\hiyou-app.zip -DestinationPath C:\hiyou\app    # サーバーで
```

`node_modules` は開発PCからコピーしない（開発用パッケージが混ざり、Chrome も入っていない）。

**共通:**

```powershell
cd C:\hiyou\app
Test-Path .\.puppeteerrc.cjs       # True であること（False なら取得したコードが古い）
npm.cmd ci --omit=dev
Get-ChildItem C:\hiyou\app\.cache\puppeteer\chrome -Recurse -Filter chrome.exe | Select-Object FullName
```

- 期待: `added 196 packages`（約 1 分）。最後の行で `C:\hiyou\app\.cache\puppeteer\chrome\win64-127.0.6533.88\chrome-win64\chrome.exe` が表示される。
- `npm warn deprecated puppeteer@22.15.0` と `16 vulnerabilities` が出るが、サーバー上で `npm audit fix --force` は実行しない（puppeteer のメジャー更新になる。対応は開発側の課題）。
- `npm ci` は registry.npmjs.org と Chrome の配布元へ HTTPS で出られる必要がある。Chrome だけ失敗したときは `npx.cmd puppeteer browsers install chrome` で取り直せる（実測 26 秒）。

### Step 5. .env と DB を引っ越す

1. **.env** はテンプレートをコピーしてから編集する（メモ帳の「名前を付けて保存」で `.env.txt` になる事故を避けるため）。

```powershell
Copy-Item C:\hiyou\app\.env.example C:\hiyou\app\.env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"    # 64 文字が出る → SESSION_SECRET に貼る
notepad C:\hiyou\app\.env
```

   - `DIFY_API_URL` / `DIFY_API_KEY`: 開発PCの .env の値を写す
   - `SESSION_SECRET=<上の 64 文字>`（行頭の # を外す。未設定だとリポジトリに書かれた既定値で署名される）
   - `PORT=3000`
   - `DB_PATH=C:/hiyou/data/hiyou.db`（区切りは `/`。テンプレートでは行頭に # が付いているので、# を外す。`PORT` の行も同じく # を外す）
   - 開発PCの現在の .env には SESSION_SECRET / PORT / DB_PATH の 3 つが無いので、必ず追加する。完成形の例は `C:\hiyou\app\配置手順\付属ファイル\windows\env.server.example`。

2. **DB**: 開発PCでアプリを止めてから（保存途中のファイルを持ち出さないため）`data\hiyou.db` を USB メモリ等でサーバーの `C:\hiyou\data\hiyou.db` に置く。USB 側は消す。

```powershell
Copy-Item E:\hiyou.db C:\hiyou\data\hiyou.db      # E: は USB メモリの例
Get-Item C:\hiyou\data\hiyou.db | Format-List FullName, Length, LastWriteTime
```

   **開発PCの現在の DB はテストデータだけ**（患者 7 名はすべてテスト用の名前。2026-11-21 に確認）なので、本番は空の DB から始めることを勧める。その場合はコピー不要で、初回起動時に `admin / admin123` が作られる。Step 8 で LAN に開ける前に必ずパスワードを変える（[2_運用編.md](2_運用編.md) の 1-2）。

### Step 6. 手で起動して確認（サービス化の前に問題を切り分ける）

```powershell
cd C:\hiyou\app
node server\index.js
```

期待する出力:

```
◇ injected env (9) from .env // tip: ...          ← dotenv の案内。( ) 内は読み込んだ変数の数。0 なら .env を読めていない
DBファイル: C:\hiyou\data\hiyou.db（65,536 バイト）   ← DB_PATH の場所か確認する。新規のときは「見つからないため新しく作成します」と出る
週次使用量レポート: cron登録 (0 6 * * 1 / Asia/Tokyo)
療養介護サービス提供実績記録票 起動: http://localhost:3000
```

- **`初期管理者を作成しました: admin / admin123` が出たら、DB を引き継いだつもりなのに空の DB が新規作成されている**（DB_PATH の書き間違い、または .env を読めていない）。止めて直す。
- 「Windows セキュリティの重要な警告（Node.js JavaScript Runtime）」が出ることがある。どちらを押してもよい（自動で作られる規則は Step 8 で消す）。
- サーバー機のブラウザーで `http://localhost:3000` → ログイン → 月次集計 → PDF を 1 枚出す。空の DB から始めた場合は患者が 1 人もいないので、先にマスタ管理 → 患者管理でテスト用の患者を 1 名登録してから出す（Step 7 の確認 4 と Step 9 でも使い、確認がすべて終わったら削除する）。
- 確認できたら **Ctrl+C で必ず止める**（動かしたまま次へ進むと、サービス側がポート重複で落ち続ける）。

### Step 7. Windows サービスにする（WinSW v2.12.0）

```powershell
cd C:\hiyou\service
curl.exe -L -o hiyou-service.exe https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW.NET461.exe
Unblock-File .\hiyou-service.exe
(Get-FileHash .\hiyou-service.exe -Algorithm SHA256).Hash
# → B5066B7BBDFBA1293E5D15CDA3CAAEA88FBEAB35BD5B38C41C913D492AADFC4F であること
Copy-Item "C:\hiyou\app\配置手順\付属ファイル\windows\hiyou-service.xml" C:\hiyou\service\hiyou-service.xml
notepad C:\hiyou\service\hiyou-service.xml       # 中のパスを確認する（フォルダ構成を変えた場合は直す）
.\hiyou-service.exe install
.\hiyou-service.exe start
.\hiyou-service.exe status                        # Started
```

- exe と xml は同じフォルダ・同じ名前（拡張子だけ違う）にする。WinSW はそれで設定を見つける。
- `WinSW.NET461.exe`（656KB）は Windows 標準の .NET Framework 4.6.1 以降で動く（Windows 10 / 11 / Server 2016 以降は追加インストール不要）。
- v2.13.0（2026-11-15 公開）はリリースノートに「largely experimental」とあるので、v2.12.0（2023-01-28）を使う。
- 実行アカウントは WinSW の既定の LocalSystem。

**確認（4 つとも行う）:**

```powershell
# 1. 自動起動・アカウント・回復設定
Get-Service hiyoukeisan | Format-List Name, DisplayName, Status, StartType     # Running / Automatic
(Get-CimInstance Win32_Service -Filter "Name='hiyoukeisan'").StartName         # LocalSystem
sc.exe qfailure hiyoukeisan     # RESET_PERIOD (in seconds) : 3600 / FAILURE_ACTIONS : RESTART -- Delay = 10000 milliseconds.

# 2. ログと待ち受け
Get-Content C:\hiyou\logs\hiyou-service.out.log -Tail 20 -Encoding UTF8        # Step 6 と同じ 4 行
Get-NetTCPConnection -LocalPort 3000 -State Listen | Format-Table LocalAddress, LocalPort, OwningProcess
#    LocalAddress が :: なら全インターフェース（IPv4 も含む）で待ち受けている。127.0.0.1 だけなら LAN から届かない

# 3. 異常終了からの自動復帰（node.exe を強制終了して 20 秒待つ）
$p = (Get-NetTCPConnection -LocalPort 3000 -State Listen | Select-Object -First 1).OwningProcess
taskkill /F /PID $p
Start-Sleep -Seconds 20
Get-NetTCPConnection -LocalPort 3000 -State Listen | Format-Table LocalAddress, LocalPort, OwningProcess   # 別の PID で再び Listen
```

4. **サービスで動いている状態で、もう一度ブラウザーから PDF を 1 枚出す。** ここで初めて Chrome が LocalSystem で起動する（この組み合わせは未検証）。失敗したら `C:\hiyou\logs\hiyou-service.err.log` を見る（§8）。

### Step 8. ファイアウォール（LAN 内だけに開ける）

```powershell
New-NetFirewallRule -DisplayName "Hiyou-Keisan (TCP 3000, LAN only)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -RemoteAddress LocalSubnet -Profile Domain,Private

# Step 6 の警告ダイアログで自動作成された node.exe 向けの規則を消す（許可でもブロックでも）
Get-NetFirewallApplicationFilter -Program "C:\Program Files\nodejs\node.exe" -ErrorAction SilentlyContinue | Get-NetFirewallRule | Format-Table DisplayName, Enabled, Action, Profile
Get-NetFirewallApplicationFilter -Program "C:\Program Files\nodejs\node.exe" -ErrorAction SilentlyContinue | Get-NetFirewallRule | Remove-NetFirewallRule

Get-NetFirewallRule -DisplayName "Hiyou-Keisan*" | Format-Table DisplayName, Enabled, Direction, Action, Profile
```

- `LocalSubnet` はサーバーと同じサブネットのアドレスだけを指す。端末が別セグメントにあるなら CIDR で明示する: `Set-NetFirewallRule -DisplayName "Hiyou-Keisan (TCP 3000, LAN only)" -RemoteAddress 192.168.1.0/24,192.168.2.0/24`
- ダイアログで「キャンセル」を押すと node.exe の**ブロック規則**が作られ、ブロックは許可より優先されるので、上の許可規則があっても LAN から届かない。「許可」を押すと全ポート・全アドレス向けの広い許可が残る。どちらも消して上の 1 本だけにする（この PC でほかに Node.js のサーバーを動かしていない前提）。
- サービスとして動く node.exe にはダイアログが出ない。規則を作らない限り LAN からは届かない（受信は既定でブロック）。
- .env の PORT を変えたら、この規則の `-LocalPort` も変える。ルーターのポート開放は**しない**。

### Step 9. 他の端末から確認、再起動テスト

別の PC の PowerShell で:

```powershell
Test-NetConnection 192.168.1.10 -Port 3000      # TcpTestSucceeded : True
```

- ブラウザーで `http://192.168.1.10:3000/` → ログイン → PDF。
- 名前で開きたい場合、`Resolve-DnsName HIYOU-SV` が引ければ `http://HIYOU-SV:3000/` も使える（同一サブネットの Windows 同士なら多くは引けるが環境次第。引けなければ IP で）。職員に配る URL は 1 つに決める（URL が変わるとログインし直しになる）。
- 最後に `Restart-Computer` → **サーバーにはログインせず**、別の PC から開けることを確認する。

### Step 10. Windows Update の再起動に備える

- サービスは再起動後に自動で立ち上がるので、放置しても復帰する。ただし**再起動のたびに全員ログアウトになり**（ログイン状態はメモリ上）、「一括保存」前の入力は失われうる。
- 設定 → Windows Update → 詳細オプション → アクティブ時間 を手動で 5:00〜23:00 にする（幅は最大 18 時間）。自動再起動が 23:00〜5:00 に寄り、月曜 6:00 の週次ジョブとも重ならない。
- 月曜 6:00 に PC が止まっていた週のレポートは送られない（後追い実行はしない）。プロジェクト直下の README.md（`C:\hiyou\app\README.md`。この配置手順フォルダの README ではない）の「手動実行API（管理者のみ）」で送り直す。

### Step 11. 切り替え後の開発PCの後始末

- 開発PCの .env を `EXPORT_ENABLED=false` にする（両方 true だと週次レポートが二重に送られる）。
- 開発PCの `data\hiyou.db`（本番データ）は退避・削除し、以後の開発はダミーデータで行う。**同じ DB ファイルを 2 か所で更新しない**（あとで合流できない）。
- 開発PCには「Node.js JavaScript Runtime」の受信許可（パブリック、全ポート、全アドレス）が残っている。外の Wi-Fi でアプリを起動すると同じネットワークから見える状態なので、管理者 PowerShell での削除を勧める:
  `Get-NetFirewallApplicationFilter -Program "C:\Program Files\nodejs\node.exe" | Get-NetFirewallRule | Remove-NetFirewallRule`

## 4. 運用

### ログの場所

| ファイル | 内容 |
|---|---|
| `C:\hiyou\logs\hiyou-service.out.log` | アプリの標準出力（起動メッセージ、週次ジョブの登録） |
| `C:\hiyou\logs\hiyou-service.err.log` | アプリのエラー（`PDF生成に失敗しました`、`サーバーエラー` など） |
| `C:\hiyou\logs\hiyou-service.wrapper.log` | WinSW 自身の記録（開始・停止・子プロセスの終了コード） |
| `C:\hiyou\app\data\export.log` | 週次レポートの送信結果。DB_PATH を変えても場所は変わらない（コードで固定） |
| イベント ビューアー → Windows ログ → システム（ソース: Service Control Manager） | サービスの異常終了と再起動の記録 |

- out / err は 10MB で切り替わり、8 世代まで残る（新しい順に `hiyou-service.0.out.log` 〜 `hiyou-service.7.out.log`）。
- 文字コードは UTF-8。PowerShell では `-Encoding UTF8` を付けないと文字化けする: `Get-Content C:\hiyou\logs\hiyou-service.err.log -Tail 50 -Encoding UTF8`

### 更新手順（業務時間外に。全員ログアウトになる）

```powershell
Stop-Service hiyoukeisan
Copy-Item C:\hiyou\data\hiyou.db "C:\hiyou\backup\hiyou-$(Get-Date -Format yyyyMMdd-HHmm).db"
cd C:\hiyou\app
git pull --ff-only
npm.cmd ci --omit=dev
Start-Service hiyoukeisan
Get-Content C:\hiyou\logs\hiyou-service.out.log -Tail 5 -Encoding UTF8
```

- `npm ci` は node_modules を作り直すので、必ずサービスを止めてから実行する。Chrome は `.cache` に残るので再ダウンロードされない（実測 27 秒）。puppeteer のバージョンを上げたときだけ、新しい Chrome が自動で入る。
- zip 方式（B）の場合は、`git pull` の代わりに `Expand-Archive -Force` で上書きする。
- `git clean` は使わない（.env と .cache が消える）。
- .env を変えたとき: `Restart-Service hiyoukeisan`
- xml を変えたとき: ログ・引数の変更は `Restart-Service` で反映される。`<onfailure>` `<resetfailure>` `<startmode>` と実行アカウントは登録時にだけ読まれるので、`hiyou-service.exe stop` → `uninstall` → `install` → `start` で入れ直す。
- Node.js の更新（26.x のセキュリティ更新）: `Stop-Service hiyoukeisan` → MSI か `winget upgrade --id OpenJS.NodeJS.LTS -e` → `Start-Service hiyoukeisan`。winget の LTS は 2027-10 に次の系列（27）へ移るので、そのときは開発PCで先に確認する。

### やめるとき

```powershell
C:\hiyou\service\hiyou-service.exe stop
C:\hiyou\service\hiyou-service.exe uninstall
Remove-NetFirewallRule -DisplayName "Hiyou-Keisan (TCP 3000, LAN only)"
```

### 単一インスタンスの注意

- サービスは Windows が 1 つしか起動しないので、通常は二重起動にならない。
- サービス稼働中に同じポートで手動起動した 2 つ目は `EADDRINUSE` で即終了する（実測）。**危険なのは、ポートを変えて同じ DB_PATH で起動すること**（2 つのプロセスがそれぞれメモリ上の DB をファイルへ丸ごと上書きし、片方の入力が消える）。サーバー上で試験起動するときは必ず別の DB_PATH を使う。

## 5. 自動起動方式の比較（2026-11-20〜21 に確認）

| 方式 | ログイン無しで起動 | 異常終了時の再起動 | ログ | 現状 | 判定 |
|---|---|---|---|---|---|
| **WinSW v2.12.0** | ○ Windows サービス | ○ Windows のサービス回復機能に任せる（`<onfailure>`） | ○ ローテーション内蔵 | v2.12.0 = 2023-01-28、v2.13.0 = 2026-11-15（experimental と明記）。MIT。exe 1 つ + XML 1 つ。未署名 | **採用** |
| Servy 10.9 | ○ | ○ ヘルス監視の設定に依存し、既定は最大 3 回で停止（0 で無制限） | ○ | 2025-08 開始、2026-11-17 に 10.9（15 か月で約 100 リリース）。署名あり、winget、GUI あり、インストーラー 126MB | 次点。GUI で管理したい場合 |
| NSSM | ○ | ○ | ○ | 正式版 2.24 = 2014-08-31、プレリリース 2.24-101 = 2017-04-26 が最後。公式ページが Windows 10 Creators Update 以降は 2.24-101 を使うよう案内 | 新規には勧めない |
| Shawl 1.9.0 | ○ | ○ 終了コードが 0 以外なら再起動 | ○ | 2026-05-03。小さな Rust 製、winget あり | 代替可（ここでは未評価） |
| タスク スケジューラ | ○（「スタートアップ時」+ SYSTEM） | △「失敗時に再起動」は終了コードでは働かないという報告が多く、仕様が曖昧。ループするラッパーを自作することになる | × 標準出力を拾わない | Windows 標準。既定値に罠（72 時間で強制停止、AC 電源時のみ開始） | 追加ソフトを一切入れられない場合のみ |
| PM2 | △ | ○ | ○ | 公式の `pm2 startup` は Windows 非対応で pm2-installer を案内。pm2-installer は 2024-01-23 以降更新なし（未解決 issue 50）、pm2-windows-service は npm 上で「NO LONGER SUPPORTED」、pm2-windows-startup は 2015 年が最終版 | 不採用。cluster モードは週次ジョブが重複する（server/jobs/scheduler.js） |
| node-windows | ○ | ○ | △ | 最新が 2022-08-17 の 1.0.0-beta.8 | 不採用 |

WinSW を選んだ理由: 再起動の仕組みが Windows 標準のサービス回復機能そのもので、挙動が単純（終了コードが 0 以外なら 10 秒後に再起動、を無制限に繰り返す）。設定が 1 つのテキストファイルで、何をしているか読める。インストーラーや常駐の管理ツールが増えない。

## 6. Puppeteer の Chrome キャッシュの罠（調査結果）

**仕組み（node_modules を読んで確認）**

- puppeteer 22.15.0 は Chrome 127.0.6533.88 を `npm ci` の postinstall でダウンロードする。保存先は次の優先順で決まる（`node_modules/puppeteer/lib/cjs/puppeteer/getConfiguration.js` 108〜113 行）:
  環境変数 `PUPPETEER_CACHE_DIR` → 設定ファイルの `cacheDirectory` → `<ホームフォルダ>\.cache\puppeteer`
- 既定のままだと、`npm ci` を実行したユーザーの `C:\Users\<ユーザー>\.cache\puppeteer` に入る。LocalSystem のホームは `C:\Windows\System32\config\systemprofile` なので、サービスからは見つからない。
- 設定ファイル（`.puppeteerrc.cjs` など）は「プロセスの作業フォルダから上へ」探される（同 43〜45 行）。`server/index.js` の場所からではない。

**実測（2026-11-20。ホームフォルダを別の場所に差し替えて別アカウントを再現し、PDF を 1 枚要求）**

| 条件 | 結果 |
|---|---|
| 対策なし | HTTP 500 `Could not find Chrome (ver. 127.0.6533.88)` |
| プロジェクト直下に `.puppeteerrc.cjs`、作業フォルダ = プロジェクトのルート | **成功** |
| 同じ設定で、作業フォルダがプロジェクトの外 | HTTP 500（設定ファイルが見つからない）。**2026-11-21 の修正後は成功**（サーバー側でも場所を指定するようにした） |
| 環境変数 `PUPPETEER_CACHE_DIR`（プロセスの環境変数、または .env に記載） | 成功 |
| `PUPPETEER_EXECUTABLE_PATH` でインストール済みの Edge 155 を指定 | 起動失敗（`Failed to launch the browser process!`）。Edge のプロセスが残った |
| `.cache` を消して `npx puppeteer browsers install chrome` | 26 秒で復旧し成功 |

**選択肢の比較**

| 方法 | 評価 |
|---|---|
| **A. `.puppeteerrc.cjs` をリポジトリに入れる（推奨）** | インストール時と実行時の両方に同じ設定が効く。誰が `npm ci` しても、どのアカウントで動かしても同じ場所になる。サーバー側でも同じ場所を環境変数で指定するようにしたので（2026-11-21、server/index.js の先頭）、実行時は作業フォルダに関係なく見つかる |
| B. 環境変数 `PUPPETEER_CACHE_DIR` | コード変更なし。ただし `npm ci` のたびに `$env:PUPPETEER_CACHE_DIR = 'C:\hiyou\app\.cache\puppeteer'` を先に実行し、.env にも `PUPPETEER_CACHE_DIR=C:/hiyou/app/.cache/puppeteer` を書く、と 2 か所をそろえ続ける必要がある。システム環境変数にすると、LocalSystem のサービスへは PC の再起動まで反映されない |
| C. サービスを専用ユーザーで動かし、そのユーザーで `npm ci` する | 更新のたびにそのユーザーで作業する必要があり、忘れると壊れる |
| D. systemprofile へキャッシュをコピーする / インストール済みの Edge・Chrome を使う | コピーしても効かなかったという報告がある / 実測で失敗。採らない |

## 7. 職員が普段使う PC を兼用する場合に変わること

- **サービス方式はそのまま使える。** ログオフしても、別の職員がログインしても動き続ける。
- **電源が最大の問題。** 帰宅時にシャットダウンされると全員使えず、月曜 6:00 の週次ジョブも動かない。「シャットダウン禁止」を徹底できないなら、.env の `EXPORT_CRON` を業務時間内（例 `0 9 * * 1` = 月曜 9:00）に変える。日中の「今すぐ再起動」でも全員ログアウトになる。
- **Step 3 の権限設定に加えて、職員のアカウントを標準ユーザー（管理者でない）にする。** 管理者権限のある職員は DB も .env も読めるので、その場合は専用機を用意する。
- その PC でのメール・Web 閲覧・USB 利用が、そのまま患者情報のあるマシンへのリスクになる。
- PDF 出力中は Chrome が 400MB 前後のメモリと CPU を数秒使う。メモリ 8GB なら体感しにくいが、4GB の PC では重くなる。
- その PC の利用者も、他の端末と同じ URL（`http://<IP>:3000/`）を使う。
- ノート PC は避ける（蓋を閉じるとスリープ、バッテリー、Wi-Fi）。

## 8. うまくいかないとき

| 症状 | 原因と対処 |
|---|---|
| 開始直後に止まる、数秒おきに再起動を繰り返す | `hiyou-service.err.log` を見る。`EADDRINUSE` = ポート 3000 を別のプロセス（Step 6 の止め忘れ）が使用中。`DB初期化エラー` = DB_PATH のフォルダに書けない、または DB ファイルが 0 バイト・破損（上書きせずに止まる。[2_運用編.md](2_運用編.md) の 2-6 で復元する） |
| `Unable to locate hiyou-service` で始まるエラー | xml が `hiyou-service.xml.txt` になっている、または名前が exe と違う |
| PDF だけ失敗（`Could not find Chrome`） | `C:\hiyou\app\.cache` に Chrome が無い（`npm ci` が未実行か、Chrome のダウンロードに失敗した） → `cd C:\hiyou\app; npx.cmd puppeteer browsers install chrome` |
| PDF だけ失敗（`Failed to launch the browser process`） | Chrome が LocalSystem で起動できていない（未検証の組み合わせ）。回避: サービスを専用の標準ユーザーで動かす（下の「権限を絞る」） |
| PDF の書体が違う・文字が欠ける | PDF は `MS Gothic` / `Meiryo` を指定している（server/routes/pdf.js）。英語版 Windows Server では日本語フォント（言語機能）を追加する |
| サーバーでは開けるが、他の端末から開けない | ネットワークが「パブリック」（Step 1-2）/ node.exe のブロック規則が残っている（Step 8）/ 端末が別サブネット（Step 8 の CIDR 指定） |
| ログに `初期管理者を作成しました` | 空の DB で起動している。.env を読めていない（`injected env (0)`、`.env.txt` になっている）か、DB_PATH の誤り |
| `git pull` で `detected dubious ownership` | 管理者 PowerShell で実行しているか確認する。それでも出れば `git config --global --add safe.directory C:/hiyou/app` |
| exe が「スマート アプリ コントロール」で止められる | WinSW と Puppeteer の Chrome はどちらも未署名（確認済み）。この機能がオンの新品 Windows 11 では止められる可能性がある（未検証） |

**権限を絞る（任意・未検証）**: SYSTEM で動かすのが最も簡単だが、アプリに欠陥があった場合の被害が PC 全体に及ぶ。より安全にするには、ローカルの標準ユーザー（例 `hiyou-svc`）を作り、`icacls C:\hiyou /grant "hiyou-svc:(OI)(CI)M"` で権限を与え、services.msc → Hiyou Keisan (Node.js) → プロパティ →「ログオン」タブでそのアカウントとパスワードを設定して `Restart-Service hiyoukeisan`。`.puppeteerrc.cjs` があるので、アカウントを変えても Chrome は見つかる。変更後は PDF を再確認する。

## 9. このアプリ固有の注意（コードから）

- 待ち受けは `app.listen(PORT)`（server/index.js）でホスト指定なし = 全インターフェース。LAN 限定はファイアウォールで担保する。
- `.env` と Chrome の場所は、作業フォルダに関係なくプロジェクト直下のものが使われる（2026-11-21 の修正。server/index.js の先頭）。
- ログイン状態はメモリ上（express-session の既定）。サービス再起動 = 全員再ログイン。
- 通信は暗号化なしの HTTP。LAN 内限定が前提。
- 停止は Ctrl+C 相当 → 15 秒で強制終了。DB の保存は「一時ファイル（`hiyou.db.tmp`）に書いてから差し替え」なので、保存の途中で止まっても DB ファイルは直前の完全な内容のまま残る（2026-11-21 の修正。その瞬間の未保存の入力は消える）。停止・再起動は利用者のいない時間に行い、更新前に DB をコピーする。
- Node.js は 20 以上が必要（node-cron 4.6.0 の要求）。
