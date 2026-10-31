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
                title: "Buka ulang jendela \(profile.label)?",
                message: "Jendela yang sedang terbuka baru menampilkan sesi pindahan setelah dibuka ulang. Pekerjaan yang sedang berjalan di jendela itu akan terhenti.",
                confirm: "Buka Ulang",
                cancel: "Nanti Saja"
            )
            if restart { arguments.append("--restart") }
        }
        await perform(arguments, report: "Sesi dipindahkan")
    }

    func useForCLI(_ account: AccountRow) async {
        await perform(["switch", account.alias])
    }

    func rename(_ account: AccountRow) async {
        guard let value = Dialog.prompt(
            title: "Ubah nama akun \(account.alias)",
            message: "Huruf kecil, angka, atau tanda hubung. Dipakai di perintah cs dan di menu ini.",
            initial: account.alias
        ) else { return }
        let alias = value.trimmingCharacters(in: .whitespaces).lowercased().replacingOccurrences(of: " ", with: "-")
        guard !alias.isEmpty, alias != account.alias else { return }
        await perform(["rename", account.alias, alias])
    }

    func rename(_ profile: ProfileRow) async {
        guard let value = Dialog.prompt(
            title: "Ubah nama profil \(profile.label)",
            message: "Hanya mengubah nama yang tampil di claude-switch. Folder profil \(profile.name) tidak diubah. Kosongkan untuk memakai nama folder.",
            initial: profile.label
        ) else { return }
        let label = value.trimmingCharacters(in: .whitespaces)
        guard label != profile.label else { return }
        await perform(label.isEmpty ? ["label", profile.name, "--clear"] : ["label", profile.name, label])
    }

    func resetName(_ profile: ProfileRow) async {
        await perform(["label", profile.name, "--clear"])
    }

    func setAutoSwitch(_ on: Bool) async {
        await perform(["config", "autoSwitch", on ? "true" : "false"])
    }

    func registerCurrent() async {
        await perform(["register"])
    }

    func addAccount() {
        runInTerminal("\"\(CS.binary.path)\" add")
    }

    func openLog() {
        let log = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/claude-switch/claude-switch.log")
        NSWorkspace.shared.open(log)
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
            Dialog.warn(title: "Tidak berhasil", message: error.localizedDescription)
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
            Dialog.warn(title: "Tidak bisa membuka Terminal", message: error.localizedDescription)
        }
    }
}

@MainActor
enum Dialog {
    static func prompt(title: String, message: String, initial: String) -> String? {
        let field = NSTextField(string: initial)
        field.frame = NSRect(x: 0, y: 0, width: 280, height: 24)
        let alert = make(title: title, message: message, buttons: ["Simpan", "Batal"])
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
