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

## 別プロセスから Socket.IO 接続（サンプル）

```bash
npm run client
```

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
