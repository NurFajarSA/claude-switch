// Prints the window number of the largest on-screen window owned by the given process id,
// skipping the menu bar layer so the status item is never picked.
import CoreGraphics
import Foundation

let pid = Int32(CommandLine.arguments[1])!
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
let mine = windows.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int ?? 99) < 20 }
let area = { (w: [String: Any]) -> Double in
    let b = w[kCGWindowBounds as String] as? [String: Double] ?? [:]
    return (b["Width"] ?? 0) * (b["Height"] ?? 0)
}
if let best = mine.max(by: { area($0) < area($1) }), let number = best[kCGWindowNumber as String] as? Int { print(number) } else { exit(1) }
