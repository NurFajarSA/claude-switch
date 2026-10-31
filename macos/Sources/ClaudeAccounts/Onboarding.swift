import AppKit
import SwiftUI

@MainActor
enum AppPresence {
    private static var openWindows = 0

    static func windowAppeared() {
        openWindows += 1
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }

    static func windowDisappeared() {
        openWindows = max(0, openWindows - 1)
        if openWindows == 0 { NSApp.setActivationPolicy(.accessory) }
    }
}

extension View {
    func appWindowPresence() -> some View {
        onAppear { AppPresence.windowAppeared() }
            .onDisappear { AppPresence.windowDisappeared() }
    }
}

enum SetupStep: Int, CaseIterable {
    case welcome, account, done
}

struct InstallLine: Identifiable {
    let id = UUID()
    let ok: Bool
    let text: String

    init(_ line: String) {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        ok = trimmed.hasPrefix("✓")
        text = String(trimmed.drop { "✓✗ ".contains($0) })
    }

    static func parse(_ output: String) -> [InstallLine] {
        output.split(whereSeparator: \.isNewline).map { InstallLine(String($0)) }.filter { !$0.text.isEmpty }
    }
}

enum SetupInstaller {
    static func run() async -> [InstallLine] {
        guard let bundled = CS.bundledBinary else {
            return [InstallLine("✗ Install: this copy of Claude Accounts doesn’t include the cs command.")]
        }
        let arguments = ["install", "--app", Bundle.main.bundlePath]
        do {
            return InstallLine.parse(String(decoding: try await CS.run(arguments, using: bundled), as: UTF8.self))
        } catch {
            return InstallLine.parse(error.localizedDescription)
        }
    }
}

struct OnboardingView: View {
    let store: Store
    @Environment(\.dismiss) private var dismiss
    @State private var step = SetupStep.welcome
    @State private var installing = false
    @State private var results: [InstallLine] = []

    private var installed: Bool { store.csInstalled && store.daemonInstalled }
    private var hasAccounts: Bool { !(store.overview?.accounts.isEmpty ?? true) }

    var body: some View {
        VStack(spacing: 0) {
            Form {
                switch step {
                case .welcome: welcome
                case .account: account
                case .done: done
                }
            }
            .formStyle(.grouped)
            Divider()
            footer
        }
        .frame(width: 540, height: 600)
        .appWindowPresence()
        .task { store.refreshSetup() }
        .task(id: step) {
            guard step == .account else { return }
            while !Task.isCancelled {
                await store.reload()
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    private func hero(title: String, summary: String, symbol: String? = nil) -> some View {
        Section {
            HStack(spacing: 14) {
                if let symbol {
                    AppIconTile(symbol: symbol, color: .green, size: 56)
                } else {
                    Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 56, height: 56)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.title3.weight(.semibold))
                    Text(summary).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.vertical, 6)
            .accessibilityElement(children: .combine)
        }
    }

    private func feature(_ symbol: String, _ color: Color, _ title: String, _ detail: String) -> some View {
        HStack(spacing: 12) {
            AppIconTile(symbol: symbol, color: color, size: 28).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                Text(detail).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var welcome: some View {
        hero(
            title: "Welcome to Claude Accounts",
            summary: "See usage for every Claude account in the menu bar, and switch before one runs out."
        )
        Section("What will be installed") {
            feature("terminal.fill", .indigo, "The cs command", "Added to ~/.local/bin so you can use it in Terminal.")
            feature("gauge.with.dots.needle.67percent", .orange, "Background usage checker", "Checks each account’s limits every few minutes.")
            feature("point.3.connected.trianglepath.dotted", .blue, "MCP server for Claude", "Lets Claude see usage and move a conversation to another account.")
            feature("arrow.triangle.2.circlepath", .green, "Claude Code hooks", "Switch the CLI to another account automatically when one runs low.")
            feature("power", .gray, "Open at login", "Keep Claude Accounts in the menu bar.")
        }
        if installing {
            Section { HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Installing…") } }
        } else if !results.isEmpty {
            Section("Result") {
                ForEach(results) { line in
                    Label {
                        Text(line.text).foregroundStyle(line.ok ? Color.primary : Color.red)
                    } icon: {
                        Image(systemName: line.ok ? "checkmark.circle.fill" : "xmark.octagon.fill")
                            .foregroundStyle(line.ok ? Color.green : Color.red)
                    }
                    .accessibilityLabel("\(line.ok ? "Done" : "Failed"): \(line.text)")
                }
            }
        } else if installed {
            Section {
                Label("Already installed on this Mac", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
            }
        }
    }

    @ViewBuilder
    private var account: some View {
        hero(
            title: "Add your first account",
            summary: "One name sets up both a Claude Desktop profile and the Claude Code CLI for that account."
        )
        Section {
            Text("Pick a short name, like work or personal. A new Claude window opens for you to sign in, then Terminal walks you through the CLI sign-in with the same account.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            LabeledContent("New account") {
                Button("Add Account…") { store.addAccount() }
            }
        }
        Section {
            let profiles = store.overview?.profiles ?? []
            if profiles.isEmpty {
                Text("No Claude Desktop profiles found yet").foregroundStyle(.secondary)
            }
            ForEach(profiles) { profile in
                LabeledContent {
                    if profile.registered {
                        StatusBadge(text: "Set Up", color: .green)
                    } else if profile.accountId != nil {
                        Button("Set Up for CLI…") { store.linkCLI(profile) }
                    } else {
                        Text("Not signed in").foregroundStyle(.secondary)
                    }
                } label: {
                    Text(profile.label)
                    Text(profileSubtitle(profile)).foregroundStyle(.secondary)
                }
            }
        } header: {
            Text("Detected on this Mac")
        } footer: {
            Text("Profiles already signed in to Claude Desktop can be set up for the CLI without signing in again to Desktop.")
        }
    }

    @ViewBuilder
    private var done: some View {
        hero(
            title: "You’re all set",
            summary: hasAccounts ? "Claude Accounts is watching your usage." : "Add an account any time from the menu bar.",
            symbol: "checkmark"
        )
        Section("Next steps") {
            feature("gauge.with.dots.needle.50percent", .blue, "Open the menu bar panel", "Click the gauge to see each account’s usage and switch the CLI.")
            feature("gearshape.fill", .gray, "Adjust the levels", "Choose when to switch and when to warn in Settings.")
            feature("questionmark.circle.fill", .teal, "Run this again later", "Choose Show Setup Assistant… in the menu bar panel or in Settings.")
        }
    }

    private var footer: some View {
        HStack {
            Text("Step \(step.rawValue + 1) of \(SetupStep.allCases.count)")
                .font(.callout)
                .foregroundStyle(.secondary)
            Spacer()
            if step != .welcome && step != .done {
                Button("Back") { step = SetupStep(rawValue: step.rawValue - 1) ?? .welcome }
            }
            primaryButton
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
    }

    @ViewBuilder
    private var primaryButton: some View {
        switch step {
        case .welcome:
            if installed && results.allSatisfy(\.ok) {
                Button("Continue") { step = .account }.keyboardShortcut(.defaultAction)
            } else {
                Button(results.isEmpty ? "Install" : "Try Again") { install() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(installing)
            }
        case .account:
            if hasAccounts {
                Button("Continue") { step = .done }.keyboardShortcut(.defaultAction)
            } else {
                Button("Skip for Now") { step = .done }
            }
        case .done:
            Button("Done") {
                store.finishOnboarding()
                dismiss()
            }
            .keyboardShortcut(.defaultAction)
        }
    }

    private func install() {
        installing = true
        results = []
        Task {
            results = await SetupInstaller.run()
            store.refreshSetup()
            await store.reload()
            installing = false
        }
    }
}
