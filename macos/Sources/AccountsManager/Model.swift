import Foundation

struct WindowRow: Decodable, Hashable {
    let label: String
    let percent: Int
    let resetsIn: String?
}

enum Severity: String, Decodable {
    case ok, warn, critical, unknown
}

struct ProfileRow: Decodable, Identifiable {
    var id: String { folder }
    let name: String
    let label: String
    let customLabel: Bool
    let folder: String
    let running: Bool
    let accountId: String?
    let alias: String?
    let email: String?
    let plan: String?
    let registered: Bool
    let percent: Int?
    let severity: Severity
    let windows: [WindowRow]
    let usageSource: String
    let usageAge: String?
    let problem: String?
    let loginDaysLeft: Int?
    let loginExpiring: Bool
}

struct AccountRow: Decodable, Identifiable {
    let id: String
    let alias: String
    let email: String
    let plan: String
    let active: Bool
    let healthy: Bool
    let problem: String?
    let percent: Int?
    let severity: Severity
    let windows: [WindowRow]
    let checkedAgo: String?
    let stale: Bool
    let loginDaysLeft: Int?
    let loginExpiring: Bool
}

struct Overview: Decodable {
    let accounts: [AccountRow]
    let profiles: [ProfileRow]
    let threshold: Int
    let warnAt: Int
    let autoSwitch: Bool
    let pollSeconds: Int
    let unregisteredActive: String?
    let desktopVersion: String?
    let desktopUpdate: String?
    let idleCloseHours: Int?
    let mcpCleanup: Bool?
}

struct SessionRow: Decodable, Identifiable {
    let id: String
    let profile: String
    let profileLabel: String
    let title: String
    let lastActivityAt: String?
}

struct CommandError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

enum AppInfo {
    static let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
    static let repository = URL(string: "https://github.com/NurFajarSA/claude-switch")!
}

enum CS {
    static let installedBinary = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin/cs")
    static let bundledBinary = Bundle.main.url(forResource: "cs", withExtension: nil)

    static var binary: URL {
        if let override = ProcessInfo.processInfo.environment["CLAUDE_SWITCH_BIN"] { return URL(fileURLWithPath: override) }
        if FileManager.default.isExecutableFile(atPath: installedBinary.path) { return installedBinary }
        return bundledBinary ?? installedBinary
    }

    static func run(_ arguments: [String], using executable: URL? = nil) async throws -> Data {
        let binary = executable ?? Self.binary
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let process = Process()
                process.executableURL = binary
                process.currentDirectoryURL = Store.dataFolder
                process.arguments = arguments
                let stdout = Pipe()
                let stderr = Pipe()
                process.standardOutput = stdout
                process.standardError = stderr
                do {
                    try process.run()
                } catch {
                    continuation.resume(throwing: CommandError(message: "Couldn’t run \(binary.path). Run `cs install` first."))
                    return
                }
                let output = stdout.fileHandleForReading.readDataToEndOfFile()
                let errorOutput = stderr.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                if process.terminationStatus == 0 {
                    continuation.resume(returning: output)
                } else {
                    let message = String(decoding: errorOutput.isEmpty ? output : errorOutput, as: UTF8.self)
                    continuation.resume(throwing: CommandError(message: message.trimmingCharacters(in: .whitespacesAndNewlines)))
                }
            }
        }
    }

    static func decode<T: Decodable>(_ type: T.Type, _ arguments: [String]) async throws -> T {
        try JSONDecoder().decode(type, from: try await run(arguments))
    }
}

struct McpServerRow: Decodable, Identifiable, Hashable {
    var id: String { "\(origin):\(name)" }
    let name: String
    let origin: String
    let target: String
    let transport: String?
    let health: String
    let detail: String
    let removable: Bool
}

struct AccountConnectorRow: Decodable, Identifiable, Hashable {
    var id: String { url }
    let name: String
    let url: String
    let accounts: [String]
    let portability: String
    let localName: String?
}

struct ConnectorReport: Decodable {
    let servers: [McpServerRow]
    let connectors: [AccountConnectorRow]
    let checked: Bool
}

struct UnusedServer: Decodable, Hashable {
    let name: String
    let lastUsed: String?
}

struct EventRow: Decodable {
    let ts: String
    let kind: String
    let title: String
    let body: String
    let data: EventData?

    struct EventData: Decodable {
        let profile: String?
        let servers: [String]?
    }
}

struct RuleAccount: Decodable, Hashable {
    let id: String
    let names: [String]
}

struct ProjectRuleRow: Decodable, Identifiable, Hashable {
    var id: String { path }
    let path: String
    let accounts: [RuleAccount]
}

struct AccountChoice: Identifiable, Hashable {
    let id: String
    let name: String
    let email: String?

    static func all(in overview: Overview) -> [AccountChoice] {
        var order: [String] = []
        for account in overview.accounts where !order.contains(account.id) { order.append(account.id) }
        for profile in overview.profiles {
            if let id = profile.accountId, !order.contains(id) { order.append(id) }
        }
        return order.map { id in
            let account = overview.accounts.first { $0.id == id }
            let profiles = overview.profiles.filter { $0.accountId == id }
            let alias = account?.alias ?? profiles.compactMap(\.alias).first
            let labels = profiles.map(\.label)
            let name = alias.flatMap { $0.isEmpty ? nil : $0 } ?? (labels.isEmpty ? "Account \(id.prefix(8))" : labels.joined(separator: ", "))
            let email = account?.email ?? profiles.compactMap(\.email).first
            return AccountChoice(id: id, name: name, email: email)
        }
    }
}
