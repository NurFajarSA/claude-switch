// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "ClaudeAccounts",
    platforms: [.macOS(.v15)],
    targets: [
        .executableTarget(name: "ClaudeAccounts", path: "Sources/ClaudeAccounts")
    ],
    swiftLanguageModes: [.v5]
)
