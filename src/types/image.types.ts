// 图片生成请求
export interface ImageGenerationRequest {
  model: string;
  prompt: string;
  size?: '512x512' | '768x768' | '1024x1024' | '1536x1536' | '2K';
  sequential_image_generation?: 'enabled' | 'disabled';
  stream?: boolean;
  response_format?: 'url' | 'b64_json';
  watermark?: boolean;
}

// 图片生成响应
export interface ImageGenerationResponse {
  model: string;
  created: number;
  data: Array<{
    url: string;
    size?: string;
    b64_json?: string;
  }>;
  usage?: {
    generated_images: number;
    output_tokens: number;
    total_tokens: number;
  };
}

// 图片尺寸配置
export type ImageSize = '512x512' | '768x768' | '1024x1024' | '1536x1536' | '2K';

export const IMAGE_SIZES = {
  SMALL: '512x512' as ImageSize,
  MEDIUM: '768x768' as ImageSize,
  LARGE: '1024x1024' as ImageSize,
  XLARGE: '1536x1536' as ImageSize,
  HD_2K: '2K' as ImageSize
};

