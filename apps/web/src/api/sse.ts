export interface SseMessage {
  event: string;
  data: string;
}

/** Incremental parser for a text/event-stream body; comments and keep-alives are dropped. */
export class SseParser {
  private buffer = '';

  push(chunk: string): SseMessage[] {
    this.buffer += chunk.replace(/\r\n/g, '\n');
    const messages: SseMessage[] = [];
    let index: number;
    while ((index = this.buffer.indexOf('\n\n')) >= 0) {
      const block = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) {
          event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''));
        }
      }
      if (data.length > 0) {
        messages.push({ event, data: data.join('\n') });
      }
    }
    return messages;
  }
}
