import { spawn } from 'node:child_process';

/**
 * Opens a URL in the user's default browser.
 *
 * Resolves `false` rather than throwing when no browser can be launched — over SSH or inside a
 * container that is expected, and the caller should print the URL instead.
 */
export async function openInBrowser(url: string): Promise<boolean> {
  const [command, args] =
    process.platform === 'darwin'
      ? (['open', [url]] as const)
      : process.platform === 'win32'
        ? (['cmd', ['/c', 'start', '', url]] as const)
        : (['xdg-open', [url]] as const);

  return new Promise((resolve) => {
    try {
      const child = spawn(command, [...args], { stdio: 'ignore', detached: true });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
