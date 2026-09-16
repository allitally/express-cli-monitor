import { logScriptResult, runScript, run1Line } from "../script/runScript.js";

const DEFAULT_ACK_TIMEOUT_MS = 5000;

/**
 * 3-2 コマンド実行ハンドラ（スケルトン）
 *
 * @param {string} commandText - 入力欄の生テキスト（改行含む）
 * @param {string[]} args - 空白区切りで分割した引数配列
 * @returns {Promise<void>|void}
 */
export async function onCommandExecute(commandText, args,socket,scriptPath, url, monitor) {
  const step = {
    event : "NoEvent",
    args: args,
    ackMode : "ack",
    expectedAck : "OK"
  };
  if (args.length > 0) {
    step.event = args[0];
  }
  //steps.push({ event, args, ackMode, expectedAck });
  try {
    await run1Line(0,step, socket, scriptPath, url, monitor, DEFAULT_ACK_TIMEOUT_MS);
  } catch (err) {
    const message = `Error executing command: ${err instanceof Error ? err.message : String(err)}, ${commandText}`;
    monitor.writePanelC(message, "#f7768e");
    console.error(message);
  }
}
