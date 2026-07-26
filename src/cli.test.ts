import { describe, it, expect } from 'vitest';
import { parseArgs } from './cli.js';

/** The parser is pure (no IO); these pin every branch of the dispatch. */
describe('parseArgs', () => {
  describe('global flags', () => {
    it('no args → help', () => {
      expect(parseArgs([])).toEqual({ cmd: 'help' });
    });
    it('--help / -h → help', () => {
      expect(parseArgs(['--help'])).toEqual({ cmd: 'help' });
      expect(parseArgs(['-h'])).toEqual({ cmd: 'help' });
    });
    it('--version / -v → version', () => {
      expect(parseArgs(['--version'])).toEqual({ cmd: 'version' });
      expect(parseArgs(['-v'])).toEqual({ cmd: 'version' });
    });
  });

  describe('mcp', () => {
    it('subcommand mcp', () => {
      expect(parseArgs(['mcp'])).toEqual({ cmd: 'mcp' });
    });
  });

  describe('host', () => {
    it('parses a command after "--"', () => {
      expect(parseArgs(['host', '--', 'claude'])).toEqual({
        cmd: 'host',
        command: ['claude'],
      });
    });
    it('parses flags before "--" and a multi-arg command after', () => {
      expect(parseArgs(['host', '--port', '1234', '--name', 'ada', '--', 'python', '-i'])).toEqual({
        cmd: 'host',
        command: ['python', '-i'],
        port: 1234,
        name: 'ada',
      });
    });
    it('treats everything after "--" as opaque (no flag interception)', () => {
      // `claude --version` is the wrapped command, NOT vibelive's --version.
      expect(parseArgs(['host', '--', 'claude', '--version'])).toEqual({
        cmd: 'host',
        command: ['claude', '--version'],
      });
    });
    it('errors when no command is given', () => {
      expect(parseArgs(['host', '--'])).toEqual({ cmd: 'error', message: expect.any(String) });
      expect(parseArgs(['host'])).toEqual({ cmd: 'error', message: expect.any(String) });
    });
    it('errors on a bad port', () => {
      expect(parseArgs(['host', '--port', 'abc', '--', 'x']).cmd).toBe('error');
      expect(parseArgs(['host', '--port', '-1', '--', 'x']).cmd).toBe('error');
      expect(parseArgs(['host', '--port', '70000', '--', 'x']).cmd).toBe('error');
    });
    it('errors on an unknown host flag', () => {
      expect(parseArgs(['host', '--bogus', '--', 'x']).cmd).toBe('error');
    });
    it('errors when --port has no value', () => {
      expect(parseArgs(['host', '--port']).cmd).toBe('error');
    });
  });

  describe('join', () => {
    it('parses a positional url and --name', () => {
      expect(parseArgs(['join', 'ws://localhost:4474', '--name', 'ada'])).toEqual({
        cmd: 'join',
        url: 'ws://localhost:4474',
        name: 'ada',
      });
    });
    it('works without a name', () => {
      expect(parseArgs(['join', 'ws://x:1'])).toEqual({
        cmd: 'join',
        url: 'ws://x:1',
      });
    });
    it('errors when no url is given', () => {
      expect(parseArgs(['join', '--name', 'ada']).cmd).toBe('error');
      expect(parseArgs(['join']).cmd).toBe('error');
    });
    it('errors on an unexpected argument', () => {
      expect(parseArgs(['join', 'ws://x:1', 'extra']).cmd).toBe('error');
    });
  });

  describe('errors', () => {
    it('unknown command', () => {
      const r = parseArgs(['frobnicate']);
      expect(r.cmd).toBe('error');
    });
  });
});
