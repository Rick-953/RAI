'use strict';

function sniffRasterImageBuffer(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
        return { contentType: 'image/png', ext: 'png' };
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return { contentType: 'image/jpeg', ext: 'jpg' };
    }
    const header6 = buffer.subarray(0, 6).toString('ascii');
    if (header6 === 'GIF87a' || header6 === 'GIF89a') {
        return { contentType: 'image/gif', ext: 'gif' };
    }
    if (
        buffer.length >= 12
        && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
        && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    ) {
        return { contentType: 'image/webp', ext: 'webp' };
    }
    return null;
}

function validateGeneratedImageBuffer(buffer, declaredContentType = '') {
    const sniffed = sniffRasterImageBuffer(buffer);
    if (!sniffed) throw new Error('generated_image_unrecognized_bytes');

    const declared = String(declaredContentType || '').split(';')[0].trim().toLowerCase();
    const normalizedDeclared = declared === 'image/jpg' ? 'image/jpeg' : declared;
    const isGenericBinary = normalizedDeclared === 'application/octet-stream';
    if (normalizedDeclared && !isGenericBinary && normalizedDeclared !== sniffed.contentType) {
        throw new Error('generated_image_content_type_mismatch');
    }
    return sniffed;
}

module.exports = {
    sniffRasterImageBuffer,
    validateGeneratedImageBuffer
};
