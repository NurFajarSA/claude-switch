import AppKit
import SwiftUI

enum Snapshot {
    @MainActor private static var preview: NSPanel?

    /// Shows the menu bar panel in a floating window, so `screencapture -l` can photograph it with real controls.
    @MainActor
    static func previewIfRequested(store: Store) async {
        let environment = ProcessInfo.processInfo.environment
        switch environment["ACCOUNTS_MANAGER_APPEARANCE"] {
        case "light": NSApp.appearance = NSAppearance(named: .aqua)
        case "dark": NSApp.appearance = NSAppearance(named: .darkAqua)
        default: break
        }
        guard environment["ACCOUNTS_MANAGER_PREVIEW_PANEL"] == "1" else { return }
        await store.reload()
        let expand = environment["ACCOUNTS_MANAGER_SNAPSHOT_OTHERS"] == "1"
        let hosting = NSHostingView(rootView: Panel(store: store, scrolls: false, expandOthers: expand).frame(width: 320))
        let size = hosting.fittingSize
        let panel = NSPanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        let effect = NSVisualEffectView(frame: NSRect(origin: .zero, size: size))
        effect.material = .popover
        effect.state = .active
        effect.blendingMode = .behindWindow
        effect.maskImage = RoundedWindow.ShapeView.mask(radius: Panel.windowRadius)
        hosting.frame = effect.bounds
        effect.addSubview(hosting)
        panel.contentView = effect
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .floating
        if let screen = NSScreen.main?.visibleFrame {
            panel.setFrameTopLeftPoint(NSPoint(x: screen.minX + 24, y: screen.maxY - 12))
        }
        panel.orderFrontRegardless()
        preview = panel
        // The expanded groups open in onAppear, after the first measurement.
        try? await Task.sleep(for: .milliseconds(300))
        let top = NSPoint(x: panel.frame.minX, y: panel.frame.maxY)
        let fitted = NSRect(origin: .zero, size: hosting.fittingSize)
        panel.setContentSize(fitted.size)
        panel.setFrameTopLeftPoint(top)
        effect.frame = fitted
        hosting.frame = fitted
        panel.invalidateShadow()
    }

    @MainActor
    static func runIfRequested(store: Store) async {
        guard let path = ProcessInfo.processInfo.environment["ACCOUNTS_MANAGER_SNAPSHOT"] else { return }
        await store.reload()
        let appearance = ProcessInfo.processInfo.environment["ACCOUNTS_MANAGER_SNAPSHOT_DARK"] == "1" ? ColorScheme.dark : .light
        let expand = ProcessInfo.processInfo.environment["ACCOUNTS_MANAGER_SNAPSHOT_OTHERS"] == "1"
        let view = Panel(store: store, scrolls: false, expandOthers: expand)
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
