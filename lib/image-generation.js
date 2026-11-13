'use strict';

const sharp = require('sharp');

const IMAGE_MODEL_COSTS = Object.freeze({
    'gpt-image-2.5': 100,
    'gpt-image-2.5-flare': 200,
    'gpt-image-2.5-sunburst': 300,
    'gpt-image-2.6': 100,
    'gpt-image-2.6-flare': 200,
    'gpt-image-2.6-sunburst': 300
});
const IMAGE_GENERATION_SIZES = Object.freeze([
    '512x512', '768x768', '1024x1024', '1024x768', '768x1024', '1024x640', '640x1024',
    '2048x2048', '2048x1152', '1152x2048'
]);
const MAX_REFERENCE_IMAGES = 9;
const REFERENCE_IMAGE_FILE_ID_PATTERN = /^\d{10,17}-[a-f0-9]{12}\.[a-z0-9]{1,10}$/i;

function inferImageGenerationSize(prompt = '') {
    const text = String(prompt);
    const explicit = text.match(/\b(\d{3,5})\s*[x×]\s*(\d{3,5})\b/i);
    if (explicit) {
        const size = `${explicit[1]}x${explicit[2]}`;
        if (!IMAGE_GENERATION_SIZES.includes(size)) throw new Error('image_size_must_be_a_supported_1k_or_2k_size');
        return size;
    }
    const twoK = /(?:^|[^0-9])2\s*k\b/i.test(text);
    if (/16\s*[:：]\s*9|横(?:版|向)|landscape/i.test(text)) return twoK ? '2048x1152' : '1024x640';
    if (/9\s*[:：]\s*16|竖(?:版|向)|portrait/i.test(text)) return twoK ? '1152x2048' : '640x1024';
    return twoK ? '2048x2048' : '1024x1024';
}

function normalizeReferenceImageFileIds(value) {
    if (value === undefined || value === null || value === '') return [];
    if (!Array.isArray(value)) throw new Error('reference_image_file_ids_must_be_an_array');
    if (value.length > MAX_REFERENCE_IMAGES) throw new Error('too_many_reference_images');
    const ids = [...new Set(value.map((item) => String(item || '').trim()))];
    if (ids.some((id) => !REFERENCE_IMAGE_FILE_ID_PATTERN.test(id))) {
        throw new Error('invalid_reference_image_file_id');
    }
    return ids;
}

function normalizeImageGenerationArgs(args = {}) {
    const prompt = String(args.prompt || args.description || '').trim().slice(0, 2000);
    if (!prompt) throw new Error('image_prompt_missing');
    const requestedModel = String(args.model || 'gpt-image-2.6').trim();
    // Released clients may still send the two retired image IDs.
    const model = ['auto', 'gpt-image-2', 'kolors-free'].includes(requestedModel) ? 'gpt-image-2.6' : requestedModel;
    if (!Object.hasOwn(IMAGE_MODEL_COSTS, model)) throw new Error('unsupported_image_model');
    const image_size = String(args.image_size || args.size || '1024x1024').trim();
    if (!IMAGE_GENERATION_SIZES.includes(image_size)) throw new Error('image_size_must_be_a_supported_1k_or_2k_size');
    if (args.batch_size !== undefined && Number(args.batch_size) !== 1) throw new Error('one_image_per_call');
    const name = String(args.name || prompt).replace(/[\x00-\x1f\x7f<>:"/\\|?*\[\]`]/g, '').trim().slice(0, 60) || 'generated-image';
    return {
        prompt,
        model,
        name,
        image_size,
        batch_size: 1,
        reference_image_file_ids: normalizeReferenceImageFileIds(args.reference_image_file_ids)
    };
}

function buildImageGenerationRequest(args) {
    const [width, height] = args.image_size.split('x').map(Number);
    return {
        model: args.model,
        prompt: args.prompt,
        // GPT Image requires at least 655,360 pixels; smaller square deliveries
        // are generated at 1K and reduced before they enter the image store.
        size: width * height < 655360 ? '1024x1024' : args.image_size,
        n: 1,
        quality: 'medium',
        output_format: 'png'
    };
}

async function prepareGeneratedImage(buffer, size = '1024x1024') {
    if (!IMAGE_GENERATION_SIZES.includes(size)) throw new Error('invalid_generated_image_size');
    const [width, height] = size.split('x').map(Number);
    // Keep the stored image within the requested 1K/2K bounds even when the
    // configured gateway returns a slightly different raster size.
    const result = await sharp(buffer, { limitInputPixels: 32 * 1024 * 1024, animated: false })
        .rotate().resize({ width, height, fit: 'inside', withoutEnlargement: true })
        .png().toBuffer({ resolveWithObject: true });
    if (result.info.width > width || result.info.height > height) throw new Error('generated_image_exceeds_requested_size');
    return { buffer: result.data, width: result.info.width, height: result.info.height };
}

module.exports = {
    IMAGE_MODEL_COSTS,
    IMAGE_GENERATION_SIZES,
    MAX_REFERENCE_IMAGES,
    inferImageGenerationSize,
    normalizeImageGenerationArgs,
    normalizeReferenceImageFileIds,
    buildImageGenerationRequest,
    prepareGeneratedImage
};
