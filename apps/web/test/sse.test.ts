import { describe, expect, it } from 'vitest';
import { SseParser } from '../src/api/sse';

describe('SseParser', () => {
  it('parses events split across chunks and drops comments', () => {
    const parser = new SseParser();
    expect(parser.push(': connected\n\nevent: run\nda')).toEqual([]);
    expect(
      parser.push('ta: {"id":"1"}\n\n: keepalive\n\nevent: issue\ndata: {"id":"2"}\n\n'),
    ).toEqual([
      { event: 'run', data: '{"id":"1"}' },
      { event: 'issue', data: '{"id":"2"}' },
    ]);
  });

  it('handles CRLF line endings and multi-line data', () => {
    const parser = new SseParser();
    expect(parser.push('event: x\r\ndata: a\r\ndata: b\r\n\r\n')).toEqual([
      { event: 'x', data: 'a\nb' },
    ]);
  });
});
