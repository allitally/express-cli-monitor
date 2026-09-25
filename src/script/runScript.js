import { readFileSync } from "node:fs";
import { io } from "socket.io-client";
import { parseScriptContent,createDeferred } from "./parseScript.js";
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
    // writePanelC(`Defined WritePanelC in logScriptResult:${JSON.stringify(result)}`,"#f7768e");

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
 * @param {ScriptStep} step
 * @param {unknown[]} receivedArgs
 * @returns {boolean}
 */
function matchesOnCondition(step, receivedArgs) {
  if (step.firstArgPattern === undefined) {
    return true;
  }

  const firstArg = receivedArgs[0];

  if (typeof firstArg !== "string") {
    return false;
  }

  // gまたはyフラグ付き正規表現を使う場合の前回位置をリセット
  step.firstArgPattern.lastIndex = 0;

  return step.firstArgPattern.test(firstArg);
}
/**
 * @param {import("socket.io").Socket} socket
 * @param {string} eventName
 * @param {Map<string, SocketHandler>} handlerMap
 */
function unregisterOnHandler(
  socket,
  eventName,
  handlerMap,
) {
  const handler = handlerMap.get(eventName);

  if (handler === undefined) {
    return;
  }

  socket.off(eventName, handler);
  handlerMap.delete(eventName);
}
/**
 * @param {import("socket.io").Socket} socket
 * @param {ScriptStep} step
 * @param {{ writePanelC?: (text: string, color?: string) => void, setStatus?: (text: string, color?: string) => void }} monitor
 * @param {number} defaultAckTimeoutMs
 * @param {Map<string, SocketHandler>} handlerMap
 * @returns {Promise<unknown>}
 */
function registerOnStep(
    socket,
    step,
    monitor,
    defaultAckTimeoutMs,
    handlerMap,
) {
    if (step.onEvent === undefined) {
        throw new Error("step.onEvent is undefined");
    }

    const eventName = step.onEvent;
    const deferred = createDeferred();

    /*
     * 同じイベント名の古いハンドラーが残っている場合は解除する。
     */
    const oldHandler = handlerMap.get(eventName);

    if (oldHandler !== undefined) {
        socket.off(eventName, oldHandler);
        handlerMap.delete(eventName);
    }
    monitor.writePanelC(`registerOnStep(${JSON.stringify(step)})`, "#7dcfff");
    /*
     * async関数そのものを保存・登録する。
     * handlerをここでawaitしない。
     */
    const handler = async (...receivedArgs) => {
        if (!matchesOnCondition(step, receivedArgs)) {
            return;
        }

        /*
         * 条件成立後、同じイベントが連続して到着しても
         * 多重実行しないようにする。
         */
        if (step.running) {
            return;
        }

        step.running = true;

        try {
            
            const payload = encodePayload(step.event, step.args, monitor);
            let receivedAck;

            if (step.ackMode === "ack") {
                /*
                 * ackモードでは、送信先からACKが返るまで待つ。
                 */
                receivedAck = await emitWithAck(
                    socket,
                    step.event,
                    payload,
                    step.timeOut ?? defaultAckTimeoutMs,
                );

                if (
                    step.expectedAck !== null &&
                        String(receivedAck) !== step.expectedAck
                ) {
                    throw new Error(
                        `Unexpected ACK for ${step.event}: ` +
                            `expected "${step.expectedAck}", ` +
                            `received "${String(receivedAck)}"`,
                    );
                }
            } else {
                /*
                 * passモードではACKを待たずに送信する。
                 * socket.emit()はPromiseを返さないのでawaitしない。
                 */
                socket.emit(
                    step.event,
                    payload,
                );
            }

            deferred.resolve(receivedAck);
        } catch (error) {
            /*
             * asyncイベントハンドラー内の例外が未処理にならないよう、
             * 待機している側へ通知する。
             */
            deferred.reject(error);
        }
    };
    if (eventName in handlerMap) {
        socket.off(eventName, handlerMap[eventName]);
    }
    handlerMap.set(eventName, handler);
    socket.on(eventName, handler);

    step.pre_registered = true;
    step.running = false;

    return deferred.promise;
}

export async function run1Line(stepNo,step, socket,scriptPath, url, monitor, ackTimeoutMs,
    on_events = undefined){
    monitor.writePanelC(`Script: ${stepNo}:${step.args[0]}`, "#bb9af7");
      let payload;
      try {
        payload = encodePayload(step.event, step.args, monitor);
          // monitor.writePanelC(`retrun: ${stepNo}:${JSON.stringify(step.args)}`, "#bb9af7");

      } catch (err) {
        // payload = encodePayload(step.event, step.args, monitor);
          monitor.writePanelC(`catch: ${stepNo}:${JSON.stringify(step.args)}`, "#bb9af7");
        return fail(scriptPath, {
            reason : "encoder_error",
            stepNo : stepNo,
            event  : step.event,
            message: err instanceof Error ? err.message : String(err),
        });
      }

      monitor.writePanelC?.(
        `[No.${stepNo}] emit ${step.event} ${JSON.stringify(payload)}`,
        "#7aa2f7",
      );

      if (step.ackMode === "pass") {
        socket.emit(step.event, payload);
        monitor.writePanelC?.(`[${stepNo}] PASS (skip ack)`, "#9ece6a");
        return {ok:true};
      }

      if (step.ackMode === "ack") {
        let received;
        try {
          received = await emitWithAck(
              socket,
              step.event,
              payload,
              step.timeOut?? ackTimeoutMs
          );
        } catch (err) {
          return fail(scriptPath, {
              reason: "ack_timeout",
              stepNo: stepNo,
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
              stepNo: stepNo,
              event: step.event,
              expected: expectedText,
              got: receivedText,
              message: `ACK mismatch at step ${stepNo}`,
          });
        }

        monitor.writePanelC?.(`[${stepNo}] PASS Ack: ${receivedText}`, "#9ece6a");
        return {ok:true};
      }

      socket.emit(step.event, payload);

  return {ok:true};
}
/**
 * @param {object} step
 * @param {string} receivedEvent
 * @param {string} receivedArgs
 **/
function shouldRunOnStep(step, receivedEvent, receivedArgs) {
  if (step.onEvent === undefined) {
    return false;
  }

  if (step.onEvent !== receivedEvent) {
    return false;
  }

  if (step.firstArgPattern !== undefined) {
    const firstArg = receivedArgs[0];

    if (typeof firstArg !== "string") {
      return false;
    }

    return step.firstArgPattern.test(firstArg);
  }

  return true;
}
/**
 * @typedef {(...args: unknown[]) => void} SocketHandler
 */

/**
 * @param {object} options
 * @param {string} options.scriptPath
 * @param {string} options.url
 * @param {{ writePanelC?: (text: string, color?: string) => void, setStatus?: (text: string, color?: string) => void }} [options.monitor]
 * @param {number} [options.ackTimeoutMs]
 * @param {@type {Map<string, SocketHandler>} [options.on_events]
 * @returns {Promise<ScriptRunResult>}
 */
export async function runScript({
    scriptPath,
    url,
    monitor,
    ackTimeoutMs = DEFAULT_ACK_TIMEOUT_MS,
    parent_socket = undefined,
    on_events = undefined
}) {
    const clear_on_events = on_events?false:true;
    
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

    const socket = parent_socket||io(url, {
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

        if (on_events===undefined) {
            on_events = new Map();
        }
        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            const stepNo = i + 1;
            if (i+1 < steps.length) {
                if (steps[i+1].onEvent !== undefined) {
                    steps[i+1].completionPromise
                        = registerOnStep(socket
                                         , steps[i+1]
                                         , monitor
                                         , ackTimeoutMs
                                         , on_events);
                }
            }
            if (step.onEvent !== undefined) {
                writePanelC?.(`onEvent ackMode=${step.ackMode},onEvent=${step.onEvent}`,"#73daca");
                if (!step.pre_registered) {
                    step.completionPromise = registerOnStep(socket,step,
                                      monitor,ackTimeoutMs, on_events);
                    
                }
                if (step.ackMode === "ack" &&
                        step.completionPromise !== undefined
                   ) {
                    try {
                        /*
                         * 条件に一致するイベントを受信し、
                         * 送信メッセージのACKが返るまでここで待つ。
                         */
                        await step.completionPromise;
                    } finally {
                        unregisterOnHandler(
                            socket,
                            step.onEvent,
                            on_events,
                        );
                    }
                }
                continue;
            }

            const received = await run1Line(stepNo,step,socket,scriptPath,
                                      url,
                                      monitor,
                                      ackTimeoutMs
                                      , on_events);
            if (!received.ok) {
                writePanelC(`Script:Error End in No.${stepNo}`,"#7aa2f7");                
                return received;
            }
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
        if (clear_on_events) {
            /*
             * エラーや中断が発生した場合も、残っている
             * ハンドラーをすべて解除する。
             */
            for (const [eventName, handler] of on_events) {
                socket.off(eventName, handler);
            }
            on_events.clear();
        }
        if (!parent_socket) {
            socket.disconnect();
            socket.close();
        }
    }
}

