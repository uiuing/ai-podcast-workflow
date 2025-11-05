// 播客说话人
export interface PodcastSpeaker {
  name: string;
  role: string;
  personality: string;
}

// 播客对话项
export interface PodcastDialogue {
  speaker: string;
  text: string;
  pause_after?: number; // 这段对话后的停顿时长（秒），由AI根据内容判断，范围0.3-2.0秒
}

// 播客生成结果
export interface PodcastGenerationResult {
  outline: string;
  title: string;
  description: string;
  categories: string[];
  related_topics: string[];
  speakers: PodcastSpeaker[];
  dialogue: PodcastDialogue[];
  cover_prompt: string;
  intro_music_duration: number; // 前奏音乐时长（秒），范围5-12秒
  outro_music_duration: number; // 结尾音乐时长（秒），范围5-12秒
  bgm_file: string; // 背景音乐文件名（开头和结尾使用同一个）
}

// 大模型响应(新格式)
export interface DoubaoResponse {
  id: string;
  object: string;
  created_at: number;
  model: string;
  status: string;
  output: Array<{
    type: string;
    role: string;
    content: Array<{
      type: string;
      text?: string;
    }>;
    status: string;
    id: string;
  }>;
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

// 任务状态
export enum TaskStatus {
  PENDING = 'pending',           // 等待中
  GENERATING = 'generating',     // AI生成中
  GENERATED = 'generated',       // AI生成完成
  PROCESSING = 'processing',     // 后处理中
  COMPLETED = 'completed',       // 完成
  FAILED = 'failed'             // 失败
}

// 任务步骤
export enum TaskStep {
  AI_GENERATION = 'ai_generation',       // AI生成对话
  COVER_GENERATION = 'cover_generation', // 生成封面
  AUDIO_GENERATION = 'audio_generation', // 生成音频
  FINALIZATION = 'finalization'          // 最终处理
}

// 创建任务请求
export interface CreatePodcastTaskRequest {
  user_input: string;
  format_id: string;
  style_id: string;
}

// 任务数据库记录(任务调度表)
export interface PodcastTask {
  id: number;
  user_id: number;
  user_input: string;
  format_id: string;
  format_name: string;
  style_id: string;
  style_name: string;
  status: TaskStatus;
  current_step: TaskStep | null;
  error_message: string | null;
  retry_count: number;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

