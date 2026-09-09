import { CliMonitor } from "./monitor/CliMonitor.js";
import { onCommandExecute } from "./handlers/commandHandler.js";
import { onTabComplete } from "./handlers/tabCompleteHandler.js";
import { createSocketServer, REMOTE_OUTPUT_EVENT } from "./server.js";

const PORT = Number(process.env.PORT ?? 3000);

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
      monitor.writePanelC("help | status | clear | quit", "#bb9af7");
    } else if (cmd === "quit" || cmd === "exit") {
      monitor.setStatus("終了中...", "#f7768e");
      monitor.destroy();
      process.exit(0);
    }
  },
  onTabComplete,
});

const { io } = createSocketServer({
  port: PORT,
  onConnection: (socket) => {
    console.log(`[socket.io] 接続: ${socket.id}`);
    monitor.setStatus(`Client connected: ${socket.id}`, "#7aa2f7");
    monitor.writePanelC(`接続: ${socket.id}`, "#73daca");

    socket.on(REMOTE_OUTPUT_EVENT, (payload) => {
      const line =
        typeof payload === "string"
          ? payload
          : typeof payload?.message === "string"
            ? payload.message
            : JSON.stringify(payload);
      monitor.appendPanelB(line);
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

process.on("SIGINT", () => {
  monitor.destroy();
  process.exit(0);
});
