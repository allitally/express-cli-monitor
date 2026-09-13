/**
 * @param {string[]} argv
 * @returns {{ scriptPath: string | null, help: boolean }}
 */
export function parseCliArgs(argv) {
  let scriptPath = null;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      return { scriptPath: null, help: true };
    }
    if (arg === "--script" || arg === "-s") {
      const next = argv[++i];
      if (!next) {
        throw new Error("--script requires a file path");
      }
      scriptPath = next;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { scriptPath, help: false };
}

export function printUsage() {
  console.log(`Usage: npm start [-- --script <file>]

Options:
  -s, --script <file>  Run Socket.IO client test script on startup
  -h, --help           Show this help
`);
}
