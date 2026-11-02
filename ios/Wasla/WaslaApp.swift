import SwiftUI

@main
struct WaslaApp: App {
    @StateObject private var store = WaslaStore()
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .environment(\.layoutDirection, .rightToLeft)
                .tint(Forest.accent)
                .task { await store.start() }
                .onChange(of: scenePhase) { _, phase in store.sceneChanged(active: phase == .active) }
        }
    }
}
