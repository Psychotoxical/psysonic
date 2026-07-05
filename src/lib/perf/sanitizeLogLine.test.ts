import { describe, expect, it } from 'vitest';
import { sanitizeLogLine } from '@/lib/perf/sanitizeLogLine';

describe('sanitizeLogLine', () => {
  it('redacts Subsonic wire-auth query params', () => {
    const line = 'GET https://music.example.com/rest/stream.view?id=1&t=abc&s=def&p=ghi';
    const out = sanitizeLogLine(line);
    expect(out).toContain('t=REDACTED');
    expect(out).toContain('s=REDACTED');
    expect(out).toContain('p=REDACTED');
    expect(out).not.toContain('abc');
  });

  it('masks remote hostnames but keeps LAN IPs', () => {
    const remote = sanitizeLogLine('connect https://my-server.example.com:4533/rest/ping');
    expect(remote).toContain('my****.example.com');
    expect(remote).not.toContain('my-server.example.com');

    const lan = sanitizeLogLine('connect http://192.168.1.42:4533/rest/ping');
    expect(lan).toContain('192.168.1.42');
  });

  it('handles stream logs with em dashes (UTF-8 safe)', () => {
    const line = '[stream] RangedHttpSource selected — total=15666KB, hint=Some("mp3")';
    expect(() => sanitizeLogLine(line)).not.toThrow();
    expect(sanitizeLogLine(line)).toContain('—');
  });

  it('redacts bearer tokens and password key/value pairs', () => {
    const line = 'auth header Bearer eyJhbGciOiJIUzI1NiJ9.xyz password=sekrit';
    const out = sanitizeLogLine(line);
    expect(out).toContain('Bearer REDACTED');
    expect(out).not.toContain('eyJhbGci');
    expect(out).toContain('password=REDACTED');
    expect(out).not.toContain('sekrit');
  });

  it('redacts reverse-proxy gate header values', () => {
    const line = 'req CF-Access-Client-Secret: gate-secret Authorization: Bearer tok123 x-pangolin-auth: pangolin-key';
    const out = sanitizeLogLine(line);
    expect(out).toContain('CF-Access-Client-Secret: REDACTED');
    expect(out).not.toContain('gate-secret');
    expect(out).not.toContain('tok123');
    expect(out).toContain('x-pangolin-auth: REDACTED');
    expect(out).not.toContain('pangolin-key');
    expect(out).not.toMatch(/Authorization:\s*Bearer\s+\S/i);
  });
});
