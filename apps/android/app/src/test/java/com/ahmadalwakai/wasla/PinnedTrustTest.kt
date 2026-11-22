package com.ahmadalwakai.wasla

import kotlinx.serialization.decodeFromString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate

/** Against certificates made by the Wasla service's own library (Tools/make_test_certs.py). */
class PinnedTrustTest {
    private val fingerprints: Map<String, String> = WaslaJson.decodeFromString(resource("fingerprints.json").decodeToString())

    private fun resource(name: String): ByteArray = javaClass.classLoader!!.getResourceAsStream(name)!!.use { it.readBytes() }

    private fun certificate(name: String): X509Certificate =
        CertificateFactory.getInstance("X.509").generateCertificate(resource("$name.pem").inputStream()) as X509Certificate

    private fun check(host: String, pin: String, name: String) = PinnedTrustManager(host, pin).checkServerTrusted(arrayOf(certificate(name)), "ECDHE_ECDSA")

    private fun refused(host: String, pin: String, name: String) {
        try { check(host, pin, name); fail("accepted $name for $host") } catch (ignored: CertificateException) {}
    }

    @Test
    fun fingerprintMatchesTheComputersOwnLibrary() {
        assertEquals(fingerprints.getValue("server-valid"), PinnedTrustManager.sha256Hex(certificate("server-valid").encoded))
    }

    @Test
    fun thePinnedCertificateIsAcceptedForItsNames() {
        val pin = fingerprints.getValue("server-valid")
        check("10.0.2.2", pin, "server-valid")
        check("127.0.0.1", pin, "server-valid")
        check("100.72.126.108", pin, "server-valid")
        check("localhost", pin, "server-valid")
        check("DESK-PC", pin, "server-valid")
        check("[::ffff:7f00:1]", pin, "server-valid")
    }

    @Test
    fun anotherCertificateIsRefusedEvenWithTheRightNames() {
        refused("10.0.2.2", fingerprints.getValue("server-other-host"), "server-valid")
        refused("10.0.2.2", "0".repeat(64), "server-valid")
    }

    @Test
    fun anExpiredCertificateIsRefused() {
        refused("10.0.2.2", fingerprints.getValue("server-expired"), "server-expired")
    }

    @Test
    fun aHostTheCertificateDoesNotNameIsRefused() {
        refused("10.0.2.3", fingerprints.getValue("server-valid"), "server-valid")
        refused("10.0.2.2", fingerprints.getValue("server-other-host"), "server-other-host")
        refused("desk-pc.local", fingerprints.getValue("server-valid"), "server-valid")
        check("192.168.9.9", fingerprints.getValue("server-other-host"), "server-other-host")
    }

    @Test
    fun anEmptyChainIsRefused() {
        try { PinnedTrustManager("10.0.2.2", fingerprints.getValue("server-valid")).checkServerTrusted(emptyArray(), "ECDHE_ECDSA"); fail("accepted nothing") } catch (ignored: CertificateException) {}
        try { PinnedTrustManager("10.0.2.2", fingerprints.getValue("server-valid")).checkClientTrusted(arrayOf(certificate("server-valid")), "RSA"); fail("accepted a client") } catch (ignored: CertificateException) {}
    }

    @Test
    fun hostMatchingNeverResolvesNames() {
        val valid = certificate("server-valid")
        assertTrue(PinnedTrustManager.hostMatches(valid, "desk-pc"))
        assertFalse(PinnedTrustManager.hostMatches(valid, "desk-pc.example.com"))
        assertFalse(PinnedTrustManager.hostMatches(valid, "example.com"))
        assertFalse(PinnedTrustManager.hostMatches(valid, "10.0.2.22"))
    }
}
