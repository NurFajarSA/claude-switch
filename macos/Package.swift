// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "ClaudeAccounts",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "ClaudeAccounts", path: "Sources/ClaudeAccounts")
    ]
)
