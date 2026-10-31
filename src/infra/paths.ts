import { createHash } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

export interface Paths {
  home: string;
  stateDir: string;
  accountsFile: string;
  configFile: string;
  usageDir: string;
  lockDir: string;
  loginPendingFile: string;
  logFile: string;
  claudeConfigDir: string;
  claudeJson: string;
  claudeSettings: string;
  liveService: string;
  keychainAccount: string;
  vaultService: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = homedir();
  const stateDir = env.CLAUDE_SWITCH_HOME ?? join(home, ".config", "claude-switch");
  const customConfigDir = env.CLAUDE_CONFIG_DIR;
  const claudeConfigDir = (customConfigDir ?? join(home, ".claude")).normalize("NFC");
  return {
    home,
    stateDir,
    accountsFile: join(stateDir, "accounts.json"),
    configFile: join(stateDir, "config.json"),
    usageDir: join(stateDir, "usage"),
    lockDir: join(stateDir, "lock"),
    loginPendingFile: join(stateDir, "login-pending.json"),
    logFile: join(stateDir, "claude-switch.log"),
    claudeConfigDir,
    claudeJson: customConfigDir ? join(customConfigDir, ".claude.json") : join(home, ".claude.json"),
    claudeSettings: join(claudeConfigDir, "settings.json"),
    liveService: env.CLAUDE_SWITCH_LIVE_SERVICE ?? claudeCodeService(customConfigDir),
    keychainAccount: keychainUser(env),
    vaultService: env.CLAUDE_SWITCH_VAULT_SERVICE ?? "claude-switch",
  };
}

function claudeCodeService(customConfigDir: string | undefined): string {
  if (!customConfigDir) return "Claude Code-credentials";
  const digest = createHash("sha256").update(customConfigDir.normalize("NFC")).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${digest}`;
}

function keychainUser(env: NodeJS.ProcessEnv): string {
  let user: string;
  try {
    user = env.USER || userInfo().username;
  } catch {
    user = "claude-code-user";
  }
  return /^[a-zA-Z0-9._-]+$/.test(user) ? user : "claude-code-user";
}
