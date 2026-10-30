import { logScriptResult, runScript, run1Line } from "../script/runScript.js";
import { CliMonitor } from "../monitor/CliMonitor.js";

const DEFAULT_ACK_TIMEOUT_MS = 5000;

/**
 * 3-2 コマンド実行ハンドラ（スケルトン）
 *
 * @param {string} commandText - 入力欄の生テキスト（改行含む）
 * @param {string[]} args - 空白区切りで分割した引数配列
 * @returns {Promise<void>|void}
 */
export async function onCommandExecute(commandText, args,socket,scriptPath, url, monitor
                                       , on_events) {
  const step = {
      event : "NoEvent",
      args: args.slice(1),
      ackMode : "ack",
      expectedAck : "OK"
  };
  if (args.length > 0) {
    step.event = args[0];
  }
    monitor.writePanelC(step.event, "#00ff8e");
  //steps.push({ event, args, ackMode, expectedAck });
  try {
      await run1Line(0,step, socket, scriptPath, url, monitor, DEFAULT_ACK_TIMEOUT_MS
                     , on_events);
  } catch (err) {
      let einfo = [String(err)]
      if (err instanceof Error) {
          einfo = `Error(${err.cause},${err.message},${err.stack})`
      }
      const message = `Error executing command: ${JSON.stringify(einfo)}, ${commandText}`;
    monitor.writePanelC(message, "#f7768e");
    // console.error(message);
  }
}
