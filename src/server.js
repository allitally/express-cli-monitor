import express from "express";
import { createServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";

export { REMOTE_OUTPUT_EVENT } from "./constants.js";

/**
 * Express + Socket.IO サーバーを起動する
 *
 * @param {object} options
 * @param {number} [options.port=3000]
 * @param {(socket: import('socket.io').Socket) => void} [options.onConnection]
 * @returns {{ app: import('express').Express, httpServer: import('node:http').Server, io: SocketIOServer }}
 */
export function createSocketServer({ port = 3000, onConnection } = {}) {
  const app = express();
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  const httpServer = createServer(app);
  const io = new SocketIOServer(httpServer, {
    cors: { origin: "*" },
  });

  io.on("connection", (socket) => {
    onConnection?.(socket);
  });

  httpServer.listen(port);

  return { app, httpServer, io };
}
