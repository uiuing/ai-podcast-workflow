import { DoubaoService } from './doubao.service';
import { ImageService } from './image.service';
import { TTSService } from './tts.service';
import { ModelConfigService } from './model-config.service';
import { SubtitleService } from './subtitle.service';
import { config } from '../config/config';
import { PodcastGenerationResult } from '../types/podcast.types';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 工作流执行选项
 */
export interface WorkflowOptions {
  userInput: string;
  formatId: string;
  styleId: string;
  outputDir: string;
  verbose?: boolean;
}

/**
 * 工作流执行结果
 */
export interface WorkflowResult {
  // 生成的内容
  generation: PodcastGenerationResult;
  
  // 文件路径
  audioPath: string;
  coverPath: string;
  subtitlePaths: {
    srt: string;
    vtt: string;
    txt: string;
  };
  
  // 成本统计
  cost: {
    textCost: number;
    imageCost: number;
    audioCost: number;
    totalCost: number;
  };
  
  // Token 使用情况
  tokens: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  
  // 音频信息
  audio: {
    duration: number;    // 秒
    fileSize: number;    // 字节
    characterCount: number;
  };
}

/**
 * 播客生成工作流服务
 * 整合三个步骤的完整流程
 */
export class WorkflowService {
  /**
   * 执行完整的播客生成工作流
   */
  static async execute(options: WorkflowOptions): Promise<WorkflowResult> {
    const { userInput, formatId, styleId, outputDir, verbose } = options;
    
    const startTime = Date.now();
    
    // 初始化成本统计
    const cost = {
      textCost: 0,
      imageCost: 0,
      audioCost: 0,
      totalCost: 0
    };
    
    // 初始化 Token 统计
    const tokens = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    };

    try {
      // ===========================================
      // 步骤 1: AI 生成播客内容
      // ===========================================
      this.printStepHeader(1, 'AI 生成播客内容');
      
      console.log('⏳ 调用豆包大模型，生成播客脚本...');
      
      const { result: generation, usage } = await DoubaoService.generatePodcast(
        userInput,
        formatId,
        styleId
      );
      
      // 计算文本生成成本
      const textModelId = config.doubao.textModelId;
      const textModel = ModelConfigService.getTextModelById(textModelId);
      const textCostResult = ModelConfigService.calculateTextCost(
        textModelId,
        usage.prompt_tokens,
        usage.completion_tokens
      );
      
      cost.textCost = textCostResult.totalCost;
      tokens.inputTokens = usage.prompt_tokens;
      tokens.outputTokens = usage.completion_tokens;
      tokens.totalTokens = usage.total_tokens;
      
      console.log('✅ AI 生成完成');
      console.log(`   标题: ${generation.title}`);
      console.log(`   对话数: ${generation.dialogue.length} 轮`);
      console.log(`   Token: 输入 ${usage.prompt_tokens.toLocaleString()} / 输出 ${usage.completion_tokens.toLocaleString()} / 总计 ${usage.total_tokens.toLocaleString()}`);
      console.log(`   💰 成本: ¥${cost.textCost.toFixed(4)}`);
      
      if (verbose) {
        console.log('\n📄 生成的内容:');
        console.log('   标题:', generation.title);
        console.log('   简介:', generation.description);
        console.log('   分类:', generation.categories.join(', '));
        console.log('   说话人:', generation.speakers.map(s => `${s.name}(${s.role})`).join(', '));
        console.log('   BGM:', generation.bgm_file);
      }

      // ===========================================
      // 步骤 2: 生成播客封面
      // ===========================================
      this.printStepHeader(2, '生成播客封面');
      
      console.log('⏳ 调用图片生成 API，生成封面图...');
      
      // 使用标题作为文件名
      const timestamp = Date.now();
      const sanitizedTitle = this.sanitizeFileName(generation.title);
      const coverFileName = `${sanitizedTitle}_${timestamp}.png`;
      const coverPath = path.join(outputDir, 'covers', coverFileName);
      
      const { url: coverUrl, fileSize: coverSize } = await ImageService.generatePodcastCover(
        generation.cover_prompt,
        coverPath
      );
      
      // 计算图片生成成本
      const imageModelId = config.image.modelId;
      const imageModel = ModelConfigService.getImageModelById(imageModelId);
      const imageCost = ModelConfigService.calculateImageCost(imageModelId, 1);
      
      cost.imageCost = imageCost;
      
      console.log('✅ 封面生成完成');
      console.log(`   文件: ${coverPath}`);
      console.log(`   大小: ${(coverSize / 1024).toFixed(2)} KB`);
      console.log(`   💰 成本: ¥${cost.imageCost.toFixed(4)}`);

      // ===========================================
      // 步骤 3: 合成播客音频
      // ===========================================
      this.printStepHeader(3, '合成播客音频');
      
      console.log('⏳ TTS 语音合成中...');
      
      // 计算总字符数
      const totalCharacters = generation.dialogue.reduce((sum, d) => sum + d.text.length, 0);
      console.log(`   总字符数: ${totalCharacters.toLocaleString()}`);
      
      // 合成音频
      let currentSegment = 0;
      const totalSegments = generation.dialogue.length;
      
      const audioBuffer = await TTSService.generatePodcastAudio(
        generation.dialogue,
        undefined, // 不需要 taskId
        {
          format: config.tts.format,
          sampleRate: config.tts.sampleRate,
          bgmFile: generation.bgm_file,
          introMusicDuration: generation.intro_music_duration,
          outroMusicDuration: generation.outro_music_duration,
          onProgress: (current, total) => {
            if (current > currentSegment) {
              currentSegment = current;
              const percent = ((current / total) * 100).toFixed(1);
              console.log(`   进度: [${this.createProgressBar(current, total, 20)}] ${current}/${total} (${percent}%)`);
            }
          }
        }
      );
      
      // 保存音频文件（使用标题作为文件名）
      const audioFileName = `${sanitizedTitle}_${timestamp}.${config.tts.format}`;
      const audioPath = path.join(outputDir, 'audios', audioFileName);
      fs.writeFileSync(audioPath, audioBuffer);
      
      // 获取音频时长
      const duration = await TTSService.getAudioBufferDuration(audioBuffer, config.tts.format);
      
      // 计算 TTS 成本
      const ttsCost = ModelConfigService.calculateTTSCost(null, totalCharacters);
      cost.audioCost = ttsCost;
      
      console.log('✅ 音频生成完成');
      console.log(`   文件: ${audioPath}`);
      console.log(`   时长: ${Math.floor(duration / 60)}分${Math.round(duration % 60)}秒`);
      console.log(`   大小: ${(audioBuffer.length / 1024 / 1024).toFixed(2)} MB`);
      console.log(`   字符数: ${totalCharacters.toLocaleString()}`);
      console.log(`   💰 成本: ¥${cost.audioCost.toFixed(4)}`);

      // ===========================================
      // 步骤 4: 生成字幕文件
      // ===========================================
      this.printStepHeader(4, '生成字幕文件');
      
      console.log('⏳ 生成字幕文件（SRT/VTT/TXT）...');
      
      // 生成字幕文件
      const subtitleBasePath = path.join(outputDir, 'subtitles', `${sanitizedTitle}_${timestamp}`);
      
      // 确保字幕目录存在
      const subtitlesDir = path.join(outputDir, 'subtitles');
      if (!fs.existsSync(subtitlesDir)) {
        fs.mkdirSync(subtitlesDir, { recursive: true });
      }
      
      const subtitlePaths = SubtitleService.generateAllFormats(
        generation.dialogue,
        generation.speakers,
        subtitleBasePath,
        generation.intro_music_duration,
        duration
      );
      
      console.log('✅ 字幕生成完成');
      console.log(`   SRT: ${subtitlePaths.srt}`);
      console.log(`   VTT: ${subtitlePaths.vtt}`);
      console.log(`   TXT: ${subtitlePaths.txt}`);

      // ===========================================
      // 计算总成本
      // ===========================================
      cost.totalCost = cost.textCost + cost.imageCost + cost.audioCost;

      // 返回完整结果
      return {
        generation,
        audioPath,
        coverPath,
        subtitlePaths,
        cost,
        tokens,
        audio: {
          duration,
          fileSize: audioBuffer.length,
          characterCount: totalCharacters
        }
      };
      
    } catch (error: any) {
      console.error('\n❌ 工作流执行失败:', error.message);
      
      if (verbose && error.stack) {
        console.error('\n错误堆栈:');
        console.error(error.stack);
      }
      
      throw error;
    }
  }

  /**
   * 打印步骤头部
   */
  private static printStepHeader(step: number, title: string): void {
    console.log('\n' + '='.repeat(60));
    console.log(`[步骤 ${step}/4] ${title}`);
    console.log('='.repeat(60) + '\n');
  }

  /**
   * 创建进度条
   */
  private static createProgressBar(current: number, total: number, width: number = 20): string {
    const percent = current / total;
    const filled = Math.floor(percent * width);
    const empty = width - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
  }

  /**
   * 清理文件名，移除非法字符
   */
  private static sanitizeFileName(fileName: string): string {
    // 移除或替换文件名中的非法字符
    return fileName
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '') // 移除非法字符
      .replace(/\s+/g, '_') // 空格替换为下划线
      .replace(/[，。！？、；：""''（）【】《》]/g, '') // 移除中文标点
      .replace(/\.+$/g, '') // 移除末尾的点
      .trim()
      .substring(0, 50); // 限制长度
  }
}

