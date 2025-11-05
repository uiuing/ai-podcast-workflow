import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { PodcastService } from './podcast.service';
import { ModelConfigService } from './model-config.service';
import { DoubaoResponse, PodcastGenerationResult } from '../types/podcast.types';
import { config } from '../config/config';

export class DoubaoService {
  private static readonly API_URL = config.doubao.apiUrl;
  private static readonly API_KEY = config.doubao.apiKey;
  private static readonly TEXT_MODEL_ID = config.doubao.textModelId;
  
  // 支持多个可能的路径（开发环境和生产环境）
  private static getVoicesConfigPath(): string {
    const possiblePaths = [
      path.join(__dirname, '../config/podcast-voices.json'),           // 开发环境 (src/)
      path.join(__dirname, '../../src/config/podcast-voices.json'),    // 编译后 (dist/)
      path.join(process.cwd(), 'src/config/podcast-voices.json'),      // 从项目根目录
    ];

    for (const configPath of possiblePaths) {
      if (fs.existsSync(configPath)) {
        console.log(`✅ 找到声音配置文件: ${configPath}`);
        return configPath;
      }
    }

    console.error('❌ 未找到声音配置文件，尝试过的路径:');
    possiblePaths.forEach(p => console.error(`   - ${p}`));
    throw new Error('未找到声音配置文件 podcast-voices.json');
  }

  /**
   * 获取所有可用的声音名字
   */
  private static getAvailableVoiceNames(): string[] {
    const configPath = this.getVoicesConfigPath();
    const voicesData = fs.readFileSync(configPath, 'utf-8');
    const voices = JSON.parse(voicesData);
    
    if (!Array.isArray(voices)) {
      throw new Error('声音配置格式错误：应该是数组');
    }
    
    const voiceNames = voices.map((voice: any) => {
      if (!voice.name) {
        console.warn('⚠️  发现没有 name 字段的声音配置:', voice);
        return null;
      }
      return voice.name;
    }).filter(Boolean);
    
    console.log(`✅ 成功加载 ${voiceNames.length} 个声音: ${voiceNames.join(', ')}`);
    return voiceNames;
  }

  /**
   * 获取完整的声音配置信息（包括描述）
   */
  private static getVoicesConfig(): Array<{ name: string; description: string; gender: string }> {
    const configPath = this.getVoicesConfigPath();
    const voicesData = fs.readFileSync(configPath, 'utf-8');
    const voices = JSON.parse(voicesData);
    
    if (!Array.isArray(voices)) {
      throw new Error('声音配置格式错误：应该是数组');
    }
    
    const voiceConfigs = voices.map((voice: any) => {
      if (!voice.name || !voice.description || !voice.gender) {
        console.warn('⚠️  发现不完整的声音配置:', voice);
        return null;
      }
      return {
        name: voice.name,
        description: voice.description,
        gender: voice.gender
      };
    }).filter(Boolean) as Array<{ name: string; description: string; gender: string }>;
    
    console.log(`✅ 成功加载 ${voiceConfigs.length} 个声音配置`);
    return voiceConfigs;
  }

  /**
   * 获取BGM目录路径
   */
  private static getBgmDirectoryPath(): string {
    const possiblePaths = [
      path.join(__dirname, '../config/bgm'),           // 开发环境 (src/)
      path.join(__dirname, '../../src/config/bgm'),    // 编译后 (dist/)
      path.join(process.cwd(), 'src/config/bgm'),      // 从项目根目录
    ];

    for (const bgmPath of possiblePaths) {
      if (fs.existsSync(bgmPath)) {
        console.log(`✅ 找到BGM目录: ${bgmPath}`);
        return bgmPath;
      }
    }

    console.error('❌ 未找到BGM目录，尝试过的路径:');
    possiblePaths.forEach(p => console.error(`   - ${p}`));
    throw new Error('未找到BGM目录 src/config/bgm');
  }

  /**
   * 获取所有可用的BGM文件名列表
   */
  private static getAvailableBgmFiles(): string[] {
    const bgmDir = this.getBgmDirectoryPath();
    const files = fs.readdirSync(bgmDir);
    
    // 只返回mp3文件
    const bgmFiles = files.filter(file => file.toLowerCase().endsWith('.mp3'));
    
    console.log(`✅ 成功加载 ${bgmFiles.length} 个BGM文件: ${bgmFiles.join(', ')}`);
    return bgmFiles;
  }

  /**
   * 生成BGM选择提示文本（根据文件名分析音乐风格）
   */
  private static getBgmSelectionGuide(bgmFiles: string[]): string {
    const fileDescriptions = bgmFiles.map(file => {
      const lowerFile = file.toLowerCase();
      let style = '';
      
      if (lowerFile.includes('interview')) {
        style = '访谈类';
      } else if (lowerFile.includes('jazz')) {
        style = '爵士风格';
      } else if (lowerFile.includes('lofi') || lowerFile.includes('lounge')) {
        style = 'LoFi/轻松氛围';
      } else if (lowerFile.includes('hip-hop') || lowerFile.includes('beat')) {
        style = '节奏感强/嘻哈风格';
      } else if (lowerFile.includes('vlog')) {
        style = 'Vlog/广告风格';
      } else if (lowerFile.includes('relaxed')) {
        style = '轻松舒缓';
      } else if (lowerFile.includes('intro')) {
        style = '开场音乐';
      } else if (lowerFile.includes('tv-show')) {
        style = '电视节目风格';
      } else {
        style = '通用背景音乐';
      }
      
      return `${file}（${style}）`;
    }).join('、');
    
    return fileDescriptions;
  }

  /**
   * 解析范围字符串的最小值
   * 例如: "15-25轮对话" -> 15, "80-100字" -> 80
   */
  private static parseRangeMin(rangeStr: string): number | undefined {
    if (!rangeStr) return undefined;
    const match = rangeStr.match(/(\d+)/);
    return match ? parseInt(match[1]) : undefined;
  }

  /**
   * 解析范围字符串的最大值
   * 例如: "15-25轮对话" -> 25, "80-100字" -> 100
   */
  private static parseRangeMax(rangeStr: string): number | undefined {
    if (!rangeStr) return undefined;
    const matches = rangeStr.match(/(\d+)/g);
    if (!matches || matches.length < 2) return undefined;
    return parseInt(matches[1]);
  }

  /**
   * 生成播客内容
   */
  static async generatePodcast(
    userInput: string,
    formatId: string,
    styleId: string
  ): Promise<{
    result: PodcastGenerationResult;
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
  }> {
    const startTime = Date.now();
    let requestBody: any = null;
    
    try {
      // 获取格式和风格信息
      const format = PodcastService.getFormatById(formatId);
      const style = PodcastService.getStyleById(styleId);

      if (!format) {
        throw new Error(`播客格式不存在: ${formatId}`);
      }

      if (!style) {
        throw new Error(`播客风格不存在: ${styleId}`);
      }

      // 获取模型配置
      const modelConfig = ModelConfigService.getTextModelById(this.TEXT_MODEL_ID);
      if (!modelConfig) {
        throw new Error(`文本模型配置不存在: ${this.TEXT_MODEL_ID}`);
      }

      // 获取可用声音列表（只包含名字，用于schema的enum限制）
      const availableVoiceNames = this.getAvailableVoiceNames();

      // 获取完整的声音配置（包含描述，用于JSON schema）
      const voicesConfig = this.getVoicesConfig();

      // 构建声音配置描述文本（用于JSON schema）
      const voicesDescription = voicesConfig
        .map(v => `${v.name}（${v.description}）`)
        .join('、');

      // 获取可用的BGM文件列表
      const availableBgmFiles = this.getAvailableBgmFiles();

      // 构建BGM选择指南文本
      const bgmSelectionGuide = this.getBgmSelectionGuide(availableBgmFiles);

      // 生成系统提示词（传递完整的声音配置信息）
      const instructions = PodcastService.createDetailedSystemPrompt(formatId, styleId, voicesConfig);

      // 构建请求
      requestBody = {
        model: modelConfig.endpoint, // 使用配置中的endpoint
        input: userInput,
        instructions,
        thinking: {
          type: 'disabled'
        },
        // tools: [
        //   {
        //     type: 'web_search',
        //     limit: 4
        //   }
        // ],
        text: {
          format: {
            type: 'json_schema',
            name: 'podcast_generation',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                outline: {
                  type: 'string',
                  description: '知识大纲，Markdown格式。包含主要知识点、核心概念、详细说明等内容结构，根据播客格式和风格自然组织。这是用户可见的内容框架，帮助用户快速了解播客涵盖的知识体系'
                },
                title: {
                  type: 'string',
                  description: '播客标题。格式：主标题（8-15字简洁有力）+ 冒号 + 副标题（可选，扩展说明）。无书名号，适合手机显示。例如："AI革命：ChatGPT如何改变我们的工作方式"'
                },
                description: {
                  type: 'string',
                  description: '播客简介，50-100字，简明扼要介绍播客核心内容、亮点和听众收获'
                },
                categories: {
                  type: 'array',
                  items: {
                    type: 'string'
                  },
                  description: '内容分类标签数组，2-4个标签，根据内容自由定义。如：["科技"、"人工智能"、"职场技能"]'
                },
                related_topics: {
                  type: 'array',
                  items: {
                    type: 'string'
                  },
                  description: '相关话题标题列表，3-4条，格式与主标题一致（无书名号），用于推荐延伸内容'
                },
                speakers: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: {
                        type: 'string',
                        enum: availableVoiceNames,
                        description: `说话人名字，从以下可用声音中选择：${voicesDescription}。请根据播客主题、风格和角色定位，智能选择最匹配的声音（考虑性别、音色特点、适用场景等）`
                      },
                      role: {
                        type: 'string',
                        description: '角色定位，如主播、嘉宾、专家、观察者、讲述者等，要有清晰的角色分工和职责'
                      },
                      personality: {
                        type: 'string',
                        description: '性格特点和自然说话风格：要详细描述该角色的说话习惯、语气特点、常用口头禅、情绪表达方式、互动风格等，让角色在对话中有鲜明个性和真实感。例如："热情外向，喜欢用生活化比喻，常说\'你懂我意思吧\'，说话时经常笑"或"沉稳理性，思考时会停顿，常说\'让我想想\'、\'嗯...\'，喜欢总结要点"'
                      }
                    },
                    required: ['name', 'role', 'personality'],
                    additionalProperties: false
                  },
                  description: `播客对话参与者数组。重要：根据播客主题、风格和内容需要，灵活确定参与者数量（1-3人）。单人独白适合深度剖析、纪实探索、深夜电台等；双人对话适合大部分互动场景；三人讨论适合多角度辩论。每个角色要有独特的性格和说话风格`
                },
                dialogue: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      speaker: {
                        type: 'string',
                        enum: availableVoiceNames,
                        description: `说话人名字，必须是speakers中定义的角色之一。可用声音：${voicesDescription}`
                      },
                      text: {
                        type: 'string',
                        description: `对话内容，每段${format.avg_words_per_round}。必须达到专业播客水准的自然对话，严格遵循以下标准：

【口语化】避免书面语，加入口水词"嗯"、"呃"、"那个"、"就是说"、"其实"、"然后"、"这个"、"怎么说呢"等，让表达接地气。

【停顿节奏】用"..."表示思考停顿。句子长短结合，避免过于工整。重要观点前可停顿营造悬念。

【情绪表达】绝对不用括号标注！情绪必须通过自然语言融入文字：开心说"哈哈"、"嘿嘿"，惊讶说"哇"、"天哪"，感慨说"唉"、"啊"，疑惑说"啊？"、"嗯？"，认同说"嗯嗯嗯"、"对对对"。加入语气词"啊"、"呀"、"哦"、"诶"等。严禁使用任何形式的括号（包括但不限于：（笑）、（停顿）、（叹气）、（轻柔的呼吸声渐弱）等），所有情绪和动作必须用文字自然表达。

【自然互动】使用"对对对"、"是的是的"、"没错没错"等回应词。可以打断、插话、补充。倾听时用"嗯嗯"、"对"、"是啊"回应。适当追问"你是说...吗？"、"那如果...呢？"。

【不完美感】允许口误纠正"不对，我想说的是..."。允许重复强调"真的真的"、"非常非常"。可以有不完整句子。

【思考过程】展现思考轨迹："让我想想..."、"怎么说呢..."、"这个问题很有意思..."。边说边想，逐步推进观点。

【互动呼应】频繁使用对方名字。对上一句回应点评。提出反问。用"刚才你提到..."、"接着你说的..."承接话题。

【角色个性】严格按照该角色的personality说话，体现其独特的说话习惯、口头禅、情绪表达方式。

【播客习惯】开场寒暄、转换话题有过渡、阶段性总结、结尾留思考。

让每句话都像真人即兴交流，而非背稿朗读，完全感受不到AI痕迹。记住：任何情绪、动作、音效都不能用括号，只能用自然的语言文字表达。`
                      },
                      pause_after: {
                        type: 'number',
                        description: `这段对话后的智能停顿时长（秒），范围0.1-1秒。根据对话内容和节奏智能判断`
                      }
                    },
                    required: ['speaker', 'text', 'pause_after'],
                    additionalProperties: false
                  },
                  description: `完整对话数组，参与者之间的真实自然对话，按播客流程顺序排列（开场→正文→结尾）。生成${format.dialogue_rounds}的对话（可根据内容需要适当调整）`
                },
                cover_prompt: {
                  type: 'string',
                  description: '根据博客主题生成100字内AI绘图提示词(1:1)：视觉匹配规则，根据主题选择：抽象/哲学类用几何图形/光影/渐变/符号/线条；技术/科技类用电路/界面/数据/芯片/代码/未来感；情感/心理类用风景/天空/海洋/植物/季节/光线；商业/职场类用建筑/空间/办公/产品/城市；生活/日常类用场景/物品/食物/家居/温馨氛围；文化/艺术类用装置/雕塑/纹理/历史/传统元素；教育/知识类用书籍/工具/图表/学习场景；健康/运动类用自然/运动器材/活力场景（避免人体）；旅行/探索类用地标/交通/地图/远景；工业/制造类用机械/材质/工艺/结构；音乐/娱乐类用乐器/舞台/抽象音波；环保/自然类用生态/绿色/可持续元素；金融/经济类用图表/货币符号/增长曲线；时间/历史类用钟表/怀旧/年代感。1:1构图。严禁：大脑/人体器官/血腥/恐怖/暴力/敏感政治/宗教符号/色情等不适内容。要求多用自然风景'
                },
                intro_music_duration: {
                  type: 'number',
                  description: '播客开头前奏音乐时长（秒），范围5-12秒。根据播客风格和氛围智能决定：轻松活泼风格可以短一些（5-7秒），专业严肃或深度内容可以长一些（8-12秒），让前奏音乐自然引入播客主题'
                },
                outro_music_duration: {
                  type: 'number',
                  description: '播客结尾音乐时长（秒），范围5-12秒。根据播客内容和结尾氛围智能决定：快速轻松的结尾可以短一些（5-7秒），深度思考或情感类结尾可以长一些（8-12秒），让结尾音乐自然淡出'
                },
                bgm_file: {
                  type: 'string',
                  enum: availableBgmFiles,
                  description: `播客背景音乐文件名（开头和结尾使用同一个BGM）。从以下可用BGM中智能选择最匹配播客主题、风格和整体氛围的音乐：${bgmSelectionGuide}。选择建议：访谈类播客选interview相关；专业严肃内容选jazz；轻松休闲选lofi/relaxed；节奏感强选beat/hip-hop；通用场景选intro相关`
                }
              },
              required: [
                'outline',
                'title',
                'description',
                'categories',
                'related_topics',
                'speakers',
                'dialogue',
                'cover_prompt',
                'intro_music_duration',
                'outro_music_duration',
                'bgm_file'
              ],
              additionalProperties: false
            }
          }
        },
        stream: false
      };

      console.log('调用豆包大模型API...');
      console.log('用户输入:', userInput);
      console.log('格式:', format.name, '风格:', style.name);

      // 处理 API Key（去除可能存在的 Bearer 前缀）
      const apiKey = this.API_KEY.replace(/^Bearer\s+/i, '').trim();
      
      const headers = {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      };
      
      // 调用API
      const response = await axios.post<DoubaoResponse>(
        this.API_URL,
        requestBody,
        {
          headers,
          timeout: config.doubao.timeout
        }
      );

      const responseTime = Date.now() - startTime;
      
      // 解析新的响应格式
      // 响应格式: { output: [{ content: [{ type: 'output_text', text: '...' }] }], usage: {...} }
      console.log('📦 收到API响应，开始解析...');
      
      const outputArray = response.data.output;
      if (!outputArray || outputArray.length === 0) {
        console.error('❌ 响应结构错误: output为空');
        console.error('完整响应:', JSON.stringify(response.data, null, 2));
        throw new Error('大模型返回数据为空');
      }

      const contentArray = outputArray[0]?.content;
      if (!contentArray || contentArray.length === 0) {
        console.error('❌ 响应结构错误: content为空');
        console.error('output内容:', JSON.stringify(outputArray, null, 2));
        throw new Error('大模型返回内容为空');
      }

      console.log(`📄 Content数组长度: ${contentArray.length}`);
      console.log('Content类型:', contentArray.map((item: any) => item.type).join(', '));

      // 找到 type 为 'output_text' 的内容
      const textContent = contentArray.find((item: any) => item.type === 'output_text');
      if (!textContent || !textContent.text) {
        console.error('❌ 未找到output_text类型的内容');
        console.error('所有content项:', JSON.stringify(contentArray, null, 2));
        throw new Error('未找到有效的文本内容');
      }

      console.log(`📝 文本长度: ${textContent.text.length} 字符`);
      console.log('前100字符:', textContent.text.substring(0, 100));

      // 解析 JSON
      let result: PodcastGenerationResult;
      try {
        result = JSON.parse(textContent.text);
        console.log('✅ JSON解析成功');
      } catch (parseError: any) {
        console.error('❌ JSON解析失败:', parseError.message);
        console.error('原始文本:', textContent.text);
        throw new Error(`JSON解析失败: ${parseError.message}`);
      }

      // 提取 usage 信息
      const usage = response.data.usage || {};

      // 计算费用
      const cost = ModelConfigService.calculateTextCost(
        this.TEXT_MODEL_ID,
        usage.input_tokens || 0,
        usage.output_tokens || 0
      );

      console.log('AI生成成功:', {
        model: modelConfig.name,
        title: result.title,
        dialogue_count: result.dialogue.length,
        total_tokens: usage.total_tokens,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cost: ModelConfigService.formatCost(cost.totalCost)
      });

      return {
        result,
        usage: {
          prompt_tokens: usage.input_tokens || 0,
          completion_tokens: usage.output_tokens || 0,
          total_tokens: usage.total_tokens || 0
        }
      };
    } catch (error: any) {
      console.error('豆包大模型调用失败:', error);
      
      // 构建详细错误信息
      let errorMessage = '未知错误';
      let errorDetails = '';
      
      if (axios.isAxiosError(error)) {
        const statusCode = error.response?.status;
        const errorData = error.response?.data?.error;
        const requestId = error.response?.headers['x-request-id'];
        
        errorMessage = errorData?.message || error.message;
        
        // 根据状态码提供更友好的错误提示
        if (statusCode === 401) {
          errorDetails = 'API Key 认证失败，请检查：\n' +
            '1. DOUBAO_API_KEY 环境变量是否正确配置\n' +
            '2. API Key 格式应为纯密钥，不包含 "Bearer " 前缀\n' +
            '3. API Key 是否已过期或被禁用';
        } else if (statusCode === 429) {
          errorDetails = 'API 调用频率超限，请稍后重试';
        } else if (statusCode === 500) {
          errorDetails = '豆包服务器内部错误';
        }
        
        // 记录请求ID便于排查
        if (requestId) {
          errorDetails += `\nRequest ID: ${requestId}`;
        }
        
        const fullMessage = errorDetails 
          ? `${errorMessage}\n${errorDetails}` 
          : errorMessage;
        
        throw new Error(`大模型API调用失败: ${fullMessage}`);
      }
      
      throw error;
    }
  }

  /**
   * 验证生成结果的完整性
   */
  static validateResult(result: PodcastGenerationResult): boolean {
    return !!(
      result.outline &&
      result.title &&
      result.description &&
      result.categories?.length > 0 &&
      result.related_topics?.length > 0 &&
      result.dialogue?.length > 0 &&
      result.cover_prompt &&
      typeof result.intro_music_duration === 'number' &&
      result.intro_music_duration >= 5 &&
      result.intro_music_duration <= 12 &&
      typeof result.outro_music_duration === 'number' &&
      result.outro_music_duration >= 5 &&
      result.outro_music_duration <= 12 &&
      result.bgm_file &&
      typeof result.bgm_file === 'string' &&
      result.bgm_file.endsWith('.mp3')
    );
  }
}

