import { parseArgs } from "node:util";
import { Engine, UserError } from "./core/engine.ts";
import { type Config, ConfigSchema } from "./core/stores.ts";
import { DesktopHub } from "./desktop/hub.ts";
import { displayName } from "./desktop/profiles.ts";
import { HandoffError } from "./desktop/sessions.ts";
import { HttpAnthropicApi } from "./infra/anthropic.ts";
import { MacKeychain } from "./infra/keychain.ts";
import { fileLogger } from "./infra/log.ts";
import { resolvePaths } from "./infra/paths.ts";
import { runDaemon } from "./surfaces/daemon.ts";
import { runHook } from "./surfaces/hook.ts";
import { install, uninstall } from "./surfaces/install.ts";
import { serveMcp, VERSION } from "./surfaces/mcp.ts";
import { describeHandoff, describeSwitch } from "./surfaces/messages.ts";
import { renderProfiles, renderTable, summaryLine, toOverviewView, until } from "./surfaces/view.ts";

const paths = resolvePaths();
const log = fileLogger(paths.logFile);
const engine = new Engine({ paths, secrets: new MacKeychain(), api: new HttpAnthropicApi(), log });
const hub = new DesktopHub(engine);
const color = process.stdout.isTTY && !process.env.NO_COLOR;

type Handler = (args: string[]) => Promise<void>;

interface Command {
  usage: string;
  summary: string;
  run: Handler;
}

const out = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

const COMMANDS: Record<string, Command> = {
  status: {
    usage: "cs status [--refresh] [--json]",
    summary: "Desktop profiles, CLI accounts and how much of each limit is used",
    run: async (args) => {
      const { values } = parseArgs({ args, options: { refresh: { type: "boolean" }, json: { type: "boolean" } } });
      if (values.refresh) await engine.pollAll();
      const view = toOverviewView(await hub.overview());
      if (values.json) return out(JSON.stringify(view, null, 2));
      out(heading("Claude Desktop (● window open)"));
      out(renderProfiles(view, color));
      out("");
      out(heading("Claude Code CLI / VS Code login (● active)"));
      out(renderTable(view, color));
    },
  },
  register: {
    usage: "cs register [alias]",
    summary: "Register the account Claude Code CLI is logged in with now",
    run: async ([alias]) => {
      const record = await engine.register(alias);
      out(`Registered ${record.alias} (${record.email}, ${record.plan}).`);
    },
  },
  add: {
    usage: "cs add [alias]",
    summary: "Log in to another account (browser) and keep the current one",
    run: async ([alias]) => {
      if (alias) await engine.assertAliasAvailable(alias);
      const claude = Bun.which("claude");
      if (!claude) throw new UserError("The `claude` CLI is not on PATH. Install Claude Code first.");
      const parked = await engine.parkLiveForLogin();
      if (parked) {
        out(`Keeping ${parked.alias} (${parked.email}).`);
        out(`The browser signs in with whichever claude.ai account it is already using. If that is ${parked.email},`);
        out("copy the login link below into a private window or another browser profile and sign in with the account to add.\n");
      }
      const code = await Bun.spawn([claude, "auth", "login"], { stdio: ["inherit", "inherit", "inherit"] }).exited;
      const result = await engine.finishLogin({ previous: parked?.id ?? null, alias });
      switch (result.kind) {
        case "not_logged_in":
          throw new UserError("Login did not finish. Nothing changed.");
        case "same_account":
          throw new UserError(
            `The browser signed in as ${result.account.email} again, which is already registered as "${result.account.alias}". Nothing was added. Run \`cs add${alias ? ` ${alias}` : ""}\` again and open the login link in a private window signed in to the other account.`,
          );
        case "added":
          if (code !== 0) throw new UserError("Login did not finish. Nothing changed.");
          out(`Added ${result.account.alias} (${result.account.email}, ${result.account.plan}). It is now the active CLI account.`);
          return;
        default: {
          const _exhaustive: never = result;
          return _exhaustive;
        }
      }
    },
  },
  switch: {
    usage: "cs switch <alias|email> | --auto",
    summary: "Change the CLI / VS Code login (Desktop windows keep their own)",
    run: async (args) => {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { auto: { type: "boolean" } } });
      const [target] = positionals;
      if (target) return out(describeSwitch(await engine.switchTo(target)));
      if (!values.auto) throw new UserError("Name an account, or pass --auto to pick the one with the most headroom.");
      const { decision, result } = await engine.autoSwitch({ force: true });
      if (result) return out(describeSwitch(result));
      out(decision.kind === "exhausted" ? `Every account is at its limit.${resetHint(decision.soonestReset)}` : `Staying: ${decision.kind === "stay" ? decision.reason : ""}`);
    },
  },
  sessions: {
    usage: "cs sessions [profile] [--limit n] [--json]",
    summary: "Recent Claude Desktop Code sessions",
    run: async (args) => {
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { limit: { type: "string", default: "10" }, json: { type: "boolean" } },
      });
      const sessions = (await hub.sessions(positionals[0])).slice(0, Number(values.limit));
      const rows = sessions.map((s) => ({
        id: s.card.sessionId,
        profile: s.profile.name,
        profileLabel: displayName(s.profile),
        title: s.card.title ?? "(untitled)",
        lastActivityAt: s.card.lastActivityAt ? new Date(s.card.lastActivityAt).toISOString() : null,
      }));
      if (values.json) return out(JSON.stringify(rows, null, 2));
      for (const r of rows) {
        const age = r.lastActivityAt ? `${until(Date.now(), Date.parse(r.lastActivityAt))} ago` : "";
        out(`${r.profileLabel.padEnd(12)} ${r.title.slice(0, 50).padEnd(50)} ${age.padStart(10)}  ${r.id}`);
      }
    },
  },
  handoff: {
    usage: "cs handoff <session-id> [--to profile] [--restart] [--no-open]",
    summary: "Continue a Desktop session under another account's profile",
    run: async (args) => {
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { to: { type: "string" }, restart: { type: "boolean" }, "no-open": { type: "boolean" } },
      });
      const sessionId = positionals[0] ?? process.env.CLAUDE_CODE_HOST_SESSION_ID;
      if (!sessionId) throw new UserError("Pass a session id (see `cs sessions`).");
      out(describeHandoff(await hub.handoff({ sessionId, to: values.to, force: true, open: !values["no-open"], restart: values.restart ?? false })));
    },
  },
  open: {
    usage: "cs open <profile>",
    summary: "Open or focus the Claude Desktop window for a profile",
    run: async ([name]) => {
      if (!name) throw new UserError("Name a profile (see `cs status`).");
      const { profile, how } = await hub.open(name);
      out(`${how === "focused" ? "Focused" : "Launched"} ${displayName(profile)}.`);
    },
  },
  label: {
    usage: "cs label <profile> <label> | --clear",
    summary: "Give a Desktop profile a display name (its folder is not renamed)",
    run: async (args) => {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { clear: { type: "boolean" } } });
      const [profile, ...words] = positionals;
      const text = words.join(" ");
      if (!profile || (!values.clear && !text)) throw new UserError('Usage: cs label <profile> "<label>"  or  cs label <profile> --clear');
      const result = await hub.setLabel(profile, values.clear ? null : text);
      out(result.label ? `${result.profile.name} is now shown as "${result.label}".` : `${result.profile.name} shows its folder name again.`);
    },
  },
  rename: {
    usage: "cs rename <alias> <new-alias>",
    summary: "Rename a registered CLI account",
    run: async ([from, to]) => {
      if (!from || !to) throw new UserError("Usage: cs rename <alias> <new-alias>");
      out(`Renamed to ${(await engine.rename(from, to)).alias}.`);
    },
  },
  remove: {
    usage: "cs remove <alias>",
    summary: "Forget a registered account and delete its stored login",
    run: async ([target]) => {
      if (!target) throw new UserError("Usage: cs remove <alias>");
      out(`Removed ${(await engine.remove(target)).alias}.`);
    },
  },
  config: {
    usage: "cs config [key] [value]",
    summary: "Show or change threshold, warnAt, pollSeconds, autoSwitch",
    run: async ([key, value]) => {
      const config = await engine.config.load();
      if (!key) return out(JSON.stringify(config, null, 2));
      if (!(key in config)) throw new UserError(`Unknown key "${key}". Keys: ${Object.keys(config).join(", ")}.`);
      if (value === undefined) return out(String(config[key as keyof Config]));
      const parsedValue: unknown = value === "true" ? true : value === "false" ? false : Number.isNaN(Number(value)) ? value : Number(value);
      const next = ConfigSchema.safeParse({ ...config, [key]: parsedValue });
      if (!next.success) throw new UserError(`Invalid value for ${key}: ${next.error.issues[0]?.message ?? "rejected"}`);
      await engine.config.save(next.data);
      out(`${key} = ${String(next.data[key as keyof Config])}`);
    },
  },
  poll: {
    usage: "cs poll",
    summary: "Fetch usage for every account once",
    run: async () => {
      const records = await engine.pollAll();
      out(`Polled ${records.length} account(s); ${records.filter((r) => r.error).length} with errors.`);
    },
  },
  statusline: {
    usage: "cs statusline",
    summary: "One-line summary for a Claude Code status line",
    run: async () => out(summaryLine(toOverviewView(await hub.overview()))),
  },
  daemon: {
    usage: "cs daemon",
    summary: "Poll usage in the background (run by launchd)",
    run: async () => {
      const controller = new AbortController();
      for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => controller.abort());
      await runDaemon(engine, log, controller.signal);
    },
  },
  mcp: {
    usage: "cs mcp",
    summary: "MCP server over stdio (registered by `cs install`)",
    run: () => serveMcp({ engine, hub, env: process.env }),
  },
  hook: {
    usage: "cs hook",
    summary: "Claude Code hook entry point (reads the event from stdin)",
    run: async () => {
      try {
        const output = await runHook({ engine, hub, stdin: await Bun.stdin.text(), env: process.env, log });
        if (output) out(JSON.stringify(output));
      } catch (err) {
        log.error("hook_failed", { error: err instanceof Error ? err.message : String(err) });
      }
    },
  },
  install: {
    usage: "cs install [--app path/to/Claude Accounts.app]",
    summary: "Install the binary, background poller, MCP server, hooks and menu bar app",
    run: async (args) => {
      const { values } = parseArgs({ args, options: { app: { type: "string" } } });
      if (/\/bun$/.test(process.execPath)) throw new UserError("Run install from the compiled binary: `bun run build && ./dist/cs install`.");
      const steps = await install({ paths, sourceBinary: process.execPath, app: values.app });
      for (const s of steps) out(`${s.ok ? "✓" : "✗"} ${s.name}: ${s.detail}`);
      if (steps.some((s) => !s.ok)) process.exitCode = 1;
    },
  },
  uninstall: {
    usage: "cs uninstall",
    summary: "Remove everything `cs install` added (stored logins stay in the Keychain)",
    run: async () => {
      for (const s of await uninstall({ paths })) out(`${s.ok ? "✓" : "✗"} ${s.name}: ${s.detail}`);
    },
  },
};

function heading(text: string) {
  return color ? `\x1b[1m${text}\x1b[0m` : text;
}

function resetHint(reset: string | null) {
  return reset ? ` Soonest reset in ${until(Date.parse(reset))}.` : "";
}

function help(): string {
  const width = Math.max(...Object.values(COMMANDS).map((c) => c.usage.length));
  return [
    `claude-switch ${VERSION}: one place for all your Claude accounts`,
    "",
    ...Object.values(COMMANDS).map((c) => `  ${c.usage.padEnd(width)}  ${c.summary}`),
  ].join("\n");
}

async function main(argv: string[]): Promise<number> {
  const [name = "status", ...rest] = argv;
  if (name === "help" || name === "--help" || name === "-h") {
    out(help());
    return 0;
  }
  if (name === "--version" || name === "-v") {
    out(VERSION);
    return 0;
  }
  const command = COMMANDS[name];
  if (!command) {
    process.stderr.write(`Unknown command "${name}".\n\n${help()}\n`);
    return 2;
  }
  try {
    await command.run(rest);
    return Number(process.exitCode ?? 0);
  } catch (err) {
    const known = err instanceof UserError || err instanceof HandoffError;
    process.stderr.write(`${known ? err.message : `Unexpected error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`}\n`);
    log.error("command_failed", { command: name, error: err instanceof Error ? err.message : String(err) });
    return 1;
  } finally {
    await log.flush();
  }
}

const code = await main(process.argv.slice(2));
if (process.argv[2] !== "mcp" && process.argv[2] !== "daemon") process.exit(code);
