import { REMOTE_OUTPUT_EVENT } from "../constants.js";
import {
  getRegisteredEventNames,
  produceAck,
} from "../script/payloadEncoders.js";

/**
 * @param {import('socket.io').Socket} socket
 * @param {object} options
 * @param {(line: string) => void} options.appendPanelB
 * @param {(text: string, color?: string) => void} [options.writePanelC]
 */
export function registerSocketEventHandlers(socket, { appendPanelB }) {
  const formatRemoteOutput = (payload) => {
    if (typeof payload === "string") {
      return payload;
    }
    if (typeof payload?.message === "string") {
      return payload.message;
    }
    return JSON.stringify(payload);
  };

  const handleEvent =
    (eventName, { toPanelB = true } = {}) =>
    (payload, ack) => {
      if (toPanelB) {
        const line =
          eventName === REMOTE_OUTPUT_EVENT
            ? formatRemoteOutput(payload)
            : `[${eventName}] ${JSON.stringify(payload)}`;
        appendPanelB(line);
      }

      if (typeof ack === "function") {
        ack(produceAck(eventName, payload));
      }
    };

  socket.on(REMOTE_OUTPUT_EVENT, handleEvent(REMOTE_OUTPUT_EVENT));

  for (const eventName of getRegisteredEventNames()) {
    if (eventName === REMOTE_OUTPUT_EVENT) {
      continue;
    }
    socket.on(eventName, handleEvent(eventName));
  }
}
