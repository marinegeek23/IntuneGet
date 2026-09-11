/**
 * Job Processor - Orchestrates the packaging and upload steps
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { PackagerConfig } from './config.js';
import { PackagingJob, JobPoller } from './job-poller.js';
import { IntuneUploader, IntuneAppResult, DuplicateAppError } from './intune-uploader.js';
import { createLogger, Logger } from './logger.js';

interface PackagingResult {
  intunewinPath: string;
  // Path to the inner AES-encrypted payload extracted from the .intunewin zip.
  // This (not the outer .intunewin) is what must be uploaded to Azure Storage.
  encryptedContentPath: string;
  // Size of the original unencrypted content (from Detection.xml); Intune's
  // mobileAppContentFile.size must be this value, not the encrypted size.
  unencryptedContentSize: number;
  // Size of the inner encrypted payload file (mobileAppContentFile.sizeEncrypted).
  encryptedContentSize: number;
  encryptionInfo: {
    encryptionKey: string;
    macKey: string;
    initializationVector: string;
    mac: string;
    profileIdentifier: string;
    fileDigest: string;
    fileDigestAlgorithm: string;
  };
}

export class JobProcessor {
  private config: PackagerConfig;
  private poller: JobPoller | null;
  private uploader: IntuneUploader;
  private logger: Logger;

  constructor(config: PackagerConfig, poller: JobPoller | null) {
    this.config = config;
    this.poller = poller;
    this.uploader = new IntuneUploader(config);
    this.logger = createLogger('JobProcessor');
  }

  /**
   * Process a packaging job
   * @throws Error if poller is not provided (null)
   */
  async processJob(job: PackagingJob): Promise<void> {
    if (!this.poller) {
      throw new Error('JobProcessor requires a JobPoller instance to process jobs');
    }
    const poller = this.poller;
    const jobWorkDir = path.join(this.config.paths.work, job.id);

    try {
      // Create job work directory
      await fs.promises.mkdir(jobWorkDir, { recursive: true });

      // Step 1: Download tools if needed (5%)
      await poller.updateJobProgress(job.id, 5, 'Checking tools...');
      await this.ensureToolsAvailable();

      // Step 2: Download installer (10-25%)
      await poller.updateJobProgress(job.id, 10, 'Downloading installer...');
      const installerPath = await this.downloadInstaller(job, jobWorkDir);
      await poller.updateJobProgress(job.id, 25, 'Installer downloaded');

      // Step 3: Verify SHA256 (25-30%)
      if (job.installer_sha256) {
        await poller.updateJobProgress(job.id, 25, 'Verifying checksum...');
        await this.verifyChecksum(installerPath, job.installer_sha256);
        await poller.updateJobProgress(job.id, 30, 'Checksum verified');
      }

      // Step 4: Create PSADT package (30-50%)
      await poller.updateJobProgress(job.id, 30, 'Creating PSADT package...');
      const packageDir = await this.createPsadtPackage(job, installerPath, jobWorkDir);
      await poller.updateJobProgress(job.id, 50, 'PSADT package created');

      // Step 5: Create .intunewin package (50-70%)
      await poller.updateJobProgress(job.id, 50, 'Creating .intunewin package...');
      const result = await this.createIntunewinPackage(packageDir, jobWorkDir);
      await poller.updateJobProgress(job.id, 70, '.intunewin package created');

      // Step 6: Update status to uploading
      await poller.updateJobStatus(job.id, 'uploading');

      // Step 7: Upload to Intune (70-95%)
      await poller.updateJobProgress(job.id, 75, 'Uploading to Intune...');
      let intuneApp;
      try {
        intuneApp = await this.uploader.uploadToIntune(
          job,
          result.encryptedContentPath,
          result.encryptionInfo,
          {
            unencryptedSize: result.unencryptedContentSize,
            encryptedSize: result.encryptedContentSize,
          },
          async (percent, message) => {
            // Map upload progress (0-100) to overall progress (75-95)
            const overallPercent = 75 + Math.floor(percent * 0.2);
            await poller.updateJobProgress(job.id, overallPercent, message);
          }
        );
      } catch (error) {
        if (error instanceof DuplicateAppError) {
          // Same app already deployed to this tenant via IntuneGet (by any
          // user): finish as duplicate_skipped instead of failing the job.
          await poller.updateJobStatus(job.id, 'duplicate_skipped', {
            intune_app_id: error.duplicateInfo.existingAppId,
            intune_app_url: error.duplicateInfo.existingAppUrl,
            duplicate_info: error.duplicateInfo,
            progress_percent: 100,
            progress_message: 'Duplicate app already exists in Intune',
          });
          this.logger.info('Job skipped as duplicate', {
            jobId: job.id,
            existingAppId: error.duplicateInfo.existingAppId,
            displayName: job.display_name,
          });
          return;
        }
        throw error;
      }

      // Step 8: Mark as deployed (100%)
      await poller.updateJobStatus(job.id, 'deployed', {
        intune_app_id: intuneApp.id,
        intune_app_url: intuneApp.url,
        progress_percent: 100,
        progress_message: 'Deployment complete',
      });

      this.logger.info('Job completed successfully', {
        jobId: job.id,
        intuneAppId: intuneApp.id,
        displayName: job.display_name,
      });
    } finally {
      // Cleanup job work directory
      try {
        await fs.promises.rm(jobWorkDir, { recursive: true, force: true });
        this.logger.debug('Cleaned up job work directory', { path: jobWorkDir });
      } catch {
        this.logger.warn('Failed to cleanup job work directory', { path: jobWorkDir });
      }
    }
  }

  /**
   * Ensure required tools are downloaded
   * This method is public to allow standalone tool setup without processing jobs
   */
  async ensureToolsAvailable(): Promise<void> {
    const toolsDir = this.config.paths.tools;
    await fs.promises.mkdir(toolsDir, { recursive: true });

    const intuneWinUtil = path.join(toolsDir, 'IntuneWinAppUtil.exe');
    const psadtDir = path.join(toolsDir, 'PSAppDeployToolkit');

    // A valid PSADT v4 template has Invoke-AppDeployToolkit.exe and the
    // PSAppDeployToolkit module folder at its root. Packager versions before
    // 1.2.0 extracted a v3-era layout (Toolkit/Deploy-Application.exe), so an
    // existing folder is not enough - treat anything else as stale.
    const isPsadtValid = () =>
      fs.existsSync(path.join(psadtDir, 'Invoke-AppDeployToolkit.exe')) &&
      fs.existsSync(path.join(psadtDir, 'PSAppDeployToolkit'));

    if (fs.existsSync(psadtDir) && !isPsadtValid()) {
      this.logger.warn('PSAppDeployToolkit folder has an outdated layout, re-downloading', {
        psadtDir,
      });
      await fs.promises.rm(psadtDir, { recursive: true, force: true });
    }

    // Check if tools exist
    const intuneWinExists = fs.existsSync(intuneWinUtil);

    if (!intuneWinExists || !fs.existsSync(psadtDir)) {
      this.logger.info('Downloading required tools...');

      // Run the download script
      const scriptPath = path.join(__dirname, '..', 'scripts', 'download-tools.ps1');

      // Check if script exists, if not use inline commands
      if (!fs.existsSync(scriptPath)) {
        await this.downloadToolsInline(toolsDir);
      } else {
        await this.runPowerShell(scriptPath, ['-ToolsDir', toolsDir]);
      }
    }

    // Verify tools are now available
    if (!fs.existsSync(intuneWinUtil)) {
      throw new Error('IntuneWinAppUtil.exe not found after download');
    }
    if (!isPsadtValid()) {
      throw new Error(
        `PSAppDeployToolkit template is missing or incomplete at ${psadtDir}. ` +
          'Delete the folder and run "intuneget-packager setup" to download it again.'
      );
    }

    this.logger.debug('Tools verified', { toolsDir });
  }

  /**
   * Download tools without external script
   */
  private async downloadToolsInline(toolsDir: string): Promise<void> {
    // Download IntuneWinAppUtil
    const intuneWinUrl = 'https://github.com/microsoft/Microsoft-Win32-Content-Prep-Tool/raw/master/IntuneWinAppUtil.exe';
    const intuneWinPath = path.join(toolsDir, 'IntuneWinAppUtil.exe');

    this.logger.info('Downloading IntuneWinAppUtil.exe...');
    await this.downloadFile(intuneWinUrl, intuneWinPath);

    // Download and extract PSAppDeployToolkit
    const psadtUrl = 'https://github.com/PSAppDeployToolkit/PSAppDeployToolkit/releases/download/4.1.8/PSAppDeployToolkit_Template_v4.zip';
    const psadtZipPath = path.join(toolsDir, 'psadt.zip');
    const psadtDir = path.join(toolsDir, 'PSAppDeployToolkit');

    this.logger.info('Downloading PSAppDeployToolkit...');
    await this.downloadFile(psadtUrl, psadtZipPath);

    // Extract using PowerShell
    await this.runPowerShell(`Expand-Archive -Path '${psadtZipPath}' -DestinationPath '${psadtDir}' -Force`);

    // Cleanup zip
    await fs.promises.unlink(psadtZipPath);
  }

  /**
   * Download a file
   * Some vendor CDNs reject the default client identity while accepting a
   * browser User-Agent (and vice versa), so retry once with a browser UA
   * when the server refuses the request outright.
   */
  private async downloadFile(url: string, destPath: string): Promise<void> {
    const fetch = (await import('node-fetch')).default;
    let response = await fetch(url);

    if (response.status === 403 || response.status === 406) {
      this.logger.warn('Download refused, retrying with browser User-Agent', {
        url,
        status: response.status,
      });
      response = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      });
    }

    if (!response.ok) {
      throw new Error(`Failed to download ${url}: ${response.statusText}`);
    }

    const buffer = await response.arrayBuffer();
    await fs.promises.writeFile(destPath, Buffer.from(buffer));
  }

  /**
   * Download the installer
   */
  private async downloadInstaller(job: PackagingJob, workDir: string): Promise<string> {
    const installerFileName = this.getInstallerFileName(job);
    const installerPath = path.join(workDir, installerFileName);

    this.logger.info('Downloading installer', {
      url: job.installer_url,
      destPath: installerPath,
    });

    await this.downloadFile(job.installer_url, installerPath);

    return installerPath;
  }

  /**
   * Get the installer file name from job
   */
  private getInstallerFileName(job: PackagingJob): string {
    // Try to extract filename from URL
    const urlPath = new URL(job.installer_url).pathname;
    let urlFileName = path.basename(urlPath);

    // Store URL-encoded names decoded (Firefox%20Setup.exe -> Firefox Setup.exe),
    // stripping any separators a decoded name could smuggle in
    try {
      urlFileName = path.basename(decodeURIComponent(urlFileName)).replace(/[\\/]/g, '');
    } catch {
      // Malformed escape sequence: keep the encoded name
    }

    if (urlFileName && urlFileName.includes('.')) {
      return urlFileName;
    }

    // Fall back to generating a name based on installer type
    const extension = this.getInstallerExtension(job.installer_type);
    return `installer${extension}`;
  }

  /**
   * Get file extension for installer type
   */
  private getInstallerExtension(installerType: string): string {
    const extensions: Record<string, string> = {
      msi: '.msi',
      exe: '.exe',
      msix: '.msix',
      appx: '.appx',
      inno: '.exe',
      nullsoft: '.exe',
      wix: '.msi',
      burn: '.exe',
      zip: '.zip',
    };
    return extensions[installerType] || '.exe';
  }

  /**
   * Verify file checksum
   */
  private async verifyChecksum(filePath: string, expectedSha256: string): Promise<void> {
    const fileBuffer = await fs.promises.readFile(filePath);
    const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    if (hash.toLowerCase() !== expectedSha256.toLowerCase()) {
      throw new Error(`Checksum mismatch: expected ${expectedSha256}, got ${hash}`);
    }

    this.logger.debug('Checksum verified', { sha256: hash });
  }

  /**
   * Create PSADT package structure
   */
  private async createPsadtPackage(
    job: PackagingJob,
    installerPath: string,
    workDir: string
  ): Promise<string> {
    const packageDir = path.join(workDir, 'Package');
    const filesDir = path.join(packageDir, 'Files');
    const toolkitDir = path.join(packageDir, 'PSAppDeployToolkit');

    // Create directory structure
    await fs.promises.mkdir(filesDir, { recursive: true });
    await fs.promises.mkdir(toolkitDir, { recursive: true });

    // Copy PSADT v4.1 toolkit files
    const psadtSource = path.join(this.config.paths.tools, 'PSAppDeployToolkit', 'PSAppDeployToolkit');
    if (!fs.existsSync(psadtSource)) {
      throw new Error(
        `PSAppDeployToolkit module not found at ${psadtSource}. ` +
          'Run "intuneget-packager setup" to download the required tools.'
      );
    }
    await this.copyDirectory(psadtSource, toolkitDir);

    // Copy Config, Strings, and Assets directories for PSADT v4.1
    const configSource = path.join(this.config.paths.tools, 'PSAppDeployToolkit', 'Config');
    if (fs.existsSync(configSource)) {
      await this.copyDirectory(configSource, path.join(packageDir, 'Config'));
    }
    const stringsSource = path.join(this.config.paths.tools, 'PSAppDeployToolkit', 'Strings');
    if (fs.existsSync(stringsSource)) {
      await this.copyDirectory(stringsSource, path.join(packageDir, 'Strings'));
    }
    const assetsSource = path.join(this.config.paths.tools, 'PSAppDeployToolkit', 'Assets');
    if (fs.existsSync(assetsSource)) {
      await this.copyDirectory(assetsSource, path.join(packageDir, 'Assets'));
    }

    // Copy Invoke-AppDeployToolkit.exe for PSADT v4.1
    const deployExeSource = path.join(
      this.config.paths.tools,
      'PSAppDeployToolkit',
      'Invoke-AppDeployToolkit.exe'
    );
    if (!fs.existsSync(deployExeSource)) {
      throw new Error(
        `Invoke-AppDeployToolkit.exe not found at ${deployExeSource}. ` +
          'Run "intuneget-packager setup" to download the required tools.'
      );
    }
    await fs.promises.copyFile(deployExeSource, path.join(packageDir, 'Invoke-AppDeployToolkit.exe'));

    // Copy installer to Files directory
    const installerFileName = path.basename(installerPath);
    await fs.promises.copyFile(installerPath, path.join(filesDir, installerFileName));

    // Generate Invoke-AppDeployToolkit.ps1
    const deployScript = this.generateDeployScript(job, installerFileName);
    await fs.promises.writeFile(path.join(packageDir, 'Invoke-AppDeployToolkit.ps1'), deployScript);

    this.logger.debug('PSADT package created', { packageDir });
    return packageDir;
  }

  /**
   * Generate Invoke-AppDeployToolkit.ps1 script (PSADT v4)
   */
  private generateDeployScript(job: PackagingJob, installerFileName: string): string {
    const silentSwitches = this.extractSilentSwitches(job.install_command, job.installer_type).replace(/'/g, "''");
    const psadtVersion = '4.1.8';
    const appVendor = job.publisher.replace(/'/g, "''");
    const appName = job.display_name.replace(/'/g, "''");
    const appArch = job.architecture ?? '';

    return `<#
.SYNOPSIS
    ${appName} Deployment Script
.DESCRIPTION
    Deploys ${appName} ${job.version} using PSAppDeployToolkit v4
    Generated by IntuneGet self-hosted packager
#>

[CmdletBinding()]
param
(
    [Parameter(Mandatory = $false)]
    [ValidateSet('Install', 'Uninstall', 'Repair')]
    [System.String]$DeploymentType = 'Install',

    [Parameter(Mandatory = $false)]
    [ValidateSet('Auto', 'Interactive', 'NonInteractive', 'Silent')]
    [System.String]$DeployMode = 'Silent',

    [Parameter(Mandatory = $false)]
    [System.Management.Automation.SwitchParameter]$SuppressRebootPassThru,

    [Parameter(Mandatory = $false)]
    [System.Management.Automation.SwitchParameter]$TerminalServerMode,

    [Parameter(Mandatory = $false)]
    [System.Management.Automation.SwitchParameter]$DisableLogging
)

##================================================
## MARK: Variables
##================================================

$adtSession = @{
    AppVendor = '${appVendor}'
    AppName = '${appName}'
    AppVersion = '${job.version}'
    AppArch = '${appArch}'
    AppLang = 'EN'
    AppRevision = '01'
    AppSuccessExitCodes = @(0)
    AppRebootExitCodes = @(1641, 3010)
    AppScriptVersion = '1.0.0'
    AppScriptDate = (Get-Date -Format 'yyyy-MM-dd')
    AppScriptAuthor = 'IntuneGet'
    RequireAdmin = $${job.install_scope === 'user' ? 'false' : 'true'}
    InstallName = ''
    InstallTitle = ''
    DeployAppScriptFriendlyName = $MyInvocation.MyCommand.Name
    DeployAppScriptParameters = $PSBoundParameters
    DeployAppScriptVersion = '${psadtVersion}'
}

function Install-ADTDeployment
{
    [CmdletBinding()]
    param ()
${this.getPreInstallRemovalBlock(job, appName)}
    ## Install the application
    ${this.getInstallCommand(job, installerFileName, silentSwitches)}
${this.getPostInstallVerificationBlock(job, appName)}
${this.getPostCommandsBlock(job, 'postInstallCommands', 'Install-ADTDeployment')}
    ## Create IntuneGet detection marker for Intune detection rules
    ${this.getRegistryMarkerCreation(job)}
}

function Uninstall-ADTDeployment
{
    [CmdletBinding()]
    param ()

    ## Uninstall the application
    ${this.getUninstallCommand(job)}
${this.getPostCommandsBlock(job, 'postUninstallCommands', 'Uninstall-ADTDeployment')}
    ## Remove IntuneGet detection marker
    ${this.getRegistryMarkerRemoval(job)}
}

function Repair-ADTDeployment
{
    [CmdletBinding()]
    param ()

    Write-ADTLogEntry -Message 'Repair operation is not implemented for this package' -Severity 'Warning' -Source 'Repair-ADTDeployment'
}

##================================================
## MARK: Initialization
##================================================

$ErrorActionPreference = [System.Management.Automation.ActionPreference]::Stop
$ProgressPreference = [System.Management.Automation.ActionPreference]::SilentlyContinue
Set-StrictMode -Version 1

try
{
    if (Test-Path -LiteralPath "$PSScriptRoot\\PSAppDeployToolkit\\PSAppDeployToolkit.psd1" -PathType Leaf)
    {
        Get-ChildItem -LiteralPath "$PSScriptRoot\\PSAppDeployToolkit" -Recurse -File | Unblock-File -ErrorAction Ignore
        Import-Module -FullyQualifiedName @{ ModuleName = "$PSScriptRoot\\PSAppDeployToolkit\\PSAppDeployToolkit.psd1"; Guid = '8c3c366b-8606-4576-9f2d-4051144f7ca2'; ModuleVersion = '${psadtVersion}' } -Force
    }
    else
    {
        Import-Module -FullyQualifiedName @{ ModuleName = 'PSAppDeployToolkit'; Guid = '8c3c366b-8606-4576-9f2d-4051144f7ca2'; ModuleVersion = '${psadtVersion}' } -Force
    }

    $iadtParams = Get-ADTBoundParametersAndDefaultValues -Invocation $MyInvocation
    $adtSession = Remove-ADTHashtableNullOrEmptyValues -Hashtable $adtSession
    $adtSession = Open-ADTSession @adtSession @iadtParams -PassThru
}
catch
{
    $Host.UI.WriteErrorLine((Out-String -InputObject $_ -Width ([System.Int32]::MaxValue)))
    exit 60008
}

##================================================
## MARK: Invocation
##================================================

try
{
    & "$($adtSession.DeploymentType)-ADTDeployment"
    Close-ADTSession
}
catch
{
    Write-ADTLogEntry -Message "An error occurred: $(Resolve-ADTErrorRecord -ErrorRecord $_)" -Severity 'Error' -Source 'Main'
    Close-ADTSession -ExitCode 60001
}
`;
  }

  /**
   * Get the psadtConfig object from package_config
   * Returns null when package_config or psadtConfig is absent or not an object
   */
  private getPsadtConfig(job: PackagingJob): Record<string, unknown> | null {
    const packageConfig = job.package_config;
    if (typeof packageConfig !== 'object' || packageConfig === null) {
      return null;
    }
    const psadtConfig = (packageConfig as Record<string, unknown>).psadtConfig;
    if (typeof psadtConfig !== 'object' || psadtConfig === null) {
      return null;
    }
    return psadtConfig as Record<string, unknown>;
  }

  /**
   * Get the nested installer metadata from package_config
   * These fields live top-level on the cart item (not inside psadtConfig)
   * Returns null entries when absent, not a string, or empty/whitespace
   */
  private getNestedInstaller(job: PackagingJob): { type: string | null; path: string | null } {
    const packageConfig = job.package_config;
    if (typeof packageConfig !== 'object' || packageConfig === null) {
      return { type: null, path: null };
    }
    const config = packageConfig as Record<string, unknown>;
    const readString = (value: unknown): string | null =>
      typeof value === 'string' && value.trim() ? value.trim() : null;
    return {
      type: readString(config.nestedInstallerType),
      path: readString(config.nestedInstallerPath),
    };
  }

  /**
   * Get custom install/uninstall command override from package_config.psadtConfig
   * Returns null when the override is absent, not a string, or empty/whitespace
   */
  private getCommandOverride(job: PackagingJob, key: 'installCommand' | 'uninstallCommand'): string | null {
    const psadtConfig = this.getPsadtConfig(job);
    if (!psadtConfig) {
      return null;
    }
    const value = psadtConfig[key];
    if (typeof value !== 'string' || !value.trim()) {
      return null;
    }
    return value.trim();
  }

  /**
   * Generate PowerShell for additional post-install / post-uninstall commands
   * (issue #118). Each entry runs as its own Start-ADTProcess (cmd.exe /c) step,
   * in order, mirroring the custom-override pattern. Returns '' when none.
   * Kept in sync with .github/scripts/Create-PSADTPackage.ps1.
   */
  private getPostCommandsBlock(
    job: PackagingJob,
    key: 'postInstallCommands' | 'postUninstallCommands',
    source: 'Install-ADTDeployment' | 'Uninstall-ADTDeployment'
  ): string {
    const psadtConfig = this.getPsadtConfig(job);
    const raw = psadtConfig?.[key];
    if (!Array.isArray(raw)) {
      return '';
    }
    const commands = raw
      .filter((c): c is string => typeof c === 'string')
      // Collapse embedded newlines to spaces so a command can never break out of
      // the single-quoted string it is embedded in within the generated script.
      .map((c) => c.replace(/[\r\n]+/g, ' ').trim())
      .filter((c) => c.length > 0);
    if (commands.length === 0) {
      return '';
    }

    const phase = source === 'Install-ADTDeployment' ? 'post-install' : 'post-uninstall';
    const steps = commands
      .map((cmd) => {
        const escaped = cmd.replace(/'/g, "''");
        return `    Write-ADTLogEntry -Message 'Executing ${phase} command: ${escaped}' -Severity 'Info' -Source '${source}'
    Start-ADTProcess -FilePath "$env:SystemRoot\\System32\\cmd.exe" -ArgumentList '/c ${escaped}' -WorkingDirectory $adtSession.DirFiles -WindowStyle Hidden`;
      })
      .join('\n');

    return `
    ## Custom ${phase} commands (user-specified)
${steps}
`;
  }

  /**
   * Generate PowerShell code to remove any existing installation before installing
   * Opt-in via package_config.psadtConfig.removeExistingInstall; returns '' when disabled
   */
  private getPreInstallRemovalBlock(job: PackagingJob, escapedAppName: string): string {
    const psadtConfig = this.getPsadtConfig(job);
    if (psadtConfig?.removeExistingInstall !== true) {
      return '';
    }
    return `
    ## Remove any existing installation before installing
    try {
        $existingApps = Get-ADTApplication -Name '${escapedAppName}' -NameMatch 'Contains' -ErrorAction SilentlyContinue
        if ($existingApps) {
            Write-ADTLogEntry -Message "Found $($existingApps.Count) existing installation(s), removing before install" -Source 'Install-ADTDeployment'
            Uninstall-ADTApplication -InstalledApplication $existingApps -ErrorAction SilentlyContinue
        }
    }
    catch {
        Write-ADTLogEntry -Message "Pre-install removal failed: $($_.Exception.Message)" -Severity 'Warning' -Source 'Install-ADTDeployment'
    }
`;
  }

  /**
   * Generate PowerShell code to verify the application appears in Add/Remove
   * Programs after install, failing the deployment before the detection
   * marker is written when it does not
   * Opt-in via package_config.psadtConfig.verifyInstall; returns '' when disabled
   */
  private getPostInstallVerificationBlock(job: PackagingJob, escapedAppName: string): string {
    const psadtConfig = this.getPsadtConfig(job);
    if (psadtConfig?.verifyInstall !== true) {
      return '';
    }
    return `
    ## Verify the application actually installed before writing the detection marker
    $verifyApps = Get-ADTApplication -Name '${escapedAppName}' -NameMatch 'Contains' -ErrorAction SilentlyContinue
    if (-not $verifyApps) {
        throw "Post-install verification failed: '${escapedAppName}' was not found in the installed applications list. The installer exited without error but the application does not appear to be installed."
    }
    Write-ADTLogEntry -Message "Post-install verification passed" -Source 'Install-ADTDeployment'
`;
  }

  /**
   * Get install command based on installer type (PSADT v4 cmdlets)
   * A custom install command override from psadtConfig takes precedence
   */
  private getInstallCommand(job: PackagingJob, fileName: string, silentSwitches: string): string {
    const installOverride = this.getCommandOverride(job, 'installCommand');
    if (installOverride) {
      const overrideEscaped = installOverride.replace(/'/g, "''");
      return `Start-ADTProcess -FilePath "$env:SystemRoot\\System32\\cmd.exe" -ArgumentList '/c ${overrideEscaped}' -WorkingDirectory $adtSession.DirFiles -WindowStyle Hidden`;
    }

    const installerType = (job.installer_type ?? '').toLowerCase();
    const ext = path.extname(fileName).toLowerCase();

    // MSIX/APPX are packages, not executables - CreateProcess on one fails with
    // BadImageFormatException (0x800700C1). Provision them for all users instead.
    if (
      ext === '.msix' ||
      ext === '.msixbundle' ||
      ext === '.appx' ||
      ext === '.appxbundle' ||
      installerType === 'msix' ||
      installerType === 'appx'
    ) {
      return this.getMsixInstallCommand(fileName);
    }

    // Portable apps have no installer to run - the payload is placed on disk.
    // Checked before the zip branch because a portable app may ship as a .zip
    // without declaring a nested installer.
    if (installerType === 'portable') {
      return this.getPortableInstallCommand(job, fileName);
    }

    // Zip archives carry a nested installer - never execute the .zip itself
    // (a zip-declared installer that is actually an .exe or .msi still runs natively)
    if (ext === '.zip' || (installerType === 'zip' && ext !== '.exe' && ext !== '.msi')) {
      return this.getZipInstallCommand(job, fileName, silentSwitches);
    }

    if (ext === '.msi' || installerType === 'msi' || installerType === 'wix') {
      const msiProperties = this.extractMsiProperties(silentSwitches);
      if (msiProperties) {
        return `Start-ADTMsiProcess -Action 'Install' -FilePath '${fileName}' -AdditionalArgumentList '${msiProperties}'`;
      }
      return `Start-ADTMsiProcess -Action 'Install' -FilePath '${fileName}'`;
    }

    return `Start-ADTProcess -FilePath "$($adtSession.DirFiles)\\${fileName}" -ArgumentList '${silentSwitches}' -WindowStyle Hidden -WaitForMsiExec`;
  }

  /**
   * Strip msiexec action and quiet flags from silent switches -
   * Start-ADTMsiProcess supplies those itself
   */
  private extractMsiProperties(silentSwitches: string): string {
    return silentSwitches
      .split(/\s+/)
      .filter((token) => token && !/^\/(q[nbrfu]?|quiet|norestart|i|x)$/i.test(token))
      .join(' ')
      .trim();
  }

  /**
   * Get install command for MSIX/APPX packages (PSADT v4 cmdlets)
   * Provisions the package online so it applies to all users
   */
  private getMsixInstallCommand(fileName: string): string {
    return `$msixPath = "$($adtSession.DirFiles)\\${fileName}"
    Write-ADTLogEntry -Message "Provisioning MSIX/APPX package for all users: $msixPath" -Severity 'Info' -Source 'Install-ADTDeployment'
    try {
        Add-AppxProvisionedPackage -Online -PackagePath $msixPath -SkipLicense -ErrorAction Stop
        Write-ADTLogEntry -Message "MSIX/APPX package provisioned successfully" -Severity 'Success' -Source 'Install-ADTDeployment'
    } catch {
        Write-ADTLogEntry -Message "Failed to provision MSIX/APPX package: $_" -Severity 'Error' -Source 'Install-ADTDeployment'
        throw
    }`;
  }

  /**
   * Get install command for portable apps (PSADT v4 cmdlets)
   * Expands a .zip payload, or copies a bare binary, into Program Files and
   * puts that directory on the machine PATH so a portable CLI resolves
   */
  private getPortableInstallCommand(job: PackagingJob, fileName: string): string {
    const folderName = this.getPortableFolderName(job);
    const ext = path.extname(fileName).toLowerCase();
    const placeLine =
      ext === '.zip'
        ? '        Expand-Archive -Path $portableSource -DestinationPath $installPath -Force'
        : '        Copy-Item -Path $portableSource -Destination $installPath -Force';

    const { root, pathTarget } = this.getPortableLocation(job);

    return `$portableSource = "$($adtSession.DirFiles)\\${fileName}"
    $installPath = Join-Path ${root} '${folderName}'
    Write-ADTLogEntry -Message "Installing portable app to: $installPath" -Severity 'Info' -Source 'Install-ADTDeployment'
    try {
        if (-not (Test-Path $installPath)) {
            $null = New-Item -Path $installPath -ItemType Directory -Force
        }
${placeLine}
        $currentPath = [System.Environment]::GetEnvironmentVariable('Path', '${pathTarget}')
        if (($currentPath -split ';') -notcontains $installPath) {
            [System.Environment]::SetEnvironmentVariable('Path', ($currentPath.TrimEnd(';') + ';' + $installPath), '${pathTarget}')
            Write-ADTLogEntry -Message "Added to ${pathTarget} PATH: $installPath" -Severity 'Info' -Source 'Install-ADTDeployment'
        }
        Write-ADTLogEntry -Message "Portable app installed successfully" -Severity 'Success' -Source 'Install-ADTDeployment'
    } catch {
        Write-ADTLogEntry -Message "Failed to install portable app: $_" -Severity 'Error' -Source 'Install-ADTDeployment'
        throw
    }`;
  }

  /**
   * Where a portable app is placed, and which PATH it joins.
   *
   * A user-scope deployment goes under LOCALAPPDATA, which the signed-in
   * user can write - so a self-updating CLI can replace its own binary in
   * place. A machine-scope one goes to Program Files, which it cannot.
   */
  private getPortableLocation(job: PackagingJob): { root: string; pathTarget: string } {
    return (job.install_scope ?? '').toLowerCase() === 'user'
      ? { root: '$env:LOCALAPPDATA', pathTarget: 'User' }
      : { root: '$env:ProgramFiles', pathTarget: 'Machine' };
  }

  /**
   * Install folder name for a portable app, stripped of characters that are
   * not valid in a path and single-quote escaped for PowerShell
   */
  private getPortableFolderName(job: PackagingJob): string {
    const cleaned = job.display_name.replace(/[\\/:*?"<>|]/g, '').trim();
    return (cleaned || job.winget_id).replace(/'/g, "''");
  }

  /**
   * Get install command for zip installers (PSADT v4 cmdlets)
   * Extracts the archive to a unique temp directory and runs the nested
   * installer declared by package_config.nestedInstallerType/nestedInstallerPath
   * Emits an install-time error when no nested installer is declared
   */
  private getZipInstallCommand(job: PackagingJob, fileName: string, silentSwitches: string): string {
    const nested = this.getNestedInstaller(job);
    if (!nested.path) {
      return 'throw "Zip package does not declare a nested installer; cannot install"';
    }

    const nestedPathEscaped = nested.path.replace(/'/g, "''");
    const nestedType = (nested.type ?? '').toLowerCase();

    // The job's install command describes extracting the archive, not running
    // what is inside it, so it carries no usable switches. Fall back to the
    // silent switches for the nested installer's own type.
    const effectiveSwitches = silentSwitches || this.getDefaultSilentSwitches(nestedType);

    let executeLine: string;
    if (nestedType === 'msi' || nestedType === 'wix') {
      const msiProperties = this.extractMsiProperties(effectiveSwitches);
      executeLine = msiProperties
        ? `Start-ADTMsiProcess -Action 'Install' -FilePath $nestedInstallerPath -AdditionalArgumentList '${msiProperties}'`
        : `Start-ADTMsiProcess -Action 'Install' -FilePath $nestedInstallerPath`;
    } else if (nestedType === 'portable') {
      executeLine = 'throw "Portable nested installers are not supported yet"';
    } else {
      executeLine = `Start-ADTProcess -FilePath $nestedInstallerPath -ArgumentList '${effectiveSwitches}' -WindowStyle Hidden -WaitForMsiExec`;
    }

    return `$zipExtractDir = [System.IO.Path]::Combine($env:TEMP, "IntuneGet_Zip_" + [System.Guid]::NewGuid().ToString("N").Substring(0, 8))
    $null = New-Item -Path $zipExtractDir -ItemType Directory -Force
    try {
        Expand-Archive -Path "$($adtSession.DirFiles)\\${fileName}" -DestinationPath $zipExtractDir -Force
        $nestedInstallerPath = Join-Path $zipExtractDir '${nestedPathEscaped}'
        if (-not (Test-Path -LiteralPath $nestedInstallerPath)) {
            throw "Nested installer not found in archive: ${nestedPathEscaped}"
        }
        Write-ADTLogEntry -Message "Running nested installer: $nestedInstallerPath" -Severity 'Info' -Source 'Install-ADTDeployment'
        ${executeLine}
    }
    finally {
        if (Test-Path -LiteralPath $zipExtractDir) {
            Remove-Item -Path $zipExtractDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }`;
  }

  /**
   * Get uninstall command (PSADT v4 cmdlets)
   * A custom uninstall command override from psadtConfig takes precedence
   */
  private getUninstallCommand(job: PackagingJob): string {
    const uninstallOverride = this.getCommandOverride(job, 'uninstallCommand');
    if (uninstallOverride) {
      const overrideEscaped = uninstallOverride.replace(/'/g, "''");
      return `Start-ADTProcess -FilePath "$env:SystemRoot\\System32\\cmd.exe" -ArgumentList '/c ${overrideEscaped}' -WorkingDirectory $adtSession.DirFiles -WindowStyle Hidden`;
    }

    if (!job.uninstall_command) {
      return "Write-ADTLogEntry -Message 'No uninstall command specified' -Severity 'Warning' -Source 'Uninstall-ADTDeployment'";
    }

    // MSIX/APPX uninstall sentinel emitted by the web app in place of a command
    const msixUninstall = job.uninstall_command.match(/^MSIX_UNINSTALL:(.+)$/);
    if (msixUninstall) {
      return this.getMsixUninstallCommand(msixUninstall[1]);
    }

    // Portable apps are just a folder on disk - there is no uninstaller to run.
    // Checked by type because these carry a REGISTRY_UNINSTALL sentinel that
    // can never match (nothing registers an uninstall entry for them).
    if ((job.installer_type ?? '').toLowerCase() === 'portable') {
      return this.getPortableUninstallCommand(job);
    }

    // Registry uninstall sentinel emitted by the web app in place of a command.
    // Checked after the portable branch above: a portable app carries this
    // sentinel too, but nothing ever registers an uninstall entry for it.
    const registryUninstall = job.uninstall_command.match(/^REGISTRY_UNINSTALL:(.+)$/);
    if (registryUninstall) {
      return this.getRegistryUninstallCommand(job, registryUninstall[1]);
    }

    // MSI uninstall: use the product code with Start-ADTMsiProcess
    const productCodeMatch = job.uninstall_command.match(
      /\{[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}\}/
    );
    if (productCodeMatch) {
      return `Start-ADTMsiProcess -Action 'Uninstall' -ProductCode '${productCodeMatch[0]}' -SuccessExitCodes @(0, 1605, 1614, 3010, 1641)`;
    }

    const uninstallCmd = job.uninstall_command.replace(/'/g, "''");
    return `Start-ADTProcess -FilePath "$env:SystemRoot\\System32\\cmd.exe" -ArgumentList '/c ${uninstallCmd}' -WindowStyle Hidden`;
  }

  /**
   * Uninstall an MSIX/APPX package: remove the provisioned copy so it stops
   * being applied to new users, then remove any per-user installed instances
   */
  private getMsixUninstallCommand(packageName: string): string {
    const escaped = packageName.replace(/'/g, "''");
    return `$packageName = '${escaped}'
    Write-ADTLogEntry -Message "Removing MSIX package: $packageName" -Severity 'Info' -Source 'Uninstall-ADTDeployment'
    try {
        $provPackage = Get-AppxProvisionedPackage -Online | Where-Object { $_.DisplayName -like "*$packageName*" }
        if ($provPackage) {
            $provPackage | Remove-AppxProvisionedPackage -Online -ErrorAction SilentlyContinue
        }
        $packages = Get-AppxPackage -Name "*$packageName*" -AllUsers -ErrorAction SilentlyContinue
        foreach ($pkg in $packages) {
            Remove-AppxPackage -Package $pkg.PackageFullName -AllUsers -ErrorAction SilentlyContinue
        }
        Write-ADTLogEntry -Message "MSIX package removal completed" -Severity 'Success' -Source 'Uninstall-ADTDeployment'
    } catch {
        Write-ADTLogEntry -Message "Failed to remove MSIX package: $_" -Severity 'Error' -Source 'Uninstall-ADTDeployment'
        throw
    }`;
  }

  /**
   * Uninstall through the application's own registered uninstaller.
   *
   * Get-ADTApplication and Uninstall-ADTApplication do the registry lookup,
   * choose MSI or EXE, and use the registered QuietUninstallString, so there
   * is no uninstall command to construct here. Falls back to winget when the
   * display name matches nothing registered - winget.exe is resolved by path
   * as well as PATH, since PATH does not include it under SYSTEM.
   */
  private getRegistryUninstallCommand(job: PackagingJob, displayName: string): string {
    const appName = this.stripInstallerSuffixes(displayName).replace(/'/g, "''");
    const wingetId = (job.winget_id ?? '').replace(/'/g, "''");

    return `$appName = '${appName}'
    $wingetId = '${wingetId}'
    Write-ADTLogEntry -Message "Searching for installed application: $appName" -Source 'Uninstall-ADTDeployment'
    $installedApp = Get-ADTApplication -Name $appName
    if ($installedApp) {
        Write-ADTLogEntry -Message "Found via registry name, uninstalling" -Source 'Uninstall-ADTDeployment'
        Uninstall-ADTApplication -Name $appName -SuccessExitCodes @(0, 1605, 1614) -RebootExitCodes @(1641, 3010)
    } else {
        Write-ADTLogEntry -Message "Not found by name '$appName', falling back to winget uninstall --id $wingetId" -Severity 'Warning' -Source 'Uninstall-ADTDeployment'
        $wingetExe = Get-Command winget.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source
        if (-not $wingetExe) {
            $wingetExe = Get-ChildItem "$env:ProgramFiles\\WindowsApps\\Microsoft.DesktopAppInstaller_*_*__8wekyb3d8bbwe\\winget.exe" -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
        }
        if ($wingetExe) {
            Start-ADTProcess -FilePath $wingetExe -ArgumentList "uninstall --id $wingetId --silent --accept-source-agreements --disable-interactivity" -WindowStyle Hidden -SuccessExitCodes @(0)
        } else {
            throw "Could not find installed application: $appName (winget not available for fallback)"
        }
    }`;
  }

  /**
   * Strip the packaging suffixes winget carries in a display name but that do
   * not appear in the registry DisplayName, e.g.
   * "Foo (Machine-Wide Install)" -> "Foo"
   */
  private stripInstallerSuffixes(displayName: string): string {
    return displayName
      .replace(
        /\s*\((?:Install|Machine-Wide Install|Machine Wide Install|User|x64|x86|64-bit|32-bit)\)$/i,
        ''
      )
      .trim();
  }

  /**
   * Uninstall a portable app: drop it off the machine PATH, then remove the
   * folder that getPortableInstallCommand created
   */
  private getPortableUninstallCommand(job: PackagingJob): string {
    const folderName = this.getPortableFolderName(job);
    const { root, pathTarget } = this.getPortableLocation(job);

    return `$installPath = Join-Path ${root} '${folderName}'
    Write-ADTLogEntry -Message "Removing portable app folder: $installPath" -Severity 'Info' -Source 'Uninstall-ADTDeployment'
    try {
        $currentPath = [System.Environment]::GetEnvironmentVariable('Path', '${pathTarget}')
        if (($currentPath -split ';') -contains $installPath) {
            $trimmed = ($currentPath -split ';' | Where-Object { $_ -and $_ -ne $installPath }) -join ';'
            [System.Environment]::SetEnvironmentVariable('Path', $trimmed, '${pathTarget}')
        }
        if (Test-Path $installPath) {
            Remove-Item -Path $installPath -Recurse -Force -ErrorAction Stop
            Write-ADTLogEntry -Message "Portable app folder removed successfully" -Severity 'Success' -Source 'Uninstall-ADTDeployment'
        } else {
            Write-ADTLogEntry -Message "Portable app folder not found: $installPath" -Severity 'Warning' -Source 'Uninstall-ADTDeployment'
        }
    } catch {
        Write-ADTLogEntry -Message "Failed to remove portable app folder: $_" -Severity 'Error' -Source 'Uninstall-ADTDeployment'
        throw
    }`;
  }

  /**
   * Sanitize wingetId for registry key name
   * Replaces . and - with _ to match detection-rules.ts logic
   */
  private sanitizeWingetId(wingetId: string): string {
    return wingetId.replace(/[\.\-]/g, '_');
  }

  /**
   * Get registry hive based on install scope
   */
  private getRegistryHive(scope: string): string {
    return scope === 'user' ? 'HKCU' : 'HKLM';
  }

  /**
   * Normalize a custom registry marker root into a safe subpath under the
   * hive. Mirrors normalizeMarkerPath in lib/registry-marker.ts (the packager
   * cannot import from lib/) - keep both in sync.
   */
  private normalizeMarkerPath(input: unknown): string {
    const DEFAULT_MARKER_PATH = 'SOFTWARE\\IntuneGet\\Apps';
    if (typeof input !== 'string') {
      return DEFAULT_MARKER_PATH;
    }

    let markerPath = input.trim().replace(/\//g, '\\').replace(/\\+/g, '\\');
    markerPath = markerPath.replace(/^\\+|\\+$/g, '');
    markerPath = markerPath.replace(/^(HKLM|HKCU|HKEY_LOCAL_MACHINE|HKEY_CURRENT_USER):?(\\|$)/i, '');
    markerPath = markerPath.replace(/[*?"'<>|\x00-\x1f]/g, '');

    const segments = markerPath
      .split('\\')
      .map((segment) => segment.trim())
      .filter(Boolean);

    return segments.length > 0 ? segments.join('\\') : DEFAULT_MARKER_PATH;
  }

  /**
   * Get the registry marker root for a job: custom value from
   * package_config.psadtConfig.registryMarkerPath, or the IntuneGet default
   */
  private getRegistryMarkerPath(job: PackagingJob): string {
    return this.normalizeMarkerPath(this.getPsadtConfig(job)?.registryMarkerPath);
  }

  /**
   * Generate PowerShell code to create IntuneGet registry marker
   * This marker is used by Intune detection rules to verify installation
   */
  private getRegistryMarkerCreation(job: PackagingJob): string {
    const sanitizedId = this.sanitizeWingetId(job.winget_id);
    const hive = this.getRegistryHive(job.install_scope);
    const markerPath = this.getRegistryMarkerPath(job);
    const regPath = `${hive}\\${markerPath}\\${sanitizedId}`;

    return `try {
        $regPath = '${regPath}'
        Set-ADTRegistryKey -LiteralPath $regPath -Name 'DisplayName' -Value '${job.display_name.replace(/'/g, "''")}' -Type String
        Set-ADTRegistryKey -LiteralPath $regPath -Name 'Version' -Value '${job.version}' -Type String
        Set-ADTRegistryKey -LiteralPath $regPath -Name 'Publisher' -Value '${job.publisher.replace(/'/g, "''")}' -Type String
        Set-ADTRegistryKey -LiteralPath $regPath -Name 'WingetId' -Value '${job.winget_id.replace(/'/g, "''")}' -Type String
        Set-ADTRegistryKey -LiteralPath $regPath -Name 'InstalledDate' -Value (Get-Date -Format 'o') -Type String
        Write-ADTLogEntry -Message "IntuneGet detection marker written to $regPath" -Severity 'Success' -Source 'Install-ADTDeployment'
    } catch {
        Write-ADTLogEntry -Message "Warning: Could not write detection marker: $_" -Severity 'Warning' -Source 'Install-ADTDeployment'
    }`;
  }

  /**
   * Generate PowerShell code to remove IntuneGet registry marker
   * Called during uninstallation to clean up detection marker
   */
  private getRegistryMarkerRemoval(job: PackagingJob): string {
    const sanitizedId = this.sanitizeWingetId(job.winget_id);
    const hive = this.getRegistryHive(job.install_scope);
    const hiveLongName = job.install_scope === 'user' ? 'HKEY_CURRENT_USER' : 'HKEY_LOCAL_MACHINE';
    const markerPath = this.getRegistryMarkerPath(job);
    const regPath = `${hive}\\${markerPath}\\${sanitizedId}`;

    return `try {
        $regPath = '${regPath}'
        if (Test-Path -LiteralPath 'Registry::${hiveLongName}\\${markerPath}\\${sanitizedId}' -PathType Container) {
            Remove-ADTRegistryKey -LiteralPath $regPath -Recurse
            Write-ADTLogEntry -Message "IntuneGet detection marker removed from $regPath" -Severity 'Success' -Source 'Uninstall-ADTDeployment'
        }
    } catch {
        Write-ADTLogEntry -Message "Warning: Could not remove detection marker: $_" -Severity 'Warning' -Source 'Uninstall-ADTDeployment'
    }`;
  }

  /**
   * Extract silent switches from install command
   *
   * Mirrors lib/msp/silent-switches.ts (the packager cannot import from lib/)
   * - keep both in sync.
   */
  private extractSilentSwitches(installCommand: string, installerType: string): string {
    const type = (installerType ?? '').toLowerCase();

    // These types are never launched as a process so they take no switches.
    // Their install commands are PowerShell cmdlets (Add-AppxPackage,
    // Expand-Archive), not an installer invocation. A zip's own command is
    // Expand-Archive too - the switches that matter belong to the nested
    // installer, which getZipInstallCommand supplies from its declared type.
    if (type === 'msix' || type === 'appx' || type === 'portable' || type === 'zip') {
      return '';
    }

    // Strip the executable path first so that a hyphen inside a filename
    // (7z2602-x64.exe, Git-2.55.0.2-64-bit.exe) is not read as a switch
    let cleaned = installCommand
      .replace(/^"[^"]+"\s*/, '') // quoted path
      .replace(/^\S+\.(exe|msi|msix|appx)\s*/i, ''); // unquoted path

    // Strip msiexec action switches and their targets:
    // /i filename.msi, /x {GUID}, /p patch.msp, etc.
    cleaned = cleaned
      .replace(/\/[ixp]\s+"[^"]+"\s*/gi, '')
      .replace(/\/[ixp]\s+\{[^}]+\}\s*/gi, '')
      .replace(/\/[ixp]\s+\S+\.(msi|msp)\s*/gi, '')
      .replace(/\/[ixp]\s+/gi, '');

    // A switch must begin at a token boundary. Without the leading (?:^|\s)
    // the hyphen inside a word is matched as a switch, so "Add-AppxPackage
    // -Path x.msix" yields "-AppxPackage -Path".
    const switchMatch = cleaned.match(
      /(?:^|\s)((?:\/\S+|-{1,2}\S+)(?:\s+(?:\/\S+|-{1,2}\S+))*)/
    );
    if (switchMatch && switchMatch[1] !== '-DeploymentType') {
      return switchMatch[1];
    }

    return this.getDefaultSilentSwitches(type);
  }

  /**
   * Silent switches for an installer type when the install command yields
   * none. Types that are never launched as a process take no switches.
   */
  private getDefaultSilentSwitches(installerType: string): string {
    const defaults: Record<string, string> = {
      msi: '/qn /norestart',
      exe: '/S',
      inno: '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART',
      nullsoft: '/S',
      wix: '/qn /norestart',
      burn: '/q /norestart',
      msix: '',
      appx: '',
      portable: '',
      zip: '',
    };
    return defaults[(installerType ?? '').toLowerCase()] ?? '/S';
  }

  /**
   * Create .intunewin package using IntuneWinAppUtil.exe
   */
  private async createIntunewinPackage(
    packageDir: string,
    workDir: string
  ): Promise<PackagingResult> {
    const outputDir = path.join(workDir, 'Output');
    await fs.promises.mkdir(outputDir, { recursive: true });

    const intuneWinUtil = path.join(this.config.paths.tools, 'IntuneWinAppUtil.exe');

    const setupFile = 'Invoke-AppDeployToolkit.exe';
    if (!fs.existsSync(path.join(packageDir, setupFile))) {
      throw new Error(
        `${setupFile} is missing from the package folder. ` +
          'Run "intuneget-packager setup" to repair the tools directory.'
      );
    }

    // Run IntuneWinAppUtil.exe. It reports some failures on stdout while still
    // exiting 0, so keep the output for diagnostics.
    const toolOutput = await this.runProcess(intuneWinUtil, [
      '-c', packageDir,
      '-s', setupFile,
      '-o', outputDir,
      '-q', // Quiet mode
    ]);

    // Find the generated .intunewin file
    const files = await fs.promises.readdir(outputDir);
    const intunewinFile = files.find(f => f.endsWith('.intunewin'));

    if (!intunewinFile) {
      const detail = toolOutput.trim().slice(-500);
      throw new Error(
        `IntuneWinAppUtil did not generate .intunewin file${detail ? `. Tool output: ${detail}` : ''}`
      );
    }

    const intunewinPath = path.join(outputDir, intunewinFile);

    // Extract encryption info AND the inner encrypted payload from the intunewin
    return await this.extractPackageContents(intunewinPath, outputDir);
  }

  /**
   * Extract encryption info and the inner encrypted content file from a
   * .intunewin package.
   *
   * A .intunewin is a ZIP containing Metadata/Detection.xml (encryption keys,
   * digest, the unencrypted content size, and the encrypted payload's file
   * name) plus Contents/<encrypted-payload>. Intune expects the raw encrypted
   * payload to be uploaded to Azure Storage - never the outer .intunewin zip -
   * with size = UnencryptedContentSize and sizeEncrypted = the payload's size.
   */
  private async extractPackageContents(
    intunewinPath: string,
    outputDir: string
  ): Promise<PackagingResult> {
    const extractDir = path.join(outputDir, 'intunewin-extract');
    const escapedIntunewin = intunewinPath.replace(/'/g, "''");
    const escapedExtractDir = extractDir.replace(/'/g, "''");

    const script = `
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      $extractDir = '${escapedExtractDir}'
      if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force }
      [System.IO.Compression.ZipFile]::ExtractToDirectory('${escapedIntunewin}', $extractDir)

      $detection = Get-ChildItem $extractDir -Filter 'Detection.xml' -Recurse | Select-Object -First 1
      if (-not $detection) { throw 'Detection.xml not found inside .intunewin package' }
      [xml]$xml = Get-Content $detection.FullName

      $encryptedFileName = $xml.ApplicationInfo.FileName
      $encryptedFile = Get-ChildItem $extractDir -Filter $encryptedFileName -Recurse | Select-Object -First 1
      if (-not $encryptedFile) { throw "Encrypted content file '$encryptedFileName' not found inside .intunewin package" }

      @{
        EncryptionKey = $xml.ApplicationInfo.EncryptionInfo.EncryptionKey
        MacKey = $xml.ApplicationInfo.EncryptionInfo.MacKey
        InitializationVector = $xml.ApplicationInfo.EncryptionInfo.InitializationVector
        Mac = $xml.ApplicationInfo.EncryptionInfo.Mac
        ProfileIdentifier = $xml.ApplicationInfo.EncryptionInfo.ProfileIdentifier
        FileDigest = $xml.ApplicationInfo.EncryptionInfo.FileDigest
        FileDigestAlgorithm = $xml.ApplicationInfo.EncryptionInfo.FileDigestAlgorithm
        EncryptedContentPath = $encryptedFile.FullName
        EncryptedContentSize = $encryptedFile.Length
        UnencryptedContentSize = [long]$xml.ApplicationInfo.UnencryptedContentSize
      } | ConvertTo-Json
    `;

    const result = await this.runPowerShell(script);
    const data = JSON.parse(result.trim());

    return {
      intunewinPath,
      encryptedContentPath: data.EncryptedContentPath,
      unencryptedContentSize: Number(data.UnencryptedContentSize),
      encryptedContentSize: Number(data.EncryptedContentSize),
      encryptionInfo: {
        encryptionKey: data.EncryptionKey,
        macKey: data.MacKey,
        initializationVector: data.InitializationVector,
        mac: data.Mac,
        profileIdentifier: data.ProfileIdentifier || 'ProfileVersion1',
        fileDigest: data.FileDigest,
        fileDigestAlgorithm: data.FileDigestAlgorithm,
      },
    };
  }

  /**
   * Copy directory recursively
   */
  private async copyDirectory(src: string, dest: string): Promise<void> {
    await fs.promises.mkdir(dest, { recursive: true });
    const entries = await fs.promises.readdir(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        await this.copyDirectory(srcPath, destPath);
      } else {
        await fs.promises.copyFile(srcPath, destPath);
      }
    }
  }

  /**
   * Run a process and wait for completion
   */
  private runProcess(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args);
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          const detail = (stderr.trim() || stdout.trim()).slice(-500);
          reject(new Error(`Process exited with code ${code}${detail ? `: ${detail}` : ''}`));
        }
      });

      proc.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Run PowerShell script or command
   */
  private runPowerShell(scriptOrPath: string, args?: string[]): Promise<string> {
    const isFile = scriptOrPath.endsWith('.ps1');
    const psArgs = isFile
      ? ['-ExecutionPolicy', 'Bypass', '-File', scriptOrPath, ...(args || [])]
      : ['-ExecutionPolicy', 'Bypass', '-Command', scriptOrPath];

    return this.runProcess('powershell.exe', psArgs);
  }
}
