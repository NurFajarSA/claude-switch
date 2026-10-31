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
}

struct Overview: Decodable {
    let accounts: [AccountRow]
    let profiles: [ProfileRow]
    let threshold: Int
    let warnAt: Int
    let autoSwitch: Bool
    let unregisteredActive: String?
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

enum CS {
    static let binary: URL = {
        let fm = FileManager.default
        if let override = ProcessInfo.processInfo.environment["CLAUDE_SWITCH_BIN"] { return URL(fileURLWithPath: override) }
        let installed = fm.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin/cs")
        if fm.isExecutableFile(atPath: installed.path) { return installed }
        return Bundle.main.url(forResource: "cs", withExtension: nil) ?? installed
    }()

    static func run(_ arguments: [String]) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let process = Process()
                process.executableURL = binary
                process.arguments = arguments
                let stdout = Pipe()
                let stderr = Pipe()
                process.standardOutput = stdout
                process.standardError = stderr
                do {
                    try process.run()
                } catch {
                    continuation.resume(throwing: CommandError(message: "Tidak bisa menjalankan \(binary.path). Jalankan `cs install` dulu."))
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
