import SwiftUI

@main
struct ClaudeAccountsApp: App {
    @State private var store = Store()

    var body: some Scene {
        MenuBarExtra {
            Panel(store: store)
                .frame(width: 400, height: 560)
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
    var tint: Color {
        switch self {
        case .ok: .green
        case .warn: .orange
        case .critical: .red
        case .unknown: .gray
        }
    }
}

struct Panel: View {
    let store: Store
    @AppStorage("showOtherProfiles") private var showOthers = false

    var body: some View {
        VStack(spacing: 0) {
            Form {
                if let message = store.error {
                    Section {
                        Label(message, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                            .textSelection(.enabled)
                    }
                } else if let notice = store.notice {
                    Section {
                        Label(notice, systemImage: "checkmark.circle.fill")
                            .textSelection(.enabled)
                    }
                }
                if let overview = store.overview {
                    desktopSection(overview)
                    cliSection(overview)
                    Section {
                        Toggle(
                            "Pindah otomatis di \(overview.threshold)%",
                            isOn: Binding(get: { overview.autoSwitch }, set: { on in Task { await store.setAutoSwitch(on) } })
                        )
                    } footer: {
                        Text("Saat akun aktif mencapai batas ini, sesi Desktop dipindah dan login CLI diganti ke akun dengan sisa limit terbanyak.")
                    }
                } else if store.error == nil {
                    Section { ProgressView().frame(maxWidth: .infinity) }
                }
            }
            .formStyle(.grouped)
            Divider()
            toolbar
        }
    }

    @ViewBuilder
    private func desktopSection(_ overview: Overview) -> some View {
        let registered = overview.profiles.filter(\.registered)
        let others = overview.profiles.filter { !$0.registered }
        Section {
            if registered.isEmpty {
                Text("Belum ada profil dengan akun terdaftar.").foregroundStyle(.secondary)
            }
            ForEach(registered) { profileRow($0) }
            if !others.isEmpty {
                DisclosureGroup("Lainnya (\(others.count))", isExpanded: $showOthers) {
                    ForEach(others) { profileRow($0) }
                }
            }
        } header: {
            Text("Claude Desktop")
        } footer: {
            if !others.isEmpty && showOthers {
                Text("Profil di Lainnya login di Desktop tapi belum didaftarkan dengan cs add, jadi angkanya dari catatan Desktop.")
            }
        }
    }

    private func profileRow(_ profile: ProfileRow) -> some View {
        ProfileRowView(store: store, profile: profile, movable: store.sessions.filter { $0.profile != profile.name })
    }

    @ViewBuilder
    private func cliSection(_ overview: Overview) -> some View {
        Section {
            if overview.accounts.isEmpty {
                if let current = overview.unregisteredActive {
                    LabeledContent("Login sekarang", value: current)
                    Button("Daftarkan akun ini") { Task { await store.registerCurrent() } }
                } else {
                    Text("Belum ada akun terdaftar.").foregroundStyle(.secondary)
                }
            } else {
                Picker(
                    "Akun aktif",
                    selection: Binding(
                        get: { overview.accounts.first(where: \.active)?.id ?? "" },
                        set: { id in
                            guard let account = overview.accounts.first(where: { $0.id == id }), !account.active else { return }
                            Task { await store.useForCLI(account) }
                        }
                    )
                ) {
                    ForEach(overview.accounts) { account in
                        Text(account.alias).tag(account.id)
                    }
                }
                .disabled(store.busy)
                ForEach(overview.accounts) { AccountRowView(store: store, account: $0) }
            }
        } header: {
            Text("Claude Code CLI & VS Code")
        }
    }

    private var toolbar: some View {
        HStack {
            Button {
                Task { await store.refreshLive() }
            } label: {
                Label("Perbarui", systemImage: "arrow.clockwise")
            }
            .disabled(store.busy)
            Button {
                store.addAccount()
            } label: {
                Label("Tambah akun", systemImage: "plus")
            }
            Spacer()
            if store.busy { ProgressView().controlSize(.small) }
            Menu {
                Button("Buka log") { store.openLog() }
                Divider()
                Button("Keluar Claude Accounts") { NSApplication.shared.terminate(nil) }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuIndicator(.hidden)
            .fixedSize()
        }
        .buttonStyle(.borderless)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }
}

struct ProfileRowView: View {
    let store: Store
    let profile: ProfileRow
    let movable: [SessionRow]
    @State private var editing = false
    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        LabeledContent {
            HStack(spacing: 8) {
                UsageView(percent: profile.percent, severity: profile.severity)
                actions
            }
        } label: {
            if editing {
                TextField("Nama profil", text: $draft, prompt: Text(profile.name))
                    .textFieldStyle(.roundedBorder)
                    .focused($focused)
                    .onSubmit(save)
                    .onExitCommand { editing = false }
            } else {
                HStack(spacing: 6) {
                    Image(systemName: "macwindow")
                        .foregroundStyle(profile.running ? Color.green : Color.secondary)
                        .help(profile.running ? "Jendela terbuka" : "Jendela tertutup")
                    Text(profile.label)
                }
                Text(subtitle)
            }
        }
        .contextMenu { menuItems }
    }

    private var actions: some View {
        Menu {
            menuItems
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .menuIndicator(.hidden)
        .buttonStyle(.borderless)
        .fixedSize()
    }

    @ViewBuilder
    private var menuItems: some View {
        Button(profile.running ? "Tampilkan jendela" : "Buka jendela") { Task { await store.open(profile) } }
        Button("Ubah nama…") {
            draft = profile.label
            editing = true
            focused = true
        }
        if profile.customLabel {
            Button("Kembalikan nama folder (\(profile.name))") { Task { await store.label(profile, as: nil) } }
        }
        Divider()
        Menu("Pindahkan sesi ke sini") {
            if movable.isEmpty { Text("Tidak ada sesi lain") }
            ForEach(movable) { session in
                Button("\(session.title) · \(session.profileLabel)") { Task { await store.move(session, to: profile) } }
            }
        }
    }

    private var subtitle: String {
        var parts = [profile.email ?? profile.accountId.map { "akun \($0.prefix(8))" } ?? "belum login"]
        if let window = profile.windows.first {
            parts.append("\(window.label) \(window.percent)%" + (window.resetsIn.map { ", reset \($0)" } ?? ""))
        }
        switch profile.usageSource {
        case "live": parts.append("live")
        case "desktop": parts.append("Desktop, \(profile.usageAge ?? "")")
        default: break
        }
        if let problem = profile.problem { parts.append(problem) }
        return parts.joined(separator: " · ")
    }

    private func save() {
        let value = draft.trimmingCharacters(in: .whitespaces)
        editing = false
        guard value != profile.label else { return }
        Task { await store.label(profile, as: value.isEmpty ? nil : value) }
    }
}

struct AccountRowView: View {
    let store: Store
    let account: AccountRow
    @State private var editing = false
    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        LabeledContent {
            HStack(spacing: 8) {
                UsageView(percent: account.percent, severity: account.severity)
                Menu {
                    menuItems
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .menuIndicator(.hidden)
                .buttonStyle(.borderless)
                .fixedSize()
            }
        } label: {
            if editing {
                TextField("Alias", text: $draft, prompt: Text(account.alias))
                    .textFieldStyle(.roundedBorder)
                    .focused($focused)
                    .onSubmit(save)
                    .onExitCommand { editing = false }
            } else {
                HStack(spacing: 6) {
                    Text(account.alias)
                    if account.active {
                        Text("aktif").font(.caption).foregroundStyle(.secondary)
                    }
                }
                Text(account.problem ?? "\(account.email) · \(account.plan)")
                    .foregroundStyle(account.problem == nil ? Color.secondary : Color.orange)
            }
        }
        .contextMenu { menuItems }
    }

    @ViewBuilder
    private var menuItems: some View {
        if !account.active {
            Button("Pakai untuk CLI & VS Code") { Task { await store.useForCLI(account) } }
                .disabled(!account.healthy)
        }
        Button("Ubah nama…") {
            draft = account.alias
            editing = true
            focused = true
        }
    }

    private func save() {
        let value = draft.trimmingCharacters(in: .whitespaces).lowercased().replacingOccurrences(of: " ", with: "-")
        editing = false
        guard !value.isEmpty, value != account.alias else { return }
        Task { await store.renameAccount(account, to: value) }
    }
}

struct UsageView: View {
    let percent: Int?
    let severity: Severity

    var body: some View {
        HStack(spacing: 6) {
            ProgressView(value: Double(min(max(percent ?? 0, 0), 100)), total: 100)
                .progressViewStyle(.linear)
                .tint(severity.tint)
                .frame(width: 70)
                .opacity(percent == nil ? 0.35 : 1)
            Text(percent.map { "\($0)%" } ?? "–")
                .monospacedDigit()
                .foregroundStyle(percent == nil ? .secondary : .primary)
                .frame(width: 38, alignment: .trailing)
        }
    }
}
