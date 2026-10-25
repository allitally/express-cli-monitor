/**
 * @param {string[]} argv
 * @returns {{
 *   scriptPath: string | null,
 *   help: boolean,
 *   dumpKeys: Partial<Record<"a" | "b" | "c" | "all", string>>,
 *   dumpDir: string | null | undefined,
 *   dumpToClipboard: boolean,
 * }}
 */
export function parseCliArgs(argv) {
  let scriptPath = null;
  /** @type {Partial<Record<"a" | "b" | "c" | "all", string>>} */
  const dumpKeys = {};
  /** @type {string | null | undefined} */
  let dumpDir;
  let dumpToClipboard = true;

  const keyFlags = {
    "--dump-key-a": "a",
    "--dump-key-b": "b",
    "--dump-key-c": "c",
    "--dump-key-all": "all",
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      return { scriptPath: null, help: true, dumpKeys, dumpDir, dumpToClipboard };
    }
    if (arg === "--script" || arg === "-s") {
      const next = argv[++i];
      if (!next) {
        throw new Error("--script requires a file path");
      }
      scriptPath = next;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(keyFlags, arg)) {
      const next = argv[++i];
      if (!next) {
        throw new Error(`${arg} requires a key spec`);
      }
      dumpKeys[keyFlags[arg]] = next;
      continue;
    }
    if (arg === "--dump-dir") {
      const next = argv[++i];
      if (!next) {
        throw new Error("--dump-dir requires a directory");
      }
      dumpDir = next;
      continue;
    }
    if (arg === "--no-dump-file") {
      dumpDir = null;
      continue;
    }
    if (arg === "--no-dump-clipboard") {
      dumpToClipboard = false;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { scriptPath, help: false, dumpKeys, dumpDir, dumpToClipboard };
}

/**
 * CLI で指定されなかった項目は環境変数、それも無ければ既定値。
 * @param {{ dumpKeys?: Partial<Record<"a" | "b" | "c" | "all", string>>, dumpDir?: string | null, dumpToClipboard?: boolean }} cli
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveDumpOptions(cli, env = process.env) {
  /** @type {Partial<Record<"a" | "b" | "c" | "all", string>>} */
  const dumpKeys = {};
  const envNames = {
    a: "DUMP_KEY_A",
    b: "DUMP_KEY_B",
    c: "DUMP_KEY_C",
    all: "DUMP_KEY_ALL",
  };
  for (const [id, name] of Object.entries(envNames)) {
    const value = env[name];
    if (value !== undefined && value.trim() !== "") {
      dumpKeys[id] = value.trim();
    }
  }
  Object.assign(dumpKeys, cli.dumpKeys ?? {});

  /** @type {string | null} */
  let dumpDir;
  if (cli.dumpDir !== undefined) {
    dumpDir = cli.dumpDir;
  } else if (env.DUMP_DIR !== undefined) {
    const value = env.DUMP_DIR.trim();
    dumpDir = value.length === 0 ? null : value;
  } else {
    dumpDir = "dumps";
  }

  return {
    dumpKeys,
    dumpDir,
    dumpToClipboard: cli.dumpToClipboard !== false,
  };
}

export function printUsage() {
  console.log(`Usage: npm start [-- --script <file>]

Options:
  -s, --script <file>     Run Socket.IO client test script on startup
  --dump-key-a <key>      Shortcut that dumps pane A (default: f6)
  --dump-key-b <key>      Shortcut that dumps pane B (default: f7)
  --dump-key-c <key>      Shortcut that dumps pane C (default: f8)
  --dump-key-all <key>    Shortcut that dumps every pane (default: f9)
  --dump-dir <dir>        Directory for dump files (default: dumps)
  --no-dump-file          Do not write a file unless dump <pane> <file> is used
  --no-dump-clipboard     Do not copy the dump to the clipboard
  -h, --help              Show this help

Keys: f6 | ctrl+f2 | alt+a | shift+f6 | ctrl+shift+a | none
Env:  DUMP_KEY_A DUMP_KEY_B DUMP_KEY_C DUMP_KEY_ALL DUMP_DIR
`);
}
