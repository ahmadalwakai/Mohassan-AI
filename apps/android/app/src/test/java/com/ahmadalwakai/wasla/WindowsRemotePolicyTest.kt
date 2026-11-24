package com.ahmadalwakai.wasla

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class WindowsRemotePolicyTest {
    private val now = Instant.parse("2026-11-23T22:00:49.016Z")
    private val target = WindowsTarget("a".repeat(64), "window", "Office", 1280, 720)
    private val nonce = "adee0d17-a433-49fc-bf02-33cf0532d02b"
    private val consent = WindowsState(nonce, true, true, true, target, "")
    private val device = WindowsDevice(
        "969573fc-e965-4417-a96c-50cdb87f6c88", "Office PC", false, true, null, consent, null,
    )

    @Test
    fun switchOnRequestsControlFor120SecondsAndOffReplacesItWith30SecondsOfView() {
        assertEquals(
            WindowsGrantRequest("control", 120, target.key, nonce),
            WindowsRemotePolicy.grantRequest(device, control = true),
        )
        assertEquals(
            WindowsGrantRequest("view", 30, target.key, nonce),
            WindowsRemotePolicy.grantRequest(device, control = false),
        )
    }

    @Test
    fun checksEvery15SecondsAndRenewsWhenUnder35SecondsRemain() {
        val grant = grant("control", now.plusSeconds(120))
        val step = WindowsRemotePolicy.GRANT_CHECK_MILLIS / 1_000
        assertEquals(15L, step)
        for (check in 1..5) {
            assertFalse(WindowsRemotePolicy.renewalDue(grant, now.plusSeconds(check * step)))
        }
        assertFalse(WindowsRemotePolicy.renewalDue(grant, now.plusSeconds(85)))
        assertTrue(WindowsRemotePolicy.renewalDue(grant, now.plusSeconds(85).plusMillis(1)))
        assertTrue(WindowsRemotePolicy.renewalDue(grant, now.plusSeconds(6 * step)))
        assertTrue(WindowsRemotePolicy.renewalDue(grant, now.plusSeconds(120)))
    }

    @Test
    fun viewOnlyMissingOrExpiredControlIsReacquiredWhenEnabled() {
        assertTrue(WindowsRemotePolicy.renewalDue(null, now))
        assertTrue(WindowsRemotePolicy.renewalDue(grant("view", now.plusSeconds(30)), now))
        assertTrue(WindowsRemotePolicy.renewalDue(grant("control", now.minusSeconds(1)), now))
        assertEquals(900L, WindowsRemotePolicy.FRAME_POLL_MILLIS)
    }

    @Test
    fun usesLocalConsentAndPrefersThePreviouslySelectedLinkedDevice() {
        val offline = device.copy(online = false)
        val viewOnly = device.copy(state = consent.copy(localControl = false))
        assertNull(WindowsRemotePolicy.grantRequest(offline, control = true))
        assertNull(WindowsRemotePolicy.grantRequest(viewOnly, control = true))
        assertEquals("view", WindowsRemotePolicy.grantRequest(viewOnly, control = false)?.scope)
        assertNull(WindowsRemotePolicy.grantRequest(device.copy(state = consent.copy(safeDesktop = false)), control = false))
        assertEquals(
            WindowsReadiness.NeedsControl,
            WindowsRemotePolicy.readiness(WindowsOverview(true, listOf(viewOnly)), viewOnly),
        )

        val second = device.copy(id = "f6181909-8237-418a-aa54-274c195b00c8", name = "Home PC")
        val overview = WindowsOverview(true, listOf(offline, second, device.copy(revoked = true)))
        assertEquals(second, WindowsRemotePolicy.preferredDevice(overview, null))
        assertEquals(offline, WindowsRemotePolicy.preferredDevice(overview, offline.id))
    }

    @Test
    fun remoteStoreReplacesControlClosesFramePollingAndCallsStop() = runBlocking {
        val root = "/api/windows/devices/${device.id}"
        val requested = mutableListOf<CloudRequest>()
        val renewalStarted = CompletableDeferred<Unit>()
        val allowRenewal = CompletableDeferred<Unit>()
        val completedGrants = mutableListOf<Pair<String, Int>>()
        var currentGrant: WindowsGrant? = null
        val frameId = "8a420fa5-d19b-447c-96d7-322c7a18340e"
        val transport = CloudTransport { request ->
            requested += request
            val body = when (request.path) {
                "/api/windows" -> CloudJson.encode(WindowsOverview(true, listOf(device.copy(grant = currentGrant))))
                "$root/grants" -> {
                    val grantRequest = CloudJson.decode<WindowsGrantRequest>(requireNotNull(request.body))
                    if (grantRequest.scope == "control" && completedGrants.isNotEmpty()) {
                        renewalStarted.complete(Unit)
                        allowRenewal.await()
                    }
                    val grant = grant(grantRequest.scope, Instant.now().plusSeconds(grantRequest.durationSeconds.toLong()))
                    currentGrant = grant
                    completedGrants += grantRequest.scope to grantRequest.durationSeconds
                    CloudJson.encode(grant)
                }
                "$root/frame" -> CloudJson.encode(WindowsFrameReply(
                    WindowsFrame(frameId, target.key, now.toString(), 1, 1, "/9j/2Q=="),
                    requireNotNull(currentGrant),
                ))
                "$root/stop" -> {
                    currentGrant = null
                    """{"ok":true}""".encodeToByteArray()
                }
                else -> error("Unexpected path: ${request.path}")
            }
            CloudResponse(200, body)
        }
        val api = CloudApi(object : SessionVault {
            override fun read() = "better-auth.session_token=0123456789012345"
            override fun save(cookie: String) = Unit
            override fun clear() = Unit
        }, transport)
        api.restore()
        val scope = CoroutineScope(coroutineContext + SupervisorJob())
        try {
            withTimeout(5_000) {
                val store = RemoteControlStore(api, scope)
                store.setForeground(true)
                store.refresh()
                store.state.first { it.readiness == WindowsReadiness.Ready }
                store.setControl(true)
                store.state.first { it.wanted && !it.busy }
                assertFalse(requested.any { it.path == "$root/frame" })

                store.setScreenOpen(true)
                assertEquals(frameId, store.state.first { it.frame != null }.frame?.frameId)
                store.setScreenOpen(false)
                val frameRequests = requested.count { it.path == "$root/frame" }
                delay(WindowsRemotePolicy.FRAME_POLL_MILLIS + 50)
                assertEquals(frameRequests, requested.count { it.path == "$root/frame" })
                assertNull(store.state.value.frame)

                currentGrant = currentGrant?.copy(expiresAt = Instant.now().plusSeconds(15).toString())
                store.setForeground(false)
                store.setForeground(true)
                renewalStarted.await()
                store.setControl(false)
                allowRenewal.complete(Unit)
                store.state.first { !it.wanted && !it.busy }
                assertEquals("view", currentGrant?.scope)
                assertEquals(listOf("control" to 120, "control" to 120, "view" to 30), completedGrants)

                store.stop()
                store.state.first { !it.busy }
                val stop = requested.last { it.path == "$root/stop" }
                assertEquals("POST", stop.method)
                assertNull(currentGrant)
            }
        } finally {
            allowRenewal.complete(Unit)
            scope.cancel()
        }
    }

    private fun grant(scope: String, expiry: Instant) =
        WindowsGrant("829378e0-a07c-4a49-9ee3-bb06cdbda5dd", scope, target.key, nonce, expiry.toString())
}
