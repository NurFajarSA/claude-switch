// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "AccountsManager",
    platforms: [.macOS(.v15)],
    targets: [
        .executableTarget(name: "AccountsManager", path: "Sources/AccountsManager")
    ],
    swiftLanguageModes: [.v5]
)
