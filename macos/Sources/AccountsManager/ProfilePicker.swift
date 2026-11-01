import AppKit
import SwiftUI

extension Notification.Name {
    static let showProfilePicker = Notification.Name("showProfilePicker")
}

enum ProfilePicker {
    static let windowID = "picker"
    static let showOnLaunchKey = "pickerOnLaunch"

    static var showOnLaunch: Bool {
        UserDefaults.standard.object(forKey: showOnLaunchKey) as? Bool ?? true
    }

    /// The launch agent passes this flag, so the picker stays hidden when the app starts at login.
    static var launchedAtLogin: Bool {
        CommandLine.arguments.contains("--at-login")
    }
}

/// Chrome-style "Who's using Chrome?" window: one card per Claude Desktop profile.
struct ProfilePickerView: View {
    let store: Store
    @Environment(\.dismissWindow) private var dismissWindow
    @Environment(\.openWindow) private var openWindow
    @AppStorage(ProfilePicker.showOnLaunchKey) private var showOnLaunch = true

    private let columns = [GridItem(.adaptive(minimum: 150, maximum: 170), spacing: 14)]

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 6) {
                Image(nsImage: NSApp.applicationIconImage)
                    .resizable()
                    .frame(width: 56, height: 56)
                    .accessibilityHidden(true)
                Text("Which Claude do you want to open?")
                    .font(.title2.weight(.semibold))
                Text("Each profile is its own Claude Desktop window, signed in to one account.")
                    .foregroundStyle(.secondary)
            }
            .padding(.top, 28)
            .padding(.bottom, 20)

            ScrollView {
                LazyVGrid(columns: columns, spacing: 14) {
                    ForEach(store.overview?.profiles ?? []) { profile in
                        ProfileCard(profile: profile, store: store) { pick(profile) }
                    }
                    AddProfileCard { store.addAccount() }
                }
                .padding(.horizontal, 28)
                .padding(.bottom, 20)
            }
            .overlay {
                if store.overview == nil {
                    ProgressView().controlSize(.small)
                }
            }

            Divider()
            HStack {
                Button("Settings…") {
                    NSApp.activate(ignoringOtherApps: true)
                    openWindow(id: "settings")
                }
                Spacer()
                Toggle("Show when Accounts Manager opens", isOn: $showOnLaunch)
                    .toggleStyle(.checkbox)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
        }
        .frame(minWidth: 560, idealWidth: 760, minHeight: 620, idealHeight: 660)
        .onExitCommand { dismissWindow(id: ProfilePicker.windowID) }
    }

    private func pick(_ profile: ProfileRow) {
        dismissWindow(id: ProfilePicker.windowID)
        Task { await store.open(profile) }
    }
}

struct ProfileCard: View {
    let profile: ProfileRow
    let store: Store
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            VStack(spacing: 10) {
                ProfileAvatar(name: profile.label, running: profile.running)
                VStack(spacing: 2) {
                    Text(profile.label)
                        .font(.headline)
                        .lineLimit(1)
                    Text(profile.email ?? profile.plan ?? "Claude Desktop")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                UsageMeter(name: profile.label, percent: profile.percent, severity: profile.severity)
                    .padding(.top, 2)
            }
            .padding(.vertical, 18)
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color.primary.opacity(hovering ? 0.10 : 0.05))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.5)
            )
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(profile.running ? "Bring the \(profile.label) window forward" : "Open the \(profile.label) window")
        .accessibilityLabel(profile.label)
        .accessibilityValue([profile.running ? "Open" : nil, profile.email, usageDescription(profile.percent)].compactMap { $0 }.joined(separator: ", "))
        .accessibilityHint(profile.running ? "Brings this profile's window forward." : "Opens this profile's window.")
        .contextMenu {
            Button(profile.running ? "Show Window" : "Open Window", action: action)
            Button("Rename…") { Task { await store.rename(profile) } }
        }
    }
}

struct ProfileAvatar: View {
    let name: String
    let running: Bool

    private static let palette: [Color] = [.blue, .purple, .pink, .orange, .teal, .indigo, .green, .brown]

    private var initials: String {
        let words = name.split(whereSeparator: { $0 == " " || $0 == "-" || $0 == "_" })
        let letters = words.count > 1 ? words.prefix(2).compactMap(\.first) : Array(name.prefix(1))
        return String(letters).uppercased()
    }

    private var color: Color {
        let sum = name.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0x7fff_ffff }
        return Self.palette[sum % Self.palette.count]
    }

    var body: some View {
        Circle()
            .fill(color.gradient)
            .frame(width: 64, height: 64)
            .overlay(Text(initials).font(.system(size: 24, weight: .semibold)).foregroundStyle(.white))
            .overlay(alignment: .bottomTrailing) {
                if running {
                    Circle()
                        .fill(.green)
                        .frame(width: 16, height: 16)
                        .overlay(Circle().strokeBorder(Color(nsColor: .windowBackgroundColor), lineWidth: 3))
                        .accessibilityHidden(true)
                }
            }
            .accessibilityHidden(true)
    }
}

struct AddProfileCard: View {
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            VStack(spacing: 10) {
                Circle()
                    .strokeBorder(Color.secondary.opacity(0.5), style: StrokeStyle(lineWidth: 1.5, dash: [4, 4]))
                    .frame(width: 64, height: 64)
                    .overlay(Image(systemName: "plus").font(.system(size: 24, weight: .medium)).foregroundStyle(.secondary))
                Text("Add Account").font(.headline)
                Text("New Desktop profile and CLI login").font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            .padding(.vertical, 18)
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, minHeight: 170)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.primary.opacity(hovering ? 0.08 : 0.02)))
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityLabel("Add Account")
    }
}
