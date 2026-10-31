import SwiftUI

@main
struct ClaudeAccountsApp: App {
    @State private var store = Store()

    var body: some Scene {
        MenuBarExtra {
            Panel(store: store)
                .frame(width: 400)
        } label: {
            let headline = store.headline
            HStack(spacing: 3) {
                Image(systemName: "gauge.with.dots.needle.50percent")
                Text(headline.text)
            }
            .task { store.start() }
        }
        .menuBarExtraStyle(.window)
    }
}

extension Severity {
    var color: Color {
        switch self {
        case .ok: .green
        case .warn: .orange
        case .critical: .red
        case .unknown: .secondary
        }
    }
}

struct Panel: View {
    let store: Store

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            if let message = store.error {
                Banner(text: message, tint: .red)
            } else if let notice = store.notice {
                Banner(text: notice, tint: .accentColor)
            }
            if let overview = store.overview {
                DesktopSection(store: store, overview: overview)
                Divider()
                CLISection(store: store, overview: overview)
            } else if store.error == nil {
                ProgressView().frame(maxWidth: .infinity)
            }
            Divider()
            footer
        }
        .padding(14)
    }

    private var header: some View {
        HStack {
            Text("Akun Claude").font(.headline)
            Spacer()
            if store.busy { ProgressView().controlSize(.small) }
            Button {
                Task { await store.refreshLive() }
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.borderless)
            .help("Ambil angka usage terbaru dari semua akun")
        }
    }

    private var footer: some View {
        HStack {
            if let overview = store.overview {
                Toggle(
                    "Pindah otomatis di \(overview.threshold)%",
                    isOn: Binding(get: { overview.autoSwitch }, set: { on in Task { await store.setAutoSwitch(on) } })
                )
                .toggleStyle(.switch)
                .controlSize(.small)
            }
            Spacer()
            Menu {
                Button("Tambah akun CLI…") { store.addAccount() }
                Button("Buka log") { store.openLog() }
                Divider()
                Button("Keluar") { NSApplication.shared.terminate(nil) }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
        }
        .font(.callout)
    }
}

struct DesktopSection: View {
    let store: Store
    let overview: Overview
    @AppStorage("showOtherProfiles") private var showOthers = false

    var body: some View {
        let registered = overview.profiles.filter(\.registered)
        let others = overview.profiles.filter { !$0.registered }
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle(title: "Claude Desktop", caption: "satu jendela per akun")
            if registered.isEmpty {
                Text("Belum ada profil yang akunnya terdaftar. Jalankan `cs add <nama>` di Terminal.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ForEach(registered) { line($0) }
            if !others.isEmpty {
                DisclosureGroup(isExpanded: $showOthers) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Login di Desktop, belum didaftarkan dengan `cs add`. Angkanya dari catatan Desktop.")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        ForEach(others) { line($0) }
                    }
                    .padding(.top, 6)
                } label: {
                    Text("Lainnya (\(others.count))").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func line(_ profile: ProfileRow) -> some View {
        ProfileLine(store: store, profile: profile, movable: store.sessions.filter { $0.profile != profile.name })
    }
}

struct ProfileLine: View {
    let store: Store
    let profile: ProfileRow
    let movable: [SessionRow]

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Circle()
                .fill(profile.running ? Color.green : Color.secondary.opacity(0.35))
                .frame(width: 7, height: 7)
                .padding(.top, 6)
                .help(profile.running ? "Jendela terbuka" : "Jendela tertutup")
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(profile.name).fontWeight(.medium)
                    Text(profile.email ?? profile.accountId.map { "akun \($0.prefix(8))" } ?? "belum login")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    UsageGauge(percent: profile.percent, severity: profile.severity)
                }
                Text(detail).font(.caption2).foregroundStyle(.secondary)
            }
            Menu {
                Button(profile.running ? "Tampilkan jendela" : "Buka jendela") { Task { await store.open(profile) } }
                if profile.accountId != nil {
                    Divider()
                    Section("Pindahkan sesi ke \(profile.name)") {
                        if movable.isEmpty { Text("Tidak ada sesi lain") }
                        ForEach(movable) { session in
                            Button("\(session.title) · \(session.profile)") { Task { await store.move(session, to: profile) } }
                        }
                    }
                }
            } label: {
                Image(systemName: "chevron.down.circle")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
        }
    }

    private var detail: String {
        var parts = profile.windows.map { w in "\(w.label) \(w.percent)%" + (w.resetsIn.map { ", reset \($0)" } ?? "") }
        switch profile.usageSource {
        case "live": parts.append("live \(profile.usageAge ?? "")")
        case "desktop": parts.append("dari Desktop \(profile.usageAge ?? "")")
        default: parts.append(profile.registered ? "belum ada data" : "daftarkan di CLI untuk angka live")
        }
        if let problem = profile.problem { parts.append(problem) }
        return parts.joined(separator: " · ")
    }
}

struct CLISection: View {
    let store: Store
    let overview: Overview

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle(title: "Claude Code CLI & VS Code", caption: "satu login, bisa diganti")
            if overview.accounts.isEmpty {
                Text(overview.unregisteredActive.map { "Login sekarang: \($0). Daftarkan agar bisa dipantau." } ?? "Belum ada akun terdaftar.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if overview.unregisteredActive != nil {
                    Button("Daftarkan akun ini") { Task { await store.registerCurrent() } }.controlSize(.small)
                }
            }
            ForEach(overview.accounts) { account in
                HStack(spacing: 8) {
                    Image(systemName: account.active ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(account.active ? Color.accentColor : Color.secondary)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(account.alias).fontWeight(account.active ? .semibold : .regular)
                        Text(account.problem ?? "\(account.email) · \(account.plan)")
                            .font(.caption2)
                            .foregroundStyle(account.problem == nil ? Color.secondary : Color.orange)
                            .lineLimit(1)
                    }
                    Spacer()
                    UsageGauge(percent: account.percent, severity: account.severity)
                    if !account.active {
                        Button("Pakai") { Task { await store.useForCLI(account) } }
                            .controlSize(.small)
                            .disabled(!account.healthy || store.busy)
                    }
                }
            }
        }
    }
}

struct UsageGauge: View {
    let percent: Int?
    let severity: Severity

    var body: some View {
        HStack(spacing: 6) {
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.secondary.opacity(0.18))
                    Capsule()
                        .fill(severity.color)
                        .frame(width: geo.size.width * CGFloat(min(max(percent ?? 0, 0), 100)) / 100)
                }
            }
            .frame(width: 70, height: 6)
            Text(percent.map { "\($0)%" } ?? "–")
                .font(.caption.monospacedDigit())
                .frame(width: 34, alignment: .trailing)
                .foregroundStyle(percent == nil ? Color.secondary : Color.primary)
        }
    }
}

struct SectionTitle: View {
    let title: String
    let caption: String

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).font(.subheadline).fontWeight(.semibold)
            Text(caption).font(.caption2).foregroundStyle(.secondary)
        }
    }
}

struct Banner: View {
    let text: String
    let tint: Color

    var body: some View {
        Text(text)
            .font(.caption)
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 6))
            .textSelection(.enabled)
    }
}
