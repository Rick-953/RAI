package sarl.rick.rai.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sarl.rick.rai.model.ChatStreamEvent

class SseEventParserTest {
    @Test
    fun parsesIncrementalContentAndReasoning() {
        assertEquals(ChatStreamEvent.Content("你好"), SseEventParser.parse("""{"type":"content","content":"你好"}"""))
        assertEquals(ChatStreamEvent.Reasoning("分析"), SseEventParser.parse("""{"type":"reasoning","content":"分析"}"""))
    }

    @Test
    fun parsesSourceContract() {
        val event = SseEventParser.parse(
            """{"type":"sources","sources":[{"title":"Material","url":"https://m3.material.io"}]}"""
        )
        assertTrue(event is ChatStreamEvent.Sources)
        assertEquals("https://m3.material.io", (event as ChatStreamEvent.Sources).sources.single().url)
    }

    @Test
    fun ignoresMalformedAndUnknownEvents() {
        assertNull(SseEventParser.parse("not-json"))
        assertNull(SseEventParser.parse("""{"type":"search_status"}"""))
    }
}
