/**
 * 图片取词的上传前压缩：长边压到 1600px、转 JPEG——截图取词不需要原图
 * 精度，压完的 base64 通常远小于 1MB，省 token 也快。纯浏览器 API
 * （createImageBitmap + canvas），不进 node 测试。
 */

const MAX_EDGE = 1600
const JPEG_QUALITY = 0.85

export async function compressImageToDataUri(blob: Blob): Promise<string> {
  const bitmap = await createImageBitmap(blob)
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('IMAGE_COMPRESS_NO_CANVAS')
    // JPEG 没有透明通道：透明底的 PNG 截图直接画会变黑底，先铺白
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)
    context.drawImage(bitmap, 0, 0, width, height)
    return canvas.toDataURL('image/jpeg', JPEG_QUALITY)
  } finally {
    bitmap.close()
  }
}
