const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

/**
 * 文本提取工具类
 * 支持从 txt、pdf、docx 文件中提取文本并分段
 */
class TextExtractor {
    /**
     * 从文件中提取文本
     * @param {string} filePath - 文件路径
     * @param {string} fileType - 文件类型 (txt, pdf, docx)
     * @returns {Promise<string>} 提取的文本内容
     */
    static async extractText(filePath, fileType) {
        try {
            switch (fileType.toLowerCase()) {
                case 'txt':
                case 'text/plain':
                    return await this.extractFromTxt(filePath);
                case 'pdf':
                case 'application/pdf':
                    return await this.extractFromPdf(filePath);
                case 'docx':
                case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
                    return await this.extractFromDocx(filePath);
                default:
                    throw new Error(`不支持的文件类型: ${fileType}`);
            }
        } catch (error) {
            console.error(' 文本提取失败:', error);
            throw error;
        }
    }

    /**
     * 从 TXT 文件提取文本
     */
    static async extractFromTxt(filePath) {
        return fs.promises.readFile(filePath, 'utf-8');
    }

    /**
     * 从 PDF 文件提取文本
     */
    static async extractFromPdf(filePath) {
        const dataBuffer = await fs.promises.readFile(filePath);
        const data = await pdfParse(dataBuffer);
        return data.text;
    }

    /**
     * 从 DOCX 文件提取文本
     */
    static async extractFromDocx(filePath) {
        const result = await mammoth.extractRawText({ path: filePath });
        return result.value;
    }

    /**
     * 将文本分段
     * @param {string} text - 原始文本
     * @param {number} segmentSize - 每段字符数 (默认 500)
     * @param {number} overlap - 段落重叠字符数 (默认 50)
     * @returns {Array<{index: number, content: string, charCount: number}>}
     */
    static segmentText(text, segmentSize = 500, overlap = 50) {
        if (!text || text.trim().length === 0) {
            return [];
        }

        const segments = [];
        let index = 0;
        let start = 0;

        while (start < text.length) {
            const end = Math.min(start + segmentSize, text.length);
            const content = text.substring(start, end).trim();

            if (content.length > 0) {
                segments.push({
                    index: index,
                    content: content,
                    charCount: content.length
                });
                index++;
            }

            // 移动到下一段，考虑重叠
            start = end - overlap;
            if (start >= text.length) break;
        }

        return segments;
    }

    /**
     * 提取并分段文件
     * @param {string} filePath - 文件路径
     * @param {string} fileType - 文件类型
     * @param {number} segmentSize - 分段大小
     * @param {number} overlap - 重叠大小
     * @returns {Promise<Array>} 分段数组
     */
    static async extractAndSegment(filePath, fileType, segmentSize = 500, overlap = 50) {
        const text = await this.extractText(filePath, fileType);
        return this.segmentText(text, segmentSize, overlap);
    }
}

module.exports = TextExtractor;

