import dotenv from 'dotenv';

// 加载环境变量
dotenv.config();

/**
 * 应用配置
 * 所有配置从环境变量读取
 */
export const config = {
  // 豆包大模型配置（文本生成）
  doubao: {
    apiUrl: process.env.DOUBAO_API_URL || 'https://ark.cn-beijing.volces.com/api/v3/responses',
    apiKey: process.env.DOUBAO_API_KEY || '',
    textModelId: process.env.DOUBAO_TEXT_MODEL_ID || 'doubao-seed-1.6-flash',
    timeout: parseInt(process.env.DOUBAO_TIMEOUT || '300000') // 默认5分钟
  },
  
  // 图片生成配置
  image: {
    apiUrl: process.env.IMAGE_API_URL || 'https://ark.cn-beijing.volces.com/api/v3/images/generations',
    apiKey: process.env.IMAGE_API_KEY || process.env.DOUBAO_API_KEY || '',
    modelId: process.env.IMAGE_MODEL_ID || 'doubao-seedream-4.0',
    timeout: parseInt(process.env.IMAGE_TIMEOUT || '60000'), // 默认60秒
    defaultSize: process.env.IMAGE_DEFAULT_SIZE || '1024x1024'
  },
  
  // TTS 语音合成配置
  tts: {
    wsEndpoint: process.env.TTS_WS_ENDPOINT || 'wss://openspeech.bytedance.com/api/v3/tts/unidirectional/stream',
    appId: process.env.TTS_APP_ID || '',
    accessToken: process.env.TTS_ACCESS_TOKEN || '',
    timeout: parseInt(process.env.TTS_TIMEOUT || '60000'), // 默认60秒
    format: (process.env.TTS_FORMAT || 'mp3') as 'mp3' | 'ogg_opus' | 'pcm' | 'wav',
    sampleRate: parseInt(process.env.TTS_SAMPLE_RATE || '24000') as 8000 | 16000 | 22050 | 24000 | 32000 | 44100 | 48000
  }
};

