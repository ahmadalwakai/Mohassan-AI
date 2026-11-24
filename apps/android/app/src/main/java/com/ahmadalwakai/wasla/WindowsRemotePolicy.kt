package com.ahmadalwakai.wasla

import java.time.Instant

internal object WindowsRemotePolicy {
    const val GRANT_CHECK_MILLIS = 15_000L
    const val FRAME_POLL_MILLIS = 900L
    private const val CONTROL_SECONDS = 120
    private const val VIEW_SECONDS = 30
    private const val RENEW_UNDER_SECONDS = 35L

    fun grantRequest(device: WindowsDevice, control: Boolean): WindowsGrantRequest? {
        val state = device.state ?: return null
        val target = state.target ?: return null
        if (device.revoked || !device.online || !state.safeDesktop || !state.localView) return null
        if (control && !state.localControl) return null
        return WindowsGrantRequest(
            scope = if (control) "control" else "view",
            durationSeconds = if (control) CONTROL_SECONDS else VIEW_SECONDS,
            targetKey = target.key,
            approvalNonce = state.approvalNonce,
        )
    }

    fun renewalDue(grant: WindowsGrant?, now: Instant): Boolean =
        grant?.takeIf { it.controls }?.expiry?.isBefore(now.plusSeconds(RENEW_UNDER_SECONDS)) ?: true

    fun preferredDevice(overview: WindowsOverview, preferred: String?): WindowsDevice? {
        val linked = overview.devices.filterNot { it.revoked }
        return linked.firstOrNull { it.id == preferred } ?: linked.firstOrNull { it.online } ?: linked.firstOrNull()
    }

    fun readiness(overview: WindowsOverview, device: WindowsDevice?): WindowsReadiness {
        val state = device?.state
        return when {
            !overview.enabled -> WindowsReadiness.Disabled
            device == null -> WindowsReadiness.NoDevice
            !device.online -> WindowsReadiness.Offline
            state?.safeDesktop != true -> WindowsReadiness.Unsafe
            !state.localView || state.target == null -> WindowsReadiness.NeedsView
            !state.localControl -> WindowsReadiness.NeedsControl
            device.grant?.controls == true -> WindowsReadiness.Active
            else -> WindowsReadiness.Ready
        }
    }
}

internal enum class WindowsReadiness {
    Disabled, NoDevice, Offline, Unsafe, NeedsView, NeedsControl, Ready, Active;

    val canTurnOn: Boolean get() = this == Ready || this == Active
}
