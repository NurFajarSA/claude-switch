import AppKit
import Foundation
import Observation

@MainActor
@Observable
final class Store {
    var overview: Overview?
    var sessions: [SessionRow] = []
    var loadError: String?
    var busy = false
    var connectors: ConnectorReport?
    var connectorsChecking = false
    var listHeight: CGFloat?
    var csInstalled = false
    var daemonInstalled = false

    @ObservationIgnored private var timer: Timer?
    @ObservationIgnored private var reloadTicket = 0
    @ObservationIgnored private var userSwitching = false

    private static let onboardingCompletedKey = "onboardingCompleted"
    private static let daemonPlist = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/LaunchAgents/app.claude-switch.daemon.plist")

    var setupIncomplete: Bool {
        !csInstalled || !daemonInstalled || (overview?.accounts.isEmpty ?? false)
    }

    var shouldAutoShowOnboarding: Bool {
        setupIncomplete && !UserDefaults.standard.bool(forKey: Self.onboardingCompletedKey)
    }

    func finishOnboarding() {
        UserDefaults.standard.set(true, forKey: Self.onboardingCompletedKey)
    }

    func refreshSetup() {
        let fm = FileManager.default
        csInstalled = fm.isExecutableFile(atPath: CS.installedBinary.path)
        daemonInstalled = fm.fileExists(atPath: Self.daemonPlist.path)
    }

    func start() async {
        guard timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.reload() }
        }
        await reload()
    }

    func reload() async {
        reloadTicket += 1
        let ticket = reloadTicket
        do {
            let next = try await CS.decode(Overview.self, ["status", "--json"])
            let recent = try await CS.decode([SessionRow].self, ["sessions", "--limit", "8", "--json"])
            guard ticket == reloadTicket else { return }
            let previous = overview
            overview = next
            sessions = recent
            loadError = nil
            notify(previous: previous, current: next)
        } catch {
            guard ticket == reloadTicket else { return }
            loadError = error.localizedDescription
        }
        refreshSetup()
        if overview != nil, !setupIncomplete { finishOnboarding() }
    }

    private static let expiryNotifiedKey = "expiryNotifiedOn"

    private func notify(previous: Overview?, current: Overview) {
        var alerts: [UsageAlert] = []
        if let previous {
            if !userSwitching, let switched = AlertRules.switched(from: previous, to: current) { alerts.append(switched) }
            alerts += AlertRules.crossedWarning(from: previous, to: current)
        }
        let today = Date().formatted(.iso8601.year().month().day())
        var notifiedOn = UserDefaults.standard.dictionary(forKey: Self.expiryNotifiedKey) as? [String: String] ?? [:]
        for (key, alert) in AlertRules.expiring(current) where notifiedOn[key] != today {
            notifiedOn[key] = today
            alerts.append(alert)
        }
        guard !alerts.isEmpty else { return }
        UserDefaults.standard.set(notifiedOn, forKey: Self.expiryNotifiedKey)
        Task { await Notifier.shared.post(alerts) }
    }

    func refreshLive() async {
        await perform(["poll"])
    }

    func open(_ profile: ProfileRow) async {
        await perform(["open", profile.name])
    }

    func move(_ session: SessionRow, to profile: ProfileRow) async {
        var arguments = ["handoff", session.id, "--to", profile.name]
        if profile.running {
            let restart = Dialog.confirm(
                title: "Reopen the \(profile.label) window?",
                message: "An open window shows a moved session only after it restarts. Work running in that window will stop.",
                confirm: "Reopen",
                cancel: "Not Now"
            )
            if restart { arguments.append("--restart") }
        }
        await perform(arguments, report: "Session moved")
    }

    func useForCLI(_ account: AccountRow) async {
        userSwitching = true
        defer { userSwitching = false }
        await perform(["switch", account.alias])
    }

    func rename(_ account: AccountRow) async {
        guard let value = Dialog.prompt(
            title: "Rename \(account.alias)",
            message: "Use lowercase letters, digits, or dashes. This name is used in cs commands and in this menu.",
            initial: account.alias
        ) else { return }
        let alias = value.trimmingCharacters(in: .whitespaces).lowercased().replacingOccurrences(of: " ", with: "-")
        guard !alias.isEmpty, alias != account.alias else { return }
        await perform(["rename", account.alias, alias])
    }

    func rename(_ profile: ProfileRow) async {
        guard let value = Dialog.prompt(
            title: "Rename \(profile.label)",
            message: "Changes only the name claude-switch shows. The profile folder \(profile.name) keeps its name. Leave it empty to use the folder name.",
            initial: profile.label
        ) else { return }
        let label = value.trimmingCharacters(in: .whitespaces)
        guard label != profile.label else { return }
        await perform(label.isEmpty ? ["label", profile.name, "--clear"] : ["label", profile.name, label])
    }

    func resetName(_ profile: ProfileRow) async {
        await perform(["label", profile.name, "--clear"])
    }

    func setThreshold(_ value: Int) async {
        await setConfig("threshold", "\(value)")
    }

    func setLoginItem(_ on: Bool) async {
        await perform(["login-item", on ? "on" : "off"])
    }

    func setConfig(_ key: String, _ value: String) async {
        await perform(["config", key, value])
    }

    func remove(_ account: AccountRow) async {
        let confirmed = Dialog.confirm(
            title: "Remove \(account.alias)?",
            message: "claude-switch forgets this account and deletes its stored CLI sign-in. Claude Desktop profiles are not touched. You can add it again later.",
            confirm: "Remove",
            cancel: "Cancel"
        )
        guard confirmed else { return }
        await perform(["remove", account.alias])
    }

    func setAutoSwitch(_ on: Bool) async {
        await perform(["config", "autoSwitch", on ? "true" : "false"])
    }

    func registerCurrent() async {
        await perform(["register"])
    }

    func addAccount() {
        guard let value = Dialog.prompt(
            title: "Add a Claude account",
            message: "One name for the Desktop profile and its CLI sign-in. A new Claude window opens for you to sign in, then Terminal walks you through the CLI sign-in with the same account. Use lowercase letters, digits, or dashes.",
            initial: ""
        ) else { return }
        let name = value.trimmingCharacters(in: .whitespaces).lowercased().replacingOccurrences(of: " ", with: "-")
        guard !name.isEmpty else { return }
        runInTerminal(["add", name])
    }

    func relogin(_ account: AccountRow) {
        runInTerminal(["relogin", account.alias])
    }

    func linkCLI(_ profile: ProfileRow) {
        runInTerminal(["link", profile.name])
    }

    func installDesktopUpdate(_ version: String) async {
        let go = Dialog.confirm(
            title: "Install Claude \(version)?",
            message: "Every Claude Desktop window quits so the update can install, then opens again. Work running in those windows will stop.",
            confirm: "Install Update",
            cancel: "Not Now"
        )
        guard go else { return }
        await perform(["update-desktop"], report: "Update Claude Desktop")
    }


    static let dataFolder = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/claude-switch")

    func openLog() {
        NSWorkspace.shared.open(Self.dataFolder.appendingPathComponent("claude-switch.log"))
    }

    var headline: String {
        guard let overview else { return "–" }
        let open = overview.profiles.filter(\.running).compactMap(\.percent)
        let pool = open.isEmpty ? overview.accounts.filter(\.active).compactMap(\.percent) : open
        return pool.max().map { "\($0)%" } ?? "–"
    }

    private func perform(_ arguments: [String], report title: String? = nil) async {
        busy = true
        defer { busy = false }
        do {
            let output = String(decoding: try await CS.run(arguments), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            if let title { Dialog.inform(title: title, message: output) }
        } catch {
            Dialog.warn(title: "That didn’t work", message: error.localizedDescription)
        }
        await reload()
    }

    func loadConnectors(check: Bool) async {
        connectorsChecking = check
        defer { connectorsChecking = false }
        do {
            connectors = try await CS.decode(ConnectorReport.self, ["connectors", "list", "--json"] + (check ? ["--check"] : []))
        } catch {
            Dialog.warn(title: "Couldn’t read MCP servers", message: error.localizedDescription)
        }
    }

    func importConnector(_ connector: AccountConnectorRow?) async {
        await perform(["connectors", "import"] + (connector.map { [$0.name] } ?? ["--all"]), report: "Connectors added")
        await loadConnectors(check: false)
    }

    func removeServer(_ server: McpServerRow) async {
        guard Dialog.confirm(
            title: "Remove \(server.name)?",
            message: "Every account on this Mac stops using this MCP server. You can add it again later.",
            confirm: "Remove",
            cancel: "Cancel"
        ) else { return }
        await perform(["connectors", "remove", server.name])
        await loadConnectors(check: false)
    }

    func addServer() async {
        guard let fields = Dialog.promptPair(
            title: "Add an MCP server",
            message: "Every account on this Mac can use it. Most servers ask you to sign in once with /mcp in Claude Code.",
            first: "Name",
            second: "https://example.com/mcp"
        ) else { return }
        await perform(["connectors", "add", fields.0, fields.1])
        await loadConnectors(check: false)
    }

    func signInToServers() {
        runShellInTerminal("echo 'Type /mcp, pick a server and sign in. Quit with /exit when done.'; echo; claude")
    }

    private func runShellInTerminal(_ command: String) {
        let script = FileManager.default.temporaryDirectory.appendingPathComponent("claude-switch-mcp.command")
        do {
            try "#!/bin/zsh -l\n\(command)\n".write(to: script, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: script.path)
            NSWorkspace.shared.open(script)
        } catch {
            Dialog.warn(title: "Couldn’t open Terminal", message: error.localizedDescription)
        }
    }

    private func runInTerminal(_ arguments: [String]) {
        let script = FileManager.default.temporaryDirectory.appendingPathComponent("claude-switch-\(arguments.first ?? "run").command")
        let quoted = ([CS.binary.path] + arguments).map { "'" + $0.replacingOccurrences(of: "'", with: "'\\''") + "'" }.joined(separator: " ")
        let body = "#!/bin/zsh -l\n\(quoted)\necho\necho 'Done. You can close this window.'\n"
        do {
            try body.write(to: script, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: script.path)
            NSWorkspace.shared.open(script)
        } catch {
            Dialog.warn(title: "Couldn’t open Terminal", message: error.localizedDescription)
        }
    }
}

@MainActor
enum Dialog {
    static func prompt(title: String, message: String, initial: String) -> String? {
        let field = NSTextField(string: initial)
        field.frame = NSRect(x: 0, y: 0, width: 280, height: 24)
        let alert = make(title: title, message: message, buttons: ["Save", "Cancel"])
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        return alert.runModal() == .alertFirstButtonReturn ? field.stringValue : nil
    }

    static func promptPair(title: String, message: String, first: String, second: String) -> (String, String)? {
        let name = NSTextField(string: "")
        name.placeholderString = first
        let url = NSTextField(string: "")
        url.placeholderString = second
        let stack = NSStackView(views: [name, url])
        stack.orientation = .vertical
        stack.spacing = 8
        stack.frame = NSRect(x: 0, y: 0, width: 300, height: 56)
        name.frame.size.width = 300
        url.frame.size.width = 300
        let alert = make(title: title, message: message, buttons: ["Add", "Cancel"])
        alert.accessoryView = stack
        alert.window.initialFirstResponder = name
        guard alert.runModal() == .alertFirstButtonReturn else { return nil }
        let pair = (name.stringValue.trimmingCharacters(in: .whitespaces), url.stringValue.trimmingCharacters(in: .whitespaces))
        return pair.0.isEmpty || pair.1.isEmpty ? nil : pair
    }

    static func confirm(title: String, message: String, confirm: String, cancel: String) -> Bool {
        make(title: title, message: message, buttons: [confirm, cancel]).runModal() == .alertFirstButtonReturn
    }

    static func inform(title: String, message: String) {
        make(title: title, message: message, buttons: ["OK"]).runModal()
    }

    static func warn(title: String, message: String) {
        let alert = make(title: title, message: message, buttons: ["OK"])
        alert.alertStyle = .warning
        alert.runModal()
    }

    private static func make(title: String, message: String, buttons: [String]) -> NSAlert {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        buttons.forEach { alert.addButton(withTitle: $0) }
        return alert
    }
}
