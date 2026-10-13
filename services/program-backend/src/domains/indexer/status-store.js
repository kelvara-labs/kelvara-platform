import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const NEVER_RUN = Object.freeze({ state: "never-run", lastResult: null });

export function createJsonStatusStore(path) {
  return {
    read() {
      if (!existsSync(path)) return { ...NEVER_RUN };
      return JSON.parse(readFileSync(path, "utf8"));
    },
    write(status) {
      mkdirSync(dirname(path), { recursive: true });
      const temporary = `${path}.tmp-${process.pid}`;
      writeFileSync(temporary, `${JSON.stringify(status, null, 2)}\n`);
      renameSync(temporary, path);
    },
  };
}
