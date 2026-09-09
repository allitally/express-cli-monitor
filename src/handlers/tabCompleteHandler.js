import { readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 3-2 TAB補完ハンドラ（スケルトン）
 *
 * @param {string[]} args - これまで入力したコマンド引数列（空白区切り）
 * @returns {Promise<string|string[]|null>|string|string[]|null}
 *   - string: 単一候補をそのまま挿入
 *   - string[]: 複数候補（共通プレフィックスがあれば挿入、なければ候補一覧をパネルCへ表示）
 *   - null: 補完なし
 */
export function onTabComplete(args) {
  if (args.length === 0) {
    return ["help", "status", "clear", "quit"];
  }

  const [cmd, ...rest] = args;
  const partial = rest.at(-1) ?? "";

  // ファイルパス補完の例（最後の引数がパスっぽい場合）
  if (rest.length > 0 && (partial.includes("/") || partial.includes("\\") || partial.startsWith("."))) {
    try {
      const dir = partial.includes("/") || partial.includes("\\")
        ? resolve(partial.replace(/[^/\\]+$/, "") || ".")
        : resolve(".");
      const base = partial.match(/[^/\\]+$/)?.[0] ?? "";
      const entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.name.startsWith(base))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      if (entries.length === 0) return null;
      return entries;
    } catch {
      return null;
    }
  }

  // コマンド名補完の例
  const commands = ["help", "status", "clear", "quit"];
  const matches = commands.filter((c) => c.startsWith(cmd));
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  return matches;
}
