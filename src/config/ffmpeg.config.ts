/**
 * FFmpeg 配置
 * 如果 ffmpeg 不在系统 PATH 中，可以在这里手动设置路径
 */

import ffmpeg from 'fluent-ffmpeg';
import * as fs from 'fs';

/**
 * 初始化 ffmpeg 配置
 * 如果设置了 FFMPEG_PATH 环境变量，将使用该路径
 */
export function initializeFfmpeg(): void {
  const ffmpegPath = process.env.FFMPEG_PATH;
  
  if (ffmpegPath) {
    if (fs.existsSync(ffmpegPath)) {
      console.log(`🎥 使用自定义 ffmpeg 路径: ${ffmpegPath}`);
      ffmpeg.setFfmpegPath(ffmpegPath);
    } else {
      console.warn(`⚠️  FFMPEG_PATH 设置的路径不存在: ${ffmpegPath}`);
      console.warn(`   将使用系统默认 ffmpeg`);
    }
  }
  
  // 同样处理 ffprobe
  const ffprobePath = process.env.FFPROBE_PATH;
  if (ffprobePath && fs.existsSync(ffprobePath)) {
    console.log(`🎥 使用自定义 ffprobe 路径: ${ffprobePath}`);
    ffmpeg.setFfprobePath(ffprobePath);
  }
}

/**
 * 检查 ffmpeg 是否可用
 */
export async function checkFfmpegAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    ffmpeg.getAvailableFormats((err, formats) => {
      if (err) {
        console.error('❌ ffmpeg 不可用:', err.message);
        console.error('   请安装 ffmpeg 或设置 FFMPEG_PATH 环境变量');
        resolve(false);
      } else {
        console.log('✅ ffmpeg 可用');
        resolve(true);
      }
    });
  });
}



