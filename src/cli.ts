import { join, resolve as resolvePath } from "node:path";
import { parseArgs } from "node:util";
import { Engine, type LoginResult, UserError } from "./core/engine.ts";
import type { AccountId } from "./domain/account.ts";
import { type Config, ConfigSchema, withWarnBelowThreshold } from "./core/stores.ts";
import { DesktopHub } from "./desktop/hub.ts";
import { displayName } from "./desktop/profiles.ts";
import { HandoffError } from "./desktop/sessions.ts";
import { HttpAnthropicApi } from "./infra/anthropic.ts";
import { MacKeychain } from "./infra/keychain.ts";
import { fileLogger } from "./infra/log.ts";
import { resolvePaths } from "./infra/paths.ts";
import { runDaemon } from "./surfaces/daemon.ts";
import { claudeRunner, ConnectorManager, interactiveClaude } from "./connectors/manager.ts";
import { RulesStore } from "./core/rules-store.ts";
import { findUnusedMcpServers, formatBytes } from "./housekeeping/housekeeping.ts";
import { VmShareStore } from "./housekeeping/vm-share.ts";
import { EventLog } from "./infra/events.ts";
import { accountDirectory, namesOf, resolveAccount } from "./surfaces/accounts.ts";
import { doctorCommand } from "./surfaces/doctor.ts";
import { runHook } from "./surfaces/hook.ts";
import { install, loginItemEnabled, setLoginItem, uninstall } from "./surfaces/install.ts";
import { serveMcp, VERSION } from "./surfaces/mcp.ts";
import { describeHandoff, describeSwitch } from "./surfaces/messages.ts";
import { renderProfiles, renderTable, summaryLine, toOverviewView, until } from "./surfaces/view.ts";

const paths = resolvePaths();
const log = fileLogger(paths.logFile);
const engine = new Engine({ paths, secrets: new MacKeychain(), api: new HttpAnthropicApi(), log });
const hub = new DesktopHub(engine);
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const connectors = new ConnectorManager({
  paths,
  hub,
  run: claudeRunner(Bun.which("claude"), join(paths.stateDir, "mcp-workdir")),
  cliAccount: async () => (await engine.status()).accounts.find((a) => a.live)?.record.alias ?? null,
});

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
      if (values.json) return out(JSON.stringify({ ...view, vmSharedBytes: (await new VmShareStore(paths.stateDir).load()).sharedBytes }, null, 2));
      out(heading("Claude Desktop (● window open)"));
      out(renderProfiles(view, color));
      out("");
      out(heading("Claude Code CLI / VS Code login (● active)"));
      out(renderTable(view, color));
    },
  },
  doctor: {
    usage: "cs doctor [--json]",
    summary: "Check that Claude Code, Claude Desktop and the install still match what claude-switch expects",
    run: (args) => doctorCommand(args, { paths, color: Boolean(color), out }),
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
    usage: "cs add <name> [--cli-only | --desktop-only]",
    summary: "Add an account to Claude Desktop and the CLI in one go",
    run: async (args) => {
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { "cli-only": { type: "boolean" }, "desktop-only": { type: "boolean" } },
      });
      const [name] = positionals;
      if (!name) throw new UserError("Usage: cs add <name>   (lowercase letters, digits or dashes)");
      if (!values["desktop-only"]) await engine.assertAliasAvailable(name);

      let expected: AccountId | undefined;
      if (!values["cli-only"]) {
        const profile = await desktopProfileFor(name);
        expected = profile.accountId ?? undefined;
        if (values["desktop-only"]) return out(`Desktop profile ${displayName(profile)} is signed in.`);
      }
      const result = await cliLogin({ alias: name, expected });
      reportLogin(result, name);
    },
  },
  link: {
    usage: "cs link <desktop-profile> [--as alias]",
    summary: "Sign the CLI in to the account a Desktop profile already uses",
    run: async (args) => {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { as: { type: "string" } } });
      const [query] = positionals;
      if (!query) throw new UserError("Usage: cs link <desktop-profile>");
      const profile = await hub.findProfile(query);
      if (!profile?.accountId) throw new UserError(`Desktop profile "${query}" is not signed in to an account yet. Open it with \`cs open ${query}\` and sign in first.`);
      const alias = values.as ?? slug(displayName(profile));
      await engine.assertAliasAvailable(alias);
      out(`Linking the CLI to the account used by Desktop profile ${displayName(profile)}.`);
      reportLogin(await cliLogin({ alias, expected: profile.accountId }), alias);
    },
  },
  relogin: {
    usage: "cs relogin <alias>",
    summary: "Sign in to a registered CLI account again before its login expires",
    run: async ([alias]) => {
      if (!alias) throw new UserError("Usage: cs relogin <alias>");
      const account = (await engine.status()).accounts.find((a) => a.record.alias === alias || a.record.email === alias)?.record;
      if (!account) throw new UserError(`Unknown account "${alias}".`);
      out(`Signing in to ${account.alias} (${account.email}) again.`);
      reportLogin(await cliLogin({ expected: account.id }), account.alias);
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
  "new-profile": {
    usage: "cs new-profile <name>",
    summary: "Create a Claude Desktop profile and open its window to sign in",
    run: async ([name]) => {
      if (!name) throw new UserError("Usage: cs new-profile <name>");
      const { profile } = await hub.createProfile(name);
      out(`Created ${profile.name}. Sign in with the account for this profile in the window that opened.`);
    },
  },
  "update-desktop": {
    usage: "cs update-desktop",
    summary: "Install a downloaded Claude Desktop update and reopen every open profile",
    run: async () => {
      const result = await hub.installUpdate();
      const reopened = result.reopened.length > 0 ? ` Reopened ${result.reopened.join(", ")}.` : "";
      if (!result.installed) {
        throw new UserError(`Claude ${result.to} did not install within 3 minutes. Check that every Claude window has quit.${reopened}`);
      }
      out(`Updated Claude Desktop from ${result.from ?? "?"} to ${result.to}.${reopened}`);
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
  "share-vm": {
    usage: "cs share-vm [--dry-run] [--json]",
    summary: "Store the Claude Desktop VM files that profiles have in common once (APFS clones)",
    run: async (args) => {
      const { values } = parseArgs({ args, options: { "dry-run": { type: "boolean" }, json: { type: "boolean" } } });
      const result = await hub.shareVmFiles({ dryRun: values["dry-run"] });
      if (values.json) return out(JSON.stringify(result, null, 2));
      const verb = values["dry-run"] ? "Would share" : "Shared";
      for (const file of result.shared) out(`${verb} ${file.profile}/${file.rel} (${formatBytes(file.size)})`);
      for (const file of result.skipped) out(`Skipped ${file.profile}/${file.rel}: ${file.reason}`);
      if (result.shared.length === 0 && result.skipped.length === 0) out("Nothing to share: every identical VM file is already stored once.");
      out(`${values["dry-run"] ? "Would free" : "Freed"} ${formatBytes(result.freedBytes)}. Stored once across profiles: ${formatBytes(result.sharedBytes)}.`);
    },
  },
  config: {
    usage: "cs config [key] [value]",
    summary: "Show or change threshold, warnAt, pollSeconds, autoSwitch, idleCloseHours, mcpCleanup, vmShare",
    run: async ([key, value]) => {
      const config = await engine.config.load();
      if (!key) return out(JSON.stringify(config, null, 2));
      if (!(key in config)) throw new UserError(`Unknown key "${key}". Keys: ${Object.keys(config).join(", ")}.`);
      if (value === undefined) return out(String(config[key as keyof Config]));
      const parsedValue: unknown = value === "true" ? true : value === "false" ? false : Number.isNaN(Number(value)) ? value : Number(value);
      const next = ConfigSchema.safeParse({ ...config, [key]: parsedValue });
      if (!next.success) throw new UserError(`Invalid value for ${key}: ${next.error.issues[0]?.message ?? "rejected"}`);
      const saved = withWarnBelowThreshold(next.data, key);
      await engine.config.save(saved);
      out(`${key} = ${String(saved[key as keyof Config])}`);
      if (saved.warnAt !== next.data.warnAt || saved.threshold !== next.data.threshold) {
        out(`warnAt = ${saved.warnAt}, threshold = ${saved.threshold} (the warning level stays below the switch level)`);
      }
    },
  },
  rules: {
    usage: "cs rules [list] [--json] | set <folder> <account…> | allow <folder> <account> | remove <folder>",
    summary: "Limit which accounts a project folder may switch or move between",
    run: async (args) => {
      const [action = "list", ...rest] = args[0]?.startsWith("--") ? ["list", ...args] : args;
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { json: { type: "boolean" } } });
      const store = new RulesStore(paths.stateDir);
      const folder = (p: string | undefined) => {
        if (!p) throw new UserError("Name a project folder.");
        return resolvePath(p.replace(/^~(?=$|\/)/, paths.home));
      };
      const directory = accountDirectory(await hub.overview({ light: true }));
      switch (action) {
        case "list": {
          const rules = await store.list();
          if (values.json) {
            return out(
              JSON.stringify(
                rules.map((r) => ({ path: r.path, accounts: r.accounts.map((id) => ({ id, names: directory.find((e) => e.id === id)?.names ?? [id.slice(0, 8)] })) })),
                null,
                2,
              ),
            );
          }
          if (rules.length === 0) return out("No project rules. Every project can use every account.");
          for (const r of rules) out(`${r.path.replace(paths.home, "~")}\n  → ${namesOf(directory, r.accounts)}`);
          return;
        }
        case "set": {
          const [path, ...accounts] = positionals;
          if (accounts.length === 0) throw new UserError("Usage: cs rules set <folder> <account…>");
          const rule = await store.set(folder(path), accounts.map((a) => resolveAccount(directory, a).id));
          return out(`${rule.path.replace(paths.home, "~")} may use ${namesOf(directory, rule.accounts)}.`);
        }
        case "allow": {
          const [path, account] = positionals;
          if (!account) throw new UserError("Usage: cs rules allow <folder> <account>");
          const rule = await store.allow(folder(path), resolveAccount(directory, account).id);
          if (!rule) throw new UserError("There is no rule for that folder. Create one with `cs rules set`.");
          return out(`${rule.path.replace(paths.home, "~")} may use ${namesOf(directory, rule.accounts)}.`);
        }
        case "remove": {
          const [path] = positionals;
          if (!(await store.remove(folder(path)))) throw new UserError("There is no rule for that folder.");
          return out("Rule removed. That project can use every account again.");
        }
        default:
          throw new UserError(`Unknown action "${action}". Use list, set, allow or remove.`);
      }
    },
  },
  connectors: {
    usage: "cs connectors [list [--check] [--json] | import <name…> | import --all | add <name> <url> | remove <name> | login <name> | logout <name>]",
    summary: "Manage MCP servers on this Mac and bring claude.ai connectors to every account",
    run: async (args) => {
      const [action = "list", ...rest] = args[0]?.startsWith("--") ? ["list", ...args] : args;
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { check: { type: "boolean" }, json: { type: "boolean" }, all: { type: "boolean" }, header: { type: "string", multiple: true } },
      });
      switch (action) {
        case "list": {
          const report = await connectors.report({ check: values.check ?? false });
          if (values.json) return out(JSON.stringify(report, null, 2));
          out(heading("On this Mac (every account uses these)"));
          for (const s of report.servers.filter((x) => x.origin !== "account")) {
            out(`  ${s.name.padEnd(28)} ${s.health.padEnd(11)} ${s.target}`);
          }
          if (!report.checked) out("  (run with --check to test each server; it takes a few seconds)");
          out("");
          out(heading("From your Claude accounts"));
          for (const c of report.connectors) {
            const state = c.localName ? `on this Mac as ${c.localName}` : c.portability === "portable" ? "can be added" : "claude.ai only";
            out(`  ${c.name.padEnd(28)} ${state.padEnd(30)} ${c.accounts.join(", ")}`);
          }
          return;
        }
        case "unused": {
          const { unused } = await findUnusedMcpServers({ engine });
          if (values.json) return out(JSON.stringify(unused, null, 2));
          if (unused.length === 0) return out("Every MCP server on this Mac was used in the last 30 days (or was added less than 30 days ago).");
          for (const s of unused) out(`${s.name.padEnd(24)} last used ${s.lastUsed ?? "never"}`);
          return;
        }
        case "import": {
          const results = await connectors.importConnectors({ names: positionals, all: values.all ?? false });
          for (const r of results) out(`${r.ok ? "✓" : "✗"} ${r.connector}${r.name ? ` → ${r.name}` : ""}: ${r.detail}`);
          if (results.some((r) => r.ok && r.detail.startsWith("added"))) out("\nSign in to each new server once: run `claude`, then `/mcp`.");
          return;
        }
        case "add": {
          const [name, url] = positionals;
          if (!name || !url) throw new UserError("Usage: cs connectors add <name> <url> [--header 'K: V']");
          await connectors.add({ name, url, headers: values.header ?? [] });
          return out(`Added ${name}. Sign in once with \`claude\` then \`/mcp\` if it asks.`);
        }
        case "remove": {
          const [name] = positionals;
          if (!name) throw new UserError("Usage: cs connectors remove <name>");
          await connectors.remove(name);
          return out(`Removed ${name}.`);
        }
        case "login": {
          if (positionals.length === 0) throw new UserError("Usage: cs connectors login <name…>");
          const failed: string[] = [];
          for (const name of positionals) {
            out(`\n— ${name}: your browser opens the sign-in page. If it shows a URL to paste, paste it here.`);
            try {
              await connectors.login(name, interactiveClaude(Bun.which("claude"), join(paths.stateDir, "mcp-workdir")));
              out(`✓ Signed in to ${name}.`);
            } catch (err) {
              failed.push(name);
              out(`✗ ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          if (failed.length > 0) throw new UserError(`Not signed in: ${failed.join(", ")}. Run \`cs connectors login ${failed.join(" ")}\` to try again.`);
          return;
        }
        case "logout": {
          const [name] = positionals;
          if (!name) throw new UserError("Usage: cs connectors logout <name>");
          await connectors.logout(name);
          return out(`Signed out of ${name}.`);
        }
        default:
          throw new UserError(`Unknown action "${action}". Use list, unused, import, add, remove, login or logout.`);
      }
    },
  },
  events: {
    usage: "cs events [--since <ISO time>] [--json]",
    summary: "Things claude-switch did on its own (closed idle profiles, cleanup suggestions)",
    run: async (args) => {
      const { values } = parseArgs({ args, options: { since: { type: "string" }, json: { type: "boolean" } } });
      const events = await new EventLog(paths.stateDir).since(values.since ?? null);
      if (values.json) return out(JSON.stringify(events, null, 2));
      if (events.length === 0) return out("No events.");
      for (const e of events) out(`${e.ts}  ${e.title}: ${e.body}`);
    },
  },
  "login-item": {
    usage: "cs login-item [on|off]",
    summary: "Show or change whether the menu bar app opens at login",
    run: async ([value]) => {
      if (value === undefined) return out((await loginItemEnabled(paths)) ? "on" : "off");
      if (value !== "on" && value !== "off") throw new UserError("Usage: cs login-item [on|off]");
      out((await setLoginItem({ paths, enabled: value === "on" })) ? "on" : "off");
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
      await runDaemon({ engine, hub, log, signal: controller.signal });
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
    usage: "cs install [--app path/to/Accounts Manager for Claude.app]",
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

async function desktopProfileFor(name: string) {
  const existing = await hub.findProfile(name);
  if (existing?.accountId) {
    out(`Desktop profile ${displayName(existing)} already signs in to an account; using it.`);
    return existing;
  }
  if (existing) {
    await hub.open(name);
    out(`Sign in to the account in the Claude window for profile ${displayName(existing)}.`);
  } else {
    await hub.createProfile(name);
    out(`Created Desktop profile ${name}. Sign in to the account in the Claude window that just opened.`);
  }
  out("Waiting for that window to finish signing in (up to 15 minutes)…");
  const profile = await hub.waitForAccount(name, { timeoutMs: 15 * 60_000 });
  if (!profile) throw new UserError(`No sign-in finished in the ${name} window. Run \`cs add ${name}\` again once you have signed in there.`);
  out(`Desktop profile ${displayName(profile)} is signed in.`);
  return profile;
}

async function cliLogin({ alias, expected }: { alias?: string; expected?: AccountId }): Promise<LoginResult> {
  const claude = Bun.which("claude");
  if (!claude) throw new UserError("The `claude` CLI is not on PATH. Install Claude Code first.");
  const parked = await engine.parkLiveForLogin();
  out("");
  out("Now the CLI login. A browser tab opens and signs in with whichever claude.ai account that browser uses.");
  out(expected ? "Use the same account as the Desktop window. If the browser is on another account," : "If the browser is already signed in to an account you registered,");
  out("copy the login link below into a private window and sign in there.\n");
  await Bun.spawn([claude, "auth", "login"], { stdio: ["inherit", "inherit", "inherit"] }).exited;
  const result = await engine.finishLogin({ previous: parked?.id ?? null, alias, expected });
  if (parked && result.kind !== "not_logged_in" && result.account.id !== parked.id) {
    await engine.switchTo(parked.id);
    out(`The CLI keeps using ${parked.alias}.`);
  }
  return result;
}

function reportLogin(result: LoginResult, name: string): void {
  switch (result.kind) {
    case "added":
      out(`Ready: ${result.account.alias} (${result.account.email}, ${result.account.plan}) works in Claude Desktop and the CLI.`);
      return;
    case "renewed":
      out(`Login for ${result.account.alias} renewed.`);
      return;
    case "unexpected_account":
      throw new UserError(
        `The browser signed in as ${result.account.email}, which is not the account this step needed. It was kept as "${result.account.alias}". Try again with the login link in a private window signed in to the right account.`,
      );
    case "same_account":
      throw new UserError(
        `The browser signed in as ${result.account.email} again, which is already "${result.account.alias}". Nothing changed for ${name}. Open the login link in a private window signed in to the other account.`,
      );
    case "not_logged_in":
      throw new UserError("Login did not finish. Nothing changed.");
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "account";
}

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
