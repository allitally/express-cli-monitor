import { parseCliArgs, printUsage } from "./cli/parseArgs.js";
import { CliMonitor } from "./monitor/CliMonitor.js";
import { onCommandExecute } from "./handlers/commandHandler.js";
import { onTabComplete } from "./handlers/tabCompleteHandler.js";
import { registerSocketEventHandlers } from "./handlers/socketEventHandler.js";
import { createSocketServer } from "./server.js";
import { logScriptResult, runScript } from "./script/runScript.js";

const PORT = Number(process.env.PORT ?? 3000);
const SCRIPT_URL = process.env.MONITOR_URL ?? `http://localhost:${PORT}`;

let cliOptions;
try {
  cliOptions = parseCliArgs(process.argv);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  printUsage();
  process.exit(1);
}

if (cliOptions.help) {
  printUsage();
  process.exit(0);
}

const monitor = new CliMonitor({
  onCommandExecute: async (commandText, args) => {
    await onCommandExecute(commandText, args);

    const cmd = args[0];
    if (cmd === "status") {
      monitor.setStatus(`接続ポート: ${PORT}`, "#7dcfff");
    } else if (cmd === "clear") {
      monitor.clearAllPanels();
      monitor.setStatus("ログをクリアしました", "#9ece6a");
    } else if (cmd === "help") {
      monitor.writePanelC("help | status | clear | load | quit", "#bb9af7");
    } else if (cmd === "load") {
      if (args.length < 2) {
        monitor.writePanelC("usage: load <script-file>", "#f7768e");
        return;
      }
      const result = await runScript({
        scriptPath: args[1],
        url: SCRIPT_URL,
        monitor,
      });
      logScriptResult(result, { writePanelC: (text, color) => monitor.writePanelC(text, color) });
    } else if (cmd === "quit" || cmd === "exit") {
      monitor.setStatus("終了中...", "#f7768e");
      monitor.destroy();
      process.exit(0);
    }
  },
  onTabComplete,
});

createSocketServer({
  port: PORT,
  onConnection: (socket) => {
    console.log(`[socket.io] 接続: ${socket.id}`);
    monitor.setStatus(`Client connected: ${socket.id}`, "#7aa2f7");
    monitor.writePanelC(`接続: ${socket.id}`, "#73daca");

    registerSocketEventHandlers(socket, {
      appendPanelB: (line) => monitor.appendPanelB(line),
    });

    socket.on("disconnect", () => {
      console.log(`[socket.io] 切断: ${socket.id}`);
      monitor.setStatus("Client disconnected", "#e0af68");
      monitor.writePanelC(`切断: ${socket.id}`, "#f7768e");
    });
  },
});

await monitor.start();
monitor.setStatus(`Listening on port ${PORT}`, "#9ece6a");
console.log(`Express + Socket.IO server started on http://localhost:${PORT}`);

if (cliOptions.scriptPath) {
  const result = await runScript({
    scriptPath: cliOptions.scriptPath,
    url: SCRIPT_URL,
    monitor,
  });
  logScriptResult(result, { writePanelC: (text, color) => monitor.writePanelC(text, color) });
  monitor.destroy();
  process.exit(result.ok ? 0 : 1);
}

process.on("SIGINT", () => {
  monitor.destroy();
  process.exit(0);
});
