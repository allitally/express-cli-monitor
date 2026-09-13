import { REMOTE_OUTPUT_EVENT } from "../constants.js";

/** @type {Record<string, (args: string[]) => unknown>} */
const payloadEncoders = {
  [REMOTE_OUTPUT_EVENT]: (args) => ({ message: args.join(" ") }),

  /** Sample: convert args to a JSON array payload */
  "array-payload": (args) => [...args],
};

/** @type {Record<string, (payload: unknown) => unknown>} */
const ackHandlers = {
  [REMOTE_OUTPUT_EVENT]: () => "ok",
  "array-payload": (payload) => JSON.stringify(payload),
};

/**
 * @param {string} eventName
 * @param {(args: string[]) => unknown} encoder
 */
export function registerPayloadEncoder(eventName, encoder) {
  payloadEncoders[eventName] = encoder;
}

/**
 * @param {string} eventName
 * @param {(payload: unknown) => unknown} handler
 */
export function registerAckHandler(eventName, handler) {
  ackHandlers[eventName] = handler;
}

/** @returns {string[]} */
export function getRegisteredEventNames() {
  return Object.keys(payloadEncoders);
}

/**
 * @param {string} eventName
 * @param {string[]} args
 */
export function encodePayload(eventName, args) {
  const encoder = payloadEncoders[eventName];
  if (!encoder) {
    throw new Error(`No payload encoder registered for event: ${eventName}`);
  }
  return encoder(args);
}

/**
 * @param {string} eventName
 * @param {unknown} payload
 */
export function produceAck(eventName, payload) {
  const handler = ackHandlers[eventName];
  if (!handler) {
    return "ok";
  }
  return handler(payload);
}
