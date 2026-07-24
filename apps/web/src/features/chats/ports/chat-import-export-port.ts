import type { ChatDocument } from '../domain/chat';

export interface ChatImportContext {
  fileType: 'json' | 'jsonl';
  userName: string;
  characterName: string;
}

export interface ChatImportExportPort {
  import(file: Blob, context: ChatImportContext): Promise<ChatDocument[]>;
  export(document: ChatDocument, format: 'jsonl' | 'txt'): string;
}
