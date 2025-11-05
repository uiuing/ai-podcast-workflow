import * as fs from 'fs';
import * as path from 'path';

export interface PodcastFormat {
  id: string;
  name: string;
  word_count: string;
  audio_duration: string;
  description: string;
  suitable_for: string;
  content_depth: string;
  dialogue_rounds: string;
  avg_words_per_round: string;
}

export interface PodcastStyle {
  id: string;
  name: string;
  description: string;
  tone: string;
  interaction: string;
  recommended_for: string[];
  features: string[];
}

export interface PodcastData {
  podcast_formats: PodcastFormat[];
  podcast_styles: PodcastStyle[];
}

export interface PodcastConfig {
  podcast_formats: PodcastFormat[];
  podcast_styles: PodcastStyle[];
}

export class PodcastService {
  private static config: PodcastConfig | null = null;
  private static readonly CONFIG_PATH = path.join(__dirname, '../config/podcast.config.json');

  /**
   * 加载配置文件
   */
  private static loadConfig(): PodcastConfig {
    if (this.config) {
      return this.config;
    }

    try {
      const configData = fs.readFileSync(this.CONFIG_PATH, 'utf-8');
      this.config = JSON.parse(configData) as PodcastConfig;
      return this.config;
    } catch (error) {
      console.error('加载播客配置文件失败:', error);
      throw new Error('无法加载播客配置文件');
    }
  }

  /**
   * 重新加载配置文件（用于配置更新后刷新）
   */
  static reloadConfig(): void {
    this.config = null;
    this.loadConfig();
  }

  /**
   * 获取所有格式
   */
  private static get formats(): PodcastFormat[] {
    return this.loadConfig().podcast_formats;
  }

  /**
   * 获取所有风格
   */
  private static get styles(): PodcastStyle[] {
    return this.loadConfig().podcast_styles;
  }

  /**
   * 获取所有播客格式和风格
   */
  static getAllPodcastData(): PodcastData {
    return {
      podcast_formats: this.formats,
      podcast_styles: this.styles
    };
  }

  /**
   * 获取所有播客格式
   */
  static getAllFormats(): PodcastFormat[] {
    return this.formats;
  }

  /**
   * 获取所有播客风格
   */
  static getAllStyles(): PodcastStyle[] {
    return this.styles;
  }

  /**
   * 根据ID获取播客格式
   */
  static getFormatById(formatId: string): PodcastFormat | undefined {
    return this.formats.find(f => f.id === formatId);
  }

  /**
   * 根据ID获取播客风格
   */
  static getStyleById(styleId: string): PodcastStyle | undefined {
    return this.styles.find(s => s.id === styleId);
  }

  /**
   * 获取某个格式推荐的风格
   */
  static getRecommendedStylesForFormat(formatId: string): PodcastStyle[] {
    return this.styles.filter(style => 
      style.recommended_for.includes(formatId)
    );
  }

  /**
   * 创建精简的系统提示词（高层次指导）
   */
  static createDetailedSystemPrompt(
    formatId: string, 
    styleId: string, 
    availableVoices: Array<{ name: string; description: string; gender: string }>
  ): string {
    const format = this.getFormatById(formatId);
    const style = this.getStyleById(styleId);
    
    if (!format || !style) {
      throw new Error('未找到对应的格式或风格配置');
    }
    
    const sections = [
      // 1. 身份定位
      `你是知了（KnowMore）的AI播客生成助手，专注于创作媲美专业人工录制的高质量播客内容。`,
      
      // 2. 播客格式定位
      `本次播客格式：${format.name}（${format.description}，适合${format.suitable_for}）。`,
      
      // 3. 内容要求
      `内容要求：总字数${format.word_count}，对话轮数${format.dialogue_rounds}，每轮对话${format.avg_words_per_round}，内容深度：${format.content_depth}。`,
      
      // 4. 播客风格定位
      `播客风格：${style.name}（${style.description}）。风格特点：${style.features.join('、')}。`,
      
      // 5. 语气基调
      `语气基调：${style.tone}。互动方式：${style.interaction}。`,
      
      // 6. 核心要求
      `核心要求：`,
      `1. 根据主题和风格，灵活选择合适数量的参与者（1-3人），单人独白、双人对话、三人讨论均可，以最适合内容表达为准；`,
      `2. 创作真实自然的对话，像专业播客录制一样，包含停顿、口水词、语气词、情感表达等真人交流细节；`,
      `3. 每个角色要有独特的性格和说话风格，让对话生动有趣；`,
      `4. 严格按照 JSON schema 的字段要求输出结构化内容。`
    ];
    
    return sections.join('\n\n');
  }

  /**
   * 验证格式和风格是否匹配
   */
  static validateFormatStyleMatch(formatId: string, styleId: string): boolean {
    const style = this.getStyleById(styleId);
    if (!style) return false;
    
    return style.recommended_for.includes(formatId);
  }
}

