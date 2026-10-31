import AppKit
import SwiftUI

enum Snapshot {
    @MainActor
    static func runIfRequested(store: Store) async {
        guard let path = ProcessInfo.processInfo.environment["CLAUDE_ACCOUNTS_SNAPSHOT"] else { return }
        await store.reload()
        let appearance = ProcessInfo.processInfo.environment["CLAUDE_ACCOUNTS_SNAPSHOT_DARK"] == "1" ? ColorScheme.dark : .light
        let view = Panel(store: store)
            .frame(width: 320)
            .background(appearance == .dark ? Color(white: 0.16) : Color(white: 0.96))
            .environment(\.colorScheme, appearance)
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        if let image = renderer.nsImage,
           let tiff = image.tiffRepresentation,
           let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
            try? png.write(to: URL(fileURLWithPath: path))
        }
        exit(0)
    }
}
