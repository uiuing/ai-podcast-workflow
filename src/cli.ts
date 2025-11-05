#!/usr/bin/env node

import { Command } from 'commander';
import * as readline from 'readline';
import { WorkflowService } from './services/workflow.service';
import { PodcastService } from './services/podcast.service';
import * as path from 'path';
import * as fs from 'fs';
import dotenv from 'dotenv';

// 加载环境变量
dotenv.config();

const program = new Command();

/**
 * CLI 入口
 */
program
  .name('ai-podcast')
  .description('🎙️ AI 播客工作流 - 自动生成高质量播客内容')
  .version('1.0.0');

program
  .option('-i, --input <text>', '播客主题（必填）')
  .option('-f, --format <type>', '播客格式: brief | standard | deep', 'standard')
  .option('-s, --style <type>', '播客风格', 'interview')
  .option('-o, --output <dir>', '输出目录', './output')
  .option('-v, --verbose', '显示详细日志', false)
  .action(async (options) => {
    try {
      // 检查环境变量配置
      checkEnvironmentConfig();

      // 如果没有提供输入，进入交互式模式
      if (!options.input) {
        await interactiveMode(options);
      } else {
        await runWorkflow(options);
      }
    } catch (error: any) {
      console.error('\n❌ 错误:', error.message);
      process.exit(1);
    }
  });

program.parse();

/**
 * 检查环境变量配置
 */
function checkEnvironmentConfig(): void {
  const requiredEnvVars = [
    'DOUBAO_API_KEY',
    'IMAGE_API_KEY',
    'TTS_APP_ID',
    'TTS_ACCESS_TOKEN'
  ];

  const missingVars: string[] = [];

  for (const varName of requiredEnvVars) {
    if (!process.env[varName]) {
      missingVars.push(varName);
    }
  }

  if (missingVars.length > 0) {
    console.error('❌ 缺少必要的环境变量配置:');
    missingVars.forEach(v => console.error(`   - ${v}`));
    console.error('\n💡 请复制 .env.example 为 .env 并填入你的 API 密钥');
    process.exit(1);
  }
}

/**
 * 交互式模式
 */
async function interactiveMode(options: any): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const question = (prompt: string): Promise<string> => {
    return new Promise((resolve) => {
      rl.question(prompt, resolve);
    });
  };

  try {
    // 显示欢迎信息
    console.log('\n🎙️ ' + '='.repeat(50));
    console.log('   AI 播客工作流 - 交互式生成');
    console.log('='.repeat(52) + '\n');

    // 获取用户输入
    const input = await question('📝 请输入播客主题: ');
    
    if (!input.trim()) {
      console.error('❌ 主题不能为空');
      process.exit(1);
    }

    // 选择格式
    console.log('\n📋 选择播客格式:');
    console.log('   1. 快闪洞察 (5-10分钟, 1200-2000字)');
    console.log('   2. 沉浸解读 (10-15分钟, 2000-3000字) [推荐]');
    console.log('   3. 透彻剖析 (15-20分钟, 3000-4000字)');
    
    const formatChoice = await question('\n请选择 (1-3, 默认2): ');
    const formatMap: { [key: string]: string } = {
      '1': 'brief',
      '2': 'standard',
      '3': 'deep',
      '': 'standard'
    };
    const format = formatMap[formatChoice.trim()] || 'standard';

    // 选择风格
    console.log('\n🎨 选择播客风格:');
    console.log('   1. 幽默对谈 - 轻松愉快的双人对话');
    console.log('   2. 吐槽漫谈 - 日式漫才风格，在欢笑中学习');
    console.log('   3. 故事剧场 - 用引人入胜的故事串联知识');
    console.log('   4. 深度访谈 - 专业而不失温度的深度对话 [推荐]');
    console.log('   5. 思辨论坛 - 多角度碰撞，激发批判性思维');
    console.log('   6. 实战课堂 - 手把手教学，边听边学');
    console.log('   7. 纪实探索 - 纪录片式深度探究');
    console.log('   8. 热点解读 - 从热点事件切入，深挖背后知识');
    console.log('   9. 深夜电台 - 温柔治愈的深夜陪伴');
    
    const styleChoice = await question('\n请选择 (1-9, 默认4): ');
    const styleMap: { [key: string]: string } = {
      '1': 'humorous_dialogue',
      '2': 'manzai',
      '3': 'storytelling',
      '4': 'interview',
      '5': 'debate',
      '6': 'tutorial',
      '7': 'documentary',
      '8': 'hot_topic',
      '9': 'midnight_radio',
      '': 'interview'
    };
    const style = styleMap[styleChoice.trim()] || 'interview';

    rl.close();

    // 执行工作流
    await runWorkflow({
      input: input.trim(),
      format,
      style,
      output: options.output,
      verbose: options.verbose
    });

  } catch (error) {
    rl.close();
    throw error;
  }
}

/**
 * 运行工作流
 */
async function runWorkflow(options: any): Promise<void> {
  const { input, format, style, output, verbose } = options;

  // 验证格式和风格
  const formatObj = PodcastService.getFormatById(format);
  const styleObj = PodcastService.getStyleById(style);

  if (!formatObj) {
    throw new Error(`无效的播客格式: ${format}`);
  }

  if (!styleObj) {
    throw new Error(`无效的播客风格: ${style}`);
  }

  // 创建输出目录
  const outputDir = path.resolve(output);
  const audiosDir = path.join(outputDir, 'audios');
  const coversDir = path.join(outputDir, 'covers');

  if (!fs.existsSync(audiosDir)) {
    fs.mkdirSync(audiosDir, { recursive: true });
  }
  if (!fs.existsSync(coversDir)) {
    fs.mkdirSync(coversDir, { recursive: true });
  }

  // 显示工作流开始信息
  printHeader();
  console.log('📝 输入主题:', input);
  console.log('📋 播客格式:', `${formatObj.name} (${formatObj.audio_duration})`);
  console.log('🎨 播客风格:', styleObj.name);
  console.log('📁 输出目录:', outputDir);
  console.log('');

  // 执行工作流
  const startTime = Date.now();
  
  const result = await WorkflowService.execute({
    userInput: input,
    formatId: format,
    styleId: style,
    outputDir,
    verbose
  });

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

  // 显示完成信息
  printSuccess(result, totalTime);
}

/**
 * 打印头部
 */
function printHeader(): void {
  console.log('\n' + '='.repeat(60));
  console.log('🚀 AI 播客工作流 - 开始生成');
  console.log('='.repeat(60) + '\n');
}

/**
 * 打印成功信息
 */
function printSuccess(result: any, totalTime: string): void {
  console.log('\n' + '='.repeat(60));
  console.log('✅ 播客生成完成！');
  console.log('='.repeat(60) + '\n');

  console.log('📊 成本统计');
  console.log(`   AI 文本生成: ¥${result.cost.textCost.toFixed(4)}`);
  console.log(`   封面图生成: ¥${result.cost.imageCost.toFixed(4)}`);
  console.log(`   TTS 音频合成: ¥${result.cost.audioCost.toFixed(4)}`);
  console.log('   ' + '─'.repeat(30));
  console.log(`   总计: ¥${result.cost.totalCost.toFixed(4)}`);
  console.log('');

  console.log('📁 输出文件');
  console.log(`   🎵 音频: ${result.audioPath}`);
  console.log(`   🖼️  封面: ${result.coverPath}`);
  console.log(`   📝 字幕 (SRT): ${result.subtitlePaths.srt}`);
  console.log(`   📝 字幕 (VTT): ${result.subtitlePaths.vtt}`);
  console.log(`   📝 字幕 (TXT): ${result.subtitlePaths.txt}`);
  console.log('');

  console.log('⏱️  总用时:', totalTime, '秒');
  console.log('');

  console.log('🎉 完成！可以开始收听你的 AI 播客啦！');
  console.log('');
}

// 如果直接运行此文件
if (require.main === module) {
  // 已经由 commander 处理
}

