import Foundation
import UserNotifications

struct UsageAlert {
    let id: String
    let title: String
    let body: String
    var category: String? = nil
    var userInfo: [String: Any] = [:]
}

enum EventAction {
    static let openAgain = "openAgain"
    static let removeThem = "removeThem"
    static let keep = "keep"
}

struct Tracked {
    let key: String
    let name: String
    let percent: Int?
    let loginDaysLeft: Int?
}

enum AlertRules {
    static let expiryDays = 3

    static func tracked(_ overview: Overview) -> [Tracked] {
        let accounts = overview.accounts.map {
            Tracked(key: "account:\($0.id)", name: $0.alias, percent: $0.percent, loginDaysLeft: $0.loginDaysLeft)
        }
        let profiles = overview.profiles.filter { !$0.registered }.map {
            Tracked(key: "profile:\($0.folder)", name: $0.label, percent: $0.percent, loginDaysLeft: $0.loginDaysLeft)
        }
        return accounts + profiles
    }

    static func switched(from old: Overview, to new: Overview) -> UsageAlert? {
        guard let before = old.accounts.first(where: \.active),
              let after = new.accounts.first(where: \.active),
              before.id != after.id,
              let previous = new.accounts.first(where: { $0.id == before.id })
        else { return nil }
        guard let percent = previous.percent ?? before.percent, percent >= new.threshold else {
            return UsageAlert(id: "switch", title: "Switched to \(after.alias)", body: "The CLI and VS Code now use \(after.alias).")
        }
        return UsageAlert(id: "switch", title: "Switched to \(after.alias)", body: "\(before.alias) reached \(percent)%")
    }

    static func crossedWarning(from old: Overview, to new: Overview) -> [UsageAlert] {
        let before = Dictionary(tracked(old).map { ($0.key, $0.percent) }, uniquingKeysWith: { first, _ in first })
        return tracked(new).compactMap { item in
            guard let now = item.percent, let was = before[item.key] ?? nil, was < new.warnAt, now >= new.warnAt else { return nil }
            return UsageAlert(id: "warn:\(item.key)", title: "Usage is getting high", body: "\(item.name) is at \(now)% of its limit")
        }
    }

    static func expiring(_ overview: Overview) -> [(key: String, alert: UsageAlert)] {
        tracked(overview).compactMap { item in
            guard let days = item.loginDaysLeft, days <= expiryDays else { return nil }
            let when = days <= 0 ? "today" : "in \(days) \(days == 1 ? "day" : "days")"
            let alert = UsageAlert(
                id: "expiry:\(item.key)",
                title: "Sign-in expires \(when)",
                body: "\(item.name) needs a new sign-in. Open Accounts Manager to renew it."
            )
            return (item.key, alert)
        }
    }
}

@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()
    static let enabledKey = "notificationsEnabled"

    static var enabled: Bool {
        UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true
    }

    weak var store: Store?
    private var attached = false

    private var center: UNUserNotificationCenter? {
        Bundle.main.bundleURL.pathExtension == "app" ? UNUserNotificationCenter.current() : nil
    }

    func attach() {
        guard !attached, let center else { return }
        attached = true
        center.delegate = self
        center.setNotificationCategories([
            UNNotificationCategory(
                identifier: "profile_closed",
                actions: [UNNotificationAction(identifier: EventAction.openAgain, title: "Open Again")],
                intentIdentifiers: []
            ),
            UNNotificationCategory(
                identifier: "mcp_unused",
                actions: [
                    UNNotificationAction(identifier: EventAction.removeThem, title: "Remove Them", options: [.destructive]),
                    UNNotificationAction(identifier: EventAction.keep, title: "Keep")
                ],
                intentIdentifiers: []
            )
        ])
    }

    func post(_ alerts: [UsageAlert]) async {
        guard Self.enabled, !alerts.isEmpty, let center else { return }
        attach()
        var status = await center.notificationSettings().authorizationStatus
        if status == .notDetermined {
            _ = try? await center.requestAuthorization(options: [.alert, .sound])
            status = await center.notificationSettings().authorizationStatus
        }
        guard status == .authorized || status == .provisional else { return }
        for alert in alerts {
            let content = UNMutableNotificationContent()
            content.title = alert.title
            content.body = alert.body
            content.sound = .default
            if let category = alert.category { content.categoryIdentifier = category }
            content.userInfo = alert.userInfo
            try? await center.add(UNNotificationRequest(identifier: alert.id, content: content, trigger: nil))
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let action = response.actionIdentifier
        let info = response.notification.request.content.userInfo
        let profile = info["profile"] as? String
        let servers = info["servers"] as? [String] ?? []
        Task { @MainActor in
            switch action {
            case EventAction.openAgain:
                if let profile { await Notifier.shared.store?.open(profileNamed: profile) }
            case EventAction.removeThem:
                await Notifier.shared.store?.removeServers(servers)
            default:
                break
            }
            completionHandler()
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }
}
