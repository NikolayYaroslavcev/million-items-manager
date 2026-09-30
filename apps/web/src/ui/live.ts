let setter: ((message: string) => void) | null = null;

export function registerAnnouncer(fn: ((message: string) => void) | null): void {
  setter = fn;
}

export function announce(message: string): void {
  setter?.(message);
}
