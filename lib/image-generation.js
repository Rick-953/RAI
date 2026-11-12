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
    '512x512', '768x768', '1024x1024', '1024x768', '768x1024', '1024x640', '640x1024'
]);

function normalizeImageGenerationArgs(args = {}) {
    const prompt = String(args.prompt || args.description || '').trim().slice(0, 2000);
    if (!prompt) throw new Error('图片生成缺少 prompt');
    const requestedModel = String(args.model || 'gpt-image-2.6').trim();
    // Released clients may still send the two retired image IDs.
    const model = ['auto', 'gpt-image-2', 'kolors-free'].includes(requestedModel) ? 'gpt-image-2.6' : requestedModel;
    if (!Object.hasOwn(IMAGE_MODEL_COSTS, model)) throw new Error('不支持的图片模型');
    const image_size = String(args.image_size || args.size || '1024x1024').trim();
    if (!IMAGE_GENERATION_SIZES.includes(image_size)) throw new Error('图片尺寸仅支持 1K（最长边 1024）及以下');
    if (args.batch_size !== undefined && Number(args.batch_size) !== 1) throw new Error('每次生成一张图片，请逐张调用');
    const name = String(args.name || prompt).replace(/[\x00-\x1f\x7f<>:"/\\|?*\[\]`]/g, '').trim().slice(0, 60) || '生成图片';
    return { prompt, model, name, image_size, batch_size: 1 };
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
    // The configured gateway returned 1254px even for an explicit 1024px request.
    // Enforce the delivery limit on decoded bytes as well as on upstream arguments.
    const result = await sharp(buffer, { limitInputPixels: 32 * 1024 * 1024, animated: false })
        .rotate().resize({ width, height, fit: 'inside', withoutEnlargement: true })
        .png().toBuffer({ resolveWithObject: true });
    if (result.info.width > 1024 || result.info.height > 1024) throw new Error('generated_image_exceeds_1k');
    return { buffer: result.data, width: result.info.width, height: result.info.height };
}

module.exports = { IMAGE_MODEL_COSTS, IMAGE_GENERATION_SIZES, normalizeImageGenerationArgs, buildImageGenerationRequest, prepareGeneratedImage };
