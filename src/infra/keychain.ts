export interface SecretStore {
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, value: string): Promise<void>;
  delete(service: string, account: string): Promise<void>;
}

const ITEM_NOT_FOUND = 44;
const INTERACTIVE_LINE_LIMIT = 4000;

export class KeychainError extends Error {
  override name = "KeychainError";
}

export class MacKeychain implements SecretStore {
  async get(service: string, account: string): Promise<string | null> {
    const { code, stdout, stderr } = await run(["find-generic-password", "-a", account, "-s", service, "-w"]);
    if (code === ITEM_NOT_FOUND) return null;
    if (code !== 0) throw new KeychainError(`read ${service} failed (${code}): ${stderr.trim()}`);
    return stdout.replace(/\n$/, "");
  }

  async set(service: string, account: string, value: string): Promise<void> {
    const hex = Buffer.from(value, "utf8").toString("hex");
    const line = `add-generic-password -U -a "${account}" -s "${service}" -X "${hex}"\n`;
    // `security -i` keeps the secret out of argv, but its stdin parser truncates lines past ~4 KB.
    // Claude Code falls back to argv for its own large credential blob; we do the same.
    const result =
      line.length <= INTERACTIVE_LINE_LIMIT
        ? await run(["-i"], line)
        : await run(["add-generic-password", "-U", "-a", account, "-s", service, "-X", hex]);
    if (result.code !== 0) throw new KeychainError(`write ${service} failed (${result.code}): ${result.stderr.trim()}`);
    const readBack = await this.get(service, account);
    if (readBack !== value) throw new KeychainError(`write ${service} did not persist`);
  }

  async delete(service: string, account: string): Promise<void> {
    const { code, stderr } = await run(["delete-generic-password", "-a", account, "-s", service]);
    if (code !== 0 && code !== ITEM_NOT_FOUND) throw new KeychainError(`delete ${service} failed (${code}): ${stderr.trim()}`);
  }
}

async function run(args: string[], input?: string) {
  const proc = Bun.spawn(["/usr/bin/security", ...args], {
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

export class MemorySecretStore implements SecretStore {
  readonly items = new Map<string, string>();
  async get(service: string, account: string) {
    return this.items.get(`${service}\u0000${account}`) ?? null;
  }
  async set(service: string, account: string, value: string) {
    this.items.set(`${service}\u0000${account}`, value);
  }
  async delete(service: string, account: string) {
    this.items.delete(`${service}\u0000${account}`);
  }
}
