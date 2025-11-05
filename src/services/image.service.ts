import axios from 'axios';
import { config } from '../config/config';
import { ModelConfigService } from './model-config.service';
import { ImageGenerationRequest, ImageGenerationResponse, IMAGE_SIZES } from '../types/image.types';
import * as fs from 'fs';
import * as path from 'path';

export class ImageService {
  private static readonly API_URL = config.image.apiUrl;
  private static readonly API_KEY = config.image.apiKey;
  private static readonly IMAGE_MODEL_ID = config.image.modelId;
  private static readonly DEFAULT_SIZE = IMAGE_SIZES.LARGE; // 1024x1024

  /**
   * 生成图片
   */
  static async generateImage(
    prompt: string, 
    size?: string,
    options?: {
      watermark?: boolean;
      stream?: boolean;
    }
  ): Promise<string> {
    const startTime = Date.now();
    let requestBody: any = null;
    
    try {
      // 获取模型配置
      const modelConfig = ModelConfigService.getImageModelById(this.IMAGE_MODEL_ID);
      if (!modelConfig) {
        throw new Error(`图片模型配置不存在: ${this.IMAGE_MODEL_ID}`);
      }

      console.log('调用图片生成API...');
      console.log('模型:', modelConfig.name);
      console.log('提示词:', prompt);
      console.log('尺寸:', size || this.DEFAULT_SIZE);

      requestBody = {
        model: modelConfig.endpoint, // 使用配置中的endpoint
        prompt,
        size: (size || this.DEFAULT_SIZE) as any,
        sequential_image_generation: 'disabled',
        stream: options?.stream ?? false,
        response_format: 'url',
        watermark: options?.watermark ?? true
      };

      // 处理 API Key（去除可能存在的 Bearer 前缀）
      const apiKey = this.API_KEY.replace(/^Bearer\s+/i, '').trim();

      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      };

      const response = await axios.post<ImageGenerationResponse>(
        this.API_URL,
        requestBody,
        {
          headers,
          timeout: config.image.timeout
        }
      );

      const responseTime = Date.now() - startTime;

      const imageUrl = response.data.data[0]?.url;
      const imageSize = response.data.data[0]?.size;
      
      if (!imageUrl) {
        throw new Error('图片生成失败：未返回图片URL');
      }

      // 计算费用
      const cost = ModelConfigService.calculateImageCost(this.IMAGE_MODEL_ID, 1);

      console.log('图片生成成功:', {
        url: imageUrl,
        model: modelConfig.name,
        size: imageSize,
        cost: ModelConfigService.formatCost(cost)
      });

      return imageUrl;
    } catch (error: any) {
      console.error('图片生成失败:', error);
      
      // 构建详细错误信息
      if (axios.isAxiosError(error)) {
        const statusCode = error.response?.status;
        const errorData = error.response?.data?.error;
        const requestId = error.response?.headers['x-request-id'];
        
        let errorMessage = errorData?.message || error.message;
        let errorDetails = '';
        
        // 根据状态码提供更友好的错误提示
        if (statusCode === 401) {
          errorDetails = 'API Key 认证失败，请检查：\n' +
            '1. IMAGE_API_KEY 环境变量是否正确配置\n' +
            '2. API Key 格式应为纯密钥，不包含 "Bearer " 前缀\n' +
            '3. API Key 是否已过期或被禁用';
        } else if (statusCode === 429) {
          errorDetails = 'API 调用频率超限，请稍后重试';
        } else if (statusCode === 500) {
          errorDetails = '图片生成服务器内部错误';
        }
        
        // 记录请求ID便于排查
        if (requestId) {
          errorDetails += `\nRequest ID: ${requestId}`;
        }
        
        const fullMessage = errorDetails 
          ? `${errorMessage}\n${errorDetails}` 
          : errorMessage;
        
        throw new Error(`图片生成API调用失败: ${fullMessage}`);
      }
      
      throw error;
    }
  }

  /**
   * 下载图片并保存到本地
   */
  private static async downloadAndSaveImage(
    imageUrl: string,
    localPath: string
  ): Promise<number> {
    // 下载图片
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 60000 // 60秒超时
    });

    const imageBuffer = Buffer.from(response.data);

    // 写入文件
    fs.writeFileSync(localPath, imageBuffer);

    // 返回文件大小
    return imageBuffer.length;
  }

  /**
   * 生成播客封面
   * 使用1024x1024尺寸（1:1正方形），适合播客封面
   */
  static async generatePodcastCover(
    coverPrompt: string, 
    localPath: string
  ): Promise<{ url: string; fileSize: number }> {
    // 生成图片
    const imageUrl = await this.generateImage(coverPrompt, IMAGE_SIZES.LARGE, {
      watermark: false,  // 不带水印
      stream: false      // 非流式
    });

    // 下载并保存到本地
    const fileSize = await this.downloadAndSaveImage(imageUrl, localPath);

    console.log('封面已保存到本地:', {
      url: localPath,
      size: `${(fileSize / 1024).toFixed(2)} KB`
    });

    return {
      url: localPath,
      fileSize
    };
  }

  /**
   * 验证提示词（可选：添加内容审核）
   */
  static validatePrompt(prompt: string): boolean {
    if (!prompt || prompt.trim().length === 0) {
      return false;
    }

    // 检查长度
    if (prompt.length > 1000) {
      return false;
    }

    // 可以添加更多验证规则
    // 如：敏感词检测、内容过滤等

    return true;
  }

  /**
   * 优化提示词（可选：添加提示词优化逻辑）
   */
  static optimizePrompt(prompt: string): string {
    // 移除多余空格
    let optimized = prompt.trim().replace(/\s+/g, ' ');

    // 可以添加更多优化逻辑
    // 如：添加质量提升关键词、风格描述等

    return optimized;
  }
}

