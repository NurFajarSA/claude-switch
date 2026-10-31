import AppKit
import SwiftUI

@main
struct ClaudeAccountsApp: App {
    @State private var store = Store()

    var body: some Scene {
        MenuBarExtra {
            Panel(store: store)
                .frame(width: 320)
        } label: {
            HStack(spacing: 3) {
                Image(systemName: "gauge.with.dots.needle.50percent")
                Text(store.headline)
            }
            .task {
                await Snapshot.runIfRequested(store: store)
                store.start()
            }
        }
        .menuBarExtraStyle(.window)
    }
}

struct Panel: View {
    let store: Store
    @State private var showOthers = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            header
            if let message = store.loadError {
                Row(icon: "exclamationmark.triangle.fill", highlighted: false, title: "Tidak bisa memuat data", subtitle: message)
            }
            if let overview = store.overview {
                desktop(overview)
                Separator()
                cli(overview)
            } else if store.loadError == nil {
                ProgressView().controlSize(.small).frame(maxWidth: .infinity).padding(12)
            }
            Separator()
            ActionRow(title: "Perbarui usage") { Task { await store.refreshLive() } }
            ActionRow(title: "Tambah akun…") { store.addAccount() }
            ActionRow(title: "Buka log") { store.openLog() }
            Separator()
            ActionRow(title: "Keluar Claude Accounts") { NSApplication.shared.terminate(nil) }
        }
        .padding(10)
    }

    private var header: some View {
        HStack(spacing: 6) {
            Text("Akun Claude").font(.system(size: 13, weight: .semibold))
            if store.busy { ProgressView().controlSize(.mini) }
            Spacer()
            if let overview = store.overview {
                Text("Pindah otomatis").font(.system(size: 11)).foregroundStyle(.secondary)
                Toggle(
                    "Pindah otomatis",
                    isOn: Binding(get: { overview.autoSwitch }, set: { on in Task { await store.setAutoSwitch(on) } })
                )
                .toggleStyle(.switch)
                .controlSize(.mini)
                .labelsHidden()
                .help("Pindah ke akun dengan sisa limit terbanyak saat akun aktif mencapai \(overview.threshold)%")
            }
        }
        .padding(.horizontal, 6)
        .padding(.bottom, 4)
    }

    @ViewBuilder
    private func desktop(_ overview: Overview) -> some View {
        let registered = overview.profiles.filter(\.registered)
        let others = overview.profiles.filter { !$0.registered }
        SectionLabel(text: "Claude Desktop")
        ForEach(registered) { DesktopProfileRow(store: store, profile: $0) }
        if !others.isEmpty {
            Button {
                withAnimation(.easeOut(duration: 0.15)) { showOthers.toggle() }
            } label: {
                Row(icon: "ellipsis", highlighted: false, title: "Lainnya", subtitle: "\(others.count) profil belum didaftarkan") {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .rotationEffect(.degrees(showOthers ? 90 : 0))
                }
            }
            .buttonStyle(RowButtonStyle())
            if showOthers {
                ForEach(others) { DesktopProfileRow(store: store, profile: $0) }
            }
        }
    }

    @ViewBuilder
    private func cli(_ overview: Overview) -> some View {
        SectionLabel(text: "Claude Code CLI dan VS Code")
        if overview.accounts.isEmpty {
            if let current = overview.unregisteredActive {
                Button {
                    Task { await store.registerCurrent() }
                } label: {
                    Row(icon: "plus", highlighted: false, title: "Daftarkan akun ini", subtitle: current)
                }
                .buttonStyle(RowButtonStyle())
            } else {
                Text("Belum ada akun terdaftar").font(.system(size: 12)).foregroundStyle(.secondary).padding(6)
            }
        }
        ForEach(overview.accounts) { CLIAccountRow(store: store, account: $0) }
    }
}

struct DesktopProfileRow: View {
    let store: Store
    let profile: ProfileRow

    var body: some View {
        Button {
            Task { await store.open(profile) }
        } label: {
            Row(icon: "macwindow", highlighted: profile.running, title: profile.label, subtitle: subtitle) {
                UsageMeter(percent: profile.percent, severity: profile.severity)
            }
        }
        .buttonStyle(RowButtonStyle())
        .help(profile.running ? "Jendela terbuka. Klik untuk menampilkannya." : "Klik untuk membuka jendela profil ini.")
        .contextMenu {
            Button(profile.running ? "Tampilkan jendela" : "Buka jendela") { Task { await store.open(profile) } }
            Menu("Pindahkan sesi ke sini") {
                let sessions = store.sessions.filter { $0.profile != profile.name }
                if sessions.isEmpty { Text("Tidak ada sesi di profil lain") }
                ForEach(sessions) { session in
                    Button("\(session.title) — \(session.profileLabel)") { Task { await store.move(session, to: profile) } }
                }
            }
            Divider()
            Button("Ubah nama…") { Task { await store.rename(profile) } }
            if profile.customLabel {
                Button("Kembalikan nama folder (\(profile.name))") { Task { await store.resetName(profile) } }
            }
        }
    }

    private var subtitle: String {
        var parts: [String] = []
        if profile.problem != nil { parts.append("perlu login ulang") }
        if profile.usageSource == "desktop", let age = profile.usageAge {
            parts.append("data \(age)")
        } else if let reset = profile.windows.first?.resetsIn {
            parts.append("reset \(reset)")
        }
        parts.append(profile.email ?? profile.accountId.map { "akun \($0.prefix(8))" } ?? "belum login")
        return parts.joined(separator: " · ")
    }
}

struct CLIAccountRow: View {
    let store: Store
    let account: AccountRow

    var body: some View {
        Button {
            guard !account.active else { return }
            Task { await store.useForCLI(account) }
        } label: {
            Row(icon: "terminal", highlighted: account.active, title: account.alias, subtitle: subtitle) {
                UsageMeter(percent: account.percent, severity: account.severity)
            }
        }
        .buttonStyle(RowButtonStyle())
        .help(account.active ? "Akun yang sedang dipakai CLI dan VS Code" : "Klik untuk memakai akun ini di CLI dan VS Code")
        .contextMenu {
            if !account.active {
                Button("Pakai untuk CLI dan VS Code") { Task { await store.useForCLI(account) } }
            }
            Button("Ubah nama…") { Task { await store.rename(account) } }
            Divider()
            Text(account.email)
            ForEach(account.windows, id: \.self) { window in
                Text("\(window.label): \(window.percent)%" + (window.resetsIn.map { ", reset \($0)" } ?? ""))
            }
        }
    }

    private var subtitle: String {
        if let problem = account.problem, !account.healthy { return problem }
        return "\(account.active ? "Aktif" : "Klik untuk pakai") · \(account.plan)"
    }
}

struct Row<Trailing: View>: View {
    let icon: String
    let highlighted: Bool
    let title: String
    let subtitle: String
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(spacing: 10) {
            ZStack {
                Circle().fill(highlighted ? Color.accentColor : Color.primary.opacity(0.1))
                Image(systemName: icon)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(highlighted ? Color.white : Color.primary.opacity(0.75))
            }
            .frame(width: 26, height: 26)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.system(size: 13, weight: .medium)).lineLimit(1)
                Text(subtitle).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
            }
            Spacer(minLength: 8)
            trailing()
        }
        .contentShape(Rectangle())
    }
}

extension Row where Trailing == EmptyView {
    init(icon: String, highlighted: Bool, title: String, subtitle: String) {
        self.init(icon: icon, highlighted: highlighted, title: title, subtitle: subtitle) { EmptyView() }
    }
}

struct RowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        HoverHighlight(pressed: configuration.isPressed) { configuration.label }
    }
}

struct HoverHighlight<Content: View>: View {
    let pressed: Bool
    @ViewBuilder var content: () -> Content
    @State private var hovering = false

    var body: some View {
        content()
            .padding(.horizontal, 6)
            .padding(.vertical, 5)
            .background(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(Color.primary.opacity(pressed ? 0.14 : hovering ? 0.08 : 0))
            )
            .onHover { hovering = $0 }
    }
}

struct ActionRow: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack {
                Text(title).font(.system(size: 13))
                Spacer()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(RowButtonStyle())
    }
}

struct UsageMeter: View {
    let percent: Int?
    let severity: Severity

    var body: some View {
        HStack(spacing: 8) {
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.12))
                    if let percent {
                        Capsule()
                            .fill(severity.tint)
                            .frame(width: max(5, geo.size.width * CGFloat(min(max(percent, 0), 100)) / 100))
                    }
                }
            }
            .frame(width: 54, height: 5)
            Text(percent.map { "\($0)%" } ?? "–")
                .font(.system(size: 12).monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(width: 34, alignment: .trailing)
        }
    }
}

struct SectionLabel: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 6)
            .padding(.top, 8)
            .padding(.bottom, 2)
    }
}

struct Separator: View {
    var body: some View {
        Divider().padding(.horizontal, 6).padding(.vertical, 5)
    }
}

extension Severity {
    var tint: Color {
        switch self {
        case .ok: .green
        case .warn: .orange
        case .critical: .red
        case .unknown: .gray
        }
    }
}
