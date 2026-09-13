import { readFileSync } from "node:fs";
import { io } from "socket.io-client";
import { parseScriptContent } from "./parseScript.js";
import { encodePayload } from "./payloadEncoders.js";

const DEFAULT_ACK_TIMEOUT_MS = 5000;

/**
 * @typedef {{ ok: true, scriptPath: string, stepsExecuted: number }} ScriptRunSuccess
 */

/**
 * @typedef {object} ScriptRunFailure
 * @property {false} ok
 * @property {string} scriptPath
 * @property {'ack_mismatch'|'ack_timeout'|'empty'|'connect_error'|'encoder_error'|'parse_error'|'unknown'} reason
 * @property {string} message
 * @property {number} [stepNo]
 * @property {string} [event]
 * @property {string} [expected]
 * @property {string} [got]
 */

/** @typedef {ScriptRunSuccess | ScriptRunFailure} ScriptRunResult */

/**
 * @param {unknown} value
 */
export function ackToString(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

/**
 * @param {import('socket.io-client').Socket} socket
 * @param {string} event
 * @param {unknown} payload
 * @param {number} timeoutMs
 */
function emitWithAck(socket, event, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`ACK timeout for event "${event}"`));
    }, timeoutMs);

    socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

/**
 * @param {import('socket.io-client').Socket} socket
 */
function waitForConnect(socket) {
  return new Promise((resolve, reject) => {
    if (socket.connected) {
      resolve();
      return;
    }

    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };

    const cleanup = () => {
      socket.off("connect", onConnect);
      socket.off("connect_error", onError);
    };

    socket.on("connect", onConnect);
    socket.on("connect_error", onError);
  });
}

/**
 * @param {string} scriptPath
 * @param {Partial<ScriptRunFailure>} details
 * @returns {ScriptRunFailure}
 */
function fail(scriptPath, details) {
  return {
    ok: false,
    scriptPath,
    reason: "unknown",
    message: "Script failed",
    ...details,
  };
}

/**
 * @param {ScriptRunResult} result
 * @param {{ writePanelC?: (text: string, color?: string) => void }} [logTarget]
 */
export function logScriptResult(result, logTarget = {}) {
  const writePanelC = logTarget.writePanelC;

  if (result.ok) {
    const message = `[script] OK: ${result.scriptPath} (${result.stepsExecuted} steps)`;
    console.log(message);
    writePanelC?.(message, "#9ece6a");
    return;
  }

  let message;
  if (result.reason === "ack_mismatch") {
    message =
      `[script] FAIL (ACK mismatch at step ${result.stepNo}, event ${result.event}): ` +
      `expected "${result.expected}", got "${result.got}"`;
  } else if (result.reason === "ack_timeout") {
    message =
      `[script] FAIL (ACK timeout at step ${result.stepNo}, event ${result.event}): ` +
      result.message;
  } else {
    message = `[script] FAIL (${result.reason}): ${result.message}`;
  }

  console.error(message);
  writePanelC?.(message, "#f7768e");
}

/**
 * @param {object} options
 * @param {string} options.scriptPath
 * @param {string} options.url
 * @param {{ writePanelC?: (text: string, color?: string) => void, setStatus?: (text: string, color?: string) => void }} [options.monitor]
 * @param {number} [options.ackTimeoutMs]
 * @returns {Promise<ScriptRunResult>}
 */
export async function runScript({
  scriptPath,
  url,
  monitor,
  ackTimeoutMs = DEFAULT_ACK_TIMEOUT_MS,
}) {
  const writePanelC = monitor?.writePanelC
    ? (text, color) => monitor.writePanelC(text, color)
    : undefined;
  const setStatus = monitor?.setStatus
    ? (text, color) => monitor.setStatus(text, color)
    : undefined;

  let steps;
  try {
    const content = readFileSync(scriptPath, "utf8");
    steps = parseScriptContent(content);
  } catch (err) {
    return fail(scriptPath, {
      reason: "parse_error",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  if (steps.length === 0) {
    return fail(scriptPath, {
      reason: "empty",
      message: "Script has no executable steps",
    });
  }

  writePanelC?.(`Script: ${scriptPath}`, "#bb9af7");
  setStatus?.("Running script...", "#7dcfff");

  const socket = io(url, {
    reconnection: false,
    forceNew: true,
  });

  try {
    try {
      await waitForConnect(socket);
    } catch (err) {
      return fail(scriptPath, {
        reason: "connect_error",
        message: err instanceof Error ? err.message : String(err),
      });
    }

    writePanelC?.(`Script client connected: ${socket.id}`, "#73daca");

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepNo = i + 1;

      let payload;
      try {
        payload = encodePayload(step.event, step.args);
      } catch (err) {
        return fail(scriptPath, {
          reason: "encoder_error",
          stepNo,
          event: step.event,
          message: err instanceof Error ? err.message : String(err),
        });
      }

      writePanelC?.(
        `[${stepNo}] emit ${step.event} ${JSON.stringify(payload)}`,
        "#7aa2f7",
      );

      if (step.ackMode === "pass") {
        socket.emit(step.event, payload);
        writePanelC?.(`[${stepNo}] PASS (skip ack)`, "#9ece6a");
        continue;
      }

      if (step.ackMode === "ack") {
        let received;
        try {
          received = await emitWithAck(
            socket,
            step.event,
            payload,
            ackTimeoutMs,
          );
        } catch (err) {
          return fail(scriptPath, {
            reason: "ack_timeout",
            stepNo,
            event: step.event,
            message: err instanceof Error ? err.message : String(err),
          });
        }

        const receivedText = ackToString(received);
        const expectedText = step.expectedAck ?? "";

        if (receivedText !== expectedText) {
          writePanelC?.(
            `[${stepNo}] FAIL expected Ack: ${expectedText}, got: ${receivedText}`,
            "#f7768e",
          );
          setStatus?.("Script failed", "#f7768e");
          return fail(scriptPath, {
            reason: "ack_mismatch",
            stepNo,
            event: step.event,
            expected: expectedText,
            got: receivedText,
            message: `ACK mismatch at step ${stepNo}`,
          });
        }

        writePanelC?.(`[${stepNo}] PASS Ack: ${receivedText}`, "#9ece6a");
        continue;
      }

      socket.emit(step.event, payload);
    }

    setStatus?.("Script passed", "#9ece6a");
    return {
      ok: true,
      scriptPath,
      stepsExecuted: steps.length,
    };
  } catch (err) {
    return fail(scriptPath, {
      reason: "unknown",
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    socket.disconnect();
    socket.close();
  }
}
