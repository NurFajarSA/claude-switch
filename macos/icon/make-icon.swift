import AppKit

let size: CGFloat = 1024
let output = CommandLine.arguments.dropFirst().first ?? "icon-1024.png"

func color(_ hex: UInt32) -> CGColor {
    NSColor(
        srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
        green: CGFloat((hex >> 8) & 0xFF) / 255,
        blue: CGFloat(hex & 0xFF) / 255,
        alpha: 1
    ).cgColor
}

let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { _ in
    guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
    let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
    let squircle = CGPath(roundedRect: tile, cornerWidth: 185, cornerHeight: 185, transform: nil)

    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: 24, color: NSColor.black.withAlphaComponent(0.28).cgColor)
    ctx.addPath(squircle)
    ctx.setFillColor(color(0xC9643F))
    ctx.fillPath()
    ctx.restoreGState()

    ctx.saveGState()
    ctx.addPath(squircle)
    ctx.clip()
    let background = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [color(0xE08B69), color(0xC8603C)] as CFArray, locations: [0, 1])!
    ctx.drawLinearGradient(background, start: CGPoint(x: 512, y: 924), end: CGPoint(x: 512, y: 100), options: [])

    let radius: CGFloat = 170
    let lineWidth: CGFloat = 64
    let left = CGPoint(x: 512 - 105, y: 512)
    let right = CGPoint(x: 512 + 105, y: 512)

    ctx.setLineWidth(lineWidth)
    ctx.setStrokeColor(NSColor.white.withAlphaComponent(0.5).cgColor)
    ctx.strokeEllipse(in: CGRect(x: right.x - radius, y: right.y - radius, width: radius * 2, height: radius * 2))
    ctx.setStrokeColor(NSColor.white.cgColor)
    ctx.strokeEllipse(in: CGRect(x: left.x - radius, y: left.y - radius, width: radius * 2, height: radius * 2))
    ctx.restoreGState()
    return true
}

let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
image.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: output))
