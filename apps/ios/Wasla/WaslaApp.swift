import SwiftUI

enum AppAppearance: String, CaseIterable, Identifiable {
    case dark, light, system

    static let storageKey = "wasla.appearance"
    var id: Self { self }

    var title: String {
        switch self {
        case .dark: return "داكن"
        case .light: return "فاتح"
        case .system: return "حسب الجهاز"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .dark: return .dark
        case .light: return .light
        case .system: return nil
        }
    }
}

@main
struct WaslaApp: App {
    @StateObject private var store = WaslaStore()
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage(AppAppearance.storageKey) private var appearance: AppAppearance = .dark

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .environment(\.layoutDirection, .rightToLeft)
                .font(Forest.font())
                .foregroundStyle(Forest.ink)
                .tint(Forest.accent)
                .preferredColorScheme(appearance.colorScheme)
                .task { await store.start() }
                .onChange(of: scenePhase) { _, phase in store.sceneChanged(active: phase == .active) }
        }
    }
}
