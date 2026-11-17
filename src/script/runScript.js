import { readFileSync } from "node:fs";
import { appendFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { io } from "socket.io-client";
import { createDeferred } from "./parseScript.js";
import { encodePayload } from "./payloadEncoders.js";
import { CliMonitor } from "../monitor/CliMonitor.js";
import {
  executeScriptProgram,
  isIdentifier,
  parseScriptProgram,
  validateScriptProgram,
} from "./scriptLanguage.js";

const DEFAULT_ACK_TIMEOUT_MS = 5000;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Verify that every numbered file in a FILE pattern exists.
 * "*" matches arbitrary text and "{0-49}" defines the sequence range.
 *
 * @param {string} filePattern
 */
export async function verifyFileSequence(filePattern) {
  const directory = path.dirname(filePattern);
  const fileNamePattern = path.basename(filePattern);
  const ranges = [...fileNamePattern.matchAll(/\{(-?\d+)-(-?\d+)\}/g)];
  if (ranges.length !== 1) {
    throw new Error("FILE pattern must contain exactly one sequence range such as {0-49}");
  }

  const range = ranges[0];
  const start = Number(range[1]);
  const end = Number(range[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
    throw new Error(`Invalid FILE sequence range: ${range[0]}`);
  }

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(`FILE directory is not available: ${directory} (${error.message})`);
  }
  const fileNames = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const before = fileNamePattern.slice(0, range.index);
  const after = fileNamePattern.slice(range.index + range[0].length);
  const wildcardRegex = (text) => escapeRegExp(text).replace(/\\\*/g, ".*");
  const zeroPadded = /^-?0\d/.test(range[1]) || /^-?0\d/.test(range[2]);
  const width = Math.max(range[1].replace("-", "").length, range[2].replace("-", "").length);
  const missing = [];

  for (let number = start; number <= end; number++) {
    const absolute = Math.abs(number);
    const numberText = zeroPadded
      ? `${number < 0 ? "-" : ""}${String(absolute).padStart(width, "0")}`
      : String(number);
    const expected = new RegExp(
      `^${wildcardRegex(before)}${escapeRegExp(numberText)}${wildcardRegex(after)}$`,
    );
    if (!fileNames.some((name) => expected.test(name))) missing.push(numberText);
  }

  if (missing.length > 0) {
    throw new Error(`FILE sequence is incomplete in ${directory}; missing: ${missing.join(", ")}`);
  }
}

function timestampForFile(date = new Date()) {
  const part = (value, width = 2) => String(value).padStart(width, "0");
  return [
    date.getFullYear(),
    part(date.getMonth() + 1),
    part(date.getDate()),
    "_",
    part(date.getHours()),
    part(date.getMinutes()),
    part(date.getSeconds()),
    "_",
    part(date.getMilliseconds(), 3),
  ].join("");
}

function reportPathFor(scriptPath, logDirectory = process.cwd()) {
  const extension = path.extname(scriptPath);
  const baseName = path.basename(scriptPath, extension).replace(/[^A-Za-z0-9_.-]/g, "_");
  return path.resolve(logDirectory, `LOG_${timestampForFile()}_${baseName}.log`);
}

class ScriptReport {
  constructor(logPath) {
    this.logPath = logPath;
    this.pendingWrite = Promise.resolve();
  }

  async initialize() {
    await writeFile(this.logPath, "", "utf8");
  }

  write(line) {
    this.pendingWrite = this.pendingWrite.then(() => appendFile(this.logPath, `${line}\n`, "utf8"));
    return this.pendingWrite;
  }

  result(stepNo, line, elapsedMs, status, ack) {
    return this.write(
      `[Step=${stepNo}][Line=${line}][Elapsed=${elapsedMs}ms] ${status} ACK=${JSON.stringify(String(ack ?? ""))}`,
    );
  }

  flush() {
    return this.pendingWrite;
  }
}

export function parseScriptParameters(argumentsList = []) {
  const parameters = Object.create(null);
  for (const argument of argumentsList) {
    const match = String(argument).match(/^([A-Za-z_$][A-Za-z0-9_$]*)=(.*)$/);
    if (!match || !isIdentifier(match[1])) {
      throw new Error(`Invalid script parameter: ${argument}`);
    }
    if (Object.prototype.hasOwnProperty.call(parameters, match[1])) {
      throw new Error(`Duplicate script parameter: ${match[1]}`);
    }
    parameters[match[1]] = match[2];
  }
  return parameters;
}

function nestedStatements(statements) {
  const result = [];
  for (const statement of statements) {
    result.push(statement);
    if (statement.body) result.push(...nestedStatements(statement.body));
    if (statement.alternate) result.push(...nestedStatements(statement.alternate));
  }
  return result;
}

function compileScriptTree(rootScriptPath) {
  const compiled = new Map();
  const compile = (scriptPath, stack = []) => {
    const absolutePath = path.resolve(scriptPath);
    if (stack.includes(absolutePath)) {
      throw new Error(`Recursive load detected: ${[...stack, absolutePath].join(" -> ")}`);
    }
    if (compiled.has(absolutePath)) return;

    let program;
    try {
      const content = readFileSync(absolutePath, "utf8");
      program = parseScriptProgram(content);
      validateScriptProgram(program);
    } catch (error) {
      const wrapped = new Error(
        `${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
      wrapped.line = error?.line;
      throw wrapped;
    }
    if (program.length === 0) throw new Error(`Script has no executable steps: ${absolutePath}`);
    compiled.set(absolutePath, program);

    for (const statement of nestedStatements(program)) {
      if (statement.type !== "load") continue;
      compile(path.resolve(path.dirname(absolutePath), statement.scriptPath), [...stack, absolutePath]);
    }
  };
  compile(rootScriptPath);
  return compiled;
}

/**
 * @typedef {{ ok: true, scriptPath: string, stepsExecuted: number, logPath: string }} ScriptRunSuccess
 */

/**
 * @typedef {object} ScriptRunFailure
 * @property {false} ok
 * @property {string} scriptPath
 * @property {'ack_mismatch'|'ack_timeout'|'empty'|'connect_error'|'encoder_error'|'file_error'|'parse_error'|'unknown'} reason
 * @property {string} message
 * @property {number} [stepNo]
 * @property {string} [displayLabel]
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
        reject(new Error(`ACK timeout(${timeoutMs/1000} sec) for event "${event}"`));
    }, timeoutMs);

    socket.emit(event, ...payload, (response) => {
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
      `[script] FAIL (ACK mismatch at ${result.displayLabel ?? `step ${result.stepNo}`}, event ${result.event}): ` +
      `expected "${result.expected}", got "${result.got}"`;
  } else if (result.reason === "ack_timeout") {
    message =
      `[script] FAIL (ACK timeout at ${result.displayLabel ?? `step ${result.stepNo}`}, event ${result.event}): ` +
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

  // Reset stateful regular expressions before each match.
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

    // Remove an older handler registered for the same event.
    const oldHandler = handlerMap.get(eventName);

    if (oldHandler !== undefined) {
        socket.off(eventName, oldHandler);
        handlerMap.delete(eventName);
    }
    monitor.writePanelC(`registerOnStep(${JSON.stringify(step)})`, "#7dcfff");
    // Register the async function itself without awaiting it here.
    const handler = async (...receivedArgs) => {
        if (!matchesOnCondition(step, receivedArgs)) {
            return;
        }

        // Prevent duplicate execution after the condition is satisfied.
        if (step.running) {
            return;
        }

        step.running = true;

        try {
            
            const payload = await encodePayload(step.event
                                                , step.args
                                                , monitor);
            let receivedAck;

            if (step.ackMode === "ack") {
                // In ACK mode, wait for the destination response.

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
                // In pass mode, emit without waiting for an ACK.
                socket.emit(
                    step.event,
                    payload,
                );
            }

            deferred.resolve(receivedAck);
        } catch (error) {
            // Forward async handler failures to the waiting caller.
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
    const displayLabel = step.displayLabel ?? `[No.${stepNo}]`;
    monitor.writePanelC(`Script: ${displayLabel}:${step.args[0]}`, "#bb9af7");
      let payload;
      try {
        payload = await encodePayload(step.event, step.args, monitor);
          // monitor.writePanelC(`retrun: ${stepNo}:${JSON.stringify(step.args)}`, "#bb9af7");

      } catch (err) {
        // payload = encodePayload(step.event, step.args, monitor);
          monitor.writePanelC(`catch: ${displayLabel}:${JSON.stringify(step.args)}`, "#bb9af7");
        return fail(scriptPath, {
            reason : "encoder_error",
            stepNo : stepNo,
            displayLabel,
            event  : step.event,
            message: err instanceof Error ? err.message : String(err),
        });
      }

      monitor.writePanelC?.(
          `${displayLabel} emit ${step.event} isArray=${Array.isArray(payload)}:${JSON.stringify(payload)}`,
        "#7aa2f7",
      );

      if (step.ackMode === "pass") {
        socket.emit(step.event, ...payload);
        monitor.writePanelC?.(`${displayLabel} PASS (skip ack)`, "#9ece6a");
        return {ok:true, ack: "PASS"};
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
              displayLabel,
              event: step.event,
              message: err instanceof Error ? err.message : String(err),
          });
        }
        const receivedText = ackToString(received);
        const expectedText = step.expectedAck ?? "";

        if (receivedText !== expectedText) {
          monitor.writePanelC?.(
            `${displayLabel} FAIL expected Ack: ${expectedText}, got: ${receivedText}`,
            "#f7768e",
          );
          monitor.setStatus?.("Script failed", "#f7768e");
          return fail(scriptPath, {
              reason: "ack_mismatch",
              stepNo: stepNo,
              displayLabel,
              event: step.event,
              expected: expectedText,
              got: receivedText,
              message: `ACK mismatch at ${displayLabel}`,
          });
        }

        monitor.writePanelC?.(`${displayLabel} PASS Ack: ${receivedText}`, "#9ece6a");
        return {ok:true, ack: receivedText};
      }

      socket.emit(step.event, payload);

  return {ok:true, ack: ""};
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
 * @param {{ process?: Record<string, unknown>, recorder?: Record<string, unknown>, Image?: object }} [options.state]
 * @param {string[] | Record<string, string>} [options.parameters]
 * @param {string} [options.logDirectory]
 * @returns {Promise<ScriptRunResult>}
 */
export async function runScript({
    scriptPath,
    url,
    monitor,
    ackTimeoutMs = DEFAULT_ACK_TIMEOUT_MS,
    parent_socket = undefined,
    on_events = undefined,
    state = {},
    parameters = [],
    logDirectory = process.cwd(),
}) {
    const writePanelC = monitor?.writePanelC
          ? (text, color) => monitor.writePanelC(text, color)
          : undefined;
    const setStatus = monitor?.setStatus
          ? (text, color) => monitor.setStatus(text, color)
          : undefined;
    const absoluteScriptPath = path.resolve(scriptPath);
    const logPath = reportPathFor(absoluteScriptPath, logDirectory);
    const report = new ScriptReport(logPath);
    try {
        await report.initialize();
    } catch (err) {
        return fail(scriptPath, {
            reason: "unknown",
            message: `Cannot create script log ${logPath}: ${err instanceof Error ? err.message : String(err)}`,
        });
    }

    let rootParameters;
    let compiled;
    try {
        rootParameters = Array.isArray(parameters) ? parseScriptParameters(parameters) : parameters;
        compiled = compileScriptTree(absoluteScriptPath);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await report.result(0, err?.line ?? 0, 0, "SYNTAX_ERROR", message);
        await report.flush();
        return fail(scriptPath, {
            reason: "parse_error",
            message,
            logPath,
        });
    }

    writePanelC?.(`Script: ${absoluteScriptPath}`, "#bb9af7");
    writePanelC?.(`Script log: ${logPath}`, "#7aa2f7");
    setStatus?.("Running script...", "#7dcfff");

    const clear_on_events = on_events ? false : true;
    const socket = parent_socket||io(url, {
        reconnection: false,
        forceNew: true,
    });
    const context = {
        stepNo: 0,
        fileTasks: [],
        fileErrors: [],
    };

    try {
        try {
            await waitForConnect(socket);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await report.result(0, 0, 0, "CONNECT_ERROR", message);
            return fail(scriptPath, {
                reason: "connect_error",
                message,
                logPath,
            });
        }

        writePanelC?.(`Script client connected: ${socket.id}`, "#73daca");

        if (on_events===undefined) {
            on_events = new Map();
        }

        const executeProgram = async (currentPath, currentParameters) => {
            const program = compiled.get(currentPath);
            await executeScriptProgram(program, {
                state,
                initialVariables: currentParameters,
                scheduleFileCheck: (filePattern, line) => {
                    const stepNo = ++context.stepNo;
                    const startedAt = Date.now();
                    const task = Promise.resolve()
                        .then(() => verifyFileSequence(filePattern))
                        .then(() => report.result(stepNo, line, Date.now() - startedAt, "FILE_OK", "OK"))
                        .catch(async (error) => {
                            const message = error instanceof Error ? error.message : String(error);
                            context.fileErrors.push({ line, message });
                            await report.result(stepNo, line, Date.now() - startedAt, "FILE_ERROR", message);
                        });
                    context.fileTasks.push(task);
                },
                executeLoad: async (childPath, childParameters) => {
                    const absoluteChildPath = path.resolve(path.dirname(currentPath), childPath);
                    const argumentText = Object.entries(childParameters)
                        .map(([name, value]) => `${name}=${value}`)
                        .join(" ");
                    await report.write(`<<${path.basename(absoluteChildPath)}${argumentText ? ` ${argumentText}` : ""}>>`);
                    await executeProgram(absoluteChildPath, childParameters);
                },
                executeCommand: async (step, _localStepNo, line) => {
                    const stepNo = ++context.stepNo;
                    const startedAt = Date.now();
                    try {
                        if (step.onEvent !== undefined) {
                            const completion = registerOnStep(
                                socket, step, monitor, ackTimeoutMs, on_events,
                            );
                            let ack = "PASS";
                            if (step.ackMode === "ack") {
                                try {
                                    ack = ackToString(await completion);
                                } finally {
                                    unregisterOnHandler(socket, step.onEvent, on_events);
                                }
                            }
                            await report.result(stepNo, line, Date.now() - startedAt, "OK", ack);
                            return;
                        }

                        const received = await run1Line(
                            stepNo, step, socket, currentPath, url, monitor,
                            ackTimeoutMs, on_events,
                        );
                        if (!received.ok) {
                            await report.result(
                                stepNo,
                                line,
                                Date.now() - startedAt,
                                "ERROR",
                                received.got ?? received.message,
                            );
                            const error = new Error(received.message);
                            error.scriptResult = received;
                            throw error;
                        }
                        await report.result(stepNo, line, Date.now() - startedAt, "OK", received.ack);
                    } catch (error) {
                        if (!error?.scriptResult) {
                            await report.result(
                                stepNo,
                                line,
                                Date.now() - startedAt,
                                "ERROR",
                                error instanceof Error ? error.message : String(error),
                            );
                        }
                        throw error;
                    }
                },
            });
        };

        let executionError;
        try {
            await executeProgram(absoluteScriptPath, rootParameters);
        } catch (error) {
            executionError = error;
        }
        await Promise.all(context.fileTasks);

        if (executionError?.scriptResult) return { ...executionError.scriptResult, logPath };
        if (executionError) {
            const message = executionError instanceof Error
                ? executionError.message
                : String(executionError);
            await report.result(
                ++context.stepNo,
                executionError?.line ?? 0,
                0,
                "SCRIPT_ERROR",
                message,
            );
            return fail(scriptPath, {
                reason: "unknown",
                message,
                logPath,
            });
        }
        if (context.fileErrors.length > 0) {
            setStatus?.("Script completed with file errors", "#f7768e");
            return fail(scriptPath, {
                reason: "file_error",
                message: context.fileErrors.map(({ line, message }) => `Line ${line}: ${message}`).join("; "),
                stepsExecuted: context.stepNo,
                logPath,
            });
        }

        setStatus?.("Script passed", "#9ece6a");
        return {
            ok: true,
            scriptPath,
            stepsExecuted: context.stepNo,
            logPath,
        };
    } catch (err) {
        if (err?.scriptResult) {
            writePanelC?.("Script: Error End", "#7aa2f7");
            return { ...err.scriptResult, logPath };
        }
        return fail(scriptPath, {
            reason: "unknown",
            message: err instanceof Error ? err.message : String(err),
            logPath,
        });
    } finally {
        await Promise.all(context.fileTasks);
        await report.flush();
        if (clear_on_events) {
            // Always unregister handlers left after failure or interruption.
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

