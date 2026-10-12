import { randomUUID } from 'crypto';
import type * as vscode from 'vscode';

/** 一条会话消息（只存文本；不存 schema 上下文原文，避免 Memento 膨胀）。 */
export interface AiChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** 该条为错误提示（如上游失败），渲染为警示样式且不进入后续请求上下文。 */
  error?: boolean;
}

export interface AiChatSession {
  id: string;
  title: string;
  messages: AiChatMessage[];
  updatedAt: number;
  /** 最近一次发送时绑定的连接（仅会话元数据，用于切换时恢复上下文条）。 */
  connId?: string;
}

/**
 * 会话历史存储（P9 S3）：本地 Memento `devbelt.ai.chatSessions`，不进 E2EE 同步。
 *
 * 上限：20 个会话（超出按 updatedAt 淘汰最旧）、单会话 200 条消息、
 * 单条内容 100K 字符——Memento 是整键 JSON 读写，必须设界。
 */
const STORAGE_KEY = 'devbelt.ai.chatSessions';
const MAX_SESSIONS = 20;
const MAX_MESSAGES_PER_SESSION = 200;
const MAX_MESSAGE_CHARS = 100_000;
const TITLE_CHARS = 30;

function normalizeMessage(message: AiChatMessage): AiChatMessage {
  return {
    role: message.role,
    content: message.content.length > MAX_MESSAGE_CHARS ? message.content.slice(0, MAX_MESSAGE_CHARS) : message.content,
    ...(message.error ? { error: true as const } : {}),
  };
}

function normalizeSession(session: AiChatSession): AiChatSession {
  return {
    id: session.id,
    title: session.title,
    messages: session.messages.slice(-MAX_MESSAGES_PER_SESSION).map(normalizeMessage),
    updatedAt: session.updatedAt,
    ...(session.connId ? { connId: session.connId } : {}),
  };
}

export class AiSessionStore {
  constructor(private readonly memento: vscode.Memento) {}

  /** 按最近更新倒序列出全部会话。 */
  list(): AiChatSession[] {
    const stored = this.memento.get<AiChatSession[]>(STORAGE_KEY, []);
    return stored
      .filter((s) => s && typeof s.id === 'string' && Array.isArray(s.messages))
      .map(normalizeSession)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): AiChatSession | undefined {
    return this.list().find((s) => s.id === id);
  }

  create(connId?: string): AiChatSession {
    const session: AiChatSession = {
      id: randomUUID(),
      title: '',
      messages: [],
      updatedAt: Date.now(),
      ...(connId ? { connId } : {}),
    };
    this.persist([session, ...this.list()]);
    return session;
  }

  /** 保存（upsert）并重排；超出上限淘汰最旧。 */
  save(session: AiChatSession): void {
    const normalized = normalizeSession({ ...session, updatedAt: Number.isFinite(session.updatedAt) ? session.updatedAt : Date.now() });
    const rest = this.list().filter((s) => s.id !== normalized.id);
    this.persist([normalized, ...rest]);
  }

  rename(id: string, title: string): void {
    const session = this.get(id);
    if (!session) return;
    session.title = title.trim().slice(0, 80);
    session.updatedAt = Date.now();
    this.save(session);
  }

  delete(id: string): void {
    this.persist(this.list().filter((s) => s.id !== id));
  }

  /** 首次用户消息 → 会话标题（空白/多行折叠，截断 30 字符）。 */
  static titleFromFirstMessage(text: string): string {
    const single = text.replace(/\s+/g, ' ').trim();
    return single.length > TITLE_CHARS ? `${single.slice(0, TITLE_CHARS - 1)}…` : single;
  }

  private persist(sessions: AiChatSession[]): void {
    void this.memento.update(STORAGE_KEY, sessions.slice(0, MAX_SESSIONS).map(normalizeSession));
  }
}