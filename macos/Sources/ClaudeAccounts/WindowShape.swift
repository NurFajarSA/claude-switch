import AppKit
import SwiftUI

struct RoundedWindow: NSViewRepresentable {
    let radius: CGFloat

    func makeNSView(context: Context) -> ShapeView {
        let view = ShapeView()
        view.radius = radius
        return view
    }

    func updateNSView(_ view: ShapeView, context: Context) {
        view.radius = radius
        view.apply()
    }

    final class ShapeView: NSView {
        var radius: CGFloat = 22

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            apply()
        }

        func apply() {
            guard let window else { return }
            window.isOpaque = false
            window.backgroundColor = .clear
            var root: NSView? = window.contentView
            while let parent = root?.superview { root = parent }
            guard let root else { return }
            let mask = Self.mask(radius: radius)
            for effect in Self.effectViews(in: root) {
                effect.maskImage = mask
            }
            window.contentView?.wantsLayer = true
            window.contentView?.layer?.cornerRadius = radius
            window.contentView?.layer?.cornerCurve = .continuous
            window.contentView?.layer?.masksToBounds = true
            window.invalidateShadow()
        }

        private static func effectViews(in view: NSView) -> [NSVisualEffectView] {
            let own = (view as? NSVisualEffectView).map { [$0] } ?? []
            return own + view.subviews.flatMap(effectViews)
        }

        private static func mask(radius: CGFloat) -> NSImage {
            let edge = radius * 2 + 1
            let image = NSImage(size: NSSize(width: edge, height: edge), flipped: false) { rect in
                NSColor.black.setFill()
                NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
                return true
            }
            image.capInsets = NSEdgeInsets(top: radius, left: radius, bottom: radius, right: radius)
            image.resizingMode = .stretch
            return image
        }
    }
}
