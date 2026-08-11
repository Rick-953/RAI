package sarl.rick.rai.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp

private sealed interface MarkdownBlock {
    data class Paragraph(val text: String) : MarkdownBlock
    data class Heading(val level: Int, val text: String) : MarkdownBlock
    data class Bullet(val text: String) : MarkdownBlock
    data class Quote(val text: String) : MarkdownBlock
    data class Code(val language: String, val text: String) : MarkdownBlock
}

@Composable
fun MarkdownText(text: String, modifier: Modifier = Modifier) {
    val blocks = parseMarkdownBlocks(text)
    SelectionContainer(modifier) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            blocks.forEach { block ->
                when (block) {
                    is MarkdownBlock.Heading -> Text(
                        text = inlineMarkdown(block.text),
                        style = when (block.level) {
                            1 -> MaterialTheme.typography.headlineSmall
                            2 -> MaterialTheme.typography.titleLarge
                            else -> MaterialTheme.typography.titleMedium
                        },
                        modifier = Modifier.fillMaxWidth().padding(top = 4.dp)
                    )
                    is MarkdownBlock.Bullet -> Row(Modifier.fillMaxWidth()) {
                        Text("•", modifier = Modifier.padding(end = 8.dp), style = MaterialTheme.typography.bodyLarge)
                        Text(inlineMarkdown(block.text), modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
                    }
                    is MarkdownBlock.Quote -> Text(
                        text = inlineMarkdown(block.text),
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSecondaryContainer,
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(MaterialTheme.colorScheme.secondaryContainer, RoundedCornerShape(8.dp))
                            .padding(horizontal = 14.dp, vertical = 10.dp)
                    )
                    is MarkdownBlock.Code -> Column(
                        Modifier
                            .fillMaxWidth()
                            .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(8.dp))
                            .padding(12.dp)
                    ) {
                        if (block.language.isNotBlank()) {
                            Text(
                                block.language,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(bottom = 6.dp)
                            )
                        }
                        Text(
                            block.text,
                            fontFamily = FontFamily.Monospace,
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.horizontalScroll(rememberScrollState())
                        )
                    }
                    is MarkdownBlock.Paragraph -> Text(
                        text = inlineMarkdown(block.text),
                        style = MaterialTheme.typography.bodyLarge,
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            }
        }
    }
}

@Composable
private fun inlineMarkdown(value: String): AnnotatedString {
    val primary = MaterialTheme.colorScheme.primary
    val codeBackground = MaterialTheme.colorScheme.surfaceVariant
    val codeForeground = MaterialTheme.colorScheme.onSurfaceVariant
    return buildAnnotatedString {
        var cursor = 0
        InlinePattern.findAll(value).forEach { match ->
            if (match.range.first > cursor) append(value.substring(cursor, match.range.first))
            val token = match.value
            when {
                token.startsWith("**") -> {
                    val start = length
                    append(token.removePrefix("**").removeSuffix("**"))
                    addStyle(SpanStyle(fontWeight = FontWeight.Bold), start, length)
                }
                token.startsWith('`') -> {
                    val start = length
                    append(token.removePrefix("`").removeSuffix("`"))
                    addStyle(
                        SpanStyle(fontFamily = FontFamily.Monospace, background = codeBackground, color = codeForeground),
                        start,
                        length
                    )
                }
                token.startsWith('[') -> {
                    val closeLabel = token.indexOf("](")
                    val label = token.substring(1, closeLabel)
                    val url = token.substring(closeLabel + 2, token.length - 1)
                    val start = length
                    append(label)
                    addLink(
                        LinkAnnotation.Url(
                            url = url,
                            styles = TextLinkStyles(
                                style = SpanStyle(color = primary, textDecoration = TextDecoration.Underline)
                            )
                        ),
                        start,
                        length
                    )
                }
            }
            cursor = match.range.last + 1
        }
        if (cursor < value.length) append(value.substring(cursor))
    }
}

private fun parseMarkdownBlocks(markdown: String): List<MarkdownBlock> {
    val lines = markdown.replace("\r\n", "\n").split('\n')
    val result = mutableListOf<MarkdownBlock>()
    val paragraph = mutableListOf<String>()
    var codeLanguage: String? = null
    val codeLines = mutableListOf<String>()

    fun flushParagraph() {
        if (paragraph.isNotEmpty()) {
            result += MarkdownBlock.Paragraph(paragraph.joinToString("\n"))
            paragraph.clear()
        }
    }

    lines.forEach { line ->
        if (codeLanguage != null) {
            if (line.trimStart().startsWith("```")) {
                result += MarkdownBlock.Code(codeLanguage.orEmpty(), codeLines.joinToString("\n"))
                codeLanguage = null
                codeLines.clear()
            } else {
                codeLines += line
            }
            return@forEach
        }
        when {
            line.trimStart().startsWith("```") -> {
                flushParagraph()
                codeLanguage = line.trim().removePrefix("```").trim()
            }
            line.isBlank() -> flushParagraph()
            HeadingPattern.matches(line) -> {
                flushParagraph()
                val marker = line.takeWhile { it == '#' }
                result += MarkdownBlock.Heading(marker.length.coerceAtMost(3), line.drop(marker.length).trim())
            }
            BulletPattern.containsMatchIn(line) -> {
                flushParagraph()
                result += MarkdownBlock.Bullet(line.trimStart().drop(2).trim())
            }
            line.trimStart().startsWith("> ") -> {
                flushParagraph()
                result += MarkdownBlock.Quote(line.trimStart().drop(2))
            }
            else -> paragraph += line
        }
    }
    if (codeLanguage != null) result += MarkdownBlock.Code(codeLanguage.orEmpty(), codeLines.joinToString("\n"))
    flushParagraph()
    return result.ifEmpty { listOf(MarkdownBlock.Paragraph("")) }
}

private val InlinePattern = Regex("""\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^]\n]+]\(https?://[^)\s]+\)""")
private val HeadingPattern = Regex("""^#{1,3}\s+.+$""")
private val BulletPattern = Regex("""^\s*[-*]\s+""")
