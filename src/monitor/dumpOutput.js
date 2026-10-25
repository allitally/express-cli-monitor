import { spawn } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/** @param {string} text */
export function normalizeDumpText(text) {
  const cleaned = String(text ?? "").replaceAll("\u0000", "");
  if (cleaned.length === 0) return "";
  return cleaned.endsWith("\n") ? cleaned : `${cleaned}\n`;
}

/** @param {string} text */
export function countDumpLines(text) {
  if (!text) return 0;
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (!body) return 0;
  return body.split("\n").length;
}

/** @param {Date} [date] */
export function fileStamp(date = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  return [
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`,
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
    pad(date.getMilliseconds(), 3),
  ].join("-");
}

/**
 * @param {string} target
 * @param {{ dumpDir?: string | null, explicitPath?: string | null, now?: Date }} [options]
 * @returns {Promise<string | null>}
 */
export async function resolveDumpFilePath(target, options = {}) {
  const fileName = `panel-${target}-${fileStamp(options.now ?? new Date())}.txt`;
  const explicitPath = options.explicitPath?.trim();
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    let asDirectory = explicitPath.endsWith("/") || explicitPath.endsWith("\\");
    if (!asDirectory) {
      try {
        const info = await stat(resolved);
        asDirectory = info.isDirectory();
      } catch {
        asDirectory = false;
      }
    }
    if (asDirectory) {
      await mkdir(resolved, { recursive: true });
      return path.join(resolved, fileName);
    }
    await mkdir(path.dirname(resolved), { recursive: true });
    return resolved;
  }

  if (!options.dumpDir) return null;
  const dir = path.resolve(options.dumpDir);
  await mkdir(dir, { recursive: true });
  return path.join(dir, fileName);
}

/** @param {string} filePath @param {string} text */
export async function writeDumpFile(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text, "utf8");
  return filePath;
}

/**
 * Windows の clip.exe は UTF-16LE を受け取る。
 * @param {string} text
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
export function copyTextWithClip(text) {
  if (process.platform !== "win32") {
    return Promise.resolve({ ok: false, detail: "clip-unavailable" });
  }
  return new Promise((resolve) => {
    const child = spawn("clip", { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
    let settled = false;
    let detail = "";
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve({ ok, detail: detail.trim() });
    };
    child.on("error", (err) => {
      detail = err.message;
      finish(false);
    });
    child.stderr?.on("data", (chunk) => {
      detail += chunk.toString();
    });
    child.on("close", (code) => finish(code === 0));
    child.stdin.end(Buffer.from(text, "utf16le"));
  });
}
