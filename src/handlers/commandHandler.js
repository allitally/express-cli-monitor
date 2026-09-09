/**
 * 3-2 コマンド実行ハンドラ（スケルトン）
 *
 * @param {string} commandText - 入力欄の生テキスト（改行含む）
 * @param {string[]} args - 空白区切りで分割した引数配列
 * @returns {Promise<void>|void}
 */
export function onCommandExecute(commandText, args) {
  // TODO: ここにコマンド処理を実装する
  console.log(`[command] text=${JSON.stringify(commandText)} args=${JSON.stringify(args)}`);
}
