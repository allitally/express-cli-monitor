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

TUI 起動後:

```
load examples/scripts/sample.script
```

### スクリプト形式

```
<ソケットメッセージ> [<引数1> [<引数2> ...]]
Ack:<期待するACK文字列>
```

- 引数はスペース区切り。ダブルクォート `"..."` で空白を含む 1 引数にできます。
- イベント行の次行が `Ack:` で始まる場合、その後の文字列と ACK 応答が一致すれば PASS、不一致ならテスト中断（終了コード 1）。
- 次行が `Pass:` の場合は ACK を待たず次の送信へ進みます。
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

```
┌─ ステータス（1行）────────────────────────────────────┐
├───────────────┬───────────────┬───────────────────────┤
│ A: console.log│ B: socket.io  │ C: info（色付き）      │
│ （スクロール） │ （スクロール） │ （スクロール）          │
├───────────────┴───────────────┴───────────────────────┤
│ コマンド入力（3行） [Enter:実行] [Tab:補完] [↑↓:履歴]   │
└───────────────────────────────────────────────────────┘
```

## 提供 API

| API | 説明 |
|-----|------|
| `monitor.setStatus(text, color)` | ステータス行へ色付き文字列を表示 |
| `onCommandExecute(text, args)` | Enter 確定時のコマンド実行ハンドラ |
| `onTabComplete(args)` | Tab 押下時の補完ハンドラ（引数配列を受け取る） |
| ↑ / ↓ | コマンド履歴（組み込み） |
| パネル A | `console.log()` を横取りして表示 |
| パネル B | Socket.IO `remote-output` イベントの出力 |
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
