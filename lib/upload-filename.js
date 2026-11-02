'use strict';
const MESSAGE = '文件名过长，请缩短文件名后重新上传（建议保留简短名称和扩展名）。';
function fileNameError() { const error = new Error(MESSAGE); error.code = 'FILE_NAME_TOO_LONG'; error.statusCode = 400; return error; }
function validateUploadFilename(name) {
    // Originals are database metadata; disk storage uses a short random basename.
    // Count characters, not UTF-8 bytes, so ordinary Chinese filenames stay valid.
    if ([...String(name || '')].length > 255) throw fileNameError();
}
function isFileNameTooLong(error) { return ['FILE_NAME_TOO_LONG', 'ENAMETOOLONG'].includes(error?.code); }
module.exports = { MESSAGE, fileNameError, validateUploadFilename, isFileNameTooLong };
