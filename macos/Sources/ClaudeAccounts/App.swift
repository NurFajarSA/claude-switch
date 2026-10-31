import AppKit
import SwiftUI

@main
struct ClaudeAccountsApp: App {
    @State private var store = Store()

    var body: some Scene {
        MenuBarExtra {
            Panel(store: store)
                .frame(width: 320)
                .background(RoundedWindow(radius: Panel.windowRadius))
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
    var scrolls = true
    var expandOthers = false
    @State private var showOthers = false

    private static let maxListHeight: CGFloat = 470
    static let edge: CGFloat = 8
    static let moduleRadius: CGFloat = 14
    static let windowRadius: CGFloat = moduleRadius + edge

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            if !scrolls {
                VStack(alignment: .leading, spacing: 8) { content }
                    .onAppear { showOthers = expandOthers }
            } else {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) { content }
                        .background(
                            GeometryReader { geo in
                                Color.clear.preference(key: ListHeightKey.self, value: geo.size.height)
                            }
                        )
                }
                .scrollIndicators(.automatic)
                .frame(height: min(store.listHeight ?? estimatedHeight, Self.maxListHeight))
                .onPreferenceChange(ListHeightKey.self) { height in
                    guard height > 0, !showOthers else { return }
                    store.listHeight = height
                }
                .onChange(of: showOthers) { _, expanded in
                    guard expanded else { return }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                        withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("others", anchor: .top) }
                    }
                }
            }
            }
            Module {
                ActionRow(title: "Refresh Usage") { Task { await store.refreshLive() } }
                ActionRow(title: "Add Account…") { store.addAccount() }
                ActionRow(title: "Open Log") { store.openLog() }
                ActionRow(title: "Quit Claude Accounts") { NSApplication.shared.terminate(nil) }
            }
        }
        .padding(Self.edge)
    }

    @ViewBuilder
    private var content: some View {
        if let message = store.loadError {
            Module { Row(icon: "exclamationmark.triangle.fill", highlighted: false, title: "Couldn’t load accounts", subtitle: message).padding(6) }
        }
        if let overview = store.overview {
            if let version = overview.desktopUpdate {
                Module {
                    Button {
                        Task { await store.installDesktopUpdate(version) }
                    } label: {
                        Row(icon: "arrow.down.circle", highlighted: true, title: "Claude \(version) is ready to install", subtitle: "Click to install and reopen every profile")
                    }
                    .buttonStyle(RowButtonStyle())
                }
            }
            desktop(overview)
            cli(overview)
        } else if store.loadError == nil {
            ProgressView().controlSize(.small).frame(maxWidth: .infinity).padding(12)
        }
    }

    private var estimatedHeight: CGFloat {
        guard let overview = store.overview else { return 60 }
        let desktopRows = overview.profiles.filter(\.registered).count + (overview.profiles.contains { !$0.registered } ? 1 : 0)
        let cliRows = max(overview.accounts.count, 1)
        let modules: CGFloat = 2 + (overview.desktopUpdate == nil ? 0 : 1)
        return modules * 29 + CGFloat(desktopRows + cliRows + (overview.desktopUpdate == nil ? 0 : 1)) * 36 + (modules - 1) * 8
    }

    private var header: some View {
        HStack(spacing: 6) {
            Text("Claude Accounts").font(.system(size: 13, weight: .semibold))
            if store.busy { ProgressView().controlSize(.mini) }
            Spacer()
            if let overview = store.overview {
                Text("Auto-switch").font(.system(size: 11)).foregroundStyle(.secondary)
                Toggle(
                    "Auto-switch",
                    isOn: Binding(get: { overview.autoSwitch }, set: { on in Task { await store.setAutoSwitch(on) } })
                )
                .toggleStyle(.switch)
                .controlSize(.mini)
                .labelsHidden()
                .help("Move to the account with the most usage left when the active one reaches \(overview.threshold)%")
            }
        }
        .padding(.horizontal, 6)
        .padding(.top, 2)
    }

    @ViewBuilder
    private func desktop(_ overview: Overview) -> some View {
        let registered = overview.profiles.filter(\.registered)
        let others = overview.profiles.filter { !$0.registered }
        Module(title: "Claude Desktop") {
            ForEach(registered) { DesktopProfileRow(store: store, profile: $0) }
            if !others.isEmpty {
                Button {
                    withAnimation(.easeOut(duration: 0.15)) { showOthers.toggle() }
                } label: {
                    Row(icon: "ellipsis", highlighted: false, title: "Other Profiles", subtitle: "\(others.count) not set up for the CLI") {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(.secondary)
                            .rotationEffect(.degrees(showOthers ? 90 : 0))
                    }
                }
                .buttonStyle(RowButtonStyle())
                .id("others")
                if showOthers {
                    ForEach(others) { DesktopProfileRow(store: store, profile: $0) }
                }
            }
        }
    }

    @ViewBuilder
    private func cli(_ overview: Overview) -> some View {
        Module(title: "Claude Code CLI and VS Code") {
            if overview.accounts.isEmpty {
                if let current = overview.unregisteredActive {
                    Button {
                        Task { await store.registerCurrent() }
                    } label: {
                        Row(icon: "plus", highlighted: false, title: "Register This Account", subtitle: current)
                    }
                    .buttonStyle(RowButtonStyle())
                } else {
                    Text("No accounts yet").font(.system(size: 12)).foregroundStyle(.secondary).padding(6)
                }
            }
            ForEach(overview.accounts) { CLIAccountRow(store: store, account: $0) }
        }
    }
}

struct ListHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

struct Module<Content: View>: View {
    var title: String?
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let title {
                Text(title)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 8)
                    .padding(.top, 4)
                    .padding(.bottom, 2)
            }
            content()
        }
        .padding(4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Panel.moduleRadius, style: .continuous).fill(Color.primary.opacity(0.05)))
        .overlay(RoundedRectangle(cornerRadius: Panel.moduleRadius, style: .continuous).strokeBorder(Color.primary.opacity(0.06), lineWidth: 0.5))
    }
}

struct DesktopProfileRow: View {
    let store: Store
    let profile: ProfileRow

    var body: some View {
        Button {
            Task { await store.open(profile) }
        } label: {
            Row(icon: "macwindow", highlighted: profile.running, title: profile.label, subtitle: subtitle, warning: profile.loginExpiring) {
                UsageMeter(percent: profile.percent, severity: profile.severity)
            }
        }
        .buttonStyle(RowButtonStyle())
        .help(profile.running ? "Window is open. Click to bring it forward." : "Click to open this profile’s window.")
        .contextMenu {
            Button(profile.running ? "Show Window" : "Open Window") { Task { await store.open(profile) } }
            Menu("Move Session Here") {
                let sessions = store.sessions.filter { $0.profile != profile.name }
                if sessions.isEmpty { Text("No sessions in other profiles") }
                ForEach(sessions) { session in
                    Button("\(session.title) — \(session.profileLabel)") { Task { await store.move(session, to: profile) } }
                }
            }
            if !profile.registered && profile.accountId != nil {
                Button("Set Up for CLI…") { store.linkCLI(profile) }
            }
            Divider()
            Button("Rename…") { Task { await store.rename(profile) } }
            if profile.customLabel {
                Button("Use Folder Name (\(profile.name))") { Task { await store.resetName(profile) } }
            }
        }
    }

    private var subtitle: String {
        if profile.loginExpiring, let days = profile.loginDaysLeft {
            return "Sign-in expires in \(days) \(days == 1 ? "day" : "days") · open the window to extend it"
        }
        var parts: [String] = []
        if profile.problem != nil { parts.append("needs sign-in") }
        if profile.usageSource == "desktop", let age = profile.usageAge {
            parts.append("updated \(age)")
        } else if let reset = profile.windows.first?.resetsIn {
            parts.append("reset \(reset)")
        }
        parts.append(profile.email ?? profile.accountId.map { "account \($0.prefix(8))" } ?? "not signed in")
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
            Row(icon: "terminal", highlighted: account.active, title: account.alias, subtitle: subtitle, warning: account.loginExpiring || !account.healthy) {
                UsageMeter(percent: account.percent, severity: account.severity)
            }
        }
        .buttonStyle(RowButtonStyle())
        .help(account.active ? "The CLI and VS Code use this account" : "Click to use this account in the CLI and VS Code")
        .contextMenu {
            if !account.active {
                Button("Use for CLI and VS Code") { Task { await store.useForCLI(account) } }
            }
            Button("Sign In Again…") { store.relogin(account) }
            Button("Rename…") { Task { await store.rename(account) } }
            Divider()
            Text(account.email)
            if let days = account.loginDaysLeft { Text("Sign-in valid for \(days) more \(days == 1 ? "day" : "days")") }
            ForEach(account.windows, id: \.self) { window in
                Text("\(window.label): \(window.percent)%" + (window.resetsIn.map { ", reset \($0)" } ?? ""))
            }
        }
    }

    private var subtitle: String {
        if !account.healthy { return "Needs sign-in · right-click → Sign In Again…" }
        if account.loginExpiring, let days = account.loginDaysLeft { return "Sign-in expires in \(days) \(days == 1 ? "day" : "days") · right-click → Sign In Again…" }
        return "\(account.active ? "Active" : "Click to use") · \(account.plan)"
    }
}

struct Row<Trailing: View>: View {
    let icon: String
    let highlighted: Bool
    let title: String
    let subtitle: String
    var warning = false
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
                Text(subtitle)
                    .font(.system(size: 11))
                    .foregroundStyle(warning ? AnyShapeStyle(Color.orange) : AnyShapeStyle(.secondary))
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            Spacer(minLength: 8)
            trailing()
        }
        .contentShape(Rectangle())
    }
}

extension Row where Trailing == EmptyView {
    init(icon: String, highlighted: Bool, title: String, subtitle: String, warning: Bool = false) {
        self.init(icon: icon, highlighted: highlighted, title: title, subtitle: subtitle, warning: warning) { EmptyView() }
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
                RoundedRectangle(cornerRadius: 10, style: .continuous)
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
