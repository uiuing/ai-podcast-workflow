import modelPricingConfig from '../config/model-pricing.config.json';

/**
 * 定价档位
 */
export interface PricingTier {
  inputMin: number;
  inputMax: number;
  inputPrice: number;
  outputPrice: number;
  cacheHitPrice: number;
}

/**
 * 文本模型配置
 */
export interface TextModelConfig {
  name: string;
  description: string;
  endpoint: string;
  pricing: {
    tiers: PricingTier[];
  };
}

/**
 * 图片模型配置
 */
export interface ImageModelConfig {
  name: string;
  description: string;
  endpoint: string;
  pricing: {
    pricePerImage: number;
  };
  supportedSizes: string[];
}

/**
 * TTS模型配置
 */
export interface TTSModelConfig {
  name: string;
  description: string;
  resourceId: string;
  pricing: {
    pricePerTenThousandCharacters: number;
  };
  features: string[];
}

/**
 * 计算文本模型费用
 */
export interface TextModelCost {
  inputCost: number;
  outputCost: number;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * 模型配置服务
 */
export class ModelConfigService {
  /**
   * 获取所有文本模型
   */
  static getTextModels(): Record<string, TextModelConfig> {
    return modelPricingConfig.textModels as Record<string, TextModelConfig>;
  }

  /**
   * 获取所有图片模型
   */
  static getImageModels(): Record<string, ImageModelConfig> {
    return modelPricingConfig.imageModels as Record<string, ImageModelConfig>;
  }

  /**
   * 获取所有TTS模型
   */
  static getTTSModels(): Record<string, TTSModelConfig> {
    return modelPricingConfig.ttsModels as Record<string, TTSModelConfig>;
  }

  /**
   * 根据ID获取文本模型配置
   */
  static getTextModelById(modelId: string): TextModelConfig | null {
    const models = this.getTextModels();
    return models[modelId] || null;
  }

  /**
   * 根据ID获取图片模型配置
   */
  static getImageModelById(modelId: string): ImageModelConfig | null {
    const models = this.getImageModels();
    return models[modelId] || null;
  }

  /**
   * 根据ID获取TTS模型配置
   */
  static getTTSModelById(modelId: string): TTSModelConfig | null {
    const models = this.getTTSModels();
    return models[modelId] || null;
  }

  /**
   * 获取默认文本模型ID
   */
  static getDefaultTextModel(): string {
    return modelPricingConfig.defaultModels.text;
  }

  /**
   * 获取默认图片模型ID
   */
  static getDefaultImageModel(): string {
    return modelPricingConfig.defaultModels.image;
  }

  /**
   * 获取默认TTS模型ID
   */
  static getDefaultTTSModel(): string {
    return (modelPricingConfig.defaultModels as any).tts || 'seed-tts-2.0';
  }

  /**
   * 计算文本模型使用费用
   */
  static calculateTextCost(
    modelId: string,
    inputTokens: number,
    outputTokens: number,
    cacheTokens: number = 0
  ): TextModelCost {
    const model = this.getTextModelById(modelId);
    
    if (!model) {
      throw new Error(`模型不存在: ${modelId}`);
    }

    // 根据输入token数确定使用哪个定价档位
    const tier = model.pricing.tiers.find(
      t => inputTokens >= t.inputMin && inputTokens <= t.inputMax
    );

    if (!tier) {
      throw new Error(`未找到匹配的定价档位: inputTokens=${inputTokens}`);
    }

    // 计算输入费用
    const inputCost = (inputTokens / 1000000) * tier.inputPrice;

    // 计算输出费用(严格按照档位价格)
    const outputCost = (outputTokens / 1000000) * tier.outputPrice;

    // 计算缓存费用(如果有)
    const cacheCost = (cacheTokens / 1000000) * tier.cacheHitPrice;

    const totalCost = inputCost + outputCost + cacheCost;

    return {
      inputCost: Number(inputCost.toFixed(6)),
      outputCost: Number(outputCost.toFixed(6)),
      totalCost: Number(totalCost.toFixed(6)),
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens
    };
  }

  /**
   * 计算图片模型使用费用
   */
  static calculateImageCost(modelId: string, imageCount: number = 1): number {
    const model = this.getImageModelById(modelId);
    
    if (!model) {
      throw new Error(`模型不存在: ${modelId}`);
    }

    return Number((model.pricing.pricePerImage * imageCount).toFixed(6));
  }

  /**
   * 计算TTS模型使用费用
   * TTS统一价格：¥4.5/万字符（不区分具体模型）
   * @param modelId 模型ID（可选，不影响计费）
   * @param characterCount 字符数
   */
  static calculateTTSCost(modelId: string | null, characterCount: number): number {
    // TTS统一价格：¥4.5/万字符
    const pricePerTenThousand = (modelPricingConfig as any).ttsPricing?.pricePerTenThousandCharacters || 4.5;
    
    // 计算成本：(字符数 / 10000) * 4.5
    return Number(((characterCount / 10000) * pricePerTenThousand).toFixed(6));
  }

  /**
   * 格式化费用显示(元)
   */
  static formatCost(cost: number): string {
    return `¥${cost.toFixed(6)}`;
  }

  /**
   * 获取模型列表(供前端选择)
   */
  static getModelList(): {
    textModels: Array<{ id: string; name: string; description: string }>;
    imageModels: Array<{ id: string; name: string; description: string }>;
    ttsModels: Array<{ id: string; name: string; description: string; features: string[] }>;
  } {
    const textModels = this.getTextModels();
    const imageModels = this.getImageModels();
    const ttsModels = this.getTTSModels();

    return {
      textModels: Object.entries(textModels).map(([id, config]) => ({
        id,
        name: config.name,
        description: config.description
      })),
      imageModels: Object.entries(imageModels).map(([id, config]) => ({
        id,
        name: config.name,
        description: config.description
      })),
      ttsModels: Object.entries(ttsModels).map(([id, config]) => ({
        id,
        name: config.name,
        description: config.description,
        features: config.features
      }))
    };
  }

  /**
   * 验证模型ID是否有效
   */
  static isValidTextModel(modelId: string): boolean {
    return !!this.getTextModelById(modelId);
  }

  /**
   * 验证图片模型ID是否有效
   */
  static isValidImageModel(modelId: string): boolean {
    return !!this.getImageModelById(modelId);
  }

  /**
   * 验证TTS模型ID是否有效
   */
  static isValidTTSModel(modelId: string): boolean {
    return !!this.getTTSModelById(modelId);
  }
}

