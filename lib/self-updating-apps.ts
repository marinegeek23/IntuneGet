/**
 * Apps that keep themselves up to date on the device and must not be offered
 * as updates by IntuneGet.
 *
 * Microsoft 365 Apps for enterprise updates itself through Click-to-Run
 * channels; the winget version is only the setup bootstrapper build, which
 * bumps near-weekly. Repackaging it changes nothing on devices and the app
 * would show as permanently outdated. Extend this list only for apps whose
 * installed product updates itself regardless of the deployed package.
 *
 * The browsers, chat clients and game launchers below behave the same way:
 * each ships its own background updater that runs regardless of the package
 * Intune delivered, so their winget version churns (often several builds a
 * month) while redeploying changes nothing on the endpoint. Left off this
 * list they generate a permanent "update available" that no deployment can
 * ever satisfy.
 */
const SELF_UPDATING_WINGET_IDS = new Set([
  'microsoft.office',
  // Browsers - Google Update / Mozilla Maintenance Service.
  'google.chrome',
  'mozilla.firefox',
  // Electron apps with built-in Squirrel/auto-updaters.
  'discord.discord',
  'microsoft.visualstudiocode',
  'anthropic.claude',
  'bitwarden.bitwarden',
  // npm-distributed CLI that updates itself in place.
  'anthropic.claudecode',
  // Game launchers - the client self-patches before it will run.
  'ubisoft.connect',
]);

export function isSelfUpdatingApp(wingetId: string): boolean {
  return SELF_UPDATING_WINGET_IDS.has(wingetId.toLowerCase());
}
