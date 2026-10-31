import AppKit

let size: CGFloat = 1024
let output = CommandLine.arguments.dropFirst().first ?? "icon-1024.png"

let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { _ in
    guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
    let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
    let squircle = CGPath(roundedRect: tile, cornerWidth: 185, cornerHeight: 185, transform: nil)

    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -12), blur: 28, color: NSColor.black.withAlphaComponent(0.35).cgColor)
    ctx.addPath(squircle)
    ctx.setFillColor(NSColor.black.cgColor)
    ctx.fillPath()
    ctx.restoreGState()

    ctx.saveGState()
    ctx.addPath(squircle)
    ctx.clip()
    let background = CGGradient(
        colorsSpace: CGColorSpaceCreateDeviceRGB(),
        colors: [NSColor(srgbRed: 0.16, green: 0.18, blue: 0.30, alpha: 1).cgColor,
                 NSColor(srgbRed: 0.07, green: 0.08, blue: 0.14, alpha: 1).cgColor] as CFArray,
        locations: [0, 1]
    )!
    ctx.drawLinearGradient(background, start: CGPoint(x: 512, y: 924), end: CGPoint(x: 512, y: 100), options: [])

    let center = CGPoint(x: 512, y: 460)
    let radius: CGFloat = 270
    let lineWidth: CGFloat = 62
    let segments: [(from: CGFloat, to: CGFloat, color: NSColor)] = [
        (180, 120, NSColor(srgbRed: 0.30, green: 0.80, blue: 0.47, alpha: 1)),
        (116, 64, NSColor(srgbRed: 0.98, green: 0.73, blue: 0.24, alpha: 1)),
        (60, 0, NSColor(srgbRed: 0.97, green: 0.38, blue: 0.33, alpha: 1)),
    ]
    ctx.setLineCap(.round)
    ctx.setLineWidth(lineWidth)
    for segment in segments {
        ctx.addArc(center: center, radius: radius, startAngle: segment.from * .pi / 180, endAngle: segment.to * .pi / 180, clockwise: true)
        ctx.setStrokeColor(segment.color.cgColor)
        ctx.strokePath()
    }

    let needleAngle: CGFloat = 52 * .pi / 180
    let tip = CGPoint(x: center.x + cos(needleAngle) * (radius - 70), y: center.y + sin(needleAngle) * (radius - 70))
    ctx.setLineWidth(34)
    ctx.setStrokeColor(NSColor.white.cgColor)
    ctx.move(to: center)
    ctx.addLine(to: tip)
    ctx.strokePath()
    ctx.setFillColor(NSColor.white.cgColor)
    ctx.fillEllipse(in: CGRect(x: center.x - 52, y: center.y - 52, width: 104, height: 104))

    let arrowY: CGFloat = 240
    ctx.setLineWidth(30)
    ctx.setStrokeColor(NSColor.white.withAlphaComponent(0.85).cgColor)
    for (direction, y) in [(1.0, arrowY + 48), (-1.0, arrowY - 48)] as [(CGFloat, CGFloat)] {
        let start = CGPoint(x: 512 - 130 * direction, y: y)
        let end = CGPoint(x: 512 + 130 * direction, y: y)
        ctx.move(to: start)
        ctx.addLine(to: end)
        ctx.move(to: CGPoint(x: end.x - 36 * direction, y: y + 30))
        ctx.addLine(to: end)
        ctx.addLine(to: CGPoint(x: end.x - 36 * direction, y: y - 30))
        ctx.strokePath()
    }
    ctx.restoreGState()
    return true
}

let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
image.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: output))
