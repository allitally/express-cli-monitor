# Express CLI Monitor (OpenTUI)

Express + Socket.IO で別プロセスと通信し、OpenTUI によるフルスクリーンコンソールモニタを表示する CLI です。

## 要件

- **Node.js 26.4.0 以上**（`--experimental-ffi` が必要）
- または **Bun 1.3.0 以上**

> 現在の Node.js 20 では OpenTUI のネイティブレンダラーが起動しません。  
> [Node.js 26.4+](https://nodejs.org/) をインストールするか、Bun を使用してください。

## インストール

```bash
cd express-cli-monitor
npm install
```

## 起動

```bash
npm start
```

## スクリプトによるクライアントテスト

起動時に `--script`（`-s`）でスクリプトファイルを指定するか、TUI のコマンド入力で `load <file>` を実行すると、内蔵 Socket.IO クライアントが 1 行ずつイベントを送信して ACK を検証します。終了時に正常終了か ACK 不一致かをパネル C とコンソールへ出力します。

```bash
npm start -- --script examples/scripts/sample.script
```

TUI 起動後（クライアント接続後）:

```
load examples/scripts/sample.script
send remote-output hello from tui
```

`send` は先頭の `send` を除いた残りを 1 行のスクリプトとして、接続中の Socket.IO クライアントへ送ります。`load` / `send` / `help` / `status` / `clear` / `quit` はクライアント接続後に有効です。`dump` と `bind` は接続前でも使えます。

### スクリプト形式

```
<ソケットメッセージ> [<引数1> [<引数2> ...]]
Ack:<期待するACK文字列>
```

- 引数はスペース区切り。ダブルクォート `"..."` で空白を含む 1 引数にできます。
- イベント行の次行が `Ack:` で始まる場合、その後の文字列と ACK 応答が一致すれば PASS、不一致ならテスト中断（終了コード 1）。
- `Ack(to=<ミリ秒>):<期待するACK文字列>` で、そのステップだけの待ち時間を指定できます。
- 次行が `Pass:` の場合は ACK を待たず次の送信へ進みます。
- `On.<イベント>: <ソケットメッセージ> ...` は、そのイベントを受信してから右側の送信を実行します。
- `On.<イベント>=='<正規表現>': <ソケットメッセージ> ...` は、受信した先頭引数が正規表現に一致したときだけ実行します。
- `#` で始まる行と空行は無視します。

### ペイロード変換（コールバック）

`src/script/payloadEncoders.js` で `<ソケットメッセージ>` 名をキーに、引数配列から Socket.IO ペイロードへ変換する関数を登録します。

```javascript
import { registerPayloadEncoder, registerAckHandler } from "./script/payloadEncoders.js";

registerPayloadEncoder("my-event", (args) => ({ items: args }));
registerAckHandler("my-event", (payload) => JSON.stringify(payload));
```

組み込みサンプル:

| イベント | 変換 |
|---------|------|
| `remote-output` | `{ message: args.join(" ") }` |
| `array-payload` | 引数配列をそのまま JSON 配列ペイロードにする |

`src/index.js` が起動時に追加登録するイベント:

| イベント | 引数 |
|---------|------|
| `exec_ips` | タイトル、ルート、1 行 IPS、任意でファイルパス |
| `exec_ips0` | タイトル、ルート、1 行 IPS、任意でファイルパスとその次の引数 |
| `query_recorder` | 1 個以上。引数をそのまま送る |
| `record_pick` / `record_reserve` / `record_range` | タイトル、ルート、`{key:value,...}` 形式のマップ |
| `history_pick` | 2 個以上。引数をそのまま送る |
| `REPL_cmd` | 1 個以上。引数をそのまま送る |
| `set_datarec_path` | 4 個以上。引数をそのまま送る |
| `exit` | 引数をそのまま送る |

マップの例: `{0:%s_%f.jpg,1:%s_%f.bin}` は `{ "0": "%s_%f.jpg", "1": "%s_%f.bin" }` になります。

## 別プロセスから Socket.IO 接続（サンプル）

### Node.js クライアント

```bash
npm run client
```

### C++ クライアント（socket.io-client-cpp 3.1.0）

CMake 3.14 以上と C++11 対応コンパイラが必要です。初回ビルド時に [socket.io-client-cpp 3.1.0](https://github.com/socketio/socket.io-client-cpp/releases/tag/3.1.0) を FetchContent で取得します。

```bash
# ターミナル1
npm start

# ターミナル2 (Visual Studio / Ninja など)
cmake -S examples/cpp-client -B examples/cpp-client/build
cmake --build examples/cpp-client/build --config Release
examples/cpp-client/build/Release/monitor_cpp_client.exe   # Windows (multi-config)
examples/cpp-client/build/monitor_cpp_client               # Linux / macOS

# ターミナル2 (MSYS2 UCRT64 + MinGW)
cmake -G 'MinGW Makefiles' -S examples/cpp-client -B examples/cpp-client/build
cmake --build examples/cpp-client/build
examples/cpp-client/build/monitor_cpp_client.exe
```

接続先は環境変数 `MONITOR_URL` で変更できます（既定: `http://localhost:3000`）。

`remote-output` イベントで送ったメッセージがパネル **B** に表示されます。

## 画面レイアウト

上から、状態表示 3 行、ログ 3 ペイン、コマンド入力 3 行です。

```
┌─ フレーム（1行） Frame 受信状態 ──────────────────────┐
├─ ステータス（1行） 接続 / Recorder ───────────────────┤
├─ ステージ（1行） query_process ───────────────────────┤
├───────────────┬───────────────┬───────────────────────┤
│ A: console.log│ B: socket.io  │ C: info（色付き）      │
│ （スクロール） │ （スクロール） │ （スクロール）          │
├───────────────┴───────────────┴───────────────────────┤
│ コマンド入力（3行）                                     │
│ [Enter:実行] [Shift+Enter:改行] [Tab:補完] [↑↓:履歴]   │
└───────────────────────────────────────────────────────┘
```

クライアント接続中は 5 秒ごとに上 3 行を更新します。

| 行 | 初期表示 | 接続中の表示 |
|----|----------|----------------|
| フレーム | `-` | `Frame(<fps> FPS): Total=<受信数>,Session=<id>,FN=<フレーム番号>` |
| ステータス | `Listening on port <PORT>` | 接続・切断メッセージ、および `Recorder: <state>` |
| ステージ | `Ready` | `Stage` `Camera` `Fnum` `FPS` `Firm` `RTE` `CompID` `Exec` `CEr` |

ペイン内のマウス選択はターミナルのコピーに載りません。各ペインのバッファ全文をダンプします。既定では `dumps/` に UTF-8 で書き、同時にクリップボードへコピーします。ペインタイトルに現在のキーが出ます（例: `A: console.log [F6]`）。

| キー | 動作 |
|------|------|
| F6 | ペイン A をダンプ |
| F7 | ペイン B をダンプ |
| F8 | ペイン C をダンプ |
| F9 | A/B/C をまとめてダンプ |

```
dump a
dump b logs/socket.txt
dump all
bind
bind a alt+a
bind all none
```

キー指定は `f6`、`ctrl+f2`、`alt+a`、`shift+f6`、`ctrl+shift+a` です。`ctrl+c` と、修飾なしの文字キーは割り当てできません。

```bash
npm start -- --dump-key-a alt+a --dump-dir logs/dumps
```

## 提供 API

| API | 説明 |
|-----|------|
| `monitor.setFrameStatus(text, color)` | 最上段のフレーム行へ色付き文字列を表示（既定色 `#FFFF00`） |
| `monitor.setStatus(text, color)` | 2 段目のステータス行へ色付き文字列を表示（既定色 `#00FF00`） |
| `monitor.addStatus(text, color)` | ステータス行を上書きする |
| `monitor.clearStatus()` | ステータス行を空にする |
| `monitor.addStageStatus(text, color)` | 3 段目のステージ行へ色付き文字列を表示（既定色 `#00FF00`） |
| `onCommandExecute(text, args)` | Enter 確定時のコマンド実行ハンドラ |
| `onTabComplete(args)` | Tab 押下時の補完ハンドラ（引数配列を受け取る） |
| Enter / Shift+Enter | 実行 / 入力欄内の改行 |
| ↑ / ↓ | コマンド履歴（組み込み） |
| F6 / F7 / F8 / F9 | ペイン A / B / C / 全部をダンプ（キーは `bind` で変更） |
| `dump <pane> [file]` | 指定ペインをファイルとクリップボードへダンプ |
| `bind <pane> <key>` | ダンプのショートカットを変更。`none` で解除 |
| `send <event> [args...]` | 接続中クライアントへ 1 イベントを送る |
| `load <file>` | スクリプトを実行する |
| `help` / `status` / `clear` / `quit` | 使い方表示 / ポート表示 / ログ消去 / 終了 |
| パネル A | `console.log()` を横取りして表示 |
| パネル B | Socket.IO `remote-output` と `send_ips_message` の出力 |
| `monitor.writePanelC(text, color)` | パネル C へ色付き文字列出力 |

## カスタマイズ

- コマンド処理: `src/handlers/commandHandler.js`
- Tab 補完: `src/handlers/tabCompleteHandler.js`
- TUI / API: `src/monitor/CliMonitor.js`

## 環境変数

| 変数 | 既定値 | 説明 |
|------|--------|------|
| `PORT` | `3000` | Express / Socket.IO のポート |
| `MONITOR_URL` | `http://localhost:3000` | クライアントサンプルの接続先 |
| `DUMP_KEY_A` | `f6` | ペイン A のダンプキー |
| `DUMP_KEY_B` | `f7` | ペイン B のダンプキー |
| `DUMP_KEY_C` | `f8` | ペイン C のダンプキー |
| `DUMP_KEY_ALL` | `f9` | 全ペインのダンプキー |
| `DUMP_DIR` | `dumps` | ダンプ先ディレクトリ。空文字ならファイル出力なし |
