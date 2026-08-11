package sarl.rick.rai.model

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RaiModelsTest {
    @Test
    fun parsesStoredMessageAndLazyAttachmentMarker() {
        val message = JSONObject(
            """{"id":12,"session_id":"s1","role":"assistant","content":"answer","reasoning_content":"why","has_attachments":1,"sources":"[{\"title\":\"Docs\",\"url\":\"https://example.test\"}]"}"""
        ).toChatMessage()
        assertEquals(12L, message.id)
        assertEquals("why", message.reasoning)
        assertTrue(message.hasAttachments)
        assertEquals("https://example.test", message.sources.single().url)
    }

    @Test
    fun uploadAttachmentCarriesCanonicalCompatibilityFields() {
        val json = Attachment("stored.png", "photo.png", "/api/uploads/stored.png", "image/png", 42).toJson()
        assertEquals("image", json.getString("type"))
        assertEquals("photo.png", json.getString("fileName"))
        assertEquals("stored.png", json.getString("filename"))
    }
}
