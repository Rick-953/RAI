package sarl.rick.rai.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerUrlTest {
    @Test
    fun normalizesWebsiteInputToHttpsOrigin() {
        assertEquals("https://rai.rick.sarl", ServerUrl.normalize("rai.rick.sarl/settings").getOrThrow())
    }

    @Test
    fun keepsExplicitNonDefaultPort() {
        assertEquals("https://example.test:8443", ServerUrl.normalize("https://example.test:8443/").getOrThrow())
    }

    @Test
    fun rejectsRemoteCleartextAndEmbeddedCredentials() {
        assertTrue(ServerUrl.normalize("http://example.test").isFailure)
        assertTrue(ServerUrl.normalize("https://user:password@example.test").isFailure)
    }

    @Test
    fun allowsEmulatorLoopbackForDevelopment() {
        assertEquals("http://10.0.2.2:3009", ServerUrl.normalize("http://10.0.2.2:3009").getOrThrow())
    }
}
