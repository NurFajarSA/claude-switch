import AppKit
import SwiftUI

enum SettingsPane: String, CaseIterable, Identifiable, Hashable {
    case general, autoSwitch, rules, accounts, profiles, connectors, usage, updates, about

    var id: String { rawValue }

    var title: String {
        switch self {
        case .general: "General"
        case .autoSwitch: "Auto-switch"
        case .rules: "Project Rules"
        case .accounts: "CLI Accounts"
        case .profiles: "Desktop Profiles"
        case .connectors: "Connectors"
        case .usage: "Usage"
        case .updates: "Updates"
        case .about: "About"
        }
    }

    var summary: String {
        switch self {
        case .general: "Start at login, and find the files Claude Accounts keeps on this Mac."
        case .rules: "Choose which accounts each project folder may use. Auto-switch and session moves stay inside these accounts."
        case .autoSwitch: "Move to another account before the one in use hits its limit."
        case .accounts: "Accounts the Claude Code CLI and VS Code can sign in with. One is in use at a time."
        case .profiles: "Each Claude Desktop profile is its own window, signed in to one account."
        case .connectors: "MCP servers on this Mac work in every account. Bring claude.ai connectors here so switching accounts keeps your tools."
        case .usage: "How often Claude Accounts checks each account’s 5-hour and weekly limits."
        case .updates: "Keep every Claude Desktop profile open across app updates."
        case .about: "Usage for every Claude account, session handoff between Desktop profiles, and automatic CLI switching."
        }
    }

    var symbol: String {
        switch self {
        case .general: "gearshape.fill"
        case .autoSwitch: "arrow.triangle.2.circlepath"
        case .rules: "folder.badge.gearshape"
        case .accounts: "terminal.fill"
        case .profiles: "macwindow"
        case .connectors: "puzzlepiece.extension.fill"
        case .usage: "gauge.with.dots.needle.67percent"
        case .updates: "arrow.down.circle.fill"
        case .about: "info.circle.fill"
        }
    }

    var color: Color {
        switch self {
        case .general: .gray
        case .autoSwitch: .green
        case .rules: .mint
        case .accounts: .indigo
        case .profiles: .blue
        case .connectors: .purple
        case .usage: .orange
        case .updates: .teal
        case .about: .blue
        }
    }

    var keywords: [String] {
        switch self {
        case .general: ["login", "startup", "log", "files", "folder"]
        case .rules: ["rules", "project", "folder", "allowed"]
        case .autoSwitch: ["threshold", "switch", "limit", "warning", "percent"]
        case .accounts: ["cli", "vs code", "sign in", "rename", "remove", "account"]
        case .profiles: ["desktop", "window", "profile", "session", "move"]
        case .connectors: ["mcp", "connector", "server", "tools", "figma", "github", "notion"]
        case .usage: ["poll", "refresh", "interval", "minutes"]
        case .updates: ["update", "version", "install"]
        case .about: ["version", "github"]
        }
    }

    static let main: [SettingsPane] = [.general, .autoSwitch, .rules, .accounts, .profiles, .connectors, .usage, .updates]
}

enum SettingsRoute: Hashable {
    case account(String)
    case profile(String)
}

struct SettingsView: View {
    let store: Store
    @AppStorage("settingsPane") private var pane: SettingsPane = .general
    @State private var query = ""
    @State private var path: [SettingsRoute] = []
    @State private var back: [SettingsPane] = []
    @State private var forward: [SettingsPane] = []

    var body: some View {
        NavigationSplitView {
            List(selection: Binding(get: { pane }, set: { if let next = $0 { select(next) } })) {
                Section {
                    ForEach(filtered(SettingsPane.main)) { SidebarRow(pane: $0).tag($0) }
                }
                if !filtered([.about]).isEmpty {
                    Section("Claude Accounts") {
                        SidebarRow(pane: .about).tag(SettingsPane.about)
                    }
                }
            }
            .listStyle(.sidebar)
            .frame(minWidth: 215)
            .searchable(text: $query, placement: .sidebar)
            .navigationSplitViewColumnWidth(min: 220, ideal: 230, max: 280)
            .toolbar(removing: .sidebarToggle)
        } detail: {
            NavigationStack(path: $path) {
                PaneContent(store: store, pane: pane)
                    .navigationTitle(pane.title)
                    .toolbar { navigationButtons }
                    .navigationDestination(for: SettingsRoute.self) { route in
                        Group {
                            switch route {
                            case let .account(id): AccountDetail(store: store, id: id)
                            case let .profile(folder): ProfileDetail(store: store, folder: folder)
                            }
                        }
                        .toolbar { navigationButtons }
                        .navigationBarBackButtonHidden(true)
                    }
            }
        }
        .frame(minWidth: 780, minHeight: 540)
        .task { await store.reload() }
        .appWindowPresence()
    }

    @ToolbarContentBuilder
    private var navigationButtons: some ToolbarContent {
        ToolbarItem(placement: .navigation) {
            ControlGroup {
                Button(action: goBack) { Label("Back", systemImage: "chevron.left") }
                    .disabled(path.isEmpty && back.isEmpty)
                Button(action: goForward) { Label("Forward", systemImage: "chevron.right") }
                    .disabled(forward.isEmpty)
            }
            .controlGroupStyle(.navigation)
        }
    }

    private func filtered(_ panes: [SettingsPane]) -> [SettingsPane] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return panes }
        return panes.filter { $0.title.lowercased().contains(q) || $0.keywords.contains { $0.contains(q) } }
    }

    private func select(_ next: SettingsPane) {
        guard next != pane else { return }
        back.append(pane)
        forward.removeAll()
        path.removeAll()
        pane = next
    }

    private func goBack() {
        if !path.isEmpty {
            path.removeLast()
        } else if let previous = back.popLast() {
            forward.append(pane)
            pane = previous
        }
    }

    private func goForward() {
        guard let next = forward.popLast() else { return }
        back.append(pane)
        path.removeAll()
        pane = next
    }
}

struct SidebarRow: View {
    let pane: SettingsPane

    var body: some View {
        Label {
            Text(pane.title)
        } icon: {
            Image(systemName: pane.symbol).foregroundStyle(pane.color)
        }
    }
}

struct AppIconTile: View {
    let symbol: String
    let color: Color
    var size: CGFloat = 20

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: size * 0.55, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(RoundedRectangle(cornerRadius: size * 0.24, style: .continuous).fill(color.gradient))
            .accessibilityHidden(true)
    }
}

struct HeroSection: View {
    let symbol: String
    let color: Color
    let title: String
    let summary: String

    var body: some View {
        Section {
            HStack(alignment: .center, spacing: 12) {
                AppIconTile(symbol: symbol, color: color, size: 44)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.system(size: 13, weight: .semibold))
                    Text(summary).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.vertical, 4)
        }
    }
}

struct PaneContent: View {
    let store: Store
    let pane: SettingsPane

    var body: some View {
        if pane == .about {
            AboutPane()
        } else if let overview = store.overview {
            Form {
                HeroSection(symbol: pane.symbol, color: pane.color, title: pane.title, summary: pane.summary)
                switch pane {
                case .general: GeneralPane(store: store)
                case .autoSwitch: AutoSwitchPane(store: store, overview: overview)
                case .rules: RulesPane(store: store, overview: overview)
                case .accounts: AccountsPane(store: store, overview: overview)
                case .profiles: ProfilesPane(store: store, overview: overview)
                case .usage: UsagePane(store: store, overview: overview)
                case .connectors: ConnectorsPane(store: store)
                case .updates: UpdatesPane(store: store, overview: overview)
                case .about: EmptyView()
                }
            }
            .formStyle(.grouped)
        } else if let message = store.loadError {
            ContentUnavailableView("Couldn’t load accounts", systemImage: "exclamationmark.triangle", description: Text(message))
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

struct GeneralPane: View {
    let store: Store
    @Environment(\.openWindow) private var openWindow
    @State private var launchAtLogin = LoginItem.isEnabled
    @AppStorage(Notifier.enabledKey) private var notificationsEnabled = true

    var body: some View {
        Section {
            Toggle(isOn: Binding(get: { launchAtLogin }, set: { on in
                launchAtLogin = on
                Task {
                    await store.setLoginItem(on)
                    launchAtLogin = LoginItem.isEnabled
                }
            })) {
                Text("Launch at Login")
                Text("Show Claude Accounts in the menu bar when you log in.")
            }
        }
        Section {
            Toggle(isOn: $notificationsEnabled) {
                Text("Notifications")
                Text("Tell me when the CLI switches accounts, usage reaches the warning level, or a sign-in is about to expire.")
            }
        }
        if let overview = store.overview, overview.idleCloseHours != nil || overview.mcpCleanup != nil {
            Section("Housekeeping") {
                if let hours = overview.idleCloseHours {
                    Picker(selection: Binding(get: { hours }, set: { value in
                        Task { await store.setConfig("idleCloseHours", "\(value)") }
                    })) {
                        ForEach(Self.idleOptions(including: hours), id: \.self) { Text(Self.idleLabel($0)).tag($0) }
                    } label: {
                        Text("Close idle Desktop profiles")
                        Text("Quits a profile window when none of its sessions changed for this long. Its sessions stay saved; reopen it from the menu bar.")
                    }
                }
                if let cleanup = overview.mcpCleanup {
                    Toggle(isOn: Binding(get: { cleanup }, set: { on in
                        Task { await store.setConfig("mcpCleanup", on ? "true" : "false") }
                    })) {
                        Text("Suggest removing unused MCP servers")
                        Text("Once a month, offers to remove MCP servers no session has used in 30 days.")
                    }
                }
            }
        }
        Section("Setup") {
            LabeledContent("Setup assistant") {
                Button("Show Setup Assistant…") {
                    NSApp.activate(ignoringOtherApps: true)
                    openWindow(id: "onboarding")
                }
            }
        }
        Section("Files") {
            LabeledContent("Command-line tool", value: CS.binary.path.replacingOccurrences(of: NSHomeDirectory(), with: "~"))
            LabeledContent("Data folder") {
                Button("Show in Finder") { NSWorkspace.shared.open(Store.dataFolder) }
            }
            LabeledContent("Activity log") {
                Button("Open") { store.openLog() }
            }
        }
    }
}

extension GeneralPane {
    static func idleOptions(including current: Int) -> [Int] {
        let base = [0, 1, 2, 3, 6, 12]
        return base.contains(current) ? base : (base + [current]).sorted()
    }

    static func idleLabel(_ hours: Int) -> String {
        switch hours {
        case 0: "Off"
        case 1: "After 1 hour"
        default: "After \(hours) hours"
        }
    }
}

struct AutoSwitchPane: View {
    let store: Store
    let overview: Overview

    var body: some View {
        Section {
            Toggle(isOn: Binding(get: { overview.autoSwitch }, set: { on in Task { await store.setAutoSwitch(on) } })) {
                Text("Switch accounts automatically")
                Text("Claude Desktop sessions move to the account with the most usage left, and the CLI signs in to it.")
            }
        }
        Section {
            PercentSlider(title: "Switch when usage reaches", value: overview.threshold, range: 50...100) { await store.setConfig("threshold", "\($0)") }
                .disabled(!overview.autoSwitch)
            PercentSlider(title: "Show a warning from", value: overview.warnAt, range: 10...99) { await store.setConfig("warnAt", "\($0)") }
        } header: {
            Text("Levels")
        } footer: {
            Text("The warning level turns the usage bar orange. It always stays below the switch level.")
        }
    }
}

struct PercentSlider: View {
    let title: String
    let value: Int
    let range: ClosedRange<Int>
    let commit: (Int) async -> Void
    @State private var draft: Double?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(title)
                Spacer()
                Text("\(Int((draft ?? Double(value)).rounded()))%")
                    .font(.system(size: 11).monospacedDigit())
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(RoundedRectangle(cornerRadius: 5, style: .continuous).strokeBorder(Color.secondary.opacity(0.35)))
                    .accessibilityHidden(true)
            }
            Slider(value: Binding(get: { draft ?? Double(value) }, set: { draft = $0 }), in: Double(range.lowerBound)...Double(range.upperBound)) {
                Text(title)
            } onEditingChanged: { editing in
                guard !editing, let final = draft else { return }
                Task {
                    await commit(Int(final.rounded()))
                    draft = nil
                }
            }
            .labelsHidden()
            .accessibilityValue("\(Int((draft ?? Double(value)).rounded())) percent")
        }
    }
}

struct AccountsPane: View {
    let store: Store
    let overview: Overview

    var body: some View {
        Section {
            if overview.accounts.isEmpty {
                Text("No CLI accounts yet").foregroundStyle(.secondary)
            }
            ForEach(overview.accounts) { account in
                NavigationLink(value: SettingsRoute.account(account.id)) {
                    LabeledContent {
                        HStack(spacing: 6) {
                            if account.active { StatusBadge(text: "In Use", color: .accentColor) }
                            Text(account.percent.map { "\($0)%" } ?? "–").monospacedDigit()
                                .accessibilityLabel("\(account.alias), \(usageDescription(account.percent).lowercased())")
                        }
                    } label: {
                        Text(account.alias)
                        Text(accountSubtitle(account)).foregroundStyle(account.loginExpiring || !account.healthy ? Color.orange : Color.secondary)
                    }
                }
            }
        } header: {
            Text("Accounts")
        } footer: {
            Text("Usage shows the higher of the 5-hour and weekly limits.")
        }
        Section {
            Button("Add Account…") { store.addAccount() }
        }
    }
}

func accountSubtitle(_ account: AccountRow) -> String {
    if !account.healthy { return "Needs sign-in" }
    if account.loginExpiring, let days = account.loginDaysLeft { return "Sign-in expires in \(days) \(days == 1 ? "day" : "days")" }
    return "\(account.email) · \(account.plan)"
}

struct ProfilesPane: View {
    let store: Store
    let overview: Overview

    var body: some View {
        let ready = overview.profiles.filter(\.registered)
        let others = overview.profiles.filter { !$0.registered }
        Section("Set up for the CLI") {
            if ready.isEmpty { Text("None yet").foregroundStyle(.secondary) }
            ForEach(ready) { ProfileLink(profile: $0) }
        }
        if !others.isEmpty {
            Section {
                ForEach(others) { ProfileLink(profile: $0) }
            } header: {
                Text("Other Profiles")
            } footer: {
                Text("These profiles are signed in on Claude Desktop only. Set one up for the CLI to see live usage and include it in auto-switch.")
            }
        }
        Section {
            Button("Add Account…") { store.addAccount() }
        }
    }
}

struct ProfileLink: View {
    let profile: ProfileRow

    var body: some View {
        NavigationLink(value: SettingsRoute.profile(profile.folder)) {
            LabeledContent {
                HStack(spacing: 6) {
                    if profile.running { StatusBadge(text: "Open", color: .green) }
                    Text(profile.percent.map { "\($0)%" } ?? "–").monospacedDigit()
                        .accessibilityLabel("\(profile.label), \(usageDescription(profile.percent).lowercased())")
                }
            } label: {
                Text(profile.label)
                Text(profileSubtitle(profile)).foregroundStyle(profile.loginExpiring ? Color.orange : Color.secondary)
            }
        }
    }
}

func profileSubtitle(_ profile: ProfileRow) -> String {
    if profile.loginExpiring, let days = profile.loginDaysLeft { return "Sign-in expires in \(days) \(days == 1 ? "day" : "days")" }
    return profile.email ?? profile.accountId.map { "Account \($0.prefix(8))" } ?? "Not signed in"
}

struct StatusBadge: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Capsule().fill(color.opacity(0.15)))
    }
}

struct UsageRows: View {
    let windows: [WindowRow]
    let source: String?

    var body: some View {
        if windows.isEmpty {
            LabeledContent("Usage", value: "No data yet")
        }
        ForEach(windows, id: \.self) { window in
            LabeledContent {
                HStack(spacing: 8) {
                    ProgressView(value: Double(window.percent), total: 100)
                        .frame(width: 90)
                        .accessibilityLabel("\(window.label) limit")
                        .accessibilityValue("\(window.percent) percent used")
                    Text("\(window.percent)%").monospacedDigit().frame(width: 38, alignment: .trailing).accessibilityHidden(true)
                }
            } label: {
                Text(window.label.prefix(1).uppercased() + window.label.dropFirst())
                if let reset = window.resetsIn { Text("Resets in \(reset)") }
            }
        }
        if let source { LabeledContent("Source", value: source) }
    }
}

struct AccountDetail: View {
    let store: Store
    let id: String

    var body: some View {
        if let account = store.overview?.accounts.first(where: { $0.id == id }) {
            Form {
                HeroSection(symbol: "terminal.fill", color: .indigo, title: account.alias, summary: "\(account.email) · \(account.plan)")
                Section("Usage") {
                    UsageRows(windows: account.windows, source: account.checkedAgo.map { "Checked \($0)" })
                }
                Section("Sign-in") {
                    LabeledContent("Status", value: account.healthy ? (account.active ? "In use by the CLI and VS Code" : "Ready") : "Needs sign-in")
                    if let days = account.loginDaysLeft {
                        LabeledContent("Valid for", value: "\(days) more \(days == 1 ? "day" : "days")")
                    }
                    LabeledContent("Renew") {
                        Button("Sign In Again…") { store.relogin(account) }
                    }
                }
                Section {
                    if !account.active {
                        Button("Use for CLI and VS Code") { Task { await store.useForCLI(account) } }
                    }
                    Button("Rename…") { Task { await store.rename(account) } }
                    Button("Remove Account…", role: .destructive) { Task { await store.remove(account) } }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(account.alias)
        } else {
            ContentUnavailableView("Account removed", systemImage: "person.crop.circle.badge.xmark")
        }
    }
}

struct ProfileDetail: View {
    let store: Store
    let folder: String

    var body: some View {
        if let profile = store.overview?.profiles.first(where: { $0.folder == folder }) {
            Form {
                HeroSection(symbol: "macwindow", color: .blue, title: profile.label, summary: profile.email ?? "Claude Desktop profile \(profile.name)")
                Section("Usage") {
                    UsageRows(windows: profile.windows, source: sourceText(profile))
                }
                Section("Window") {
                    LabeledContent("Status", value: profile.running ? "Open" : "Closed")
                    if let days = profile.loginDaysLeft {
                        LabeledContent("Sign-in valid for", value: "\(days) more \(days == 1 ? "day" : "days")")
                    }
                    LabeledContent(profile.running ? "Bring to front" : "Open window") {
                        Button(profile.running ? "Show" : "Open") { Task { await store.open(profile) } }
                    }
                    Picker("Move a session here", selection: Binding<String>(get: { "" }, set: { id in
                        guard let session = store.sessions.first(where: { $0.id == id }) else { return }
                        Task { await store.move(session, to: profile) }
                    })) {
                        Text("Choose…").tag("")
                        ForEach(store.sessions.filter { $0.profile != profile.name }) { session in
                            Text("\(session.title) — \(session.profileLabel)").tag(session.id)
                        }
                    }
                }
                Section {
                    if !profile.registered && profile.accountId != nil {
                        Button("Set Up for CLI…") { store.linkCLI(profile) }
                    }
                    Button("Rename…") { Task { await store.rename(profile) } }
                    if profile.customLabel {
                        Button("Use Folder Name (\(profile.name))") { Task { await store.resetName(profile) } }
                    }
                } footer: {
                    Text("Renaming changes only the name shown here. The profile folder stays \(profile.name).")
                }
            }
            .formStyle(.grouped)
            .navigationTitle(profile.label)
        } else {
            ContentUnavailableView("Profile not found", systemImage: "macwindow.badge.plus")
        }
    }

    private func sourceText(_ profile: ProfileRow) -> String? {
        switch profile.usageSource {
        case "live": "Live, \(profile.usageAge ?? "")"
        case "desktop": "Recorded by Claude Desktop \(profile.usageAge ?? "")"
        default: nil
        }
    }
}

struct UsagePane: View {
    let store: Store
    let overview: Overview
    private static let choices = [60, 120, 300, 600, 900]

    var body: some View {
        Section {
            Picker("Check usage every", selection: Binding(get: { overview.pollSeconds }, set: { seconds in
                Task { await store.setConfig("pollSeconds", "\(seconds)") }
            })) {
                ForEach(Self.choices, id: \.self) { seconds in
                    Text(seconds == 60 ? "1 minute" : "\(seconds / 60) minutes").tag(seconds)
                }
            }
            LabeledContent("Check now") {
                Button("Refresh Usage") { Task { await store.refreshLive() } }
            }
        } footer: {
            Text("Accounts added with Add Account show live numbers. Other Desktop profiles show what Claude Desktop last recorded while their window was open.")
        }
    }
}

struct UpdatesPane: View {
    let store: Store
    let overview: Overview

    var body: some View {
        Section("Claude Desktop") {
            LabeledContent("Installed version", value: overview.desktopVersion ?? "Not found")
            if let update = overview.desktopUpdate {
                LabeledContent("Claude \(update) is downloaded") {
                    Button("Install and Reopen Profiles") { Task { await store.installDesktopUpdate(update) } }
                }
            } else {
                LabeledContent("Status", value: "Up to date")
            }
        }
        Section {
            LabeledContent("After an update", value: "Reopen every profile that was open")
        } footer: {
            Text("Claude Desktop installs an update only after every window quits, then reopens just the default profile. Claude Accounts reopens the rest.")
        }
    }
}

struct AboutPane: View {
    var body: some View {
        VStack(spacing: 10) {
            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .frame(width: 96, height: 96)
            Text("Claude Accounts").font(.title2.weight(.semibold))
            Text("Version \(AppInfo.version)").foregroundStyle(.secondary)
            Text("Usage for every Claude account, session handoff between Claude Desktop profiles, and automatic CLI switching. Not affiliated with Anthropic.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .frame(maxWidth: 380)
            Link("View on GitHub", destination: AppInfo.repository)
        }
        .padding(30)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

enum LoginItem {
    static var isEnabled: Bool {
        FileManager.default.fileExists(
            atPath: FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents/app.claude-switch.menubar.plist").path
        )
    }
}

struct ConnectorsPane: View {
    let store: Store

    var body: some View {
        if let report = store.connectors {
            Section {
                let waiting = report.servers.filter { $0.origin == "local" && $0.health == "needs_auth" }
                HStack {
                    Button("Add Server…") { Task { await store.addServer() } }
                    if !waiting.isEmpty {
                        Button("Sign In to All (\(waiting.count))") { Task { await store.signInToAll(waiting) } }
                            .disabled(!store.signingIn.isEmpty)
                    }
                    Spacer()
                    if store.connectorsChecking { ProgressView().controlSize(.small) }
                    Button(report.checked ? "Check Again" : "Check Status") { Task { await store.loadConnectors(check: true) } }
                        .disabled(store.connectorsChecking)
                }
                ForEach(report.servers.filter { $0.origin != "account" }) { server in
                    LabeledContent {
                        HStack(spacing: 8) {
                            if store.signingIn.contains(server.name) {
                                ProgressView().controlSize(.small)
                                Text("Finish in Terminal").font(.caption).foregroundStyle(.secondary)
                            } else if server.health == "needs_auth" {
                                Button("Sign In") { Task { await store.signIn(server) } }
                            } else {
                                HealthBadge(health: server.health, checked: report.checked)
                                    .help(server.detail)
                            }
                            if server.removable && server.name != "claude-switch" {
                                Menu {
                                    if server.health == "connected" && server.transport == "http" {
                                        Button("Sign Out") { Task { await store.signOut(server) } }
                                    }
                                    Button("Remove…", role: .destructive) { Task { await store.removeServer(server) } }
                                } label: {
                                    Image(systemName: "ellipsis.circle")
                                }
                                .menuStyle(.borderlessButton)
                                .menuIndicator(.hidden)
                                .fixedSize()
                                .accessibilityLabel("Actions for \(server.name)")
                            }
                        }
                    } label: {
                        Text(server.origin == "plugin" ? server.name.replacingOccurrences(of: "plugin:", with: "") : server.name)
                        Text(server.origin == "plugin" ? "From a plugin · \(host(server.target))" : host(server.target))
                    }
                }
            } header: {
                Text("On this Mac")
            } footer: {
                Text("These work in the CLI, VS Code and Claude Desktop’s Code tab for every account, and stay signed in when you switch.")
            }
            let portable = report.connectors.filter { $0.portability == "portable" && $0.localName == nil }
            Section {
                ForEach(report.connectors) { connector in
                    LabeledContent {
                        if let local = connector.localName {
                            StatusBadge(text: "On This Mac", color: .green).help("Added as \(local)")
                        } else if connector.portability == "portable" {
                            Button("Add to This Mac") { Task { await store.importConnector(connector) } }
                        } else {
                            StatusBadge(text: "claude.ai Only", color: .secondary)
                        }
                    } label: {
                        Text(connector.name)
                        Text(connector.accounts.joined(separator: ", "))
                    }
                }
                if !portable.isEmpty {
                    HStack {
                        Spacer()
                        Button("Add All \(portable.count) to This Mac") { Task { await store.importConnector(nil) } }
                    }
                }
            } header: {
                Text("Connectors in your Claude accounts")
            } footer: {
                Text("After adding, sign in to each one once. Claude Code hides a claude.ai or plugin copy that points at the same URL, so tools don’t show up twice.")
            }
        } else {
            Section { ProgressView().frame(maxWidth: .infinity) }
                .task { await store.loadConnectors(check: true) }
        }
    }

    private func host(_ target: String) -> String {
        URL(string: target)?.host() ?? target
    }
}

struct HealthBadge: View {
    let health: String
    let checked: Bool

    var body: some View {
        switch health {
        case "connected": StatusBadge(text: "Connected", color: .green)
        case "needs_auth": StatusBadge(text: "Sign In Needed", color: .orange)
        case "degraded": StatusBadge(text: "Partly Working", color: .orange)
        case "failed": StatusBadge(text: "Failed", color: .red)
        default: if checked { StatusBadge(text: "Unknown", color: .secondary) } else { EmptyView() }
        }
    }
}
