export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogBindings = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(event: string, data?: LogBindings): void;
  info(event: string, data?: LogBindings): void;
  warn(event: string, data?: LogBindings): void;
  error(event: string, data?: LogBindings): void;
  child(bindings: LogBindings): Logger;
}
