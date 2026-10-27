export function clipboardWrite(): ((text: string) => Promise<void>) | null {
  const clipboard = (navigator as { clipboard?: { writeText?: (text: string) => Promise<void> } }).clipboard;
  const write = clipboard?.writeText;
  if (!write) {
    return null;
  }
  return (text) => write.call(clipboard, text);
}
