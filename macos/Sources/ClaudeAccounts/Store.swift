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
    var listHeight: CGFloat?

    @ObservationIgnored private var timer: Timer?

    func start() {
        guard timer == nil else { return }
        Task { await reload() }
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.reload() }
        }
    }

    func reload() async {
        do {
            overview = try await CS.decode(Overview.self, ["status", "--json"])
            sessions = try await CS.decode([SessionRow].self, ["sessions", "--limit", "8", "--json"])
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
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
