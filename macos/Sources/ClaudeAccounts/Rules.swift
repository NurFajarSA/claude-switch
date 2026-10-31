import SwiftUI

struct RulesPane: View {
    let store: Store
    let overview: Overview

    var body: some View {
        let choices = AccountChoice.all(in: overview)
        Section {
            if store.rules.isEmpty {
                Text(store.rulesError ?? "No rules yet. Every project can use every account.").foregroundStyle(.secondary)
            }
            ForEach(store.rules) { rule in
                RuleRow(store: store, rule: rule, choices: choices)
            }
        } header: {
            Text("Rules")
        } footer: {
            Text("A session in a folder with a rule only switches or moves between these accounts. When they are all used up, Claude asks whether to wait, use another account once, or allow it for this project. Folders without a rule can use every account.")
        }
        Section {
            Button("Add Rule…") { Task { await store.addRule(choices: choices) } }
                .disabled(choices.isEmpty)
        }
        .task { await store.loadRules() }
    }
}

struct RuleRow: View {
    let store: Store
    let rule: ProjectRuleRow
    let choices: [AccountChoice]

    private var options: [AccountChoice] {
        let known = Set(choices.map(\.id))
        let extra = rule.accounts.filter { !known.contains($0.id) }
            .map { AccountChoice(id: $0.id, name: $0.names.first ?? "Account \($0.id.prefix(8))", email: nil) }
        return choices + extra
    }

    private var allowed: Set<String> { Set(rule.accounts.map(\.id)) }

    private var summary: String {
        rule.accounts.map { $0.names.first ?? "Account \($0.id.prefix(8))" }.joined(separator: ", ")
    }

    private var folderName: String { URL(fileURLWithPath: rule.path).lastPathComponent }

    var body: some View {
        LabeledContent {
            HStack(spacing: 8) {
                if rule.accounts.isEmpty {
                    Text("No accounts").foregroundStyle(.orange)
                } else {
                    Text(summary).foregroundStyle(.secondary).lineLimit(2).multilineTextAlignment(.trailing)
                }
                Menu {
                    ForEach(options) { choice in
                        Toggle(choice.name, isOn: Binding(get: { allowed.contains(choice.id) }, set: { on in toggle(choice, on: on) }))
                    }
                    Divider()
                    Button("Remove Rule…", role: .destructive) { Task { await store.removeRule(rule) } }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .accessibilityLabel("Actions for \(folderName)")
            }
        } label: {
            Text(folderName)
            Text(Self.shortened(rule.path))
        }
    }

    private func toggle(_ choice: AccountChoice, on: Bool) {
        var next = allowed
        if on { next.insert(choice.id) } else { next.remove(choice.id) }
        guard !next.isEmpty else {
            Dialog.warn(title: "Keep at least one account", message: "A rule needs an account to allow. Use Remove Rule to let this folder use every account.")
            return
        }
        let ids = options.map(\.id).filter(next.contains)
        Task { await store.setRule(rule.path, accounts: ids) }
    }

    static func shortened(_ path: String) -> String {
        let home = NSHomeDirectory()
        if path == home { return "~" }
        return path.hasPrefix(home + "/") ? "~" + path.dropFirst(home.count) : path
    }
}
