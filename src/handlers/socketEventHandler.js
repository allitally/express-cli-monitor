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
  socket.on("image_binary", 
    (eventNmae,{ toPanelB = true } = {}) =>
    (payload,ack) =>{
      if (typeof ack === "function") {
        ack(produceAck(eventNmae, payload));
      }
   });
  socket.on("other_info", 
    (eventNmae,{ toPanelB = true } = {}) =>
    (payload,ack) =>{
      if (typeof ack === "function") {
        ack(produceAck(eventNmae, payload));
      }
   });
  socket.on("notice_record_complete", 
    (eventNmae,{ toPanelB = true } = {}) =>
    (payload,ack) =>{
      if (typeof ack === "function") {
        ack(produceAck(eventNmae, payload));
      }
   });
  socket.on("send_ips_message", 
    (eventNmae,{ toPanelB = true } = {}) =>
    (payload,ack) =>{
      line = formatRemoteOutput(payload);
 //     console.log(`log:${line}`);
      appendPanelB(line);
      if (typeof ack === "function") {
        ack(produceAck(eventNmae, payload));
      }
   });


  for (const eventName of getRegisteredEventNames()) {
    if (eventName === REMOTE_OUTPUT_EVENT) {
      continue;
    }
    socket.on(eventName, handleEvent(eventName));
  }
}
