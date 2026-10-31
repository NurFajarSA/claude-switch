import AppKit
import SwiftUI

@main
struct ClaudeAccountsApp: App {
    @State private var store = Store()

    var body: some Scene {
        MenuBarExtra {
            AccountsMenu(store: store)
        } label: {
            HStack(spacing: 3) {
                Image(systemName: "gauge.with.dots.needle.50percent")
                Text(store.headline)
            }
            .task { store.start() }
        }
        .menuBarExtraStyle(.menu)
    }
}

struct AccountsMenu: View {
    let store: Store

    var body: some View {
        if let message = store.loadError {
            Text("⚠︎ \(message)")
            Divider()
        }
        if let overview = store.overview {
            desktop(overview)
            Divider()
            cli(overview)
            Divider()
            Toggle(
                "Pindah Otomatis di \(overview.threshold)%",
                isOn: Binding(get: { overview.autoSwitch }, set: { on in Task { await store.setAutoSwitch(on) } })
            )
        } else if store.loadError == nil {
            Text("Memuat…")
        }
        Divider()
        Button("Perbarui Usage") { Task { await store.refreshLive() } }
            .keyboardShortcut("r")
            .disabled(store.busy)
        Button("Tambah Akun CLI…") { store.addAccount() }
        Button("Buka Log") { store.openLog() }
        Divider()
        Button("Keluar Claude Accounts") { NSApplication.shared.terminate(nil) }
            .keyboardShortcut("q")
    }

    @ViewBuilder
    private func desktop(_ overview: Overview) -> some View {
        let registered = overview.profiles.filter(\.registered)
        let others = overview.profiles.filter { !$0.registered }
        Section("Claude Desktop") {
            ForEach(registered) { ProfileMenu(store: store, profile: $0) }
            if !others.isEmpty {
                Menu("Lainnya") {
                    Section("Belum didaftarkan dengan cs add") {
                        ForEach(others) { ProfileMenu(store: store, profile: $0) }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func cli(_ overview: Overview) -> some View {
        Section("Claude Code CLI & VS Code") {
            if overview.accounts.isEmpty {
                if let current = overview.unregisteredActive {
                    Button("Daftarkan \(current)") { Task { await store.registerCurrent() } }
                } else {
                    Text("Belum ada akun terdaftar")
                }
            }
            ForEach(overview.accounts) { AccountMenu(store: store, account: $0) }
        }
    }
}

struct ProfileMenu: View {
    let store: Store
    let profile: ProfileRow

    var body: some View {
        Menu {
            Button(profile.running ? "Tampilkan Jendela" : "Buka Jendela") { Task { await store.open(profile) } }
            Menu("Pindahkan Sesi ke Sini") {
                let sessions = store.sessions.filter { $0.profile != profile.name }
                if sessions.isEmpty { Text("Tidak ada sesi di profil lain") }
                ForEach(sessions) { session in
                    Button("\(session.title) — \(session.profileLabel)") { Task { await store.move(session, to: profile) } }
                }
            }
            Divider()
            Button("Ubah Nama…") { Task { await store.rename(profile) } }
            if profile.customLabel {
                Button("Kembalikan Nama Folder (\(profile.name))") { Task { await store.resetName(profile) } }
            }
            Divider()
            ForEach(details, id: \.self) { Text($0) }
        } label: {
            Label {
                Text(title)
            } icon: {
                Image(nsImage: UsageIcon.make(percent: profile.percent, severity: profile.severity, running: profile.running))
            }
        }
    }

    private var title: String {
        "\(profile.label)    \(profile.percent.map { "\($0)%" } ?? "–")"
    }

    private var details: [String] {
        var lines = [profile.email ?? profile.accountId.map { "Akun \($0.prefix(8))" } ?? "Belum login"]
        lines.append(profile.running ? "Jendela terbuka" : "Jendela tertutup")
        for window in profile.windows {
            lines.append("\(window.label): \(window.percent)%" + (window.resetsIn.map { ", reset dalam \($0)" } ?? ""))
        }
        switch profile.usageSource {
        case "live": lines.append("Angka live, \(profile.usageAge ?? "")")
        case "desktop": lines.append("Dari catatan Desktop, \(profile.usageAge ?? "")")
        default: lines.append("Belum ada data usage")
        }
        if let problem = profile.problem { lines.append(problem) }
        return lines
    }
}

struct AccountMenu: View {
    let store: Store
    let account: AccountRow

    var body: some View {
        Menu {
            Button("Pakai untuk CLI & VS Code") { Task { await store.useForCLI(account) } }
                .disabled(account.active || !account.healthy)
            Button("Ubah Nama…") { Task { await store.rename(account) } }
            Divider()
            Text(account.email)
            Text(account.plan)
            ForEach(account.windows, id: \.self) { window in
                Text("\(window.label): \(window.percent)%" + (window.resetsIn.map { ", reset dalam \($0)" } ?? ""))
            }
            if let problem = account.problem { Text(problem) }
        } label: {
            Label {
                Text("\(account.alias)\(account.active ? "  ✓" : "")    \(account.percent.map { "\($0)%" } ?? "–")")
            } icon: {
                Image(nsImage: UsageIcon.make(percent: account.percent, severity: account.severity, running: nil))
            }
        }
    }
}

enum UsageIcon {
    static func make(percent: Int?, severity: Severity, running: Bool?) -> NSImage {
        let size = NSSize(width: running == nil ? 30 : 40, height: 14)
        let image = NSImage(size: size, flipped: false) { _ in
            var x: CGFloat = 0
            if let running {
                let dot = NSBezierPath(ovalIn: NSRect(x: 1, y: 4, width: 6, height: 6))
                (running ? NSColor.systemGreen : NSColor.tertiaryLabelColor).setFill()
                dot.fill()
                x = 10
            }
            let track = NSRect(x: x, y: 4.5, width: size.width - x, height: 5)
            NSColor.quaternaryLabelColor.setFill()
            NSBezierPath(roundedRect: track, xRadius: 2.5, yRadius: 2.5).fill()
            if let percent {
                var fill = track
                fill.size.width = max(track.height, track.width * CGFloat(min(max(percent, 0), 100)) / 100)
                severity.color.setFill()
                NSBezierPath(roundedRect: fill, xRadius: 2.5, yRadius: 2.5).fill()
            }
            return true
        }
        image.isTemplate = false
        return image
    }
}

extension Severity {
    var color: NSColor {
        switch self {
        case .ok: .systemGreen
        case .warn: .systemOrange
        case .critical: .systemRed
        case .unknown: .tertiaryLabelColor
        }
    }
}
