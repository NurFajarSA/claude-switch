import AppKit
import Foundation
import Observation

@MainActor
@Observable
final class Store {
    var overview: Overview?
    var sessions: [SessionRow] = []
    var error: String?
    var notice: String?
    var busy = false
    var lastUpdated: Date?

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
            error = nil
            lastUpdated = Date()
        } catch {
            self.error = error.localizedDescription
        }
    }

    func refreshLive() async {
        await perform(["poll"], announce: false)
    }

    func open(_ profile: ProfileRow) async {
        await perform(["open", profile.name], announce: false)
    }

    func move(_ session: SessionRow, to profile: ProfileRow) async {
        var arguments = ["handoff", session.id, "--to", profile.name]
        if profile.running {
            NSApp.activate(ignoringOtherApps: true)
            let alert = NSAlert()
            alert.messageText = "Buka ulang jendela \(profile.name)?"
            alert.informativeText = "Jendela yang sedang terbuka baru menampilkan sesi pindahan setelah dibuka ulang. Pekerjaan yang sedang berjalan di jendela itu akan terhenti."
            alert.addButton(withTitle: "Buka ulang")
            alert.addButton(withTitle: "Nanti saja")
            if alert.runModal() == .alertFirstButtonReturn { arguments.append("--restart") }
        }
        await perform(arguments)
    }

    func useForCLI(_ account: AccountRow) async {
        await perform(["switch", account.alias])
    }

    func setAutoSwitch(_ on: Bool) async {
        await perform(["config", "autoSwitch", on ? "true" : "false"], announce: false)
    }

    func addAccount() {
        runInTerminal("\"\(CS.binary.path)\" add")
    }

    func registerCurrent() async {
        await perform(["register"])
    }

    func openLog() {
        let log = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/claude-switch/claude-switch.log")
        NSWorkspace.shared.open(log)
    }

    var headline: (text: String, severity: Severity) {
        guard let overview else { return ("–", .unknown) }
        let open = overview.profiles.filter { $0.running && $0.percent != nil }
        let pool = open.isEmpty ? overview.accounts.filter(\.active).map { ($0.percent, $0.severity) } : open.map { ($0.percent, $0.severity) }
        guard let worst = pool.compactMap({ p, s in p.map { ($0, s) } }).max(by: { $0.0 < $1.0 }) else { return ("–", .unknown) }
        return ("\(worst.0)%", worst.1)
    }

    private func perform(_ arguments: [String], announce: Bool = true) async {
        busy = true
        defer { busy = false }
        do {
            let output = String(decoding: try await CS.run(arguments), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            if announce { notice = output }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        await reload()
    }

    private func runInTerminal(_ command: String) {
        let script = FileManager.default.temporaryDirectory.appendingPathComponent("claude-switch-add.command")
        let body = "#!/bin/zsh -l\n\(command)\necho\necho 'Selesai. Jendela ini boleh ditutup.'\n"
        do {
            try body.write(to: script, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: script.path)
            NSWorkspace.shared.open(script)
        } catch {
            self.error = error.localizedDescription
        }
    }
}
