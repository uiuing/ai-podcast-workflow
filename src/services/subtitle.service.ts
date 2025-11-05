import * as fs from 'fs';
import * as path from 'path';
import { PodcastDialogue, PodcastSpeaker } from '../types/podcast.types';

/**
 * 字幕条目
 */
export interface SubtitleEntry {
  index: number;
  startTime: string;  // HH:MM:SS,mmm
  endTime: string;    // HH:MM:SS,mmm
  speaker: string;
  text: string;
}

/**
 * 字幕生成服务
 */
export class SubtitleService {
  /**
   * 生成 SRT 字幕文件
   * @param dialogue 对话内容
   * @param speakers 说话人信息
   * @param outputPath 输出文件路径
   * @param introDuration 前奏时长（秒）
   * @param audioDuration 总音频时长（秒）
   */
  static generateSRT(
    dialogue: PodcastDialogue[],
    speakers: PodcastSpeaker[],
    outputPath: string,
    introDuration: number = 0,
    audioDuration?: number
  ): void {
    const entries: SubtitleEntry[] = [];
    let currentTime = introDuration; // 从前奏结束开始

    // 估算每个字符的平均发音时长（秒/字）
    // 中文正常语速约 4-5 字/秒，这里取 0.2 秒/字
    const secondsPerChar = 0.2;

    dialogue.forEach((item, index) => {
      const textLength = item.text.length;
      const estimatedDuration = textLength * secondsPerChar;
      const pauseAfter = item.pause_after || 0.5; // 默认停顿 0.5 秒

      const startTime = currentTime;
      const endTime = currentTime + estimatedDuration;

      entries.push({
        index: index + 1,
        startTime: this.formatTime(startTime),
        endTime: this.formatTime(endTime),
        speaker: item.speaker,
        text: item.text
      });

      // 更新当前时间：对话时长 + 停顿时长
      currentTime = endTime + pauseAfter;
    });

    // 生成 SRT 内容
    const srtContent = this.generateSRTContent(entries);

    // 写入文件
    fs.writeFileSync(outputPath, srtContent, 'utf-8');
  }

  /**
   * 生成 VTT 字幕文件（WebVTT 格式）
   * @param dialogue 对话内容
   * @param speakers 说话人信息
   * @param outputPath 输出文件路径
   * @param introDuration 前奏时长（秒）
   * @param audioDuration 总音频时长（秒）
   */
  static generateVTT(
    dialogue: PodcastDialogue[],
    speakers: PodcastSpeaker[],
    outputPath: string,
    introDuration: number = 0,
    audioDuration?: number
  ): void {
    const entries: SubtitleEntry[] = [];
    let currentTime = introDuration;

    const secondsPerChar = 0.2;

    dialogue.forEach((item, index) => {
      const textLength = item.text.length;
      const estimatedDuration = textLength * secondsPerChar;
      const pauseAfter = item.pause_after || 0.5;

      const startTime = currentTime;
      const endTime = currentTime + estimatedDuration;

      entries.push({
        index: index + 1,
        startTime: this.formatTimeVTT(startTime),
        endTime: this.formatTimeVTT(endTime),
        speaker: item.speaker,
        text: item.text
      });

      currentTime = endTime + pauseAfter;
    });

    // 生成 VTT 内容
    const vttContent = this.generateVTTContent(entries);

    // 写入文件
    fs.writeFileSync(outputPath, vttContent, 'utf-8');
  }

  /**
   * 生成 TXT 纯文本字幕（带时间戳和说话人）
   * @param dialogue 对话内容
   * @param speakers 说话人信息
   * @param outputPath 输出文件路径
   * @param introDuration 前奏时长（秒）
   */
  static generateTXT(
    dialogue: PodcastDialogue[],
    speakers: PodcastSpeaker[],
    outputPath: string,
    introDuration: number = 0
  ): void {
    let content = '';
    let currentTime = introDuration;

    const secondsPerChar = 0.2;

    dialogue.forEach((item, index) => {
      const textLength = item.text.length;
      const estimatedDuration = textLength * secondsPerChar;
      const pauseAfter = item.pause_after || 0.5;

      const startTime = currentTime;
      const timeStr = this.formatTime(startTime);

      // 格式：[HH:MM:SS,mmm] 说话人：文本内容
      content += `[${timeStr}] ${item.speaker}：${item.text}\n\n`;

      currentTime = startTime + estimatedDuration + pauseAfter;
    });

    fs.writeFileSync(outputPath, content.trim(), 'utf-8');
  }

  /**
   * 格式化时间为 SRT 格式：HH:MM:SS,mmm
   */
  private static formatTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const milliseconds = Math.floor((seconds % 1) * 1000);

    return `${this.pad(hours, 2)}:${this.pad(minutes, 2)}:${this.pad(secs, 2)},${this.pad(milliseconds, 3)}`;
  }

  /**
   * 格式化时间为 VTT 格式：HH:MM:SS.mmm
   */
  private static formatTimeVTT(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const milliseconds = Math.floor((seconds % 1) * 1000);

    return `${this.pad(hours, 2)}:${this.pad(minutes, 2)}:${this.pad(secs, 2)}.${this.pad(milliseconds, 3)}`;
  }

  /**
   * 数字补零
   */
  private static pad(num: number, length: number): string {
    return num.toString().padStart(length, '0');
  }

  /**
   * 生成 SRT 内容
   */
  private static generateSRTContent(entries: SubtitleEntry[]): string {
    return entries.map(entry => {
      return [
        entry.index,
        `${entry.startTime} --> ${entry.endTime}`,
        `${entry.speaker}：${entry.text}`,
        '' // 空行分隔
      ].join('\n');
    }).join('\n');
  }

  /**
   * 生成 VTT 内容
   */
  private static generateVTTContent(entries: SubtitleEntry[]): string {
    const header = 'WEBVTT\n\n';
    const body = entries.map(entry => {
      return [
        entry.index,
        `${entry.startTime} --> ${entry.endTime}`,
        `<v ${entry.speaker}>${entry.text}`,
        '' // 空行分隔
      ].join('\n');
    }).join('\n');

    return header + body;
  }

  /**
   * 生成所有格式的字幕文件
   * @param dialogue 对话内容
   * @param speakers 说话人信息
   * @param basePath 基础文件路径（不含扩展名）
   * @param introDuration 前奏时长（秒）
   * @param audioDuration 总音频时长（秒）
   */
  static generateAllFormats(
    dialogue: PodcastDialogue[],
    speakers: PodcastSpeaker[],
    basePath: string,
    introDuration: number = 0,
    audioDuration?: number
  ): {
    srt: string;
    vtt: string;
    txt: string;
  } {
    const srt = `${basePath}.srt`;
    const vtt = `${basePath}.vtt`;
    const txt = `${basePath}.txt`;

    this.generateSRT(dialogue, speakers, srt, introDuration, audioDuration);
    this.generateVTT(dialogue, speakers, vtt, introDuration, audioDuration);
    this.generateTXT(dialogue, speakers, txt, introDuration);

    return { srt, vtt, txt };
  }
}

