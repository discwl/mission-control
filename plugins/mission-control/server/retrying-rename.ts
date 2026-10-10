import { rename as fsRename } from "node:fs/promises";

// Windows refuses a rename while another process briefly holds the file, or for a folder any file
// inside it: an indexer such as Gortex watching the vault, endpoint security scanning a new file,
// or a status read. Those holds last milliseconds to a second or two, so retry them; any other
// error, or a hold that outlasts the retries, fails as before.
const transient = new Set(["EPERM", "EACCES", "EBUSY"]);

export async function rename(from: string, to: string, options: { attempts?: number; delayMs?: number; move?: typeof fsRename } = {}): Promise<void> {
  const { attempts = 15, delayMs = 30, move = fsRename } = options;
  for (let attempt = 1; ; attempt++) {
    try { return await move(from, to); }
    catch (error) {
      if (attempt >= attempts || !transient.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
    }
  }
}
