/**
 * Socket.IO 接続先プロセスのサンプル
 *
 * 使い方:
 *   ターミナル1: npm start
 *   ターミナル2: npm run client
 */
import { io } from "socket.io-client";
import { REMOTE_OUTPUT_EVENT } from "../src/constants.js";

const URL = process.env.MONITOR_URL ?? "http://localhost:3000";

const socket = io(URL, { reconnection: true });

socket.on("connect", () => {
  console.log(`[client] connected: ${socket.id}`);

  let count = 0;
  setInterval(() => {
    count++;
    socket.emit(REMOTE_OUTPUT_EVENT, {
      message: `[remote] tick ${count} at ${new Date().toISOString()}`,
    });
  }, 3000);
});

socket.on("disconnect", () => {
  console.log("[client] disconnected");
});

socket.on("connect_error", (err) => {
  console.error("[client] connect_error:", err.message);
});
