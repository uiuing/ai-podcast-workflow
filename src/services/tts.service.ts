import * as fs from 'fs';
import * as path from 'path';
import * as uuid from 'uuid';
import WebSocket from 'ws';
import { promisify } from 'util';
import ffmpeg from 'fluent-ffmpeg';
import { config } from '../config/config';
import { initializeFfmpeg } from '../config/ffmpeg.config';
import { PodcastDialogue, PodcastSpeaker } from '../types/podcast.types';
import {
  MsgType,
  ReceiveMessage,
  EventType,
  FullClientRequest,
} from '../plugins/volcengine/protocols';

// 初始化 ffmpeg 配置
initializeFfmpeg();

/**
 * 声音配置接口
 */
export interface VoiceConfig {
  id: string;
  name: string;
  originalName: string;
  description: string;
  gender: 'male' | 'female';
  lang: string;
  model: string;
  note?: string;
}

/**
 * TTS WebSocket 请求参数
 */
export interface TTSRequest {
  user: {
    uid: string;
  };
  req_params: {
    text: string;
    speaker: string;
    audio_params: {
      format: 'mp3' | 'ogg_opus' | 'pcm' | 'wav';
      sample_rate: 8000 | 16000 | 22050 | 24000 | 32000 | 44100 | 48000;
      speech_rate?: number;
      enable_timestamp?: boolean;
    };
    additions?: string;
  };
}

/**
 * 音频片段信息
 */
export interface AudioSegment {
  speaker: string;
  text: string;
  audioData: Buffer;
  duration?: number;
  timestamp?: any;
}

/**
 * 音频标准化配置接口
 */
interface AudioNormalizationConfig {
  normalization: {
    enabled: boolean;
    mode?: 'loudnorm' | 'compressor';
  };
  compressor?: {
    threshold: number;
    ratio: number;
    attack: number;
    release: number;
    makeup: number;
  };
  limiter?: {
    enabled: boolean;
    limit: number;
    release: number;
  };
  loudnorm: {
    I: number;
    TP: number;
    LRA: number;
  };
  processing: {
    sampleRate: number;
    tempDir: string;
    cleanupOnError: boolean;
  };
  quality?: {
    mp3?: {
      bitrate?: string;
      vbrQuality?: number;
    };
    wav?: {
      codec?: string;
    };
    ogg_opus?: {
      bitrate?: string;
    };
    useVBR?: boolean;
  };
}

/**
 * 语音合成服务
 * 基于火山引擎豆包TTS WebSocket Stream API V3
 */
export class TTSService {
  private static readonly WS_ENDPOINT = config.tts.wsEndpoint;
  private static readonly APP_ID = config.tts.appId;
  private static readonly ACCESS_TOKEN = config.tts.accessToken;
  private static readonly VOICES_CONFIG_PATH = path.join(__dirname, '../config/podcast-voices.json');
  private static readonly NORMALIZATION_CONFIG_PATH = path.join(__dirname, '../config/audio-normalization.config.json');
  
  // 声音配置缓存
  private static voicesCache: VoiceConfig[] | null = null;
  
  // 标准化配置缓存
  private static normalizationConfig: AudioNormalizationConfig | null = null;

  /**
   * 加载声音配置
   */
  private static loadVoices(): VoiceConfig[] {
    if (this.voicesCache) {
      return this.voicesCache;
    }

    try {
      const voicesData = fs.readFileSync(this.VOICES_CONFIG_PATH, 'utf-8');
      this.voicesCache = JSON.parse(voicesData) as VoiceConfig[];
      return this.voicesCache;
    } catch (error) {
      console.error('加载声音配置失败:', error);
      return [];
    }
  }

  /**
   * 加载音频标准化配置
   */
  private static loadNormalizationConfig(): AudioNormalizationConfig {
    if (this.normalizationConfig) {
      return this.normalizationConfig;
    }

    try {
      const configData = fs.readFileSync(this.NORMALIZATION_CONFIG_PATH, 'utf-8');
      this.normalizationConfig = JSON.parse(configData) as AudioNormalizationConfig;
      return this.normalizationConfig;
    } catch (error) {
      console.warn('⚠️  加载音频标准化配置失败，使用默认配置:', error);
      // 返回默认配置（使用压缩器模式）
      return {
        normalization: {
          enabled: true,
          mode: 'compressor'
        },
        compressor: {
          threshold: -20,
          ratio: 4,
          attack: 5,
          release: 50,
          makeup: 0
        },
        limiter: {
          enabled: true,
          limit: -1.0,
          release: 5
        },
        loudnorm: {
          I: -16,
          TP: -1.5,
          LRA: 11
        },
        processing: {
          sampleRate: 24000,
          tempDir: 'temp',
          cleanupOnError: true
        }
      };
    }
  }

  /**
   * 规范化文件路径（Windows 兼容）
   * 将反斜杠转换为正斜杠，避免 ffmpeg 在 Windows 上的路径问题
   */
  private static normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, '/');
  }

  /**
   * 获取音频处理滤镜字符串
   */
  private static getAudioFilter(): string {
    const normConfig = this.loadNormalizationConfig();
    const mode = normConfig.normalization.mode || 'compressor';

    if (mode === 'loudnorm') {
      // 使用 loudnorm 完全标准化
      const { I, TP, LRA } = normConfig.loudnorm;
      return `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}`;
    } else {
      // 使用压缩器模式：仅限制峰值，保持动态范围
      const filters: string[] = [];
      
      if (normConfig.compressor) {
        const { threshold, ratio, attack, release, makeup } = normConfig.compressor;
        // acompressor: 动态范围压缩，降低过大的声音
        filters.push(
          `acompressor=threshold=${threshold}dB:ratio=${ratio}:attack=${attack}:release=${release}:makeup=${makeup}`
        );
      }
      
      if (normConfig.limiter?.enabled) {
        const { limit, release } = normConfig.limiter;
        // alimiter: 硬限制峰值，防止削波
        filters.push(`alimiter=limit=${limit}:release=${release}`);
      }
      
      return filters.join(',');
    }
  }

  /**
   * 根据声音名字获取声音配置
   * @param speakerName 声音名字（如"语嫣"）或声音ID（如"zh_female_vv_uranus_bigtts"）
   * @returns 声音配置，如果找不到返回 undefined
   */
  private static getVoiceConfig(speakerName: string): VoiceConfig | undefined {
    const voices = this.loadVoices();
    
    // 先按名字查找
    let voice = voices.find(v => v.name === speakerName);
    
    // 如果找不到，再按ID查找
    if (!voice) {
      voice = voices.find(v => v.id === speakerName);
    }
    
    return voice;
  }

  /**
   * 获取声音的API调用参数
   * @param speakerName 声音名字或ID
   * @returns { voiceId: 声音ID, resourceId: 资源ID(model) }
   */
  private static getVoiceParams(speakerName: string): { voiceId: string; resourceId: string } {
    const voice = this.getVoiceConfig(speakerName);
    
    if (voice) {
      return {
        voiceId: voice.id,
        resourceId: voice.model  // 直接使用配置中的 model 字段作为 resourceId
      };
    }
    
    // 如果找不到配置，使用传入的名字作为ID，并使用默认资源ID
    console.warn(`⚠️  未找到声音配置: ${speakerName}，将使用默认配置`);
    return {
      voiceId: speakerName,
      resourceId: 'seed-tts-2.0'  // 默认资源ID
    };
  }

  /**
   * 生成单句语音 - 使用 WebSocket Stream API
   */
  static async synthesizeSingle(
    text: string,
    speaker: string,
    taskId?: number,
    options?: {
      format?: 'mp3' | 'ogg_opus' | 'pcm' | 'wav';
      sampleRate?: number;
      speechRate?: number;
      enableTimestamp?: boolean;
    }
  ): Promise<AudioSegment> {
    const startTime = Date.now();
    let requestBody: TTSRequest | null = null;
    let ws: WebSocket | null = null;

    try {
      // 获取声音ID
      // 获取声音参数（ID和资源ID）
      const { voiceId, resourceId } = this.getVoiceParams(speaker);
      
      console.log(`🎙️ [TTS] 开始合成 - TaskId: ${taskId || 'N/A'}, Speaker: ${speaker}, 文本: ${text.length}字`);
      
      if (!this.APP_ID) {
        throw new Error('TTS_APP_ID 未配置，请检查环境变量');
      }
      if (!this.ACCESS_TOKEN) {
        throw new Error('TTS_ACCESS_TOKEN 未配置，请检查环境变量');
      }

      // 创建 WebSocket 连接
      const connectId = uuid.v4();
      const headers = {
        'X-Api-App-Key': this.APP_ID,
        'X-Api-Access-Key': this.ACCESS_TOKEN,
        'X-Api-Resource-Id': resourceId,
        'X-Api-Connect-Id': connectId,
      };


      ws = new WebSocket(this.WS_ENDPOINT, {
        headers,
        skipUTF8Validation: true,
      });

      // 处理连接错误
      ws.on('unexpected-response', (request, response) => {
        console.error(`\n❌ 收到意外的 HTTP 响应:`);
        console.error(`   - 状态码: ${response.statusCode} ${response.statusMessage}`);
        console.error(`   - 响应头:`, JSON.stringify(response.headers, null, 2));
        
        let body = '';
        response.on('data', (chunk) => {
          body += chunk.toString();
        });
        response.on('end', () => {
          console.error(`   - 响应体:`, body);
          console.error(`\n💡 常见 403 错误原因:`);
          console.error(`   1. ACCESS_TOKEN 已过期 - 请到火山引擎控制台重新生成`);
          console.error(`   2. APP_ID 配置错误 - 请检查是否对应正确的应用`);
          console.error(`   3. Resource-Id 不匹配 - 当前使用: ${resourceId}`);
          console.error(`   4. IP 白名单限制 - 请检查火山引擎控制台的 IP 白名单设置`);
          console.error(`   5. 账号欠费或权限不足`);
        });
      });

      // 等待连接建立
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('WebSocket 连接超时（10秒）'));
        }, 10000);

        ws!.on('open', () => {
          clearTimeout(timeout);
          resolve(undefined);
        });
        
        ws!.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });

      // 构建请求参数
      const sampleRate = options?.sampleRate || 24000;
      const format = options?.format || 'wav';
      requestBody = {
        user: {
          uid: taskId?.toString() || uuid.v4(),
        },
        req_params: {
          text,
          speaker: voiceId,
          audio_params: {
            format: format,
            sample_rate: sampleRate as 8000 | 16000 | 22050 | 24000 | 32000 | 44100 | 48000,
            speech_rate: options?.speechRate || 0,
            enable_timestamp: options?.enableTimestamp || false,
          },
          additions: JSON.stringify({
            disable_markdown_filter: false,
          }),
        },
      };

      // 发送请求
      await FullClientRequest(
        ws,
        new TextEncoder().encode(JSON.stringify(requestBody))
      );

      // 接收音频数据
      const audioChunks: Uint8Array[] = [];
      let timestampData: any = null;

      while (true) {
        const msg = await ReceiveMessage(ws);

        switch (msg.type) {
          case MsgType.FullServerResponse:
            // 检查错误信息
            if (msg.payload && msg.payload.length > 0) {
              try {
                const responseData = JSON.parse(new TextDecoder().decode(msg.payload));
                if (responseData.code && responseData.code !== 0) {
                  console.error(`❌ TTS服务器错误: code=${responseData.code}, message=${responseData.message}`);
                }
              } catch (e) {
                // 可能不是JSON格式
              }
            }
            break;
          case MsgType.AudioOnlyServer:
            audioChunks.push(msg.payload);
            break;
          default:
            throw new Error(`未知消息类型: ${msg.toString()}`);
        }

        if (
          msg.type === MsgType.FullServerResponse &&
          msg.event === EventType.SessionFinished
        ) {
          break;
        }
      }

      if (audioChunks.length === 0) {
        throw new Error('未收到音频数据');
      }

      // 合并音频数据
      const audioData = Buffer.concat(audioChunks);
      const responseTime = Date.now() - startTime;

      console.log(`✅ [TTS] 合成完成 - ${responseTime}ms, ${(audioData.length / 1024).toFixed(2)}KB`);

      // 关闭 WebSocket
      ws.close();

      return {
        speaker,
        text,
        audioData,
        timestamp: timestampData
      };

    } catch (error: any) {
      const responseTime = Date.now() - startTime;

      console.error(`❌ [TTS] 合成失败 - ${error.message}`);

      // 确保关闭 WebSocket
      if (ws) {
        try {
          ws.close();
        } catch (closeError) {
          // 忽略关闭错误
        }
      }

      throw new Error(`语音合成失败: ${error.message}`);
    }
  }

  /**
   * 批量合成播客对话
   */
  static async synthesizeDialogue(
    dialogue: PodcastDialogue[],
    taskId?: number,
    options?: {
      format?: 'mp3' | 'ogg_opus' | 'pcm' | 'wav';
      sampleRate?: number;
      speechRate?: number;
      enableTimestamp?: boolean;
      onProgress?: (current: number, total: number) => void;
    }
  ): Promise<AudioSegment[]> {
    console.log(`🎙️ 开始批量合成 ${dialogue.length} 段对话`);

    const segments: AudioSegment[] = [];
    const total = dialogue.length;

    for (let i = 0; i < dialogue.length; i++) {
      const item = dialogue[i];
      
      try {
        const segment = await this.synthesizeSingle(
          item.text,
          item.speaker,
          taskId,
          options
        );

        segments.push(segment);

        // 进度回调
        if (options?.onProgress) {
          options.onProgress(i + 1, total);
        }

        // 避免请求过快，添加短暂延迟
        if (i < dialogue.length - 1) {
          await this.delay(100);
        }

      } catch (error: any) {
        throw new Error(`第 ${i + 1} 段对话合成失败: ${error.message}`);
      }
    }

    console.log(`✅ 批量合成完成: ${segments.length}/${total} 段`);

    return segments;
  }

  /**
   * 检查 ffmpeg 是否可用
   */
  private static async checkFfmpegAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      ffmpeg.getAvailableFormats((err, formats) => {
        if (err) {
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });
  }

  /**
   * 使用 ffmpeg 标准化单个音频片段的音量
   * @param audioData 音频数据
   * @param format 音频格式
   * @returns 标准化后的音频数据
   */
  private static async normalizeAudioVolume(
    audioData: Buffer,
    format: 'mp3' | 'ogg_opus' | 'pcm' | 'wav'
  ): Promise<Buffer> {
    const normConfig = this.loadNormalizationConfig();
    const tempDir = path.join(process.cwd(), normConfig.processing.tempDir);
    
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const inputFile = path.join(tempDir, `temp_input_${uuid.v4()}.${format}`);
    const outputFile = path.join(tempDir, `temp_output_${uuid.v4()}.${format}`);

    try {
      // 写入临时输入文件
      fs.writeFileSync(inputFile, audioData);

      // 使用 ffmpeg loudnorm 滤镜标准化音量
      // loudnorm 是专业的音量标准化滤镜，符合 EBU R128 标准
      const { I, TP, LRA } = normConfig.loudnorm;
      const sampleRate = normConfig.processing.sampleRate;
      const qualityOptions = this.getQualityOptions(format);
      
      await new Promise<void>((resolve, reject) => {
        const command = ffmpeg(this.normalizePath(inputFile))
          .audioFilters(`loudnorm=I=${I}:TP=${TP}:LRA=${LRA}`)
          .audioFrequency(sampleRate);
        
        // 添加音频质量参数
        if (qualityOptions.length > 0) {
          command.outputOptions(qualityOptions);
        }
        
        // 添加更大的输出缓冲区限制（防止"Result too large"错误）
        command.outputOptions([
          '-max_muxing_queue_size', '9999',
          '-bufsize', '10M'
        ]);
        
        command
          .save(this.normalizePath(outputFile))
          .on('end', () => resolve())
          .on('error', (err) => reject(err));
      });

      // 读取标准化后的音频
      const normalizedAudio = fs.readFileSync(outputFile);

      // 清理临时文件
      fs.unlinkSync(inputFile);
      fs.unlinkSync(outputFile);

      return normalizedAudio;
    } catch (error: any) {
      // 清理临时文件（根据配置）
      if (normConfig.processing.cleanupOnError) {
        if (fs.existsSync(inputFile)) {
          fs.unlinkSync(inputFile);
        }
        if (fs.existsSync(outputFile)) {
          fs.unlinkSync(outputFile);
        }
      }
      throw new Error(`音量标准化失败: ${error.message}`);
    }
  }

  /**
   * 生成静音音频文件
   * @param duration 静音时长（秒）
   * @param sampleRate 采样率
   * @param format 音频格式
   * @returns 静音音频文件路径
   */
  private static async generateSilence(
    duration: number,
    sampleRate: number,
    format: 'mp3' | 'ogg_opus' | 'pcm' | 'wav',
    tempDir: string
  ): Promise<string> {
    const silenceFile = path.join(tempDir, `silence_${duration}s_${uuid.v4()}.${format}`);
    const tempPcmFile = path.join(tempDir, `silence_temp_${uuid.v4()}.pcm`);
    
    try {
      // 方法1: 先生成 PCM 静音数据，再转换为目标格式
      // 这比 lavfi 虚拟输入更兼容各种 ffmpeg 版本
      
      // 生成纯静音的 PCM 数据 (16-bit, mono)
      const numSamples = Math.floor(duration * sampleRate);
      const silenceBuffer = Buffer.alloc(numSamples * 2); // 16-bit = 2 bytes per sample
      // Buffer.alloc 默认填充 0，代表静音
      
      // 写入临时 PCM 文件
      fs.writeFileSync(tempPcmFile, silenceBuffer);
      
      // 使用 ffmpeg 将 PCM 转换为目标格式
      await new Promise<void>((resolve, reject) => {
        ffmpeg()
          .input(this.normalizePath(tempPcmFile))
          .inputFormat('s16le') // 16-bit signed little-endian PCM
          .inputOptions([
            `-ar ${sampleRate}`,  // 采样率
            '-ac 1'                // 单声道
          ])
          .audioCodec(this.getAudioCodec(format))
          .save(this.normalizePath(silenceFile))
          .on('end', () => resolve())
          .on('error', (err) => reject(err));
      });
      
      // 清理临时 PCM 文件
      if (fs.existsSync(tempPcmFile)) {
        fs.unlinkSync(tempPcmFile);
      }
      
      return silenceFile;
    } catch (error: any) {
      // 清理临时文件
      if (fs.existsSync(tempPcmFile)) {
        try {
          fs.unlinkSync(tempPcmFile);
        } catch (e) {}
      }
      throw new Error(`生成静音失败: ${error.message}`);
    }
  }

  /**
   * 根据格式获取音频编码器
   */
  private static getAudioCodec(format: 'mp3' | 'ogg_opus' | 'pcm' | 'wav'): string {
    switch (format) {
      case 'mp3':
        return 'libmp3lame';
      case 'ogg_opus':
        return 'libopus';
      case 'wav':
        return 'pcm_s16le';
      case 'pcm':
        return 'pcm_s16le';
      default:
        return 'libmp3lame';
    }
  }

  /**
   * 获取音频质量编码参数
   */
  private static getQualityOptions(format: 'mp3' | 'ogg_opus' | 'pcm' | 'wav'): string[] {
    const normConfig = this.loadNormalizationConfig();
    const quality = normConfig.quality;
    
    if (!quality) {
      // 如果没有配置，使用默认高质量参数
      return format === 'mp3' ? ['-q:a 0'] : ['-b:a 320k'];
    }

    const options: string[] = [];
    
    switch (format) {
      case 'mp3':
        if (quality.useVBR && quality.mp3?.vbrQuality !== undefined) {
          // VBR 模式（质量优先）
          options.push(`-q:a ${quality.mp3.vbrQuality}`);
          console.log(`   使用 MP3 VBR 编码，质量等级: ${quality.mp3.vbrQuality} (0=最高质量)`);
        } else if (quality.mp3?.bitrate) {
          // CBR 模式（固定比特率）
          options.push(`-b:a ${quality.mp3.bitrate}`);
          console.log(`   使用 MP3 CBR 编码，比特率: ${quality.mp3.bitrate}`);
        } else {
          options.push('-q:a 0'); // 默认最高质量 VBR
        }
        break;
      
      case 'wav':
        // WAV 格式，保持 PCM 编码
        if (quality.wav?.codec) {
          options.push(`-acodec ${quality.wav.codec}`);
        }
        break;
      
      case 'ogg_opus':
        if (quality.ogg_opus?.bitrate) {
          options.push(`-b:a ${quality.ogg_opus.bitrate}`);
          console.log(`   使用 Opus 编码，比特率: ${quality.ogg_opus.bitrate}`);
        } else {
          options.push('-b:a 256k'); // 默认高质量
        }
        break;
      
      default:
        options.push('-b:a 320k');
    }
    
    return options;
  }

  /**
   * 使用 ffmpeg concat 合并多个音频文件（仅合并，不做音量标准化）
   * @param segments 音频片段数组（包含pause信息）
   * @param dialogue 原始对话数据（包含AI判断的停顿时长）
   * @param format 音频格式
   * @returns 合并后的音频（未标准化）
   */
  private static async mergeWithFfmpeg(
    segments: AudioSegment[],
    dialogue: PodcastDialogue[],
    format: 'mp3' | 'ogg_opus' | 'pcm' | 'wav'
  ): Promise<Buffer> {
    const normConfig = this.loadNormalizationConfig();
    const tempDir = path.join(process.cwd(), normConfig.processing.tempDir);
    
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    // 确保临时目录有写权限（Windows特殊处理）
    try {
      const testFile = path.join(tempDir, `test_${Date.now()}.txt`);
      fs.writeFileSync(testFile, 'test');
      fs.unlinkSync(testFile);
    } catch (err: any) {
      console.error(`⚠️  临时目录无写权限: ${tempDir}`);
      throw new Error(`临时目录无写权限: ${err.message}`);
    }

    const tempFiles: string[] = [];
    const concatListFile = path.join(tempDir, `concat_list_${uuid.v4()}.txt`);
    const mergedFile = path.join(tempDir, `merged_temp_${uuid.v4()}.${format}`);

    try {
      // 1. 生成所有需要的静音文件（根据AI判断的停顿时长）
      console.log(`🔇 生成智能静音片段（AI判断）...`);
      const sampleRate = normConfig.processing.sampleRate;
      
      // 开头静音：固定1.0秒
      const openingSilence = await this.generateSilence(1.0, sampleRate, format, tempDir);
      tempFiles.push(openingSilence);
      
      // 为每段对话生成对应的停顿静音
      const pauseSilences: string[] = [];
      for (let i = 0; i < dialogue.length; i++) {
        // 获取AI判断的停顿时长，默认0.3秒
        const pauseDuration = dialogue[i].pause_after || 0.3;
        
        // 只为非最后一个片段生成停顿
        if (i < dialogue.length - 1) {
          const pauseFile = await this.generateSilence(pauseDuration, sampleRate, format, tempDir);
          pauseSilences.push(pauseFile);
          tempFiles.push(pauseFile);
        }
      }

      console.log(`   生成开头静音: 1.0秒`);
      console.log(`   生成 ${pauseSilences.length} 个智能停顿（AI判断时长）`);

      // 2. 将音频片段写入临时文件，并构建包含智能静音的concat列表
      console.log(`📝 准备合并文件列表（含AI智能停顿）...`);
      const concatList: string[] = [];
      
      // 添加开头的1秒静音
      concatList.push(`file '${this.normalizePath(openingSilence)}'`);
      
      for (let i = 0; i < segments.length; i++) {
        // 添加音频片段
        const tempFile = path.join(tempDir, `segment_${uuid.v4()}.${format}`);
        fs.writeFileSync(tempFile, segments[i].audioData);
        tempFiles.push(tempFile);
        concatList.push(`file '${this.normalizePath(tempFile)}'`);
        
        // 在每个片段后添加AI判断的停顿（最后一个片段除外）
        if (i < segments.length - 1) {
          const pauseDuration = dialogue[i].pause_after || 0.8;
          concatList.push(`file '${this.normalizePath(pauseSilences[i])}'`);
          console.log(`   片段${i + 1}后停顿: ${pauseDuration.toFixed(1)}秒`);
        }
      }

      console.log(`   添加开头静音: 1.0秒`);

      // 3. 创建 ffmpeg concat 列表文件
      fs.writeFileSync(concatListFile, concatList.join('\n'));

      // 4. 使用 ffmpeg concat 协议合并音频
      // -f concat: 使用 concat 分离器
      // -safe 0: 允许使用绝对路径
      // -c copy: 直接复制流，不重新编码（快速）
      console.log(`🔗 合并音频片段（含静音）...`);
      
      await new Promise<void>((resolve, reject) => {
        ffmpeg()
          .input(this.normalizePath(concatListFile))
          .inputOptions(['-f concat', '-safe 0'])
          .outputOptions('-c copy')
          .save(this.normalizePath(mergedFile))
          .on('end', () => resolve())
          .on('error', (err) => reject(err));
      });

      console.log(`✅ 音频合并完成`);

      // 读取合并后的音频（不做音量标准化）
      const mergedAudio = fs.readFileSync(mergedFile);

      // 清理所有临时文件
      tempFiles.forEach(file => {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      });
      if (fs.existsSync(concatListFile)) {
        fs.unlinkSync(concatListFile);
      }
      if (fs.existsSync(mergedFile)) {
        fs.unlinkSync(mergedFile);
      }

      console.log(`✅ 音频合并完成（合并 + AI智能静音间隔）: ${(mergedAudio.length / 1024 / 1024).toFixed(2)} MB`);

      return mergedAudio;
    } catch (error: any) {
      // 清理所有临时文件
      tempFiles.forEach(file => {
        if (fs.existsSync(file)) {
          try {
            fs.unlinkSync(file);
          } catch (e) {}
        }
      });
      if (fs.existsSync(concatListFile)) {
        try {
          fs.unlinkSync(concatListFile);
        } catch (e) {}
      }
      if (fs.existsSync(mergedFile)) {
        try {
          fs.unlinkSync(mergedFile);
        } catch (e) {}
      }
      throw new Error(`使用 ffmpeg 合并音频失败: ${error.message}`);
    }
  }

  /**
   * 合并多个音频片段为完整音频（含AI智能静音间隔，不含音量标准化）
   * 注意：音量标准化应该在所有内容（包括BGM）处理完成后最后进行
   */
  static async mergeAudioSegments(
    segments: AudioSegment[],
    dialogue: PodcastDialogue[],
    format: 'mp3' | 'ogg_opus' | 'pcm' | 'wav' = 'mp3'
  ): Promise<Buffer> {
    // 检查 ffmpeg 是否可用
    const hasFfmpeg = await this.checkFfmpegAvailable();
    
    if (hasFfmpeg) {
      console.log(`🎚️  使用 ffmpeg 合并音频（AI智能静音间隔）...`);
      console.log(`   智能停顿: AI根据对话内容动态判断（0.3-2.0秒）`);
      console.log(`   💡 音量标准化将在所有内容处理完成后最后进行`);
      
      try {
        return await this.mergeWithFfmpeg(segments, dialogue, format);
      } catch (error: any) {
        console.warn(`⚠️  ffmpeg 合并失败，降级到简单拼接: ${error.message}`);
        console.warn(`   ⚠️  简单拼接模式不支持静音间隔`);
        // 降级到简单拼接
        const audioBuffers = segments.map(seg => seg.audioData);
        const mergedAudio = Buffer.concat(audioBuffers);
        console.log(`✅ 音频合并完成（简单拼接）: ${(mergedAudio.length / 1024 / 1024).toFixed(2)} MB`);
        return mergedAudio;
      }
    } else {
      console.warn(`⚠️  未检测到 ffmpeg，使用简单拼接（不含静音间隔）`);
      console.warn(`   💡 建议安装 ffmpeg 以获得AI智能静音间隔功能`);
      // 对于PCM和WAV格式，可以直接拼接
      // 对于MP3和OGG_OPUS，简单拼接可能有问题，但通常也能播放
      const audioBuffers = segments.map(seg => seg.audioData);
      const mergedAudio = Buffer.concat(audioBuffers);
      console.log(`✅ 音频合并完成（简单拼接）: ${(mergedAudio.length / 1024 / 1024).toFixed(2)} MB`);
      return mergedAudio;
    }
  }

  /**
   * 对最终音频进行音量标准化处理（简化方案：使用 loudnorm 通用标准化，保持动态范围）
   * @param audioBuffer 待处理的音频Buffer
   * @param format 音频格式
   * @returns 标准化后的音频Buffer
   */
  static async normalizeAudioFinal(
    audioBuffer: Buffer,
    format: 'mp3' | 'ogg_opus' | 'pcm' | 'wav'
  ): Promise<Buffer> {
    const normConfig = this.loadNormalizationConfig();
    
    // 检查是否启用音量标准化
    if (!normConfig.normalization.enabled) {
      console.log(`ℹ️  音量标准化已禁用（配置文件设置），跳过处理`);
      return audioBuffer;
    }
    
    // 使用系统临时目录（路径更短，避免Windows路径问题）
    const os = require('os');
    const tempDir = os.tmpdir();
    const timestamp = Date.now();
    const inputFile = path.join(tempDir, `in_${timestamp}.${format}`);
    const outputFile = path.join(tempDir, `out_${timestamp}.${format}`);
    
    try {
      // 写入输入文件
      fs.writeFileSync(inputFile, audioBuffer);
      
      const { I, TP, LRA } = normConfig.loudnorm;
      
      console.log(`🔊 音量标准化处理（loudnorm - 保持动态范围）...`);
      console.log(`   目标响度: ${I} LUFS（符合播客标准）`);
      console.log(`   真峰值限制: ${TP} dBFS`);
      console.log(`   动态范围: ${LRA} LU`);
      
      // 使用 loudnorm 滤镜 - 简单、通用、效果好
      const loudnormFilter = `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}`;
      
      await new Promise<void>((resolve, reject) => {
        ffmpeg(inputFile)
          .audioFilters(loudnormFilter)
          .audioCodec(this.getAudioCodec(format))
          .audioBitrate('256k')  // 使用固定比特率，简单稳定
          .save(outputFile)
          .on('start', (cmdLine) => {
            console.log(`   处理中...`);
          })
          .on('end', () => {
            resolve();
          })
          .on('error', (err) => {
            reject(err);
          });
      });
      
      // 读取标准化后的音频
      const normalizedAudio = fs.readFileSync(outputFile);
      
      console.log(`✅ 音量标准化完成: ${(normalizedAudio.length / 1024 / 1024).toFixed(2)} MB`);
      
      // 清理临时文件
      try {
        fs.unlinkSync(inputFile);
        fs.unlinkSync(outputFile);
      } catch (e) {
        // 忽略清理错误
      }
      
      return normalizedAudio;
      
    } catch (error: any) {
      console.error(`❌ 音量标准化失败: ${error.message}`);
      console.warn(`   ⚠️  使用原始音频（无标准化）`);
      
      // 清理临时文件
      try {
        if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile);
        if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
      } catch (e) {
        // 忽略清理错误
      }
      
      // 返回原始音频
      return audioBuffer;
    }
  }

  /**
   * 获取BGM文件路径
   */
  private static getBgmFilePath(bgmFileName: string): string {
    const possiblePaths = [
      path.join(__dirname, '../config/bgm', bgmFileName),           // 开发环境 (src/)
      path.join(__dirname, '../../src/config/bgm', bgmFileName),    // 编译后 (dist/)
      path.join(process.cwd(), 'src/config/bgm', bgmFileName),      // 从项目根目录
    ];

    for (const bgmPath of possiblePaths) {
      if (fs.existsSync(bgmPath)) {
        console.log(`✅ 找到BGM文件: ${bgmPath}`);
        return bgmPath;
      }
    }

    throw new Error(`未找到BGM文件: ${bgmFileName}`);
  }

  /**
   * 添加BGM到音频（前奏独立 + 混音淡入对话 + 纯对话 + 混音淡出对话 + 结尾独立）
   * @param audioFile 原始音频文件路径
   * @param bgmFilePath BGM文件路径
   * @param introDuration 前奏独立播放时长（秒）
   * @param outroDuration 结尾独立播放时长（秒）
   * @param format 音频格式
   * @param tempDir 临时目录
   * @returns 添加BGM后的音频文件路径
   */
  private static async addBgmToAudio(
    audioFile: string,
    bgmFilePath: string,
    introDuration: number,
    outroDuration: number,
    format: 'mp3' | 'ogg_opus' | 'pcm' | 'wav',
    tempDir: string
  ): Promise<string> {
    // 新的淡入淡出方案
    const bgmFadeToMidDuration = 1; // BGM从100%淡出到60%的时长
    const bgmFadeToZeroDuration = 8; // BGM从60%继续淡出到0%的时长（同时对话开始）
    const bgmMidVolume = 0.6; // BGM中间音量（60%）
    const totalFadeOutDuration = bgmFadeToMidDuration + bgmFadeToZeroDuration; // 总淡出时长 9秒
    
    // 淡入使用相同的逻辑（但方向相反）
    const bgmFadeInFromZeroDuration = 10; // BGM从0%淡入到60%（同时对话结束）
    const bgmFadeInToFullDuration = 1; // BGM从60%继续淡入到100%
    const totalFadeInDuration = bgmFadeInFromZeroDuration + bgmFadeInToFullDuration; // 总淡入时长 11秒

    // 确保时长参数是数字类型（防止字符串传入）
    const introSec = Number(introDuration);
    const outroSec = Number(outroDuration);
    
    if (isNaN(introSec) || isNaN(outroSec)) {
      throw new Error(`无效的BGM时长参数: intro=${introDuration}, outro=${outroDuration}`);
    }

    console.log(`🎼 添加BGM到音频（播客模式 - 新版自然过渡）...`);
    console.log(`   前奏BGM独立: ${introSec}秒 (BGM 100%)`);
    console.log(`   BGM淡出第一阶段: ${bgmFadeToMidDuration}秒 (BGM 100%→60%)`);
    console.log(`   BGM淡出第二阶段 + 对话开始: ${bgmFadeToZeroDuration}秒 (BGM 60%→0% + 对话淡入)`);
    console.log(`   中间纯对话: (对话100%，无BGM)`);
    console.log(`   对话淡出 + BGM淡入第一阶段: ${bgmFadeInFromZeroDuration}秒 (对话淡出 + BGM 0%→60%)`);
    console.log(`   BGM淡入第二阶段: ${bgmFadeInToFullDuration}秒 (BGM 60%→100%)`);
    console.log(`   结尾BGM独立: ${outroSec}秒 (BGM 100%)`);

    // 获取对话时长
    const dialogueDuration = await this.getAudioDuration(audioFile);
    // 总时长 = 前奏 + BGM第一阶段淡出 + 对话（含BGM第二阶段淡出和淡入） + BGM第二阶段淡入 + 结尾
    const totalDuration = introSec + bgmFadeToMidDuration + dialogueDuration + bgmFadeInToFullDuration + outroSec;
    console.log(`   对话时长: ${dialogueDuration.toFixed(2)}秒, 总时长: ${totalDuration.toFixed(2)}秒`);

    // 临时文件列表（用于最后清理）
    const tempFiles: string[] = [];
    
    try {
      // 1. 获取原始BGM的时长
      const originalBgmDuration = await this.getAudioDuration(bgmFilePath);
      console.log(`📏 原始BGM时长: ${originalBgmDuration.toFixed(2)}秒`);
      
      // 计算结尾需要的BGM时长（第二阶段淡入 + 结尾独立）
      const outroNeededDuration = bgmFadeInToFullDuration + outroSec;
      
      // 计算结尾BGM的起始位置（从BGM后面部分截取，保留自然结尾）
      let outroStartInOriginal = originalBgmDuration - outroNeededDuration;
      if (outroStartInOriginal < 0) {
        console.warn(`⚠️  BGM时长不足以提供完整结尾，将使用整个BGM: 需要${outroNeededDuration}秒，实际${originalBgmDuration}秒`);
        outroStartInOriginal = 0;
      }
      
      console.log(`🎵 BGM结尾策略: 使用原始BGM的自然结尾（${outroStartInOriginal.toFixed(2)}秒 → ${originalBgmDuration.toFixed(2)}秒）`);
      
      // 2. 准备中间部分的BGM（循环）- 不包含结尾
      console.log(`🔄 准备BGM音轨（前奏+中间循环部分）...`);
      const middleDuration = totalDuration - outroNeededDuration;
      const loopedBgmFile = path.join(tempDir, `looped_bgm_${uuid.v4()}.${format}`);
      tempFiles.push(loopedBgmFile);
      
      await new Promise<void>((resolve, reject) => {
        ffmpeg(this.normalizePath(bgmFilePath))
          .inputOptions(['-stream_loop', '-1']) // 无限循环
          .duration(middleDuration)
          .audioCodec(this.getAudioCodec(format))
          .format(format)
          .outputOptions([
            '-max_muxing_queue_size', '4096',
            '-avoid_negative_ts', 'make_zero',
            '-fflags', '+genpts',
            '-q:a', '0'
          ])
          .save(this.normalizePath(loopedBgmFile))
          .on('end', () => {
            console.log(`✅ BGM循环部分生成完成: ${middleDuration.toFixed(2)}秒`);
            resolve();
          })
          .on('error', (err) => {
            console.error(`❌ BGM循环错误: ${err.message}`);
            reject(err);
          });
      });

      // 3. 为对话前后添加静音
      console.log(`🔇 为对话添加前后静音...`);
      const paddedDialogueFile = path.join(tempDir, `padded_dialogue_${uuid.v4()}.${format}`);
      tempFiles.push(paddedDialogueFile);
      
      // 生成前置静音（前奏 + BGM第一阶段淡出）
      const frontSilenceFile = await this.generateSilence(introSec + bgmFadeToMidDuration, 24000, format, tempDir);
      tempFiles.push(frontSilenceFile);
      
      // 生成后置静音（BGM第二阶段淡入 + 结尾）
      const backSilenceFile = await this.generateSilence(bgmFadeInToFullDuration + outroSec, 24000, format, tempDir);
      tempFiles.push(backSilenceFile);
      
      // 拼接：前静音 + 对话 + 后静音
      const concatListFile = path.join(tempDir, `dialogue_concat_${uuid.v4()}.txt`);
      tempFiles.push(concatListFile);
      
      fs.writeFileSync(concatListFile, [
        `file '${this.normalizePath(frontSilenceFile)}'`,
        `file '${this.normalizePath(audioFile)}'`,
        `file '${this.normalizePath(backSilenceFile)}'`
      ].join('\n'));
      
      await new Promise<void>((resolve, reject) => {
        ffmpeg()
          .input(this.normalizePath(concatListFile))
          .inputOptions(['-f concat', '-safe 0'])
          .audioCodec(this.getAudioCodec(format))
          .format(format)
          .outputOptions([
            '-max_muxing_queue_size', '4096',
            '-avoid_negative_ts', 'make_zero',
            '-fflags', '+genpts',
            '-q:a', '0'
          ])
          .save(this.normalizePath(paddedDialogueFile))
          .on('end', () => {
            console.log(`✅ 对话静音填充完成`);
            resolve();
          })
          .on('error', (err) => {
            console.error(`❌ 对话拼接错误: ${err.message}`);
            reject(err);
          });
      });

      // 4. 分段处理BGM（前奏100% + 两阶段淡出 + 静音 + 两阶段淡入 + 自然结尾100%）
      console.log(`🎚️ 分段处理BGM...`);
      
      // 计算关键时间点
      const fadeToMidEnd = introSec + bgmFadeToMidDuration;  // BGM第一阶段淡出结束（到60%）
      const fadeToZeroEnd = fadeToMidEnd + bgmFadeToZeroDuration;  // BGM第二阶段淡出结束（到0%）
      const dialogueStart = introSec + bgmFadeToMidDuration;  // 对话开始时间（在BGM第二阶段淡出期间）
      const dialogueEnd = dialogueStart + dialogueDuration;  // 对话结束时间
      const fadeInFromZeroStart = dialogueEnd - bgmFadeInFromZeroDuration;  // BGM第一阶段淡入开始（从0%）
      const fadeInToFullStart = dialogueEnd;  // BGM第二阶段淡入开始（从60%到100%）
      const fadeInToFullEnd = fadeInToFullStart + bgmFadeInToFullDuration;  // BGM第二阶段淡入结束
      const silenceDuration = fadeInFromZeroStart - fadeToZeroEnd;  // 中间静音时长
      
      console.log(`   BGM时间轴:`);
      console.log(`   0-${introSec}s: 前奏 100%`);
      console.log(`   ${introSec}-${fadeToMidEnd}s: 第一阶段淡出 100%→60% (${bgmFadeToMidDuration}秒)`);
      console.log(`   ${fadeToMidEnd}-${fadeToZeroEnd}s: 第二阶段淡出 60%→0% (${bgmFadeToZeroDuration}秒)`);
      console.log(`   ${fadeToZeroEnd}-${fadeInFromZeroStart}s: 静音 ${silenceDuration.toFixed(1)}秒`);
      console.log(`   ${fadeInFromZeroStart}-${dialogueEnd}s: 第一阶段淡入 0%→60% (${bgmFadeInFromZeroDuration}秒)`);
      console.log(`   ${fadeInToFullStart}-${fadeInToFullEnd}s: 第二阶段淡入 60%→100% (${bgmFadeInToFullDuration}秒)`);
      console.log(`   ${fadeInToFullEnd}-${totalDuration}s: 结尾 100%`);
      console.log(`   对话时间轴:`);
      console.log(`   ${dialogueStart}s 对话开始 (BGM第二阶段淡出同时进行)`);
      console.log(`   ${dialogueEnd}s 对话结束 (BGM第二阶段淡入同时开始)`);
      
      // 4.1 前奏部分（100%音量）
      const introBgmPart = path.join(tempDir, `bgm_intro_${uuid.v4()}.${format}`);
      tempFiles.push(introBgmPart);
      await new Promise<void>((resolve, reject) => {
        ffmpeg(this.normalizePath(loopedBgmFile))
          .setStartTime(0)
          .duration(introSec)
          .audioCodec('copy')
          .save(this.normalizePath(introBgmPart))
          .on('end', () => resolve())
          .on('error', (err) => reject(err));
      });
      
      // 4.2 第一阶段淡出（100% → 60%）
      // 分两步：先提取全音量片段，再应用音量渐变
      const fadeToMidTempPart = path.join(tempDir, `bgm_temp_mid_${uuid.v4()}.${format}`);
      tempFiles.push(fadeToMidTempPart);
      
      // 第一步：提取片段（保持100%音量）
      await new Promise<void>((resolve, reject) => {
        ffmpeg(this.normalizePath(loopedBgmFile))
          .setStartTime(introSec)
          .duration(bgmFadeToMidDuration)
          .audioCodec('copy')
          .save(this.normalizePath(fadeToMidTempPart))
          .on('end', () => resolve())
          .on('error', (err) => reject(err));
      });
      
      // 第二步：应用音量渐变（从100%降到60%）
      const fadeToMidPart = path.join(tempDir, `bgm_fade_to_mid_${uuid.v4()}.${format}`);
      tempFiles.push(fadeToMidPart);
      await new Promise<void>((resolve, reject) => {
        // 计算音量减少量：从1.0到0.6，减少0.4
        const volumeDecrease = 1.0 - bgmMidVolume;
        ffmpeg(this.normalizePath(fadeToMidTempPart))
          .audioFilters(`volume=volume='1-${volumeDecrease}*t/${bgmFadeToMidDuration}':eval=frame`)
          .audioCodec(this.getAudioCodec(format))
          .outputOptions(['-q:a', '0'])
          .save(this.normalizePath(fadeToMidPart))
          .on('end', () => resolve())
          .on('error', (err) => reject(err));
      });
      
      // 4.3 第二阶段淡出（60% → 0%）
      const fadeToZeroTempPart = path.join(tempDir, `bgm_temp_zero_${uuid.v4()}.${format}`);
      tempFiles.push(fadeToZeroTempPart);
      
      // 第一步：提取片段
      await new Promise<void>((resolve, reject) => {
        ffmpeg(this.normalizePath(loopedBgmFile))
          .setStartTime(fadeToMidEnd)
          .duration(bgmFadeToZeroDuration)
          .audioCodec('copy')
          .save(this.normalizePath(fadeToZeroTempPart))
          .on('end', () => resolve())
          .on('error', (err) => reject(err));
      });
      
      // 第二步：先设置60%音量，然后完全淡出到0%
      const fadeToZeroPart = path.join(tempDir, `bgm_fade_to_zero_${uuid.v4()}.${format}`);
      tempFiles.push(fadeToZeroPart);
      await new Promise<void>((resolve, reject) => {
        ffmpeg(this.normalizePath(fadeToZeroTempPart))
          .audioFilters([
            `volume=${bgmMidVolume}`,
            `afade=t=out:st=0:d=${bgmFadeToZeroDuration}`
          ])
          .audioCodec(this.getAudioCodec(format))
          .outputOptions(['-q:a', '0'])
          .save(this.normalizePath(fadeToZeroPart))
          .on('end', () => resolve())
          .on('error', (err) => reject(err));
      });
      
      // 4.4 静音部分
      const silencePart = await this.generateSilence(silenceDuration, 24000, format, tempDir);
      tempFiles.push(silencePart);
      
      // 4.5 第一阶段淡入（0% → 60%）
      const fadeFromZeroTempPart = path.join(tempDir, `bgm_temp_from_zero_${uuid.v4()}.${format}`);
      tempFiles.push(fadeFromZeroTempPart);
      
      // 第一步：提取片段
      await new Promise<void>((resolve, reject) => {
        ffmpeg(this.normalizePath(loopedBgmFile))
          .setStartTime(fadeInFromZeroStart)
          .duration(bgmFadeInFromZeroDuration)
          .audioCodec('copy')
          .save(this.normalizePath(fadeFromZeroTempPart))
          .on('end', () => resolve())
          .on('error', (err) => reject(err));
      });
      
      // 第二步：先淡入到100%，然后降到60%音量
      const fadeFromZeroPart = path.join(tempDir, `bgm_fade_from_zero_${uuid.v4()}.${format}`);
      tempFiles.push(fadeFromZeroPart);
      await new Promise<void>((resolve, reject) => {
        ffmpeg(this.normalizePath(fadeFromZeroTempPart))
          .audioFilters([
            `afade=t=in:st=0:d=${bgmFadeInFromZeroDuration}`,
            `volume=${bgmMidVolume}`
          ])
          .audioCodec(this.getAudioCodec(format))
          .outputOptions(['-q:a', '0'])
          .save(this.normalizePath(fadeFromZeroPart))
          .on('end', () => resolve())
          .on('error', (err) => reject(err));
      });
      
      // 4.6 第二阶段淡入（60% → 100%）- 从原始BGM截取
      console.log(`🎵 提取BGM自然结尾（第二阶段淡入部分）...`);
      const fadeToFullTempPart = path.join(tempDir, `bgm_temp_to_full_${uuid.v4()}.${format}`);
      tempFiles.push(fadeToFullTempPart);
      
      // 第一步：从原始BGM提取片段（保留自然音质）
      await new Promise<void>((resolve, reject) => {
        ffmpeg(this.normalizePath(bgmFilePath))
          .setStartTime(outroStartInOriginal)
          .duration(bgmFadeInToFullDuration)
          .audioCodec('copy')
          .save(this.normalizePath(fadeToFullTempPart))
          .on('end', () => resolve())
          .on('error', (err) => reject(err));
      });
      
      // 第二步：应用音量渐变（从60%升到100%）
      const fadeToFullPart = path.join(tempDir, `bgm_fade_to_full_${uuid.v4()}.${format}`);
      tempFiles.push(fadeToFullPart);
      await new Promise<void>((resolve, reject) => {
        // 计算音量增加量：从0.6到1.0，增加0.4
        const volumeIncrease = 1.0 - bgmMidVolume;
        ffmpeg(this.normalizePath(fadeToFullTempPart))
          .audioFilters(`volume=volume='${bgmMidVolume}+${volumeIncrease}*t/${bgmFadeInToFullDuration}':eval=frame`)
          .audioCodec(this.getAudioCodec(format))
          .outputOptions(['-q:a', '0'])
          .save(this.normalizePath(fadeToFullPart))
          .on('end', () => resolve())
          .on('error', (err) => reject(err));
      });
      
      // 4.7 结尾部分（100%音量）- 从原始BGM截取自然结尾
      console.log(`🎵 提取BGM自然结尾（100%音量部分）...`);
      const outroBgmPart = path.join(tempDir, `bgm_outro_${uuid.v4()}.${format}`);
      tempFiles.push(outroBgmPart);
      const outroFullStart = outroStartInOriginal + bgmFadeInToFullDuration; // 第二阶段淡入之后
      const outroFullDuration = originalBgmDuration - outroFullStart; // 从这里到BGM真实结束
      
      console.log(`   从原始BGM ${outroFullStart.toFixed(2)}秒 提取到 ${originalBgmDuration.toFixed(2)}秒（时长: ${outroFullDuration.toFixed(2)}秒）`);
      
      await new Promise<void>((resolve, reject) => {
        ffmpeg(this.normalizePath(bgmFilePath))
          .setStartTime(outroFullStart)
          .duration(outroFullDuration)
          .audioCodec('copy')
          .save(this.normalizePath(outroBgmPart))
          .on('end', () => {
            console.log(`✅ BGM自然结尾提取完成`);
            resolve();
          })
          .on('error', (err) => reject(err));
      });
      
      // 4.8 拼接所有BGM部分
      console.log(`🔗 拼接BGM各部分...`);
      const processedBgmFile = path.join(tempDir, `processed_bgm_${uuid.v4()}.${format}`);
      tempFiles.push(processedBgmFile);
      
      const bgmConcatList = path.join(tempDir, `bgm_concat_${uuid.v4()}.txt`);
      tempFiles.push(bgmConcatList);
      
      fs.writeFileSync(bgmConcatList, [
        `file '${this.normalizePath(introBgmPart)}'`,
        `file '${this.normalizePath(fadeToMidPart)}'`,
        `file '${this.normalizePath(fadeToZeroPart)}'`,
        `file '${this.normalizePath(silencePart)}'`,
        `file '${this.normalizePath(fadeFromZeroPart)}'`,
        `file '${this.normalizePath(fadeToFullPart)}'`,
        `file '${this.normalizePath(outroBgmPart)}'`
      ].join('\n'));
      
      await new Promise<void>((resolve, reject) => {
        ffmpeg()
          .input(this.normalizePath(bgmConcatList))
          .inputOptions(['-f concat', '-safe 0'])
          .audioCodec(this.getAudioCodec(format))
          .format(format)
          .outputOptions([
            '-max_muxing_queue_size', '4096',
            '-avoid_negative_ts', 'make_zero',
            '-fflags', '+genpts',
            '-q:a', '0'
          ])
          .save(this.normalizePath(processedBgmFile))
          .on('start', (cmdLine) => {
            console.log(`   拼接命令: ${cmdLine.substring(0, 100)}...`);
          })
          .on('end', () => {
            console.log(`✅ BGM处理完成（前奏→淡出60%→淡出0%→静音→淡入60%→淡入100%→自然结尾）`);
            resolve();
          })
          .on('error', (err) => {
            console.error(`❌ BGM拼接错误: ${err.message}`);
            reject(err);
          });
      });

      // 5. 混音：BGM + 对话（调整音量平衡，确保人声清晰）
      console.log(`🎵 混音BGM和对话...`);
      
      // 从配置文件读取混音音量配置
      const podcastConfigPath = path.join(__dirname, '../config/podcast.config.json');
      let bgmVolume = 0.25;  // 默认BGM音量25%
      let voiceVolume = 1.0; // 默认人声音量100%
      
      try {
        const podcastConfig = JSON.parse(fs.readFileSync(podcastConfigPath, 'utf-8'));
        if (podcastConfig.audio_mixing) {
          bgmVolume = podcastConfig.audio_mixing.bgm_volume || 0.25;
          voiceVolume = podcastConfig.audio_mixing.voice_volume || 1.0;
        }
      } catch (e) {
        console.warn(`⚠️  无法读取混音配置，使用默认值`);
      }
      
      console.log(`   音量平衡: 人声 ${(voiceVolume * 100).toFixed(0)}% | BGM ${(bgmVolume * 100).toFixed(0)}%（背景音乐柔和）`);
      const finalOutput = path.join(tempDir, `with_bgm_final_${uuid.v4()}.${format}`);
      
      await new Promise<void>((resolve, reject) => {
        const cmd = ffmpeg()
          .input(this.normalizePath(processedBgmFile))
          .input(this.normalizePath(paddedDialogueFile))
          .complexFilter([
            // 先设置各自音量，然后混音
            // BGM作为背景，人声清晰可闻
            `[0:a]volume=${bgmVolume}[bgm]`,
            `[1:a]volume=${voiceVolume}[voice]`,
            '[bgm][voice]amix=inputs=2:duration=longest:dropout_transition=0[outa]'
          ])
          .outputOptions(['-map', '[outa]'])
          .audioCodec(this.getAudioCodec(format))
          .format(format);
        
        // 添加质量参数
        const qualityOptions = this.getQualityOptions(format);
        if (qualityOptions.length > 0) {
          cmd.outputOptions(qualityOptions);
        }
        
        // 优化输出选项，避免"Result too large"错误
        cmd.outputOptions([
          '-max_muxing_queue_size', '4096',
          '-avoid_negative_ts', 'make_zero',
          '-fflags', '+genpts'
        ]);
        
        cmd.save(this.normalizePath(finalOutput))
          .on('start', (commandLine) => {
            console.log(`   执行命令: ${commandLine.substring(0, 200)}...`);
          })
          .on('end', () => {
            console.log(`✅ 混音完成`);
            resolve();
          })
          .on('error', (err) => {
            console.error(`❌ 混音错误: ${err.message}`);
            reject(err);
          });
      });

      // 6. 清理临时文件
      console.log(`🧹 清理临时文件...`);
      tempFiles.forEach(file => {
        if (fs.existsSync(file)) {
          try {
            fs.unlinkSync(file);
          } catch (e) {
            console.warn(`⚠️  删除临时文件失败: ${file}`);
          }
        }
      });

      console.log(`✅ BGM处理完成（前奏 → 淡出60% → 淡出0%+对话 → 纯对话 → 对话+淡入60% → 淡入100% → 自然结尾 🎵）`);
      return finalOutput;
      
    } catch (error: any) {
      // 出错时清理临时文件
      console.error(`❌ BGM处理失败: ${error.message}`);
      tempFiles.forEach(file => {
        if (fs.existsSync(file)) {
          try {
            fs.unlinkSync(file);
          } catch (e) {}
        }
      });
      throw new Error(`混音失败: ${error.message}`);
    }
  }

  /**
   * 获取音频文件时长（秒）
   */
  private static async getAudioDuration(audioFile: string): Promise<number> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(this.normalizePath(audioFile), (err, metadata) => {
        if (err) {
          reject(err);
        } else {
          const duration = metadata.format.duration || 0;
          resolve(duration);
        }
      });
    });
  }

  /**
   * 获取音频Buffer的时长（秒）
   * 通过写入临时文件然后使用 ffprobe 获取时长
   */
  static async getAudioBufferDuration(
    audioBuffer: Buffer,
    format: 'mp3' | 'ogg_opus' | 'pcm' | 'wav'
  ): Promise<number> {
    const tempDir = path.join(process.cwd(), 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const tempFile = path.join(tempDir, `temp_duration_${uuid.v4()}.${format}`);
    
    try {
      // 写入临时文件
      fs.writeFileSync(tempFile, audioBuffer);
      
      // 获取时长
      const duration = await this.getAudioDuration(tempFile);
      
      return duration;
    } finally {
      // 清理临时文件
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    }
  }

  /**
   * 生成完整播客音频
   */
  static async generatePodcastAudio(
    dialogue: PodcastDialogue[],
    taskId?: number,
    options?: {
      format?: 'mp3' | 'ogg_opus' | 'pcm' | 'wav';
      sampleRate?: number;
      speechRate?: number;
      onProgress?: (current: number, total: number) => void;
      bgmFile?: string;
      introMusicDuration?: number;
      outroMusicDuration?: number;
    }
  ): Promise<Buffer> {
    console.log(`🎬 生成播客音频 - ${dialogue.length}段对话`);

    const format = options?.format || 'mp3';

    // 步骤1: 批量合成所有对话
    const segments = await this.synthesizeDialogue(dialogue, taskId, options);

    // 步骤2: 合并音频片段（不进行音量标准化）
    let audioBuffer = await this.mergeAudioSegments(segments, dialogue, format);

    // 步骤3: 如果有BGM配置，添加BGM
    if (options?.bgmFile && options?.introMusicDuration && options?.outroMusicDuration) {
      console.log(`🎵 添加BGM: ${options.bgmFile}`);
      
      const normConfig = this.loadNormalizationConfig();
      const tempDir = path.join(process.cwd(), normConfig.processing.tempDir);
      
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      // 将对话音频写入临时文件
      const dialogueFile = path.join(tempDir, `dialogue_${uuid.v4()}.${format}`);
      fs.writeFileSync(dialogueFile, audioBuffer);

      try {
        // 获取BGM文件路径
        const bgmFilePath = this.getBgmFilePath(options.bgmFile);

        // 添加BGM
        const withBgmFile = await this.addBgmToAudio(
          dialogueFile,
          bgmFilePath,
          options.introMusicDuration,
          options.outroMusicDuration,
          format,
          tempDir
        );

        // 读取添加BGM后的音频
        audioBuffer = fs.readFileSync(withBgmFile);

        // 清理临时文件
        [dialogueFile, withBgmFile].forEach(file => {
          if (fs.existsSync(file)) {
            fs.unlinkSync(file);
          }
        });

        console.log(`✅ BGM添加完成`);

      } catch (error: any) {
        console.error(`❌ 添加BGM失败: ${error.message}`);
        console.warn(`⚠️  降级为无BGM版本`);
        
        // 清理临时文件
        if (fs.existsSync(dialogueFile)) {
          fs.unlinkSync(dialogueFile);
        }
        
        // 继续使用无BGM的音频
      }
    }

    // 步骤4: 最后对整体音频进行音量标准化（在所有内容处理完成后）
    console.log(`\n📊 最终处理阶段...`);
    const finalAudio = await this.normalizeAudioFinal(audioBuffer, format);

    console.log(`🎉 播客音频生成完成!`);
    return finalAudio;
  }

  /**
   * 延迟函数
   */
  private static delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 验证配置
   */
  static validateConfig(): void {
    if (!this.APP_ID) {
      throw new Error('TTS_APP_ID 未配置');
    }
    if (!this.ACCESS_TOKEN) {
      throw new Error('TTS_ACCESS_TOKEN 未配置');
    }
    console.log('✅ TTS 配置验证通过');
  }
}

